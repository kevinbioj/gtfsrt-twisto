import GtfsRealtime from "gtfs-realtime-bindings";

import { INCOMING_AT_DISTANCE, STOPPED_AT_DISTANCE, STOPPED_AT_PROGRESS } from "../config.js";
import type { MonitoredCall, MonitoredJourney } from "../siri/fetch-vehicle-monitoring.js";
import { buildModifications, modificationsId } from "./build-modifications.js";
import type { TripMatch } from "./match-trip.js";
import { isCallCancelled, isScheduledCall, type ResolvedCall, resolveCalls } from "./resolve-calls.js";
import type { StaticGtfs } from "./use-static-gtfs.js";

const { VehicleStopStatus } = GtfsRealtime.transit_realtime.VehiclePosition;
const TripSchedule = GtfsRealtime.transit_realtime.TripDescriptor.ScheduleRelationship;
const StopSchedule = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship;
const { DropOffPickupType } = GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.StopTimeProperties;

export type BuiltEntities = {
	vehiclePosition: GtfsRealtime.transit_realtime.IVehiclePosition;
	/** `undefined` lorsque la source n'annonce aucun horaire : il n'y aurait rien à publier. */
	tripUpdate: GtfsRealtime.transit_realtime.ITripUpdate | undefined;
	/**
	 * Ce qui sépare la course annoncée de son horaire théorique, lorsqu'elle s'en écarte : les arrêts
	 * qu'elle ajoute, ceux qu'elle abandonne (cf. `build-modifications.ts`).
	 */
	tripModifications: GtfsRealtime.transit_realtime.ITripModifications | undefined;
	/**
	 * La course modifiée, pour les consommateurs qui savent lire {@link tripModifications}. Elle double
	 * {@link tripUpdate}, que le format destine à ceux qui ne le savent pas (cf. {@link buildModifiedTripUpdate}).
	 */
	modifiedTripUpdate: GtfsRealtime.transit_realtime.ITripUpdate | undefined;
	/** Quais retrouvés par leur seul rang, tels qu'ils s'écrivent au journal (« NOKA12 → noka11 »). */
	recoveredStops: string[];
	/** Arrêts supplémentaires décrits par une modification de course, pour le journal. */
	addedStops: string[];
	/** Arrêts supplémentaires qu'aucune modification n'a su décrire, pour le journal. */
	undescribedStops: string[];
	/** Quais annoncés que rien ne rattache au GTFS, pour le journal. */
	unknownStops: string[];
	/** L'arrêt où la source situe le véhicule, déjà rapproché du GTFS. */
	currentCall: ResolvedCall | undefined;
	/** La course est annulée : la source n'en dessert plus aucun arrêt (cf. {@link isJourneyCancelled}). */
	cancelled: boolean;
};

/**
 * Traduit une course du SAE en entités GTFS-RT. Tout ce que la source publie et que le format sait
 * porter y passe : position et cap, quai courant et son rang, horaires prévus ET théoriques de chaque
 * arrêt annoncé, arrêts supprimés, arrêts supplémentaires, girouette, retard de la course, et pour une
 * course supplémentaire la destination qu'aucun GTFS ne donnerait.
 */
export function buildEntities(gtfs: StaticGtfs, journey: MonitoredJourney, match: TripMatch): BuiltEntities {
	const resolved = resolveCalls(gtfs, journey, match);
	const cancelled = isJourneyCancelled(match, resolved);

	// Une course annulée ne dessert plus rien : il n'y a pas d'écart à décrire, seulement une absence.
	const modifications = cancelled ? undefined : buildModifications(journey, match, resolved);
	const described = modifications?.described ?? new Set<ResolvedCall>();

	const trip = buildTripDescriptor(match, cancelled);
	const vehicle = buildVehicleDescriptor(journey);
	const currentCall = resolved.find(({ call }) => call.current);

	// Les arrêts supplémentaires sortent de la course théorique : le rang qu'ils occupent y est celui
	// d'un autre arrêt, et les annoncer là reviendrait à déplacer celui-ci. C'est la course modifiée qui
	// en rend compte.
	const scheduledCalls = resolved.filter((call) => !described.has(call) || isScheduledCall(call));

	return {
		vehiclePosition: {
			trip,
			vehicle,
			position: journey.position,
			// Le rang n'est publié que s'il est bien celui de la course annoncée : celui d'un arrêt
			// supplémentaire appartient à un autre arrêt de l'horaire théorique.
			currentStopSequence:
				currentCall === undefined || described.has(currentCall) ? undefined : currentCall.stopSequence,
			stopId: currentCall?.stopId,
			currentStatus: currentCall === undefined ? undefined : stopStatus(journey, currentCall.call),
			timestamp: journey.recordedAt,
		},
		tripUpdate: buildTripUpdate(journey, match, trip, vehicle, scheduledCalls, cancelled),
		tripModifications: modifications?.entity,
		modifiedTripUpdate:
			modifications?.entity === undefined
				? undefined
				: buildModifiedTripUpdate(journey, match, vehicle, resolved, described),
		recoveredStops: resolved
			.filter(({ resolution }) => resolution === "sequence")
			.map(({ call, stopId }) => `${call.stopRef} → ${stopId}`),
		addedStops: [...described].filter((call) => !isScheduledCall(call)).map(({ stopId }) => stopId),
		undescribedStops: (modifications?.undescribed ?? []).map(({ stopId }) => stopId),
		unknownStops: resolved.filter(({ resolution }) => resolution === "unknown").map(({ call }) => call.stopRef),
		currentCall,
		cancelled,
	};
}

// ---

function buildTripDescriptor(match: TripMatch, cancelled: boolean): GtfsRealtime.transit_realtime.ITripDescriptor {
	return {
		tripId: match.tripId,
		routeId: match.routeId,
		directionId: match.directionId,
		startDate: match.startDate,
		// L'heure de départ n'est déclarée que pour une course supplémentaire : elle situe une course
		// qu'aucun horaire théorique ne décrit. Sur une course du GTFS, elle ne dirait rien de plus que
		// son identifiant et sa journée de service, et un écart de quelques secondes avec l'horaire
		// publié suffirait à la faire tenir pour fautive.
		startTime: match.scheduled ? undefined : match.startTime,
		scheduleRelationship: cancelled
			? TripSchedule.CANCELED
			: match.scheduled
				? TripSchedule.SCHEDULED
				: TripSchedule.NEW,
	};
}

function buildVehicleDescriptor(journey: MonitoredJourney): GtfsRealtime.transit_realtime.IVehicleDescriptor {
	return {
		id: journey.vehicleId,
		// Le numéro de parc seul, tel qu'il se lit sur le véhicule : « Keolis_5210 » → « 5210 ».
		label: journey.vehicleId.split("_").at(-1) ?? journey.vehicleId,
	};
}

/**
 * Le statut du véhicule à son prochain arrêt. La source publie la distance qui l'en sépare et
 * l'avancement sur le tronçon : les deux se complètent, l'avancement atteignant 100 % avant que la
 * distance ne tombe sous le seuil du « à quai ». Faute des deux, la mention d'approche tranche.
 */
function stopStatus(
	journey: MonitoredJourney,
	call: MonitoredCall,
): GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus {
	const { distanceFromStop, approaching, numberOfStopsAway } = call;
	const { percentage } = journey.progress;

	const atStop =
		(distanceFromStop !== undefined && distanceFromStop <= STOPPED_AT_DISTANCE) ||
		(percentage !== undefined && percentage >= STOPPED_AT_PROGRESS && (numberOfStopsAway ?? 0) === 0);
	if (atStop) return VehicleStopStatus.STOPPED_AT;

	if ((distanceFromStop !== undefined && distanceFromStop <= INCOMING_AT_DISTANCE) || approaching) {
		return VehicleStopStatus.INCOMING_AT;
	}

	return VehicleStopStatus.IN_TRANSIT_TO;
}

/**
 * La course est-elle annulée ?
 *
 * Le VehicleMonitoring ne déclare jamais une course annulée en tant que telle : il ne publie que les
 * véhicules en ligne, et une course supprimée n'y figure simplement pas — absence qui ne prouve rien,
 * un véhicule pouvant aussi bien n'avoir pas encore pris son service. Ce que la source dit en revanche,
 * arrêt par arrêt, c'est qu'un arrêt n'est pas desservi (`ArrivalStatus`/`DepartureStatus` à
 * `cancelled`). Une course dont TOUS les arrêts annoncés sont dans ce cas ne dessert plus personne :
 * c'est une annulation, et elle se déclare comme telle.
 *
 * Encore faut-il qu'elle n'ait pas commencé — son premier arrêt annoncé doit être son origine. Une
 * course dont seule la fin est supprimée a bel et bien circulé : elle reste une course qui roule, dont
 * les derniers arrêts sautent un à un (cf. {@link toStopTimeUpdate}).
 *
 * Une course supplémentaire n'est jamais annulée : on ne déclare pas l'existence d'une course pour dire
 * dans le même souffle qu'elle ne circule pas — mieux vaut alors n'en rien dire.
 */
function isJourneyCancelled(match: TripMatch, resolved: ResolvedCall[]): boolean {
	if (!match.scheduled || match.stops === undefined || resolved.length === 0) return false;
	if (!resolved.every(({ call }) => isCallCancelled(call))) return false;

	// `resolved` est dans l'ordre de la course : son premier élément est le premier arrêt annoncé.
	const origin = match.stops[0]?.stopSequence;
	return origin !== undefined && resolved[0]?.stopSequence === origin;
}

/**
 * La course telle qu'elle sera publiée. `undefined` lorsqu'aucun arrêt n'apporte d'information — ni
 * horaire, ni suppression : mieux vaut taire la course que d'annoncer une liste vide.
 */
function buildTripUpdate(
	journey: MonitoredJourney,
	match: TripMatch,
	trip: GtfsRealtime.transit_realtime.ITripDescriptor,
	vehicle: GtfsRealtime.transit_realtime.IVehicleDescriptor,
	resolved: ResolvedCall[],
	cancelled: boolean,
): GtfsRealtime.transit_realtime.ITripUpdate | undefined {
	// Une course annulée ne dessert rien : le format veut qu'elle n'annonce aucun arrêt, et son retard
	// n'a plus d'objet. Le descripteur porte à lui seul toute l'information.
	if (cancelled) return { trip, vehicle, timestamp: journey.recordedAt };

	// Le format attend une suite de rangs croissante, quand les arrêts sont ordonnés comme la course les
	// dessert : les deux ne coïncident pas sur une course qui s'écarte de son horaire théorique.
	const stopTimeUpdate = resolved
		.toSorted((a, b) => a.stopSequence - b.stopSequence)
		.map((call) => toStopTimeUpdate(call, true));
	if (!stopTimeUpdate.some(({ scheduleRelationship }) => scheduleRelationship !== StopSchedule.NO_DATA)) {
		return undefined;
	}

	return {
		trip,
		vehicle,
		stopTimeUpdate,
		timestamp: journey.recordedAt,
		delay: journey.delaySeconds,
		// Une course supplémentaire n'a pas d'horaire théorique où lire sa destination : on la déclare
		// ici, faute de quoi le consommateur n'aurait qu'un identifiant de course inconnu. Les autres
		// propriétés (`trip_id`, `start_date`, `start_time`) ne sont pas répétées : le format les réserve
		// aux courses dédoublées, et le descripteur les porte déjà.
		tripProperties: match.scheduled || !match.headsign ? undefined : { tripHeadsign: match.headsign },
	};
}

/**
 * La même course, vue au travers des modifications qui la décrivent. Le format veut que son descripteur
 * ne porte QUE le renvoi aux modifications — ni identifiant de course, ni ligne, ni sens, ni date —,
 * de sorte qu'un consommateur qui n'en connaît pas le principe ne puisse pas la confondre avec la
 * course théorique : c'est pourquoi les deux courses cohabitent dans le flux, celle-ci pour qui sait
 * les lire, l'autre pour tous les autres.
 *
 * Ses arrêts sont désignés par leur seul quai : les rangs de l'horaire théorique ne valent plus pour
 * une course dont les arrêts ont changé, et c'est au consommateur de renuméroter ce qu'il reconstruit.
 * Les arrêts que les modifications font disparaître n'y figurent plus — ils ne font plus partie de la
 * course —, quand ceux que la source supprime sans dévier restent annoncés comme sautés.
 */
function buildModifiedTripUpdate(
	journey: MonitoredJourney,
	match: TripMatch,
	vehicle: GtfsRealtime.transit_realtime.IVehicleDescriptor,
	resolved: ResolvedCall[],
	described: ReadonlySet<ResolvedCall>,
): GtfsRealtime.transit_realtime.ITripUpdate | undefined {
	const stopTimeUpdate = resolved
		.filter((call) => (described.has(call) ? !isScheduledCall(call) : isScheduledCall(call)))
		.map((call) => toStopTimeUpdate(call, false));
	if (stopTimeUpdate.length === 0) return undefined;

	return {
		trip: {
			modifiedTrip: {
				modificationsId: modificationsId(match),
				affectedTripId: match.tripId,
				startDate: match.startDate,
			},
		},
		vehicle,
		stopTimeUpdate,
		timestamp: journey.recordedAt,
		delay: journey.delaySeconds,
	};
}

function toStopTimeUpdate(
	{ call, stopId, stopSequence }: ResolvedCall,
	withSequence: boolean,
): GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate {
	const stop = { stopId, stopSequence: withSequence ? stopSequence : undefined };

	// Arrêt supprimé, ou que le véhicule traverse sans s'arrêter : ses horaires n'ont plus cours.
	if (isCallCancelled(call) || call.boardingActivity === "passThru") {
		return { ...stop, scheduleRelationship: StopSchedule.SKIPPED };
	}

	const arrival = toStopTimeEvent(call.expectedArrival, call.aimedArrival);
	const departure = toStopTimeEvent(call.expectedDeparture, call.aimedDeparture);

	// Aucun horaire annoncé : la source dit expressément n'avoir rien à en dire (`noReport`), le plus
	// souvent du départ d'un véhicule arrivé à son terminus.
	if (arrival === undefined && departure === undefined) {
		return { ...stop, scheduleRelationship: StopSchedule.NO_DATA };
	}

	return {
		...stop,
		arrival,
		departure,
		scheduleRelationship: StopSchedule.SCHEDULED,
		stopTimeProperties: toStopTimeProperties(call),
	};
}

/**
 * L'horaire d'un arrêt : l'heure prévue, le retard qu'elle représente, et l'heure théorique qui l'a
 * produit. `undefined` sans heure prévue — il n'y a alors pas de temps réel à publier.
 */
function toStopTimeEvent(
	expected: number | undefined,
	aimed: number | undefined,
): GtfsRealtime.transit_realtime.TripUpdate.IStopTimeEvent | undefined {
	if (expected === undefined) return undefined;

	return {
		time: expected,
		delay: aimed === undefined ? undefined : expected - aimed,
		scheduledTime: aimed,
	};
}

/**
 * Ce que la source dit de l'arrêt au-delà de ses horaires : la girouette qui y est affichée — elle ne
 * la publie que pour le prochain arrêt — et l'interdiction de monter, s'il y en a une.
 */
function toStopTimeProperties(
	call: MonitoredCall,
): GtfsRealtime.transit_realtime.TripUpdate.StopTimeUpdate.IStopTimeProperties | undefined {
	const stopHeadsign = call.destinationDisplay || undefined;
	const pickupType = call.boardingActivity === "noBoarding" ? DropOffPickupType.NONE : undefined;
	if (stopHeadsign === undefined && pickupType === undefined) return undefined;

	return { stopHeadsign, pickupType };
}
