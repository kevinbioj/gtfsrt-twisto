import { serve } from "@hono/node-server";
import GtfsRealtime from "gtfs-realtime-bindings";
import { Hono } from "hono";
import { rateLimiter } from "hono-rate-limiter";

import {
	CANDIDATE_DAY_OFFSETS,
	FEED_PREFIX,
	FIXTURE_MODE,
	GTFS_CHECK_INTERVAL,
	POLL_INTERVAL,
	PORT,
	RECORD_STALENESS,
	SIRI_FIXTURE_PATH,
	STATIC_GTFS_URL,
} from "./config.js";
import { type BuiltEntities, buildEntities } from "./gtfs-rt/build-entities.js";
import { modificationsId } from "./gtfs-rt/build-modifications.js";
import { handleRequest } from "./gtfs-rt/handle-request.js";
import { matchTrip, type TripMatch } from "./gtfs-rt/match-trip.js";
import { type PredictedTrip, propagateDelay } from "./gtfs-rt/propagate-delay.js";
import { serviceDays } from "./gtfs-rt/service-days.js";
import { tripKeepUntil, useRealtimeStore, vehicleKeepUntil } from "./gtfs-rt/use-realtime-store.js";
import { useStaticGtfs } from "./gtfs-rt/use-static-gtfs.js";
import { fetchVehicleMonitoring, type MonitoredJourney } from "./siri/fetch-vehicle-monitoring.js";

// Charge un fichier .env s'il existe (SIRI_ENDPOINT et REQUESTOR_REF notamment).
try {
	process.loadEnvFile();
} catch {
	// pas de .env → on s'appuie sur les variables d'environnement du système
}

console.log(` ,----.,--------.,------.,---.        ,------.,--------. ,--------.           ,--.         ,--.
'  .-./'--.  .--'|  .---'   .-',-----.|  .--. '--.  .--' '--.  .--',--.  ,--. \`--' ,---. ,-'  '-. ,---.
|  | .---.|  |   |  \`--,\`.  \`-.'-----'|  '--'.'  |  |       |  |   |  |.'.|  |,--.(  .-' '-.  .-'| .-. |
'  '--'  ||  |   |  |\`  .-'    |      |  |\\  \\   |  |       |  |   |   ,'.   ||  |.-'  \`)  |  |  ' '-' '
 \`------' \`--'   \`--'   \`-----'       \`--' '--'  \`--'       \`--'   '--'   '--'\`--'\`----'   \`--'   \`---'`);

if (FIXTURE_MODE) {
	console.log(`⚠ Fixture mode: replaying ${SIRI_FIXTURE_PATH} instead of querying the SIRI service.`);
}

const store = useRealtimeStore();
const staticGtfs = await useStaticGtfs(STATIC_GTFS_URL, GTFS_CHECK_INTERVAL);

const hono = new Hono();
hono.use(
	rateLimiter({
		windowMs: 5_000,
		limit: 5,
		keyGenerator: (c) => `${c.req.header("CF-Connecting-IP")}_${c.req.method}_${c.req.path}`,
		handler: (c) => c.json({ code: 429, message: "Too many requests, please try again later." }, 429),
	}),
);

/** Ce qu'il y a à émettre à cet instant : le store écarte lui-même les relevés périmés. */
const nowSeconds = () => Math.floor(Date.now() / 1000);
const publishedTripUpdates = () => store.publishedTripUpdates(nowSeconds());
const publishedPositions = () => store.publishedVehiclePositions(nowSeconds());
const publishedModifications = () => store.publishedTripModifications(nowSeconds());

hono.get("/vehicle-positions", (c) => handleRequest(c, "protobuf", null, publishedPositions()));
hono.get("/vehicle-positions.json", (c) => handleRequest(c, "json", null, publishedPositions()));
// Les modifications accompagnent les courses : une course modifiée ne se lit pas sans elles.
hono.get("/trip-updates", (c) => handleRequest(c, "protobuf", publishedTripUpdates(), null, publishedModifications()));
hono.get("/trip-updates.json", (c) => handleRequest(c, "json", publishedTripUpdates(), null, publishedModifications()));
/**
 * L'archive GTFS statique du réseau. Le portail la sert en `no-store`, sans ETag ni `Last-Modified` :
 * un consommateur ne peut donc pas savoir qu'une nouvelle version est parue sans la retélécharger
 * entièrement. Cette route lui répond ce que le producteur sait déjà — la date de parution que le
 * portail annonce dans les métadonnées du jeu de données, à défaut l'instant de son dernier import —,
 * et renvoie le téléchargement lui-même vers le portail plutôt que de relayer treize mégaoctets.
 */
hono.on(["GET", "HEAD"], "/static-gtfs", (c) => {
	const lastModified = staticGtfs.publishedAt ?? staticGtfs.importedAt;
	c.header("Last-Modified", new Date(lastModified.epochMilliseconds).toUTCString());

	// Une réponse à HEAD porte les en-têtes de ce que le GET rendrait, sans corps ni redirection : c'est
	// la date que le client vient chercher, pas la ressource.
	if (c.req.method === "HEAD") {
		c.header("Content-Type", "application/zip");
		return c.body(null, 200);
	}

	return c.redirect(STATIC_GTFS_URL, 302);
});

hono.get("/", (c) =>
	handleRequest(
		c,
		c.req.query("format") === "json" ? "json" : "protobuf",
		publishedTripUpdates(),
		publishedPositions(),
		publishedModifications(),
	),
);

serve({ fetch: hono.fetch, port: PORT });
console.log(`➔ Listening on :${PORT}`);

// ---

/**
 * Les courses dont le dernier relevé a publié un retard DÉDUIT de leur bloc. Elles se retirent d'elles-
 * mêmes dès que le relevé suivant ne les reconduit pas : le véhicule qui les précède a rattrapé son
 * retard, et laisser vieillir la prévision annoncerait un retard que plus rien n'appuie.
 */
let predictedTripKeys = new Set<string>();

async function poll() {
	let journeys: MonitoredJourney[];

	try {
		journeys = await fetchVehicleMonitoring();
	} catch (cause) {
		// Le store n'est pas vidé : ses entités gardent leur dernier relevé et cessent d'être émises
		// d'elles-mêmes en vieillissant.
		console.error("✘ Poll error:", cause);
		return;
	}

	const gtfs = staticGtfs.data;
	const now = nowSeconds();

	// GTFS indisponible — première tentative échouée, portail en panne : aucune course ne s'y
	// retrouverait, et tout le parc passerait pour des courses supplémentaires sur des lignes inconnues.
	// Le store garde alors ce qu'il a, et se vide de lui-même en vieillissant ; le GTFS, lui, est
	// retenté toutes les cinq minutes (cf. `useStaticGtfs`).
	if (gtfs.trips.size === 0) {
		console.warn("✘ Static GTFS unavailable — skipping this poll.");
		store.sweep(now);
		return;
	}
	// Les journées de service se recalculent à chaque relevé : le producteur tourne des semaines
	// d'affilée, et celles de son démarrage ne vaudraient plus rien le lendemain.
	const days = serviceDays(gtfs, CANDIDATE_DAY_OFFSETS);

	let scheduled = 0;
	let extra = 0;
	let ambiguous = 0;
	let cancelled = 0;
	let modified = 0;
	let staleRecords = 0;
	let silentTrips = 0;
	const predictions: PredictedTrip[] = [];
	// Ce que la source a dit elle-même de chaque course : une prévision ne s'y substitue jamais.
	const observedTripKeys = new Set<string>();
	const recoveredStops = new Set<string>();
	const addedStops = new Set<string>();
	const undescribedStops = new Set<string>();
	const unknownStops = new Set<string>();

	for (const journey of journeys) {
		// Que la source cesse elle-même de réhorodater un véhicule est un aveu : elle l'a perdu.
		if (!FIXTURE_MODE && now - journey.recordedAt > RECORD_STALENESS) {
			staleRecords += 1;
			continue;
		}

		const match = matchTrip(gtfs, days, journey);
		const built = buildEntities(gtfs, journey, match);

		if (match.scheduled) scheduled += 1;
		else extra += 1;
		if (match.ambiguous) ambiguous += 1;
		if (built.cancelled) cancelled += 1;
		if (built.tripModifications !== undefined) modified += 1;
		for (const stop of built.recoveredStops) recoveredStops.add(stop);
		for (const stop of built.addedStops) addedStops.add(stop);
		for (const stop of built.undescribedStops) undescribedStops.add(stop);
		for (const stop of built.unknownStops) unknownStops.add(stop);

		// Le véhicule reste au feed une demi-heure après ce relevé : ce n'est pas parce que la source
		// cesse de le publier — fin de service, rentrée au dépôt — qu'il faut le faire disparaître dans
		// l'intervalle de deux rafraîchissements.
		store.vehiclePositions.set(`VM:${FEED_PREFIX}:${journey.vehicleId}`, {
			entity: built.vehiclePosition,
			keepUntil: vehicleKeepUntil(journey.recordedAt),
		});

		// Les courses, elles, survivent aussi à leur fin théorique : une course terminée en avance n'est
		// plus relevée alors que son horaire la fait encore rouler.
		const keepUntil = tripKeepUntil(journey.recordedAt, match.endsAt);

		// L'identifiant porte la journée de service : deux occurrences d'une même course peuvent circuler
		// ensemble — celle d'hier qui s'achève après minuit et celle d'aujourd'hui qui part à « 25:10 » —
		// et sous un identifiant nu, la seconde écraserait la première.
		const tripKey = `ET:${FEED_PREFIX}:${match.tripId}:${match.startDate}`;
		// La source parle d'elle-même de cette course : aucune prévision ne s'y substituera, quand bien
		// même elle n'aurait aucun horaire à en dire.
		observedTripKeys.add(tripKey);

		if (built.tripUpdate === undefined) {
			silentTrips += 1;
		} else {
			store.tripUpdates.set(tripKey, { entity: built.tripUpdate, keepUntil });
		}

		// La course s'écarte de son horaire théorique : les modifications qui l'en séparent, et la course
		// telle qu'elle roule vraiment, pour les consommateurs qui savent les appliquer.
		const modifiedTripKey = `EM:${FEED_PREFIX}:${match.tripId}:${match.startDate}`;
		if (built.tripModifications === undefined) {
			// La course a rejoint son itinéraire — la source n'annonce plus que des arrêts théoriques : ce
			// qui l'en écartait n'a plus cours, et le laisser vieillir dans le store ferait doublon avec la
			// course théorique jusqu'à son échéance.
			store.tripModifications.delete(modificationsId(match));
			store.tripUpdates.delete(modifiedTripKey);
		} else {
			store.tripModifications.set(modificationsId(match), {
				entity: built.tripModifications,
				keepUntil,
			});
			if (built.modifiedTripUpdate !== undefined) {
				store.tripUpdates.set(modifiedTripKey, {
					entity: built.modifiedTripUpdate,
					keepUntil,
				});
			}
		}

		// Le véhicule assurera d'autres courses après celle-ci : son retard les concerne déjà, et la
		// source n'en dira rien avant qu'il ne s'y déclare en service (cf. `propagate-delay.ts`).
		if (!built.cancelled) predictions.push(...propagateDelay(gtfs, journey, match, now));

		console.log(`\t⛛ ${describeJourney(journey, match, built)}`);
	}

	const predicted = publishPredictions(predictions, observedTripKeys);
	const forgotten = store.sweep(now);

	if (recoveredStops.size > 0) {
		console.warn(`\t⚠ ${recoveredStops.size} stops matched by sequence alone: ${[...recoveredStops].join(", ")}.`);
	}
	if (addedStops.size > 0) {
		console.warn(`\t⚠ ${addedStops.size} extra stops described as trip modifications: ${[...addedStops].join(", ")}.`);
	}
	if (undescribedStops.size > 0) {
		console.warn(`\t⚠ ${undescribedStops.size} extra stops left undescribed: ${[...undescribedStops].join(", ")}.`);
	}
	if (unknownStops.size > 0) {
		console.warn(`\t⚠ ${unknownStops.size} stops unknown to the GTFS: ${[...unknownStops].join(", ")}.`);
	}

	console.log(
		`✓ ${store.publishedVehiclePositions(now).size} positions, ${store.publishedTripUpdates(now).size} trip updates (${scheduled} scheduled, ${extra} extra, ${cancelled} cancelled, ${modified} modified, ${predicted} predicted from blocks, ${ambiguous} ambiguous, ${staleRecords} stale records, ${silentTrips} without realtime, ${forgotten} forgotten).`,
	);
}

/**
 * Publie les retards déduits des blocs, et retire ceux que ce relevé ne reconduit pas. Renvoie le
 * nombre de courses annoncées en retard sans avoir été observées.
 *
 * Une prévision ne se substitue jamais à ce que la source dit : la course que le SAE annonce lui-même —
 * son véhicule vient de s'y déclarer en service — a toujours raison, et la prévision qui la visait
 * disparaît en même temps qu'elle est remplacée.
 */
function publishPredictions(predictions: PredictedTrip[], observedTripKeys: ReadonlySet<string>): number {
	const keys = new Set<string>();

	for (const prediction of predictions) {
		const key = `ET:${FEED_PREFIX}:${prediction.tripId}:${prediction.startDate}`;
		if (observedTripKeys.has(key)) continue;

		store.tripUpdates.set(key, {
			entity: prediction.entity,
			keepUntil: tripKeepUntil(prediction.recordedAt, prediction.endsAt),
		});
		keys.add(key);
	}

	for (const key of predictedTripKeys) {
		if (keys.has(key) || observedTripKeys.has(key)) continue;
		store.tripUpdates.delete(key);
	}
	predictedTripKeys = keys;

	return keys.size;
}

/** Le véhicule tel qu'il s'écrit au journal : sa course, où il en est, et son retard. */
function describeJourney(journey: MonitoredJourney, match: TripMatch, built: BuiltEntities): string {
	const identity = `${journey.vehicleId.padEnd(12, " ")} ${(journey.lineRef || journey.lineName).padEnd(4, " ")} ${match.directionId}`;
	const trip = `${match.tripId.padEnd(34, " ")} (${match.by}${match.ambiguous ? ", ambiguous" : ""})`;

	if (built.cancelled) return `${identity}  ${trip} — course annulée`;

	return `${identity}  ${trip} — ${describeLocation(built)}${describeDelay(journey.delaySeconds)}${describeDeviation(built)}`;
}

/** Ce que la course fait de plus que son horaire théorique, lorsqu'elle s'en écarte. */
function describeDeviation(built: BuiltEntities): string {
	if (built.tripModifications === undefined) return "";

	return `, dévié par ${built.addedStops.join(", ")}`;
}

function describeLocation(built: BuiltEntities): string {
	const { currentCall, vehiclePosition } = built;
	if (currentCall === undefined) return "arrêt inconnu";

	const { VehicleStopStatus } = GtfsRealtime.transit_realtime.VehiclePosition;
	const status =
		vehiclePosition.currentStatus === VehicleStopStatus.STOPPED_AT
			? "à quai"
			: vehiclePosition.currentStatus === VehicleStopStatus.INCOMING_AT
				? "approche"
				: "vers";

	return `${status} ${currentCall.call.stopName || currentCall.stopId} #${currentCall.stopSequence}`;
}

function describeDelay(delaySeconds: number | undefined): string {
	if (delaySeconds === undefined || Math.abs(delaySeconds) < 60) return "";

	const minutes = Math.round(delaySeconds / 60);
	return minutes > 0 ? `, ${minutes} min de retard` : `, ${-minutes} min d'avance`;
}

setInterval(poll, POLL_INTERVAL);
await poll();
