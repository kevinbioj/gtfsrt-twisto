import GtfsRealtime from "gtfs-realtime-bindings";

import { INCOMING_AT_DISTANCE, STOPPED_AT_DISTANCE, STOPPED_AT_PROGRESS } from "../config.js";
import type { MonitoredCall, MonitoredJourney } from "../siri/fetch-vehicle-monitoring.js";
import { buildModifications, modificationsId } from "./build-modifications.js";
import type { TripMatch } from "./match-trip.js";
import { isCallCancelled, isScheduledCall, type ResolvedCall, resolveCalls } from "./resolve-calls.js";
import { midnightOf } from "./service-days.js";
import type { StaticGtfs, TripStop } from "./use-static-gtfs.js";

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
	const location = locateVehicle(gtfs, journey, match, currentCall, described);

	// Les arrêts supplémentaires sortent de la course théorique : le rang qu'ils occupent y est celui
	// d'un autre arrêt, et les annoncer là reviendrait à déplacer celui-ci — c'est la course modifiée qui
	// en rend compte. Les quais que le GTFS ignore, eux, ne se désignent pas du tout. Ni les uns ni les
	// autres n'ont leur place dans la course théorique, qu'une modification sache ou non les décrire : le
	// format ne lui laisse dire que ce que l'horaire théorique porte déjà.
	const scheduledCalls = resolved.filter(isScheduledCall);

	return {
		vehiclePosition: {
			trip,
			vehicle,
			position: journey.position,
			// Le rang n'est publié que s'il est bien celui de la course annoncée : celui d'un arrêt
			// supplémentaire appartient à un autre arrêt de l'horaire théorique.
			currentStopSequence: location?.stopSequence,
			stopId: location?.stopId,
			currentStatus: location?.status,
			timestamp: journey.recordedAt,
		},
		tripUpdate: buildTripUpdate(journey, match, trip, vehicle, scheduledCalls, cancelled, location),
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

/** Le véhicule tel que le feed le désigne : sa référence SAE, et son numéro de parc pour libellé. */
export function buildVehicleDescriptor(journey: MonitoredJourney): GtfsRealtime.transit_realtime.IVehicleDescriptor {
	return {
		id: journey.vehicleId,
		// Le numéro de parc seul, tel qu'il se lit sur le véhicule : « Keolis_5210 » → « 5210 ».
		label: journey.vehicleId.split("_").at(-1) ?? journey.vehicleId,
	};
}

/** Où le flux situe le véhicule : le quai, son rang, et ce que le véhicule y fait. */
type VehicleLocation = {
	stopId: string;
	stopSequence: number | undefined;
	status: GtfsRealtime.transit_realtime.VehiclePosition.VehicleStopStatus;
	/**
	 * L'arrêt de l'horaire théorique où le véhicule est à quai, lorsque c'est lui qui le désigne et non
	 * la source (cf. {@link locateVehicle}). La source ne publie plus cet arrêt — il est desservi —, et
	 * c'est d'ici que la course tire de quoi l'annoncer quand même (cf. {@link stoppedAtUpdate}).
	 */
	deduced: TripStop | undefined;
};

/**
 * Où situer le véhicule. La source ne publie que son PROCHAIN arrêt : tant qu'il n'a pas quitté le
 * précédent, elle annonce déjà celui d'après, et le déclarer en route vers lui reviendrait à le faire
 * partir avant l'heure — c'est ce qui se voit le mieux à un terminus, où un véhicule qui attend son
 * départ serait annoncé roulant vers le deuxième arrêt de sa course.
 *
 * L'avancement sur le tronçon le dit (cf. {@link notYetDeparted}) : à zéro, le véhicule est à quai à
 * l'arrêt précédent, que l'horaire théorique de la course désigne. Faute de cet arrêt — une course
 * supplémentaire, ou un véhicule à son tout premier arrêt —, le prochain arrêt reste ce qu'on a de
 * mieux.
 */
function locateVehicle(
	gtfs: StaticGtfs,
	journey: MonitoredJourney,
	match: TripMatch,
	currentCall: ResolvedCall | undefined,
	described: ReadonlySet<ResolvedCall>,
): VehicleLocation | undefined {
	// Un quai que le GTFS ignore ne se publie pas : l'identifiant qu'annonce la source ne renvoie à rien
	// chez le consommateur. Mieux vaut ne pas situer le véhicule que le situer là où personne ne peut
	// aller voir — sa position, elle, reste publiée.
	if (currentCall === undefined || currentCall.resolution === "unknown") return undefined;

	// Le rang d'un arrêt supplémentaire appartient à un autre arrêt de l'horaire théorique : il ne
	// désigne pas l'arrêt qui le précède, et rien ne dit alors d'où le véhicule vient.
	const sequenced = !described.has(currentCall);

	if (sequenced && notYetDeparted(journey, currentCall.call)) {
		const previous = previousStop(match, currentCall.stopSequence);
		if (previous !== undefined && gtfs.stops.has(previous.stopId)) {
			return {
				stopId: previous.stopId,
				stopSequence: previous.stopSequence,
				status: VehicleStopStatus.STOPPED_AT,
				deduced: previous,
			};
		}
	}

	return {
		stopId: currentCall.stopId,
		stopSequence: sequenced ? currentCall.stopSequence : undefined,
		status: stopStatus(journey, currentCall.call),
		deduced: undefined,
	};
}

/**
 * Le véhicule n'a pas encore quitté l'arrêt précédent : la source n'annonce aucun avancement sur le
 * tronçon qui mène au prochain arrêt, et la distance qui l'en sépare est ce tronçon tout entier. Les
 * deux sont exigés ensemble — un avancement nul seul se lirait aussi bien comme une absence de
 * mesure —, et le prochain arrêt doit bien être le prochain (`NumberOfStopsAway` à zéro).
 */
function notYetDeparted(journey: MonitoredJourney, call: MonitoredCall): boolean {
	const { percentage, linkDistance } = journey.progress;
	if (percentage !== 0 || (call.numberOfStopsAway ?? 0) !== 0) return false;
	if (linkDistance === undefined || call.distanceFromStop === undefined) return false;

	return call.distanceFromStop >= linkDistance;
}

/** L'arrêt que l'horaire théorique de la course place juste avant ce rang. */
function previousStop(match: TripMatch, stopSequence: number): TripStop | undefined {
	let previous: TripStop | undefined;

	for (const stop of match.stops ?? []) {
		if (stop.stopSequence >= stopSequence) continue;
		if (previous === undefined || stop.stopSequence > previous.stopSequence) previous = stop;
	}

	return previous;
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
	location: VehicleLocation | undefined,
): GtfsRealtime.transit_realtime.ITripUpdate | undefined {
	// Une course annulée ne dessert rien : le format veut qu'elle n'annonce aucun arrêt, et son retard
	// n'a plus d'objet. Le descripteur porte à lui seul toute l'information.
	if (cancelled) return { trip, vehicle, timestamp: journey.recordedAt };

	// Le format attend une suite de rangs croissante, quand les arrêts sont ordonnés comme la course les
	// dessert : les deux ne coïncident pas sur une course qui s'écarte de son horaire théorique.
	const stopTimeUpdate = resolved
		.toSorted((a, b) => a.stopSequence - b.stopSequence)
		.map((call) => toStopTimeUpdate(call, true));

	// L'arrêt où le véhicule est à quai, quand c'est l'horaire théorique qui le désigne : la source ne
	// l'annonce plus, et sans lui l'arrêt que le consommateur affiche en tête — celui où il montre le
	// véhicule — serait le seul de la course sans temps réel.
	// Borne : l'heure reconstituée ne peut pas dépasser celle du prochain arrêt annoncé, sans quoi la
	// course décrirait un véhicule qui atteint son prochain arrêt avant d'avoir quitté le précédent.
	const nextTime = stopTimeUpdate.find(
		({ arrival, departure }) => arrival?.time !== undefined || departure?.time !== undefined,
	);
	const stopped = stoppedAtUpdate(
		journey,
		match,
		location,
		Number(nextTime?.arrival?.time ?? nextTime?.departure?.time) || undefined,
	);
	if (stopped !== undefined && !stopTimeUpdate.some(({ stopSequence }) => stopSequence === stopped.stopSequence)) {
		stopTimeUpdate.unshift(stopped);
	}

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
 * L'arrêt où le véhicule est à quai, annoncé depuis l'horaire théorique. La source ne publie plus cet
 * arrêt — il est desservi —, mais elle publie le retard de la course : l'horaire théorique décalé de ce
 * retard est l'heure à laquelle le véhicule y est, et c'est de cette même règle que la source tire les
 * heures qu'elle annonce aux arrêts suivants.
 *
 * `undefined` hors de ce cas, et pour une course dont on ne saurait pas dater la journée de service :
 * sans minuit de référence, un horaire en secondes depuis minuit ne se rapporte à aucun instant.
 */
function stoppedAtUpdate(
	journey: MonitoredJourney,
	match: TripMatch,
	location: VehicleLocation | undefined,
	notAfter: number | undefined,
): GtfsRealtime.transit_realtime.TripUpdate.IStopTimeUpdate | undefined {
	const stop = location?.deduced;
	if (stop === undefined) return undefined;

	const midnight = midnightOf(match.startDate);
	if (midnight === undefined) return undefined;

	// Un retard que la source ne donne pas est tenu pour nul : l'horaire théorique reste ce qu'il y a de
	// plus juste à annoncer pour un arrêt qu'elle a cessé de publier.
	const delay = journey.delaySeconds ?? 0;
	const arrival = toScheduledEvent(stop.arrival, midnight, delay, notAfter);
	const departure = toScheduledEvent(stop.departure, midnight, delay, notAfter);
	if (arrival === undefined && departure === undefined) return undefined;

	return {
		stopId: stop.stopId,
		stopSequence: stop.stopSequence,
		arrival,
		departure,
		scheduleRelationship: StopSchedule.SCHEDULED,
	};
}

/**
 * Un horaire théorique de l'horaire GTFS, décalé du retard de la course, sans dépasser l'heure du
 * prochain arrêt annoncé. Le retard publié est celui qui s'ensuit, de sorte qu'il concorde toujours
 * avec l'heure et l'horaire théorique qui l'encadrent.
 */
function toScheduledEvent(
	secondsFromMidnight: number,
	midnight: number,
	delay: number,
	notAfter: number | undefined,
): GtfsRealtime.transit_realtime.TripUpdate.IStopTimeEvent | undefined {
	if (!Number.isFinite(secondsFromMidnight)) return undefined;

	const scheduledTime = midnight + secondsFromMidnight;
	const time = notAfter === undefined ? scheduledTime + delay : Math.min(scheduledTime + delay, notAfter);

	return { time, delay: time - scheduledTime, scheduledTime };
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

	// L'heure constatée l'emporte sur l'heure prévue — c'est une prévision qui s'est réalisée —, et
	// surtout elle est parfois la SEULE que la source publie : à l'arrêt où se trouve le véhicule, et
	// singulièrement à un terminus, elle annonce l'heure à laquelle il est arrivé plutôt qu'une heure
	// d'arrivée à venir. Sans ce recours, le premier arrêt d'une course au départ n'aurait aucun temps
	// réel à publier.
	const arrival = toStopTimeEvent(call.actualArrival ?? call.expectedArrival, call.aimedArrival);
	const departure = toStopTimeEvent(call.actualDeparture ?? call.expectedDeparture, call.aimedDeparture);

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
