import type { MonitoredJourney } from "../siri/fetch-vehicle-monitoring.js";
import { midnightOf, type ServiceDay, serviceDateOf } from "./service-days.js";
import {
	departureKey,
	formatServiceTime,
	originKey,
	resolveRouteId,
	resolveStopId,
	type StaticGtfs,
	type TripStop,
} from "./use-static-gtfs.js";

/** Comment la course a été rapprochée du GTFS, pour le journal. */
export type MatchedBy = "trip-id" | "origin-departure" | "departure" | "none";

/** La course du GTFS qu'assure le véhicule, ou la course supplémentaire à déclarer à sa place. */
export type TripMatch = {
	/** Vrai lorsque la course a été retrouvée dans le GTFS ; faux pour une course supplémentaire. */
	scheduled: boolean;
	tripId: string;
	routeId: string;
	directionId: number;
	/** Journée de service, au format `AAAAMMJJ`. */
	startDate: string;
	/** Départ depuis le minuit de cette journée, tel que le GTFS l'écrit (« 25:10:00 » possible). */
	startTime: string;
	/** Destination : celle du GTFS quand la course y figure, celle du SAE sinon. */
	headsign: string;
	/** Horaire théorique de la course ; `undefined` pour une course supplémentaire. */
	stops: TripStop[] | undefined;
	/**
	 * Instant, en secondes epoch, où l'horaire théorique fait arriver la course à son terminus.
	 * `undefined` pour une course supplémentaire, qu'aucun horaire ne décrit. Le producteur s'en sert
	 * pour garder la course au feed jusqu'à cette heure passée, même terminée en avance (cf.
	 * `tripKeepUntil`).
	 */
	endsAt: number | undefined;
	by: MatchedBy;
	/** Plusieurs courses du GTFS convenaient également : celle retenue peut n'être pas la bonne. */
	ambiguous: boolean;
};

/** Amplitude maximale d'une journée de service, en secondes : au-delà, l'horaire relève d'un autre jour. */
const MAX_SERVICE_DAY_SPAN = 30 * 3600;

/**
 * Rapproche la course qu'annonce le SAE de celle du GTFS, par trois chemins de fiabilité décroissante :
 *
 *  1. le **nom de course** du SAE est l'identifiant GTFS. C'est le cas du tramway, dont le
 *     `VehicleJourneyName` s'écrit « 7308684-26HIV03-T1T2T3-Semaine-00 » ;
 *  2. sinon, la ligne, l'**arrêt d'origine** et l'**heure de départ théorique** désignent la course. Les
 *     courses de bus portent un nom que le GTFS ignore (« 7453915-01-EP-HSEM-Semaine »), mais ce
 *     triplet les identifie : sur une journée de semaine, il ne laisse d'ambiguïté que sur une douzaine
 *     de courses scolaires en double ;
 *  3. à défaut, la ligne et l'heure de départ seules — le SAE et le GTFS peuvent ne pas s'accorder sur
 *     le point de départ d'une mission.
 *
 * Aucun des trois n'aboutissant, la course est déclarée **supplémentaire** : c'est le cas des
 * substitutions de tramway (B1, B2, B3), dont la ligne même est absente du GTFS.
 *
 * Les journées candidates sont parcourues dans l'ordre reçu — aujourd'hui d'abord (cf.
 * `CANDIDATE_DAY_OFFSETS`) : une course de fin de nuit appartient à la journée de la veille, que le
 * GTFS écrit « 25:10:00 », et c'est en cherchant sur les deux qu'on la retrouve.
 */
export function matchTrip(gtfs: StaticGtfs, days: readonly ServiceDay[], journey: MonitoredJourney): TripMatch {
	// La ligne se rapproche par la référence du SAE, qui porte le `route_id` : son nom commercial, lui,
	// est un libellé d'affichage que le GTFS ne connaît pas (« Ligne 5 » pour « 5 », « Nav » pour
	// « NVCV »). Il ne sert que de recours, pour un relevé qui viendrait sans référence de ligne.
	const routeId = resolveRouteId(gtfs, journey.lineRef) ?? resolveRouteId(gtfs, journey.lineName);
	const reference = journey.originAimedDeparture ?? journey.recordedAt;

	const known = journey.journeyName ? gtfs.trips.get(journey.journeyName) : undefined;
	if (known !== undefined) {
		const startDate = resolveStartDate(gtfs, days, journey.journeyName, reference) ?? serviceDateOf(reference);

		return {
			scheduled: true,
			tripId: journey.journeyName,
			routeId: known.routeId,
			directionId: known.directionId,
			startDate,
			startTime: formatServiceTime(gtfs.tripDepartures.get(journey.journeyName) ?? 0),
			headsign: known.headsign || journey.destinationName,
			stops: gtfs.tripStops.get(journey.journeyName),
			endsAt: scheduledEnd(gtfs, journey.journeyName, midnightOf(startDate)),
			by: "trip-id",
			ambiguous: false,
		};
	}

	if (routeId !== undefined && journey.originAimedDeparture !== undefined) {
		const matched = matchByDeparture(gtfs, days, journey, routeId, journey.originAimedDeparture);
		if (matched !== undefined) return matched;
	}

	return extraTrip(journey, routeId, reference);
}

// ---

/**
 * Cherche la course par son heure de départ, journée candidate après journée candidate. La première qui
 * propose des candidats l'emporte : les journées sont distantes de vingt-quatre heures, et une course
 * annoncée ne peut relever que de l'une d'elles.
 */
function matchByDeparture(
	gtfs: StaticGtfs,
	days: readonly ServiceDay[],
	journey: MonitoredJourney,
	routeId: string,
	aimedDeparture: number,
): TripMatch | undefined {
	const originStopId = resolveStopId(gtfs, journey.originStopRef);

	for (const day of days) {
		const departure = aimedDeparture - day.midnight;
		if (departure < 0 || departure > MAX_SERVICE_DAY_SPAN) continue;

		let by: MatchedBy = "origin-departure";
		let candidates =
			originStopId === undefined
				? []
				: operating(gtfs, day, gtfs.originIndex.get(originKey(routeId, originStopId, departure)));

		if (candidates.length === 0) {
			by = "departure";
			candidates = operating(gtfs, day, gtfs.departureIndex.get(departureKey(routeId, departure)));
		}
		if (candidates.length === 0) continue;

		const narrowed = narrow(gtfs, candidates, journey);
		const tripId = narrowed[0] as string;
		const meta = gtfs.trips.get(tripId);

		return {
			scheduled: true,
			tripId,
			routeId: meta?.routeId ?? routeId,
			directionId: meta?.directionId ?? journey.directionId,
			startDate: day.date,
			startTime: formatServiceTime(departure),
			headsign: meta?.headsign || journey.destinationName,
			stops: gtfs.tripStops.get(tripId),
			endsAt: scheduledEnd(gtfs, tripId, day.midnight),
			by,
			ambiguous: narrowed.length > 1,
		};
	}

	return undefined;
}

/** Une course supplémentaire : le GTFS ne la décrit pas, on la déclare telle qu'elle est annoncée. */
function extraTrip(journey: MonitoredJourney, routeId: string | undefined, reference: number): TripMatch {
	const startDate = serviceDateOf(reference);
	const midnight = midnightOf(startDate);

	return {
		scheduled: false,
		// Le nom de course du SAE fait l'identifiant : c'est le seul dont il soit constant d'un relevé à
		// l'autre. À défaut, la référence datée de la course, qu'il donne toujours.
		tripId:
			journey.journeyName || journey.datedJourneyRef || `${journey.lineRef || journey.lineName}-${journey.vehicleId}`,
		routeId: routeId ?? (journey.lineRef || journey.lineName),
		directionId: journey.directionId,
		startDate,
		startTime: formatServiceTime(midnight === undefined ? 0 : reference - midnight),
		headsign: journey.destinationName,
		stops: undefined,
		endsAt: undefined,
		by: "none",
		ambiguous: false,
	};
}

/**
 * L'instant où l'horaire théorique fait arriver la course à son terminus : l'arrivée au dernier arrêt,
 * que le GTFS compte en secondes depuis le minuit de la journée de service, posée sur ce minuit-là.
 * `undefined` faute de l'un ou de l'autre.
 */
function scheduledEnd(gtfs: StaticGtfs, tripId: string, midnight: number | undefined): number | undefined {
	const arrival = gtfs.tripArrivals.get(tripId);
	if (arrival === undefined || midnight === undefined) return undefined;

	return midnight + arrival;
}

/** Ne garde que les courses dont le service circule bien ce jour-là. */
function operating(gtfs: StaticGtfs, day: ServiceDay, tripIds: string[] | undefined): string[] {
	if (tripIds === undefined) return [];
	return tripIds.filter((tripId) => day.services.has(gtfs.trips.get(tripId)?.serviceId ?? ""));
}

/**
 * Départage plusieurs courses au même départ, par critères de plus en plus fins : le sens, puis le
 * terminus, puis les arrêts que le SAE annonce — qui doivent tous figurer dans l'horaire théorique.
 * Un critère qui n'élimine personne est ignoré, faute de pouvoir trancher.
 *
 * Le réseau compte une douzaine de courses scolaires strictement jumelles, que rien ne distingue : la
 * première est alors retenue, et l'appelant en est averti (cf. {@link TripMatch}).
 */
function narrow(gtfs: StaticGtfs, candidates: string[], journey: MonitoredJourney): string[] {
	if (candidates.length === 1) return candidates;

	let kept = keepIfAny(candidates, (tripId) => gtfs.trips.get(tripId)?.directionId === journey.directionId);

	const destinationStopId = resolveStopId(gtfs, journey.destinationStopRef);
	if (destinationStopId !== undefined) {
		kept = keepIfAny(kept, (tripId) => gtfs.tripStops.get(tripId)?.at(-1)?.stopId === destinationStopId);
	}

	const announced = journey.calls.flatMap((call) => {
		const stopId = resolveStopId(gtfs, call.stopRef);
		return stopId === undefined ? [] : [stopId];
	});
	if (announced.length > 0) {
		kept = keepIfAny(kept, (tripId) => servesAll(gtfs.tripStops.get(tripId), announced));
	}

	return kept;
}

function keepIfAny(candidates: string[], predicate: (tripId: string) => boolean): string[] {
	const kept = candidates.filter(predicate);
	return kept.length === 0 ? candidates : kept;
}

/** Vrai si la course dessert tous les quais annoncés. */
function servesAll(stops: TripStop[] | undefined, stopIds: string[]): boolean {
	if (stops === undefined) return false;

	const served = new Set(stops.map(({ stopId }) => stopId));
	return stopIds.every((stopId) => served.has(stopId));
}

/**
 * La journée de service d'une course dont on connaît l'identifiant GTFS, ou `undefined` lorsqu'aucune
 * journée candidate ne la fait circuler.
 *
 * Le GTFS écrit ses horaires en secondes depuis le minuit de la journée de service, jamais en
 * instants : posé sur deux journées différentes, le même horaire donne deux créneaux distants de
 * vingt-quatre heures. Il suffit donc de regarder lequel encadre l'instant annoncé — le retard d'un
 * véhicule se compte en minutes, l'écart entre deux journées en heures.
 */
function resolveStartDate(
	gtfs: StaticGtfs,
	days: readonly ServiceDay[],
	tripId: string,
	reference: number,
): string | undefined {
	const serviceId = gtfs.trips.get(tripId)?.serviceId;
	const departure = gtfs.tripDepartures.get(tripId);
	const arrival = gtfs.tripArrivals.get(tripId);
	if (serviceId === undefined || departure === undefined || arrival === undefined) return undefined;

	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;

	for (const { date, midnight, services } of days) {
		if (!services.has(serviceId)) continue;

		// Distance de la référence au créneau de la course ce jour-là : nulle pendant qu'elle roule, et
		// c'est de combien elle le manque sinon.
		const distance = Math.max(0, midnight + departure - reference, reference - (midnight + arrival));
		if (distance < bestDistance) {
			bestDistance = distance;
			best = date;
		}
	}

	return best;
}
