import GtfsRealtime from "gtfs-realtime-bindings";

import type { FeedSnapshot } from "./use-realtime-store.js";

const CANCELED = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;

/**
 * Une course a-t-elle quelque chose à annoncer ? Ses arrêts, ou son annulation : une course annulée ne
 * dessert rien, et son descripteur porte à lui seul toute l'information.
 */
function informs(tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate): boolean {
	return (tripUpdate.stopTimeUpdate?.length ?? 0) > 0 || tripUpdate.trip?.scheduleRelationship === CANCELED;
}

/**
 * Assemble le feed à partir d'un instantané du store. Son en-tête est daté de la dernière modification
 * de ce dernier et non de l'instant de la requête : le `timestamp` du format dit quand la donnée a été
 * produite, et deux lectures successives d'un feed inchangé doivent porter la même date — c'est elle
 * que le `Last-Modified` de la réponse annonce (cf. `handleRequest`).
 */
export function createFeed({ lastModified, tripUpdates, vehiclePositions, tripModifications }: FeedSnapshot) {
	return GtfsRealtime.transit_realtime.FeedMessage.create({
		header: {
			gtfsRealtimeVersion: "2.0",
			incrementality: GtfsRealtime.transit_realtime.FeedHeader.Incrementality.FULL_DATASET,
			timestamp: lastModified,
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
