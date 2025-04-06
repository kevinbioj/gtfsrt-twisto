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
let tripIds: string[];
const resourceDirectory = await mkdtemp(join(tmpdir(), "twisto-gtfs_"));
try {
	await downloadGtfs(GTFS_URL, resourceDirectory);
	tripIds = await importGtfs(resourceDirectory);
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

const lines = [
	{ LineRef: "SIRI_NVP_037:Line::1:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::114:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::106:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::123:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::F3:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::RES4:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::10:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::113:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::D1EB:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::105:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::104:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::RES3:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::9:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::11EX:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::F2:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::8:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::41:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::120:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::6A:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::T1:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::37:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::116:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::T2:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::6B:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::121:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::F5:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::B2:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::11:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::MP:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::7:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::B1:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::F4:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::T3:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::102:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::115:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::10EX:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::12:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::NUIT:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::RES5:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::22:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::101:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::30:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::119:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::127:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::F7:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::NVCV:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::110:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::40:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::100:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::4:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::32:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::118:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::5:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::31:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::109:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::F6:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::23:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::126:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::B3:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::125:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::108:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::3:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::33:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::F1:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::20:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::112:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::2:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::12EX:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::34:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::137:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::107:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::RES1:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::21:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::111:LOC", Monitored: true },
	{ LineRef: "SIRI_NVP_037:Line::124:LOC", Monitored: true },
];

// const lines = await linesDiscovery(SIRI_WS, SIRI_REQUESTOR);
const monitoredLines = lines.filter(({ Monitored }) => Monitored);
console.log("► %d lines were discovered (%d monitored)", lines.length, monitoredLines.length);

console.log("ⓘ Waiting 60 seconds to avoid rate-limiting");
// await setTimeout(60_000);

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

				const gtfsTripId = tripIds.find((tripId) =>
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
					scheduleRelationship: GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.SCHEDULED,
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
							const stopTimeUpdate: GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate = {
								// 2025-04-06 : some stops can't be matched auto-magically, so we only publish sequence for now
								// stopId: parseRef(stopCall.StopPointRef)[VALUE_ID].toLowerCase(),
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
									stopTimeUpdate.scheduleRelationship =
										GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SCHEDULED;
								}
							}

							return stopTimeUpdate;
						})
						.toSorted((a, b) => (a.stopSequence ?? 0) - (b.stopSequence ?? 0)),
					trip: tripDescriptor,
					timestamp: recordedAtEpoch,
					vehicle: vehicleDescriptor,
				});

				// const currentStopRef = atStop ? monitoredCall?.StopPointRef : onwardCalls[0]?.StopPointRef;

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
						// 2025-04-06 : some stops can't be matched auto-magically, so we only publish sequence for now
						// stopId: currentStopRef ? parseRef(currentStopRef)[VALUE_ID].toLowerCase() : undefined,
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
