import { FIXTURE_MODE, REQUESTOR_REF, SIRI_ENDPOINT } from "../config.js";
import { decodeSiriText, list, present, siriRef } from "../utils/siri-ref.js";
import { fetchLinesDiscovery } from "./fetch-lines-discovery.js";
import { GET_VEHICLE_MONITORING } from "./payloads.js";
import { requestSiri } from "./request-siri.js";
import type { RawCall, RawMonitoredVehicleJourney, RawVehicleActivity } from "./types.js";

/**
 * Un arrêt annoncé par la source pour la course en train de rouler. Elle n'en publie que le prochain
 * (`MonitoredCall`) et ceux qui le suivent (`OnwardCalls`) : les arrêts déjà desservis ne sont plus
 * là, et il n'y a donc rien à annoncer pour eux.
 */
export type MonitoredCall = {
	/** Référence de l'arrêt selon la source (« HECC11 »), avant rapprochement avec le GTFS. */
	stopRef: string;
	/**
	 * Rang de l'arrêt dans la course RÉELLE, tel que la source le numérote — le `stop_sequence` du GTFS
	 * tant que les deux courses coïncident, décalé dès qu'elle dessert un arrêt de plus.
	 */
	order: number;
	stopName: string;
	/** Girouette annoncée à cet arrêt. La source ne la publie que pour le prochain arrêt. */
	destinationDisplay: string;
	/** Horaires en secondes epoch ; `undefined` quand la source n'en annonce pas. */
	aimedArrival: number | undefined;
	expectedArrival: number | undefined;
	aimedDeparture: number | undefined;
	expectedDeparture: number | undefined;
	/**
	 * Horaires CONSTATÉS : l'heure à laquelle le véhicule est effectivement arrivé, et celle à laquelle
	 * il est reparti. La source ne les publie que pour l'arrêt où il se trouve — à un terminus, elle y
	 * remplace l'heure prévue, l'événement ayant eu lieu (cf. {@link EARLIEST_PLAUSIBLE_TIME} pour la
	 * sentinelle qu'elle emploie quand il n'a pas encore eu lieu).
	 */
	actualArrival: number | undefined;
	actualDeparture: number | undefined;
	/** `onTime`, `delayed`, `cancelled`, `noReport`… tel que la source l'écrit. */
	arrivalStatus: string;
	departureStatus: string;
	/** `boarding`, `noBoarding`, `passThru`… tel que la source l'écrit. */
	boardingActivity: string;
	/** Distance restante jusqu'à l'arrêt, en mètres. */
	distanceFromStop: number | undefined;
	numberOfStopsAway: number | undefined;
	/** La source annonce le véhicule en approche de cet arrêt (`ArrivalProximityText`). */
	approaching: boolean;
	/** Vrai pour l'arrêt où la source situe le véhicule (`MonitoredCall`). */
	current: boolean;
};

/** Une course en cours, telle que la source la publie, réduite à ce qui est exploitable. */
export type MonitoredJourney = {
	/** Numéro de parc du véhicule, tel que la source l'écrit (« Keolis_5210 »). */
	vehicleId: string;
	/**
	 * Identifiant de la ligne selon la source (« 5 », « T1 », « NVCV »), tiré de son `LineRef` : c'est
	 * lui qui porte le `route_id` du GTFS, et c'est donc par lui que la ligne se rapproche.
	 */
	lineRef: string;
	/**
	 * Nom commercial de la ligne, tel que la source l'affiche (« Ligne 5 », « Nav », « NUI »). Un
	 * libellé de girouette, à ne pas confondre avec {@link lineRef} : la source l'écrit à sa façon, et
	 * il ne se retrouve pas dans le GTFS (« Nav » pour la ligne « NVCV »).
	 */
	lineName: string;
	directionId: number;
	/** Sens tel que la source l'écrit (« ALLER », « RETOUR », « 1 », « 2 »), pour le journal. */
	directionName: string;
	/** Nom de la course au sens de la source (« 7308684-26HIV03-T1T2T3-Semaine-00 »). */
	journeyName: string;
	/** Référence datée de la course, propre au SAE (« SIRI_NVP_037-VehicleJourney--14729535-LOC »). */
	datedJourneyRef: string;
	/** Nom de la mission (« SC01-JV01 », « HECC11->JEVI02 »). */
	journeyPatternName: string;
	/** `bus` ou `tram`. */
	vehicleMode: string;
	originStopRef: string;
	originName: string;
	destinationStopRef: string;
	destinationName: string;
	/** Départ théorique de la course, en secondes epoch : la clé qui la retrouve dans le GTFS. */
	originAimedDeparture: number | undefined;
	destinationAimedArrival: number | undefined;
	/** Instant du relevé, en secondes epoch. */
	recordedAt: number;
	/** Fin de validité annoncée du relevé, en secondes epoch. */
	validUntil: number | undefined;
	position: { latitude: number; longitude: number; bearing: number };
	/** Retard de la course, en secondes ; négatif pour une avance. */
	delaySeconds: number | undefined;
	/** La source déclare suivre réellement ce véhicule. */
	monitored: boolean;
	/** Avancement sur le tronçon menant au prochain arrêt : sa longueur et la part parcourue. */
	progress: { linkDistance: number | undefined; percentage: number | undefined };
	/** Le prochain arrêt en tête, puis les suivants. */
	calls: MonitoredCall[];
};

/**
 * Relève l'ensemble des véhicules en ligne. Le service exigeant de déclarer les lignes demandées,
 * elles sont d'abord découvertes (`LinesDiscovery`) puis portées toutes ensemble dans l'unique
 * requête du relevé. Un enregistrement rejoué, lui, porte déjà sa réponse : rien n'est découvert.
 *
 * Une course sans véhicule identifié ou sans position n'est pas retenue : il n'y aurait rien à en
 * publier.
 *
 * La source raisonne par véhicule et n'en publie qu'une course ; par prudence, un véhicule qui
 * reparaîtrait ne garde que son relevé le plus frais.
 */
export async function fetchVehicleMonitoring(): Promise<MonitoredJourney[]> {
	const lineRefs = FIXTURE_MODE ? [] : await fetchLinesDiscovery();
	const response = await requestSiri(SIRI_ENDPOINT, GET_VEHICLE_MONITORING(REQUESTOR_REF, lineRefs));

	const delivery = response.Envelope?.Body?.GetVehicleMonitoringResponse?.Answer?.VehicleMonitoringDelivery;
	if (delivery === undefined) {
		throw new Error("La réponse du service ne porte aucun VehicleMonitoringDelivery.");
	}

	const journeys = new Map<string, MonitoredJourney>();

	for (const activity of list(delivery.VehicleActivity)) {
		const journey = toJourney(activity);
		if (journey === undefined) continue;

		const previous = journeys.get(journey.vehicleId);
		if (previous === undefined || journey.recordedAt >= previous.recordedAt) {
			journeys.set(journey.vehicleId, journey);
		}
	}

	return [...journeys.values()];
}

// ---

function toJourney(activity: RawVehicleActivity): MonitoredJourney | undefined {
	const monitoredJourney = activity.MonitoredVehicleJourney;
	if (monitoredJourney === undefined) return undefined;

	// La source porte le véhicule sur l'activité (`VehicleMonitoringRef`) ; la course le redit parfois
	// (`VehicleRef`), et l'un ou l'autre suffit.
	const vehicleId = siriRef(activity.VehicleMonitoringRef ?? monitoredJourney.VehicleRef);
	const recordedAt = toEpochSeconds(activity.RecordedAtTime);
	const position = toPosition(monitoredJourney);
	if (!vehicleId || recordedAt === undefined || position === undefined) return undefined;

	const progress = present(activity.ProgressBetweenStops);
	const framed = present(monitoredJourney.FramedVehicleJourneyRef);
	const directionName = decodeSiriText(monitoredJourney.DirectionName);

	return {
		vehicleId,
		lineRef: siriRef(monitoredJourney.LineRef),
		lineName: decodeSiriText(monitoredJourney.PublishedLineName) || siriRef(monitoredJourney.LineRef),
		directionId: toDirectionId(directionName),
		directionName,
		journeyName: decodeSiriText(monitoredJourney.VehicleJourneyName),
		datedJourneyRef: framed?.DatedVehicleJourneyRef ?? "",
		journeyPatternName: decodeSiriText(monitoredJourney.JourneyPatternName),
		vehicleMode: monitoredJourney.VehicleMode ?? "",
		originStopRef: siriRef(monitoredJourney.OriginRef),
		originName: decodeSiriText(monitoredJourney.OriginName),
		destinationStopRef: siriRef(monitoredJourney.DestinationRef),
		destinationName: decodeSiriText(monitoredJourney.DestinationName),
		originAimedDeparture: toEpochSeconds(monitoredJourney.OriginAimedDepartureTime),
		destinationAimedArrival: toEpochSeconds(monitoredJourney.DestinationAimedArrivalTime),
		recordedAt,
		validUntil: toEpochSeconds(activity.ValidUntilTime),
		position,
		delaySeconds: toDelaySeconds(monitoredJourney.Delay),
		monitored: monitoredJourney.Monitored === "true",
		progress: {
			linkDistance: toNumber(progress?.LinkDistance),
			percentage: toNumber(progress?.Percentage),
		},
		calls: toCalls(monitoredJourney),
	};
}

/**
 * Les arrêts annoncés pour la course : le prochain d'abord — le seul que la source dise suivre —,
 * puis ceux qui le suivent. Ils ne sont pas triés ici : la source liste ses arrêts supprimés APRÈS
 * les autres, et le tri se fait une fois les quais rapprochés du GTFS (cf. `resolveCalls`).
 */
function toCalls(monitoredJourney: RawMonitoredVehicleJourney): MonitoredCall[] {
	const calls: MonitoredCall[] = [];

	const monitoredCall = toCall(present(monitoredJourney.MonitoredCall), true);
	if (monitoredCall !== undefined) calls.push(monitoredCall);

	for (const onwardCall of list(present(monitoredJourney.OnwardCalls)?.OnwardCall)) {
		const call = toCall(onwardCall, false);
		// Le prochain arrêt est parfois redit parmi les suivants : celui que la source dit suivre,
		// mieux renseigné, l'emporte.
		if (call !== undefined && !calls.some(({ stopRef, order }) => stopRef === call.stopRef && order === call.order)) {
			calls.push(call);
		}
	}

	return calls;
}

function toCall(raw: RawCall | undefined, current: boolean): MonitoredCall | undefined {
	if (raw === undefined) return undefined;

	const stopRef = siriRef(raw.StopPointRef);
	const order = toNumber(raw.Order);
	if (!stopRef || order === undefined) return undefined;

	return {
		stopRef,
		order,
		stopName: decodeSiriText(raw.StopPointName),
		destinationDisplay: decodeSiriText(raw.DestinationDisplay),
		aimedArrival: toEpochSeconds(raw.AimedArrivalTime),
		expectedArrival: toEpochSeconds(raw.ExpectedArrivalTime),
		aimedDeparture: toEpochSeconds(raw.AimedDepartureTime),
		expectedDeparture: toEpochSeconds(raw.ExpectedDepartureTime),
		actualArrival: toEpochSeconds(raw.ActualArrivalTime),
		actualDeparture: toEpochSeconds(raw.ActualDepartureTime),
		arrivalStatus: raw.ArrivalStatus ?? "",
		departureStatus: raw.DepartureStatus ?? "",
		boardingActivity: raw.DepartureBoardingActivity ?? "",
		distanceFromStop: toNumber(raw.DistanceFromStop),
		numberOfStopsAway: toNumber(raw.NumberOfStopsAway),
		approaching: (raw.ArrivalProximityText ?? "") !== "",
		current,
	};
}

function toPosition(
	monitoredJourney: RawMonitoredVehicleJourney,
): { latitude: number; longitude: number; bearing: number } | undefined {
	const location = present(monitoredJourney.VehicleLocation);
	const latitude = toNumber(location?.Latitude);
	const longitude = toNumber(location?.Longitude);
	if (latitude === undefined || longitude === undefined) return undefined;

	return { latitude, longitude, bearing: toNumber(monitoredJourney.Bearing) ?? 0 };
}

/** Le SAE nomme ses sens « ALLER »/« RETOUR » pour le bus et « 1 »/« 2 » pour le tramway. */
function toDirectionId(directionName: string): number {
	const normalized = directionName.toUpperCase();
	return normalized === "RETOUR" || normalized === "2" ? 1 : 0;
}

/** Un retard ISO 8601 (« PT295S », « -PT32S ») en secondes. */
function toDelaySeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;

	try {
		return Temporal.Duration.from(value).total("seconds");
	} catch {
		return undefined;
	}
}

/**
 * Instant où le premier horaire réel a pu tomber. En deçà, c'est la sentinelle que la source emploie
 * pour « aucun horaire » (« 0001-01-01T00:00:00+00:09:21 », vue sur l'`ActualDepartureTime` d'un
 * véhicule à son terminus) : la lire comme une date la placerait deux mille ans en arrière.
 */
const EARLIEST_PLAUSIBLE_TIME = Date.UTC(2000, 0, 1);

function toEpochSeconds(value: string | undefined): number | undefined {
	if (!value) return undefined;

	try {
		const milliseconds = Temporal.Instant.from(value).epochMilliseconds;
		if (milliseconds < EARLIEST_PLAUSIBLE_TIME) return undefined;
		return Math.floor(milliseconds / 1000);
	} catch {
		return undefined;
	}
}

function toNumber(value: string | undefined): number | undefined {
	if (value === undefined || value === "") return undefined;

	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}
