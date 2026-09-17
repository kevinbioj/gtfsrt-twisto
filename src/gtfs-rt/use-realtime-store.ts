import type GtfsRealtime from "gtfs-realtime-bindings";

import { FIXTURE_MODE, TRIP_RETENTION, VEHICLE_RETENTION } from "../config.js";

/** Une entité du feed, avec l'instant jusqu'auquel elle y reste. */
export type StoredEntity<T> = { entity: T; keepUntil: number };

/**
 * Le store des entités publiées. Il n'est pas vidé à chaque relevé : une entité y survit à l'absence
 * de son véhicule dans la réponse du service — un trou de couverture, une requête qui échoue, une
 * course qui s'achève —, puis sort du feed et de la mémoire d'elle-même passé son échéance.
 *
 * Cette échéance n'est pas la même pour tous : un véhicule reste une demi-heure après son dernier
 * relevé (cf. {@link VEHICLE_RETENTION}), une course dix minutes après son dernier relevé ET après sa
 * fin théorique (cf. {@link TRIP_RETENTION}), de sorte qu'une course terminée en avance ne quitte pas
 * le feed avant l'heure à laquelle on l'y cherche encore.
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

		/** Oublie les entités dont l'échéance est passée. Renvoie le nombre d'entités oubliées. */
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

/** Jusqu'à quand garder un véhicule relevé à cet instant. */
export function vehicleKeepUntil(recordedAt: number): number {
	return recordedAt + VEHICLE_RETENTION;
}

/**
 * Jusqu'à quand garder une course relevée à cet instant, dont l'horaire théorique s'achève à
 * {@link endsAt} — `undefined` pour une course supplémentaire, qu'aucun horaire ne décrit : son dernier
 * relevé est alors tout ce dont on dispose pour la dater.
 *
 * La plus tardive des deux échéances l'emporte : une course terminée en avance reste publiée jusqu'à
 * sa fin théorique passée, et une course en retard au-delà de son horaire reste publiée tant qu'on la
 * relève, puis le délai de garde après son dernier relevé.
 */
export function tripKeepUntil(recordedAt: number, endsAt: number | undefined): number {
	return Math.max(recordedAt, endsAt ?? 0) + TRIP_RETENTION;
}

function expired(keepUntil: number, nowSeconds: number): boolean {
	return !FIXTURE_MODE && nowSeconds > keepUntil;
}

function prune<T>(entities: Map<string, StoredEntity<T>>, nowSeconds: number): number {
	let forgotten = 0;

	for (const [id, { keepUntil }] of entities) {
		if (!expired(keepUntil, nowSeconds)) continue;
		entities.delete(id);
		forgotten += 1;
	}

	return forgotten;
}

function published<T>(entities: Map<string, StoredEntity<T>>, nowSeconds: number): Map<string, T> {
	const map = new Map<string, T>();

	for (const [id, { entity, keepUntil }] of entities) {
		if (expired(keepUntil, nowSeconds)) continue;
		map.set(id, entity);
	}

	return map;
}
