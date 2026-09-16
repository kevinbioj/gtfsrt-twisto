import type GtfsRealtime from "gtfs-realtime-bindings";

import { FIXTURE_MODE, VEHICLE_STALENESS } from "../config.js";

/** Une entité du feed, avec la date du relevé qui l'a produite. */
export type StoredEntity<T> = { entity: T; recordedAt: number };

/**
 * Le store des entités publiées. Il n'est pas vidé à chaque relevé : une entité y survit à l'absence
 * de son véhicule dans la réponse du service — un trou de couverture, une requête qui échoue —, puis
 * sort du feed et de la mémoire d'elle-même passé {@link VEHICLE_STALENESS}.
 *
 * En mode enregistrement, rien ne périme : le fichier rejoué date forcément d'avant, et tout
 * disparaîtrait au premier relevé.
 */
export function useRealtimeStore() {
	const vehiclePositions = new Map<string, StoredEntity<GtfsRealtime.transit_realtime.IVehiclePosition>>();
	const tripUpdates = new Map<string, StoredEntity<GtfsRealtime.transit_realtime.ITripUpdate>>();
	const tripModifications = new Map<string, StoredEntity<GtfsRealtime.transit_realtime.ITripModifications>>();

	return {
		vehiclePositions,
		tripUpdates,
		tripModifications,

		/** Oublie les entités dont le relevé est périmé. Renvoie le nombre d'entités oubliées. */
		sweep(nowSeconds: number): number {
			return (
				prune(vehiclePositions, nowSeconds) + prune(tripUpdates, nowSeconds) + prune(tripModifications, nowSeconds)
			);
		},

		/** Les positions à émettre à cet instant. */
		publishedVehiclePositions(nowSeconds: number) {
			return published(vehiclePositions, nowSeconds);
		},

		/** Les courses à émettre à cet instant. */
		publishedTripUpdates(nowSeconds: number) {
			return published(tripUpdates, nowSeconds);
		},

		/** Les modifications de course à émettre à cet instant. */
		publishedTripModifications(nowSeconds: number) {
			return published(tripModifications, nowSeconds);
		},
	};
}

// ---

function expired(recordedAt: number, nowSeconds: number): boolean {
	return !FIXTURE_MODE && nowSeconds - recordedAt > VEHICLE_STALENESS;
}

function prune<T>(entities: Map<string, StoredEntity<T>>, nowSeconds: number): number {
	let forgotten = 0;

	for (const [id, { recordedAt }] of entities) {
		if (!expired(recordedAt, nowSeconds)) continue;
		entities.delete(id);
		forgotten += 1;
	}

	return forgotten;
}

function published<T>(entities: Map<string, StoredEntity<T>>, nowSeconds: number): Map<string, T> {
	const map = new Map<string, T>();

	for (const [id, { entity, recordedAt }] of entities) {
		if (expired(recordedAt, nowSeconds)) continue;
		map.set(id, entity);
	}

	return map;
}
