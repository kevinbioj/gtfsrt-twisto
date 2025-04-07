import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";

import { serve } from "@hono/node-server";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { stream } from "hono/streaming";
import { Temporal } from "temporal-polyfill";

import { createFeed } from "./gtfs-rt/create-feed.js";
import { downloadGtfs } from "./gtfs/download-gtfs.js";
import { importGtfs } from "./gtfs/import-gtfs.js";

import { lines } from "./lines.js";
import { getVehicleMonitoring } from "./siri/get-vehicle-monitoring.js";
import { VALUE_ID, parseRef } from "./siri/parse-ref.js";
import type { StopCall } from "./siri/types.js";

const fixTimestamp = (input: string) => {
	const plusIndex = input.indexOf("+");
	return `${input}[${input.slice(plusIndex)}]`;
};

const GTFS_URL =
	"https://data.twisto.fr/api/explore/v2.1/catalog/datasets/fichier-gtfs-du-reseau-twisto/alternative_exports/gtfs_twisto_zip/";
const SIRI_WS = "https://api.okina.fr/gateway/cae/realtime/anshar/ws/services";
const SIRI_REQUESTOR = "BUS-TRACKER.FR";

const tripUpdates = new Map<string, GtfsRealtime.transit_realtime.ITripUpdate>();
const vehiclePositions = new Map<string, GtfsRealtime.transit_realtime.IVehiclePosition>();

setInterval(() => {
	const currentEpoch = Math.floor(Date.now() / 1000);

	for (const [id, tripUpdate] of tripUpdates) {
		if (currentEpoch - +tripUpdate.timestamp! >= 3600) {
			tripUpdates.delete(id);
		}
	}

	for (const [id, vehicle] of vehiclePositions) {
		if (currentEpoch - +vehicle.timestamp! >= 3600) {
			vehiclePositions.delete(id);
		}
	}
}, 120_000);

// ---

console.log("► Importing GTFS into memory");
let gtfs: Awaited<ReturnType<typeof importGtfs>>;
const resourceDirectory = await mkdtemp(join(tmpdir(), "twisto-gtfs_"));
try {
	await downloadGtfs(GTFS_URL, resourceDirectory);
	gtfs = await importGtfs(resourceDirectory);
} finally {
	await rm(resourceDirectory, { recursive: true, force: true });
}

// ---

const hono = new Hono();
hono.get("/", (c) => {
	const format = c.req.query("format") ?? "binary";
	if (!["binary", "plaintext"].includes(format)) {
		return c.json({ error: '"format" must be either "binary" or "plaintext" (default: "binary")' }, 400);
	}

	const feed = GtfsRealtime.transit_realtime.FeedMessage.create(createFeed(tripUpdates, vehiclePositions));
	if (format === "plaintext") return c.json(feed);

	return stream(c, async (stream) => {
		const encoded = GtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish();
		await stream.write(encoded);
	});
});
serve({ fetch: hono.fetch, port: +(process.env.PORT ?? 3000) });

// ---

const monitoredLines = lines.filter(({ Monitored }) => Monitored);

while (true) {
	try {
		const vehicleActivities = await getVehicleMonitoring(
			SIRI_WS,
			SIRI_REQUESTOR,
			monitoredLines.map(({ LineRef }) => LineRef),
		);

		console.log("► Handling %d vehicle activities", vehicleActivities.length);

		for (const vehicleActivity of vehicleActivities) {
			try {
				const recordedAt = Temporal.Instant.from(vehicleActivity.RecordedAtTime);
				const recordedAtEpoch = Math.floor(recordedAt.epochMilliseconds / 1000);
				const vehicleId = parseRef(vehicleActivity.VehicleMonitoringRef)[VALUE_ID];

				const journey = vehicleActivity.MonitoredVehicleJourney;
				const monitoredCall = journey.MonitoredCall;
				const onwardCalls =
					typeof journey.OnwardCalls?.OnwardCall !== "undefined"
						? Array.isArray(journey.OnwardCalls?.OnwardCall)
							? journey.OnwardCalls?.OnwardCall
							: [journey.OnwardCalls?.OnwardCall]
						: [];

				const gtfsTripId = gtfs.tripIds.find((tripId) =>
					tripId.startsWith(journey.VehicleJourneyName.slice(0, journey.VehicleJourneyName.indexOf("-"))),
				);

				const waitingForDeparture =
					Temporal.ZonedDateTime.compare(
						Temporal.Now.zonedDateTimeISO(),
						fixTimestamp(journey.OriginAimedDepartureTime),
					) < 0;

				const atStop =
					onwardCalls.length === 0 ||
					typeof monitoredCall === "undefined" ||
					Temporal.Instant.compare(vehicleActivity.RecordedAtTime, monitoredCall.ExpectedDepartureTime) < 0;

				const tripDescriptor = {
					tripId: gtfsTripId ?? journey.VehicleJourneyName,
					routeId: parseRef(journey.LineRef)[VALUE_ID],
					directionId: journey.DirectionName - 1,
					scheduleRelationship: gtfsTripId
						? GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED
						: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.ADDED,
				};

				const vehicleDescriptor = {
					id: vehicleId,
					label: vehicleId.slice(vehicleId.indexOf("_") + 1),
				};

				tripUpdates.set(`SM:${gtfsTripId ?? journey.VehicleJourneyName}`, {
					stopTimeUpdate: [
						...(waitingForDeparture
							? [
									{
										StopPointRef: journey.OriginRef,
										Order: 1,
										AimedDepartureTime: journey.OriginAimedDepartureTime,
										ExpectedDepartureTime: journey.OriginAimedDepartureTime,
									} satisfies StopCall,
								]
							: []),
						...(monitoredCall ? [monitoredCall] : []),
						...onwardCalls,
					]
						.flatMap((stopCall) => {
							const stopId = parseRef(stopCall.StopPointRef)[VALUE_ID].toLowerCase();
							if (!gtfs.stops.has(stopId.toLowerCase())) return [];

							const stopTimeUpdate: GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate = {
								stopId,
								stopSequence: stopCall.Order,
							};

							if (stopCall.ArrivalStatus === "cancelled" || stopCall.DepartureStatus === "cancelled") {
								stopTimeUpdate.scheduleRelationship =
									GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;
							} else {
								if (
									stopCall.ArrivalStatus !== "noReport" &&
									typeof stopCall.ExpectedArrivalTime !== "undefined" &&
									typeof stopCall.AimedArrivalTime !== "undefined"
								) {
									stopTimeUpdate.arrival = {
										time: Math.floor(Temporal.Instant.from(stopCall.ExpectedArrivalTime).epochMilliseconds / 1000),
										delay: Temporal.Instant.from(stopCall.ExpectedArrivalTime)
											.since(stopCall.AimedArrivalTime)
											.total("seconds"),
									};
								}

								if (stopCall.DepartureStatus !== "noReport" && typeof stopCall.ExpectedDepartureTime !== "undefined") {
									stopTimeUpdate.departure = {
										time: Math.floor(Temporal.Instant.from(stopCall.ExpectedDepartureTime).epochMilliseconds / 1000),
										delay: Temporal.Instant.from(stopCall.ExpectedDepartureTime)
											.since(stopCall.AimedDepartureTime)
											.total("seconds"),
									};
								}

								if (typeof stopTimeUpdate.arrival === "undefined" && typeof stopTimeUpdate.departure === "undefined") {
									stopTimeUpdate.scheduleRelationship =
										GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.NO_DATA;
								} else {
									stopTimeUpdate.scheduleRelationship = gtfsTripId
										? GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED
										: GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.UNSCHEDULED;
								}
							}

							return stopTimeUpdate;
						})
						.toSorted((a, b) => (a.stopSequence ?? 0) - (b.stopSequence ?? 0)),
					trip: tripDescriptor,
					timestamp: recordedAtEpoch,
					vehicle: vehicleDescriptor,
				});

				const currentStopRef = parseRef(atStop ? monitoredCall!.StopPointRef : onwardCalls[0]!.StopPointRef)[
					VALUE_ID
				].toLowerCase();

				if (typeof journey.VehicleLocation !== "undefined") {
					vehiclePositions.set(`VM:${vehicleId}`, {
						currentStatus: atStop
							? GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.STOPPED_AT
							: GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus.IN_TRANSIT_TO,
						currentStopSequence: atStop ? monitoredCall!.Order : onwardCalls[0]!.Order,
						position: {
							latitude: journey.VehicleLocation.Latitude,
							longitude: journey.VehicleLocation.Longitude,
							bearing: journey.Bearing,
						},
						stopId: gtfs.stops.has(currentStopRef) ? currentStopRef : undefined,
						timestamp: recordedAtEpoch,
						trip: tripDescriptor,
						vehicle: vehicleDescriptor,
					});
				}
			} catch (cause) {
				const error = new Error(`Failed to handle vehicle "${vehicleActivity.VehicleMonitoringRef}"`, { cause });
				console.error(error);
				console.dir(vehicleActivity, { depth: null });
			}
		}
	} catch (cause) {
		const error = new Error("Failed to refresh data", { cause });
		console.error(error);
	} finally {
		await setTimeout(60_000);
	}
}
