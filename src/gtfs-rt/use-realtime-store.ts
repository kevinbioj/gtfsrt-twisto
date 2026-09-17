import type GtfsRealtime from "gtfs-realtime-bindings";

import { FIXTURE_MODE, TRIP_RETENTION, VEHICLE_RETENTION } from "../config.js";

/** Une entité du feed, avec l'instant jusqu'auquel elle y reste. */
export type StoredEntity<T> = { entity: T; keepUntil: number };

/**
 * Un instantané de ce que le feed a à dire, daté de l'instant où le store a changé pour la dernière
 * fois. Les entités y sont filtrées à cette date-là et non à l'heure de la requête : le contenu d'une
 * réponse ne doit dépendre que de {@link lastModified}, sans quoi une entité arrivée à échéance entre
 * deux relevés ferait changer le feed sous un `Last-Modified` inchangé — et le consommateur qui s'y
 * fie au `If-Modified-Since` ne reverrait jamais le feed sans elle.
 */
export type FeedSnapshot = {
	/** L'instant de la dernière modification des collections publiées, en secondes. */
	lastModified: number;
	tripUpdates: Map<string, GtfsRealtime.transit_realtime.ITripUpdate> | null;
	vehiclePositions: Map<string, GtfsRealtime.transit_realtime.IVehiclePosition> | null;
	tripModifications: Map<string, GtfsRealtime.transit_realtime.ITripModifications> | null;
};

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
	const vehiclePositions = new EntityCollection<GtfsRealtime.transit_realtime.IVehiclePosition>();
	const tripUpdates = new EntityCollection<GtfsRealtime.transit_realtime.ITripUpdate>();
	const tripModifications = new EntityCollection<GtfsRealtime.transit_realtime.ITripModifications>();

	return {
		vehiclePositions,
		tripUpdates,
		tripModifications,

		/** Oublie les entités dont l'échéance est passée. Renvoie le nombre d'entités oubliées. */
		sweep(nowSeconds: number): number {
			return vehiclePositions.prune(nowSeconds) + tripUpdates.prune(nowSeconds) + tripModifications.prune(nowSeconds);
		},

		/** Les positions telles qu'elles étaient à la dernière modification du store. */
		vehiclePositionsSnapshot(): FeedSnapshot {
			const lastModified = vehiclePositions.lastModified;
			return {
				lastModified,
				tripUpdates: null,
				vehiclePositions: vehiclePositions.published(lastModified),
				tripModifications: null,
			};
		},

		/**
		 * Les courses telles qu'elles étaient à la dernière modification du store. Les modifications les
		 * accompagnent : une course modifiée ne se lit pas sans elles, et les deux collections partagent
		 * donc une seule et même date — la plus récente des deux.
		 */
		tripUpdatesSnapshot(): FeedSnapshot {
			const lastModified = Math.max(tripUpdates.lastModified, tripModifications.lastModified);
			return {
				lastModified,
				tripUpdates: tripUpdates.published(lastModified),
				vehiclePositions: null,
				tripModifications: tripModifications.published(lastModified),
			};
		},

		/** Tout ce que le feed a à dire, à la dernière modification du store. */
		snapshot(): FeedSnapshot {
			const lastModified = Math.max(
				vehiclePositions.lastModified,
				tripUpdates.lastModified,
				tripModifications.lastModified,
			);
			return {
				lastModified,
				tripUpdates: tripUpdates.published(lastModified),
				vehiclePositions: vehiclePositions.published(lastModified),
				tripModifications: tripModifications.published(lastModified),
			};
		},
	};
}

// ---

/**
 * Une collection d'entités du feed, qui retient la date de sa dernière modification. C'est elle qui
 * date le feed — son en-tête comme son `Last-Modified` — plutôt que l'heure de la requête : entre deux
 * relevés, le producteur n'a rien de neuf à dire, et l'annoncer serait promettre au consommateur une
 * fraîcheur que la source ne lui a pas donnée.
 */
export class EntityCollection<T> {
	readonly #entities = new Map<string, StoredEntity<T>>();
	#lastModified = nowSeconds();

	/** L'instant de la dernière modification de la collection, en secondes. */
	get lastModified(): number {
		return this.#lastModified;
	}

	get size(): number {
		return this.#entities.size;
	}

	set(id: string, stored: StoredEntity<T>): void {
		this.#entities.set(id, stored);
		this.#touch();
	}

	delete(id: string): boolean {
		if (!this.#entities.delete(id)) return false;
		this.#touch();
		return true;
	}

	/** Oublie les entités dont l'échéance est passée. Renvoie le nombre d'entités oubliées. */
	prune(nowSeconds: number): number {
		let forgotten = 0;

		for (const [id, { keepUntil }] of this.#entities) {
			if (!expired(keepUntil, nowSeconds)) continue;
			this.#entities.delete(id);
			forgotten += 1;
		}

		if (forgotten > 0) this.#touch();
		return forgotten;
	}

	/** Les entités à émettre à cet instant. */
	published(atSeconds: number): Map<string, T> {
		const map = new Map<string, T>();

		for (const [id, { entity, keepUntil }] of this.#entities) {
			if (expired(keepUntil, atSeconds)) continue;
			map.set(id, entity);
		}

		return map;
	}

	// L'horloge ne recule pas, quand bien même celle du système le ferait : un `Last-Modified` qui
	// remonterait dans le temps ferait tenir pour frais un feed que le consommateur a déjà dépassé.
	#touch(): void {
		this.#lastModified = Math.max(this.#lastModified, nowSeconds());
	}
}

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

function nowSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

function expired(keepUntil: number, nowSeconds: number): boolean {
	return !FIXTURE_MODE && nowSeconds > keepUntil;
}
