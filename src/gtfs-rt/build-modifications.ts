import type GtfsRealtime from "gtfs-realtime-bindings";

import { FEED_PREFIX } from "../config.js";
import type { MonitoredCall, MonitoredJourney } from "../siri/fetch-vehicle-monitoring.js";
import type { TripMatch } from "./match-trip.js";
import { isCallServed, isScheduledCall, type ResolvedCall } from "./resolve-calls.js";
import { midnightOf } from "./service-days.js";
import type { TripStop } from "./use-static-gtfs.js";

/**
 * Ce que le système de modifications de course a su dire de l'écart entre la course annoncée et son
 * horaire théorique.
 */
export type BuiltModifications = {
	/** `undefined` lorsque la course annoncée ne s'écarte pas de l'horaire théorique, ou qu'il n'y a rien à en dire. */
	entity: GtfsRealtime.transit_realtime.ITripModifications | undefined;
	/** Les arrêts annoncés dont les modifications rendent compte : les ajouts comme les suppressions qu'ils entraînent. */
	described: ReadonlySet<ResolvedCall>;
	/** Les arrêts supplémentaires qu'aucune modification n'a su décrire, pour le journal. */
	undescribed: ResolvedCall[];
};

/** Un écart entre deux arrêts de l'horaire théorique : ce qui s'y ajoute, et ce qui y disparaît. */
type Deviation = {
	/** Dernier arrêt théorique desservi avant l'écart ; `undefined` si l'écart ouvre la liste annoncée. */
	previous: ResolvedCall | undefined;
	/** Premier arrêt théorique desservi après l'écart ; `undefined` si l'écart la termine. */
	next: ResolvedCall | undefined;
	/** Arrêts théoriques que la source annonce comme non desservis. */
	dropped: ResolvedCall[];
	/** Arrêts supplémentaires, dans l'ordre de la course. */
	added: ResolvedCall[];
	/** L'écart comporte un quai que le GTFS ignore : il n'est pas descriptible (cf. {@link toModification}). */
	opaque: boolean;
};

/**
 * Décrit, au moyen du système de modifications de course, ce que la course annoncée fait de plus ou de
 * moins que son horaire théorique.
 *
 * Le SAE annonce parfois des arrêts que la course du GTFS ne dessert pas : renfort passant par une
 * antenne, déviation de chantier, prolongement au-delà du terminus. Un `stop_time_update` ne sait pas
 * les porter — il ne peut désigner qu'un arrêt de la course théorique —, et les publier tels quels
 * revient à annoncer un arrêt au rang d'un autre. Le message `TripModifications` est fait pour ça : il
 * remplace une tranche d'arrêts de la course d'origine par une suite d'arrêts de remplacement, que le
 * consommateur applique lui-même à l'horaire théorique.
 *
 * Ce qui est publié reste volontairement étroit : seuls les écarts comportant au moins un arrêt
 * supplémentaire donnent lieu à une modification. Une suppression isolée — la fin d'une course qui
 * saute — continue de se dire par un `stop_time_update` à `SKIPPED`, que tous les consommateurs
 * comprennent, là où `TripModifications` reste expérimental.
 *
 * Deux choses ne sont volontairement pas déclarées :
 *
 *  - le **tracé** de la course modifiée (`shape_id`) : le producteur ne charge pas `shapes.txt` et ne
 *    saurait de toute façon pas tracer le détour, la source ne publiant que des points d'arrêt ;
 *  - le **retard propagé** (`propagated_modification_delay`) : le `TripUpdate` porte déjà l'heure
 *    prévue de chacun des arrêts qui suivent, ce qui est plus juste qu'un décalage uniforme.
 */
export function buildModifications(
	journey: MonitoredJourney,
	match: TripMatch,
	resolved: ResolvedCall[],
): BuiltModifications {
	const stops = match.stops;
	if (!match.scheduled || stops === undefined || stops.length === 0) {
		return { entity: undefined, described: new Set(), undescribed: [] };
	}

	const modifications: GtfsRealtime.transit_realtime.TripModifications.IModification[] = [];
	const described = new Set<ResolvedCall>();
	const undescribed: ResolvedCall[] = [];
	const midnight = midnightOf(match.startDate);

	for (const deviation of deviationsOf(resolved)) {
		const built = toModification(journey, stops, resolved, deviation, midnight);
		if (built === undefined) {
			undescribed.push(...deviation.added);
			continue;
		}

		modifications.push(built.modification);
		for (const call of built.described) described.add(call);
	}

	if (modifications.length === 0) return { entity: undefined, described, undescribed };

	return {
		entity: {
			// Une seule course par entité : le SAE raisonne par véhicule, et deux véhicules dérouteront
			// rarement de la même façon au même moment. Le format veut par ailleurs qu'une course ne soit
			// jamais rattachée à deux modifications le même jour de service, ce que garantit l'identifiant.
			selectedTrips: [{ tripIds: [match.tripId] }],
			serviceDates: [match.startDate],
			modifications,
		},
		described,
		undescribed,
	};
}

/**
 * L'identifiant sous lequel les modifications d'une course se publient, et que sa version modifiée
 * cite. Il porte la journée de service : une course ne peut être rattachée qu'à un seul jeu de
 * modifications par journée, et deux occurrences d'une même course peuvent se chevaucher.
 */
export function modificationsId(match: TripMatch): string {
	return `TM:${FEED_PREFIX}:${match.tripId}:${match.startDate}`;
}

// ---

/**
 * Découpe la course annoncée en écarts : chaque suite d'arrêts qui ne sont pas des arrêts desservis de
 * l'horaire théorique, entre les deux arrêts théoriques qui l'encadrent. Seuls les écarts comportant un
 * arrêt supplémentaire sont retenus — les autres n'ont rien que `SKIPPED` ne dise déjà.
 */
function deviationsOf(resolved: ResolvedCall[]): Deviation[] {
	const deviations: Deviation[] = [];
	let current: Deviation = { previous: undefined, next: undefined, dropped: [], added: [], opaque: false };

	for (const call of resolved) {
		if (isScheduledCall(call) && isCallServed(call.call)) {
			current.next = call;
			if (current.added.length > 0) deviations.push(current);
			current = { previous: call, next: undefined, dropped: [], added: [], opaque: false };
			continue;
		}

		// Un arrêt que la source annonce comme non desservi et que le GTFS ignore n'apprend rien à
		// personne : ni la course théorique ni la course réelle ne le desservent.
		if (!isCallServed(call.call)) {
			if (isScheduledCall(call)) current.dropped.push(call);
			continue;
		}

		if (call.resolution === "added") current.added.push(call);
		else current.opaque = true;
	}

	if (current.added.length > 0) deviations.push(current);

	return deviations;
}

/**
 * Traduit un écart en une modification. `undefined` lorsque l'écart n'est pas descriptible : un quai
 * que le GTFS ignore ne peut pas être désigné comme arrêt de remplacement — le format exige un arrêt
 * connu, du GTFS statique ou déclaré dans le flux, et la source ne publie pas de quoi le déclarer (ni
 * position, ni code) ; sans horaire non plus, il n'y a rien à quoi accrocher les arrêts ajoutés.
 */
function toModification(
	journey: MonitoredJourney,
	stops: TripStop[],
	resolved: ResolvedCall[],
	deviation: Deviation,
	midnight: number | undefined,
):
	| { modification: GtfsRealtime.transit_realtime.TripModifications.IModification; described: ResolvedCall[] }
	| undefined {
	if (deviation.opaque) return undefined;

	const replaced = replacedStops(stops, deviation);
	const span = spanOf(deviation, replaced);
	if (span === undefined) return undefined;

	const { startSequence, endSequence, replacements } = span;
	const start = stops.findIndex(({ stopSequence }) => stopSequence === startSequence);
	if (start === -1) return undefined;

	// Le format compte les temps de parcours depuis l'arrêt qui PRÉCÈDE la tranche remplacée, ou depuis
	// l'origine de la course lorsque la tranche l'englobe.
	const reference = stops[Math.max(0, start - 1)];
	const referenceTime = reference === undefined ? undefined : scheduledTimeOf(reference, resolved, journey, midnight);
	if (referenceTime === undefined) return undefined;

	const replacementStops = toReplacementStops(journey, replacements, referenceTime, start === 0);
	if (replacementStops === undefined) return undefined;

	return {
		modification: {
			// Le rang ET le quai : le rang suffit au format, mais une course qui dessert deux fois le même
			// quai ne laisse aucun doute au consommateur qui lirait l'un plutôt que l'autre.
			startStopSelector: { stopSequence: startSequence, stopId: stops[start]?.stopId },
			endStopSelector:
				endSequence === undefined
					? undefined
					: {
							stopSequence: endSequence,
							stopId: stops.find(({ stopSequence }) => stopSequence === endSequence)?.stopId,
						},
			replacementStops,
			lastModifiedTime: journey.recordedAt,
		},
		described: [
			...deviation.added,
			...deviation.dropped.filter(({ stopSequence }) => isReplaced(replaced, stopSequence)),
		],
	};
}

/**
 * Ce que la modification remplace, et ce qu'elle met à la place. Trois cas :
 *
 *  - des arrêts théoriques disparaissent : ils forment la tranche remplacée, que les arrêts
 *    supplémentaires viennent occuper ;
 *  - rien ne disparaît et la liste annoncée reprend après l'écart : les arrêts supplémentaires
 *    s'intercalent avant l'arrêt théorique qui suit, que le format désigne alors seul, sans tranche à
 *    remplacer ;
 *  - rien ne disparaît et la liste annoncée s'arrête là : la course se prolonge au-delà de son dernier
 *    arrêt théorique desservi, qui se remplace par lui-même suivi des arrêts supplémentaires — le
 *    format ne sait pas ajouter après la fin d'une course autrement.
 *
 * `undefined` lorsque l'écart ne tient à aucun arrêt théorique : il n'y a alors rien à quoi le
 * rattacher, la source n'annonçant que des arrêts que la course ne dessert pas.
 */
function spanOf(
	deviation: Deviation,
	replaced: TripStop[],
): { startSequence: number; endSequence: number | undefined; replacements: ResolvedCall[] } | undefined {
	const first = replaced[0];
	const last = replaced.at(-1);
	if (first !== undefined && last !== undefined) {
		return { startSequence: first.stopSequence, endSequence: last.stopSequence, replacements: deviation.added };
	}

	if (deviation.next !== undefined) {
		return { startSequence: deviation.next.stopSequence, endSequence: undefined, replacements: deviation.added };
	}

	if (deviation.previous !== undefined) {
		return {
			startSequence: deviation.previous.stopSequence,
			endSequence: deviation.previous.stopSequence,
			replacements: [deviation.previous, ...deviation.added],
		};
	}

	return undefined;
}

/**
 * Les arrêts de l'horaire théorique que l'écart fait disparaître : tous ceux qui séparent les deux
 * arrêts desservis qui l'encadrent — la source annonce tout ce qui reste à desservir, et ce qu'elle
 * passe sous silence entre deux arrêts annoncés n'est donc plus desservi.
 *
 * Faute d'un des deux encadrements, seules les suppressions que la source déclare expressément sont
 * retenues : sa liste peut s'arrêter avant la fin de la course, et rien ne dit alors que ce qui suit
 * saute.
 */
function replacedStops(stops: TripStop[], deviation: Deviation): TripStop[] {
	const previous = deviation.previous?.stopSequence;
	const next = deviation.next?.stopSequence;

	if (previous !== undefined && next !== undefined) {
		return stops.filter(({ stopSequence }) => stopSequence > previous && stopSequence < next);
	}

	const dropped = deviation.dropped.map(({ stopSequence }) => stopSequence);
	if (dropped.length === 0) return [];

	const from = Math.min(...dropped);
	const to = Math.max(...dropped);
	return stops.filter(({ stopSequence }) => stopSequence >= from && stopSequence <= to);
}

function isReplaced(replaced: TripStop[], stopSequence: number): boolean {
	return replaced.some((stop) => stop.stopSequence === stopSequence);
}

/**
 * Les arrêts de remplacement, chacun avec son temps de parcours depuis l'arrêt de référence. Le format
 * veut cette suite strictement croissante, ce que deux horaires identiques — une source qui arrondit à
 * la minute — ne donneraient pas : elle est donc redressée seconde par seconde. Un temps négatif n'est
 * toléré que lorsque la référence est l'origine de la course.
 */
function toReplacementStops(
	journey: MonitoredJourney,
	replacements: ResolvedCall[],
	referenceTime: number,
	referenceIsOrigin: boolean,
): GtfsRealtime.transit_realtime.IReplacementStop[] | undefined {
	const replacementStops: GtfsRealtime.transit_realtime.IReplacementStop[] = [];
	let minimum = referenceIsOrigin ? Number.NEGATIVE_INFINITY : 1;

	for (const { call, stopId } of replacements) {
		const time = scheduledCallTime(call, journey.delaySeconds);
		if (time === undefined) return undefined;

		const travelTimeToStop = Math.max(Math.round(time - referenceTime), minimum);
		replacementStops.push({ stopId, travelTimeToStop });
		minimum = travelTimeToStop + 1;
	}

	return replacementStops.length === 0 ? undefined : replacementStops;
}

/**
 * L'horaire THÉORIQUE d'un arrêt de la course, en secondes epoch : c'est sur lui que se comptent les
 * temps de parcours, le consommateur ajoutant ensuite le temps réel que porte le `TripUpdate`. Celui
 * qu'annonce la source prime — il vaut aussi pour les arrêts supplémentaires, que le GTFS ignore —, et
 * l'horaire du GTFS prend le relais pour un arrêt déjà desservi, dont la source ne dit plus rien.
 */
function scheduledTimeOf(
	stop: TripStop,
	resolved: ResolvedCall[],
	journey: MonitoredJourney,
	midnight: number | undefined,
): number | undefined {
	const announced = resolved.find((call) => isScheduledCall(call) && call.stopSequence === stop.stopSequence);

	const fromSource = announced === undefined ? undefined : scheduledCallTime(announced.call, journey.delaySeconds);
	if (fromSource !== undefined) return fromSource;

	if (midnight === undefined) return undefined;
	const scheduled = Number.isFinite(stop.arrival) ? stop.arrival : stop.departure;
	return Number.isFinite(scheduled) ? midnight + scheduled : undefined;
}

/**
 * L'horaire théorique d'un arrêt annoncé, en secondes epoch. La source le publie pour ses arrêts
 * supplémentaires comme pour les autres ; à défaut, l'heure prévue défalquée du retard de la course en
 * tient lieu — c'est l'horaire qu'aurait eu cet arrêt sans le retard, et c'est bien de cela qu'un temps
 * de parcours doit se compter.
 */
function scheduledCallTime(call: MonitoredCall, delaySeconds: number | undefined): number | undefined {
	const aimed = call.aimedArrival ?? call.aimedDeparture;
	if (aimed !== undefined) return aimed;

	// L'heure constatée fait aussi bien l'affaire que l'heure prévue — c'est la même heure, une fois
	// l'événement survenu —, et à l'arrêt où se trouve le véhicule elle est parfois la seule publiée.
	const observed = call.expectedArrival ?? call.expectedDeparture ?? call.actualArrival ?? call.actualDeparture;
	return observed === undefined ? undefined : observed - (delaySeconds ?? 0);
}
