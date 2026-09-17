import GtfsRealtime from "gtfs-realtime-bindings";

import { PROPAGATED_DELAY_MIN, PROPAGATED_UNCERTAINTY, PROPAGATION_HORIZON, PROPAGATION_MAX_TRIPS } from "../config.js";
import type { MonitoredJourney } from "../siri/fetch-vehicle-monitoring.js";
import { buildVehicleDescriptor } from "./build-entities.js";
import type { TripMatch } from "./match-trip.js";
import { midnightOf } from "./service-days.js";
import { type StaticGtfs, sameStation, type TripStop } from "./use-static-gtfs.js";

const TripSchedule = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship;
const StopSchedule = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship;

/** Une course à venir, dont le retard est déduit de celle qui la précède sur le même véhicule. */
export type PredictedTrip = {
	tripId: string;
	/** Journée de service, celle de la course d'où vient le retard : un bloc ne la franchit pas. */
	startDate: string;
	/** Retard reporté, en secondes — toujours positif, une course ne partant pas avant l'heure. */
	delay: number;
	/** Relevé d'où vient la prévision : c'est de lui que court le délai de garde de la course. */
	recordedAt: number;
	/** Fin théorique de la course, pour la garder au feed aussi longtemps qu'il faut (cf. `tripKeepUntil`). */
	endsAt: number;
	entity: GtfsRealtime.transit_realtime.ITripUpdate;
};

/**
 * Reporte le retard d'une course sur les suivantes du même bloc.
 *
 * Le VehicleMonitoring ne parle que du présent : il n'annonce une course qu'une fois le véhicule en
 * service dessus, si bien qu'une course qui ne peut PAS partir à l'heure — son véhicule est encore sur
 * la précédente, à vingt minutes de son terminus — reste publiée à l'horaire théorique jusqu'à la
 * dernière minute. Le `block_id` du GTFS dit pourtant ce qu'il faut savoir : quelles courses un même
 * véhicule enchaîne, et dans quel ordre.
 *
 * Le report se fait de proche en proche. Une course qui arrive avec vingt minutes de retard et repart
 * dix minutes plus tard — battement théorique — en emporte dix ; le reste du battement absorbe ce qui
 * peut l'être, et le solde passe à la course d'après. Deux réserves y sont faites :
 *
 *  - un battement n'en est un que si les deux courses se touchent, terminus de l'une contre origine de
 *    l'autre (le même quai, ou deux quais d'une même station). Le réseau compte huit pour cent
 *    d'enchaînements où le véhicule doit se déplacer à vide entre les deux — cinq minutes de battement
 *    théorique pour une traversée de ville qui en prend autant : il n'y a là rien à absorber, et le
 *    retard passe entier ;
 *  - le retard ne se rattrape pas de lui-même. C'est vrai de la course suivante, de moins en moins
 *    ensuite — d'où {@link PROPAGATION_MAX_TRIPS}.
 *
 * L'avance, elle, ne se reporte pas : une course ne part jamais avant son heure, et le SAE reprendra la
 * main dès que le véhicule se déclarera en service sur la course suivante — ce qui écrase la prévision
 * par de l'observé (cf. `index.ts`).
 */
export function propagateDelay(
	gtfs: StaticGtfs,
	journey: MonitoredJourney,
	match: TripMatch,
	nowSeconds: number,
): PredictedTrip[] {
	// Une course supplémentaire n'appartient à aucun bloc, et une course à l'heure n'a rien à reporter.
	// L'appelant, lui, écarte les courses annulées : leur véhicule n'est pas là où on le croit.
	if (!match.scheduled || (journey.delaySeconds ?? 0) < PROPAGATED_DELAY_MIN) return [];

	const block = gtfs.tripBlock.get(match.tripId);
	const chain = block === undefined ? undefined : gtfs.blockTrips.get(block);
	const from = chain?.indexOf(match.tripId) ?? -1;
	if (chain === undefined || from === -1) return [];

	const midnight = midnightOf(match.startDate);
	if (midnight === undefined) return [];

	const predicted: PredictedTrip[] = [];
	// Le retard constaté à l'instant du relevé vaut pour l'arrivée au terminus : c'est l'hypothèse même
	// du report, faute de savoir ce que la course rattrapera d'ici là.
	let delay = journey.delaySeconds ?? 0;
	let previous = match.tripId;

	for (const tripId of chain.slice(from + 1)) {
		if (predicted.length >= PROPAGATION_MAX_TRIPS) break;

		const departure = gtfs.tripDepartures.get(tripId);
		const arrival = gtfs.tripArrivals.get(tripId);
		const stops = gtfs.tripStops.get(tripId);
		const meta = gtfs.trips.get(tripId);
		if (departure === undefined || arrival === undefined || stops === undefined || meta === undefined) break;

		// Au-delà de l'horizon, le SAE aura repris la main bien avant que la prévision ne serve.
		if (midnight + departure > nowSeconds + PROPAGATION_HORIZON) break;

		delay -= layover(gtfs, previous, tripId);
		if (delay < PROPAGATED_DELAY_MIN) break;

		predicted.push({
			tripId,
			startDate: match.startDate,
			delay,
			recordedAt: journey.recordedAt,
			endsAt: midnight + arrival,
			entity: {
				trip: {
					tripId,
					routeId: meta.routeId,
					directionId: meta.directionId,
					startDate: match.startDate,
					scheduleRelationship: TripSchedule.SCHEDULED,
				},
				// Le véhicule est le cœur de la prévision : c'est parce que c'est LUI qui assurera cette
				// course, et qu'il est ailleurs, qu'elle partira en retard.
				vehicle: buildVehicleDescriptor(journey),
				stopTimeUpdate: stops.map((stop) => toPredictedUpdate(stop, midnight, delay)),
				timestamp: journey.recordedAt,
				delay,
			},
		});

		previous = tripId;
	}

	return predicted;
}

// ---

/**
 * Le battement théorique entre deux courses enchaînées, en secondes : ce que le retard de la première
 * peut absorber avant de peser sur la seconde. Nul dès que le véhicule doit se déplacer entre les
 * deux — le battement lui sert alors à rouler, non à attendre.
 */
function layover(gtfs: StaticGtfs, previousTripId: string, tripId: string): number {
	const arrival = gtfs.tripArrivals.get(previousTripId);
	const departure = gtfs.tripDepartures.get(tripId);
	if (arrival === undefined || departure === undefined) return 0;

	const terminus = gtfs.tripStops.get(previousTripId)?.at(-1)?.stopId;
	const origin = gtfs.tripStops.get(tripId)?.[0]?.stopId;
	if (terminus === undefined || origin === undefined) return 0;
	if (!sameStation(gtfs, { stopId: terminus, stopRef: "", stopName: "" }, origin)) return 0;

	return Math.max(0, departure - arrival);
}

/** Un arrêt de la course à venir, tous ses horaires décalés du retard reporté. */
function toPredictedUpdate(
	stop: TripStop,
	midnight: number,
	delay: number,
): GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate {
	const arrival = toPredictedEvent(stop.arrival, midnight, delay);
	const departure = toPredictedEvent(stop.departure, midnight, delay);

	// Un arrêt dont le GTFS n'écrit aucun horaire n'a pas d'heure à décaler : il n'y a rien à en prévoir.
	if (arrival === undefined && departure === undefined) {
		return { stopId: stop.stopId, stopSequence: stop.stopSequence, scheduleRelationship: StopSchedule.NO_DATA };
	}

	return {
		stopId: stop.stopId,
		stopSequence: stop.stopSequence,
		arrival,
		departure,
		scheduleRelationship: StopSchedule.SCHEDULED,
	};
}

function toPredictedEvent(
	secondsFromMidnight: number,
	midnight: number,
	delay: number,
): GtfsRealtime.transit_realtime.TripUpdate.IStopTimeEvent | undefined {
	if (!Number.isFinite(secondsFromMidnight)) return undefined;

	const scheduledTime = midnight + secondsFromMidnight;
	return { time: scheduledTime + delay, delay, scheduledTime, uncertainty: PROPAGATED_UNCERTAINTY };
}
