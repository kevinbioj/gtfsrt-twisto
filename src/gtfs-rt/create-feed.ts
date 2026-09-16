import GtfsRealtime from "gtfs-realtime-bindings";

const CANCELED = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;

/**
 * Une course a-t-elle quelque chose à annoncer ? Ses arrêts, ou son annulation : une course annulée ne
 * dessert rien, et son descripteur porte à lui seul toute l'information.
 */
function informs(tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate): boolean {
	return (tripUpdate.stopTimeUpdate?.length ?? 0) > 0 || tripUpdate.trip?.scheduleRelationship === CANCELED;
}

export function createFeed(
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate> | null,
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> | null,
	tripModifications: Map<string, GtfsRealtime.transit_realtime.ITripModifications> | null,
) {
	return GtfsRealtime.transit_realtime.FeedMessage.create({
		header: {
			gtfsRealtimeVersion: "2.0",
			incrementality: GtfsRealtime.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
			timestamp: Math.floor(Temporal.Now.instant().epochMilliseconds / 1000),
		},
		entity: [
			// Les modifications d'abord : les courses qui s'y réfèrent ne veulent rien dire sans elles, et
			// rien n'oblige un consommateur à lire le flux deux fois.
			...(tripModifications !== null
				? tripModifications
						.entries()
						.map(([id, tripModifications]) => ({ id, tripModifications }))
						.toArray()
				: []),
			...(tripUpdates !== null
				? tripUpdates
						.entries()
						.flatMap(([id, tripUpdate]) => (informs(tripUpdate) ? [{ id, tripUpdate }] : []))
						.toArray()
				: []),
			...(vehiclePositions !== null
				? vehiclePositions
						.entries()
						.map(([id, vehicle]) => ({ id, vehicle }))
						.toArray()
				: []),
		],
	});
}
