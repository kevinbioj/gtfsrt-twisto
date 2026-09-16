import { unzipSync } from "fflate";

import { STATIC_GTFS_METADATA_URL } from "../config.js";

/** Un quai du réseau : son libellé et la station qui le porte. */
export type StopMeta = { name: string; parentStation: string };

export type RouteMeta = { shortName: string; longName: string; routeType: number };

/** Ce que le GTFS dit d'une course : sa ligne, son sens, sa destination et son service. */
export type TripMeta = {
	routeId: string;
	directionId: number;
	headsign: string;
	serviceId: string;
	shapeId: string;
};

/**
 * Un arrêt dans l'horaire théorique d'une course. Les horaires sont en secondes depuis le minuit de la
 * journée de service — donc au-delà de 86 400 pour une course qui déborde sur le lendemain, comme le
 * GTFS l'écrit (« 25:10:00 »).
 */
export type TripStop = { stopSequence: number; stopId: string; arrival: number; departure: number };

/** Le calendrier hebdomadaire d'un service et l'enveloppe de dates où il vaut. */
export type ServiceCalendar = {
	/** Jours desservis, du lundi (indice 0) au dimanche (indice 6), dans l'ordre des colonnes du GTFS. */
	weekdays: boolean[];
	/** Bornes INCLUSES de validité, au format `AAAAMMJJ` du GTFS. */
	startDate: string;
	endDate: string;
};

/** Journée ajoutée par une exception de `calendar_dates.txt`. */
export const SERVICE_ADDED = 1;
/** Journée retirée par une exception de `calendar_dates.txt`. */
export const SERVICE_REMOVED = 2;

export type StaticGtfs = {
	/** stopId → libellé et station parente. Les stations elles-mêmes n'y figurent pas. */
	stops: Map<string, StopMeta>;
	/**
	 * Identifiant de quai en MAJUSCULES → identifiant réel du GTFS. Le SAE écrit ses références en
	 * capitales (« HECC11ct ») quand le GTFS les écrit en minuscules (« hecc11 ») : le rapprochement se
	 * fait donc sans considération de casse, plutôt qu'en pariant sur une casse ou l'autre.
	 */
	stopIdByRef: Map<string, string>;
	routes: Map<string, RouteMeta>;
	/** Nom commercial en MAJUSCULES → routeId. Chez Twisto les deux coïncident, mais rien ne l'impose. */
	routeIdByShortName: Map<string, string>;
	trips: Map<string, TripMeta>;
	/** tripId → horaire théorique ordonné. */
	tripStops: Map<string, TripStop[]>;
	/** tripId → départ du premier arrêt, en secondes depuis le minuit de la journée de service. */
	tripDepartures: Map<string, number>;
	/** tripId → arrivée au dernier arrêt, dans la même unité que {@link tripDepartures}. */
	tripArrivals: Map<string, number>;
	calendars: Map<string, ServiceCalendar>;
	/** serviceId → date `AAAAMMJJ` → {@link SERVICE_ADDED} ou {@link SERVICE_REMOVED}. */
	calendarExceptions: Map<string, Map<string, number>>;
	/**
	 * `routeId|stopId|départ` → courses de cette ligne partant de ce quai à cette heure (cf.
	 * {@link originKey}). C'est par là que se retrouve une course dont le SAE ne donne pas
	 * l'identifiant GTFS : son arrêt d'origine et son heure de départ théorique la désignent.
	 */
	originIndex: Map<string, string[]>;
	/**
	 * `routeId|départ` → courses de cette ligne partant à cette heure, quel que soit leur arrêt
	 * d'origine (cf. {@link departureKey}). Repli lorsque le SAE et le GTFS ne s'accordent pas sur le
	 * point de départ — mission tronquée, quai renuméroté.
	 */
	departureIndex: Map<string, string[]>;
};

export function originKey(routeId: string, stopId: string, departure: number): string {
	return `${routeId}|${stopId}|${departure}`;
}

export function departureKey(routeId: string, departure: number): string {
	return `${routeId}|${departure}`;
}

/**
 * L'identifiant GTFS du quai que désigne une référence SAE, ou `undefined` lorsque le GTFS l'ignore —
 * il arrive qu'il ait un arrêt de retard sur le terrain.
 */
export function resolveStopId(gtfs: StaticGtfs, stopRef: string): string | undefined {
	if (!stopRef) return undefined;
	if (gtfs.stops.has(stopRef)) return stopRef;
	return gtfs.stopIdByRef.get(stopRef.toUpperCase());
}

/** L'identifiant GTFS de la ligne que nomme le SAE, ou `undefined` pour une ligne qu'il ne connaît pas. */
export function resolveRouteId(gtfs: StaticGtfs, lineName: string): string | undefined {
	if (!lineName) return undefined;
	if (gtfs.routes.has(lineName)) return lineName;
	return gtfs.routeIdByShortName.get(lineName.toUpperCase());
}

/**
 * Deux quais sont-ils le même point d'arrêt ? Le SAE et le GTFS ne numérotent pas toujours les quais
 * d'un même arrêt de la même façon — « NOKA12 » pour « noka11 » —, et c'est leur station parente qui
 * les réunit. Le quai annoncé étant parfois inconnu du GTFS, son libellé sert alors de recours : les
 * deux noms sont rapprochés sans considération de casse ni d'accents, et l'un peut préciser l'autre
 * (« Buron » pour « Buron (anc. Arromanches) »).
 */
export function sameStation(
	gtfs: StaticGtfs,
	announced: { stopId: string | undefined; stopName: string },
	stopId: string,
): boolean {
	const other = gtfs.stops.get(stopId);
	if (other === undefined) return false;

	if (announced.stopId !== undefined) {
		if (announced.stopId === stopId) return true;

		const meta = gtfs.stops.get(announced.stopId);
		return meta !== undefined && meta.parentStation !== "" && meta.parentStation === other.parentStation;
	}

	const name = normalizeName(announced.stopName);
	const reference = normalizeName(other.name);
	if (name === "" || reference === "") return false;

	return name.startsWith(reference) || reference.startsWith(name);
}

/** Un libellé d'arrêt réduit à ses lettres et ses chiffres, pour être comparé d'une source à l'autre. */
function normalizeName(name: string): string {
	return name
		.normalize("NFD")
		.replace(/\p{Diacritic}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");
}

/**
 * Le rang d'un quai dans l'horaire théorique d'une course. Un quai desservi deux fois — une course en
 * boucle — est départagé par le rang qu'annonce le SAE ; à défaut, le premier passage l'emporte.
 * `undefined` pour un quai que la course ne dessert pas.
 */
export function stopSequenceOf(stops: TripStop[], stopId: string, announcedOrder: number): number | undefined {
	let first: number | undefined;

	for (const stop of stops) {
		if (stop.stopId !== stopId) continue;
		if (stop.stopSequence === announcedOrder) return stop.stopSequence;
		first ??= stop.stopSequence;
	}

	return first;
}

let currentInterval: NodeJS.Timeout | undefined;

export async function useStaticGtfs(url: string, checkInterval: number) {
	const loaded = await loadGtfs(url);
	const resource = {
		data: loaded.data,
		importedAt: Temporal.Now.instant(),
		/**
		 * Date de parution de la version chargée, telle que le portail l'annonce, ou `undefined` lorsqu'il
		 * n'en annonce pas — sa signature n'est alors qu'une taille ou un ETag, qui ne se lit pas comme
		 * une date.
		 */
		publishedAt: loaded.publishedAt,
	};
	// Version chargée, telle que la publie le portail : sert à détecter une nouvelle parution sans
	// retélécharger l'archive à chaque vérification.
	let signature = loaded.signature;

	if (currentInterval !== undefined) {
		clearInterval(currentInterval);
	}

	currentInterval = setInterval(async () => {
		const remote = await fetchSignature(url);
		// Inchangé, ou signature indisponible → on garde.
		if (remote === null || remote.signature === signature) return;

		const next = await loadGtfs(url);
		if (next.data.trips.size === 0) return; // chargement échoué → on garde l'ancien
		resource.data = next.data;
		resource.importedAt = Temporal.Now.instant();
		resource.publishedAt = next.publishedAt;
		signature = next.signature;
		console.log("✓ Static GTFS updated (new version published).");
	}, checkInterval);

	return resource;
}

/** Le GTFS statique tenu à jour par {@link useStaticGtfs}. */
export type StaticGtfsResource = Awaited<ReturnType<typeof useStaticGtfs>>;

// ---

/**
 * Version publiée du GTFS. Le portail sert l'archive en `no-store`, sans ETag ni `Last-Modified` : la
 * date de publication se lit sur les métadonnées du jeu de données, et la taille de l'archive sert de
 * repli. `null` quand aucune des deux n'est disponible — on garde alors ce qui est chargé.
 */
async function fetchSignature(url: string): Promise<Signature | null> {
	try {
		const response = await fetch(STATIC_GTFS_METADATA_URL, { signal: AbortSignal.timeout(10_000) });
		if (response.ok) {
			const metadata = (await response.json()) as {
				metas?: { default?: { modified?: string; data_processed?: string } };
			};
			const published = metadata.metas?.default?.modified ?? metadata.metas?.default?.data_processed;
			if (published) return { signature: published, publishedAt: toInstant(published) };
		}
	} catch {
		// Métadonnées indisponibles : on se rabat sur ce que dit l'archive elle-même.
	}

	try {
		const response = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(10_000) });
		if (!response.ok) return null;

		const lastModified = response.headers.get("last-modified");
		const signature = response.headers.get("etag") ?? lastModified ?? response.headers.get("content-length");
		if (signature === null) return null;

		return { signature, publishedAt: lastModified === null ? undefined : toInstant(lastModified) };
	} catch {
		return null;
	}
}

/**
 * Une date de parution, quelle que soit la façon dont le portail l'écrit : un instant ISO, une date
 * seule (« 2026-09-10 », rapportée à son minuit UTC), ou une date HTTP. `undefined` pour tout ce qui
 * ne se lit pas comme une date — un ETag ou une taille d'archive.
 */
function toInstant(value: string): Temporal.Instant | undefined {
	try {
		return Temporal.Instant.from(value);
	} catch {
		// Pas un instant : on tente les deux autres écritures.
	}

	try {
		return Temporal.PlainDate.from(value).toZonedDateTime("UTC").toInstant();
	} catch {
		// Pas une date ISO non plus.
	}

	const milliseconds = Date.parse(value);
	return Number.isNaN(milliseconds) ? undefined : Temporal.Instant.fromEpochMilliseconds(milliseconds);
}

function emptyGtfs(): StaticGtfs {
	return {
		stops: new Map(),
		stopIdByRef: new Map(),
		routes: new Map(),
		routeIdByShortName: new Map(),
		trips: new Map(),
		tripStops: new Map(),
		tripDepartures: new Map(),
		tripArrivals: new Map(),
		calendars: new Map(),
		calendarExceptions: new Map(),
		originIndex: new Map(),
		departureIndex: new Map(),
	};
}

/** Version publiée de l'archive, et sa date de parution lorsque celle-ci se lit. */
type Signature = { signature: string; publishedAt: Temporal.Instant | undefined };

async function loadGtfs(
	url: string,
): Promise<{ data: StaticGtfs; signature: string | null; publishedAt: Temporal.Instant | undefined }> {
	console.log("➔ Fetching static GTFS.");

	try {
		const response = await fetch(url);
		if (!response.ok) {
			console.error(`✘ Failed to fetch static GTFS (HTTP ${response.status}).`);
			return { data: emptyGtfs(), signature: null, publishedAt: undefined };
		}

		const buffer = new Uint8Array(await response.arrayBuffer());
		// `shapes.txt` n'est pas lu : la source situe elle-même ses véhicules sur leur course — quai,
		// rang et distance restante —, et ce fichier pèse à lui seul treize mégaoctets.
		const files = unzipSync(buffer, {
			filter: (file) =>
				file.name === "stops.txt" ||
				file.name === "routes.txt" ||
				file.name === "trips.txt" ||
				file.name === "stop_times.txt" ||
				file.name === "calendar.txt" ||
				file.name === "calendar_dates.txt",
		});

		if (!files["stops.txt"] || !files["trips.txt"] || !files["stop_times.txt"]) {
			console.error("✘ Static GTFS is missing stops.txt, trips.txt or stop_times.txt.");
			return { data: emptyGtfs(), signature: null, publishedAt: undefined };
		}

		const decoder = new TextDecoder();
		const data = emptyGtfs();

		buildStops(decoder.decode(files["stops.txt"]), data);
		if (files["routes.txt"]) buildRoutes(decoder.decode(files["routes.txt"]), data);
		buildTrips(decoder.decode(files["trips.txt"]), data);
		if (files["calendar.txt"]) buildCalendar(decoder.decode(files["calendar.txt"]), data);
		if (files["calendar_dates.txt"]) buildCalendarDates(decoder.decode(files["calendar_dates.txt"]), data);
		buildStopTimes(decoder.decode(files["stop_times.txt"]), data);

		console.log(
			`✓ Loaded ${data.stops.size} stops, ${data.routes.size} routes, ${data.trips.size} trips, ${data.calendars.size} calendars from GTFS.`,
		);

		const signature = await fetchSignature(url);
		return { data, signature: signature?.signature ?? null, publishedAt: signature?.publishedAt };
	} catch (cause) {
		console.error("✘ Failed to load static GTFS!", cause);
		return { data: emptyGtfs(), signature: null, publishedAt: undefined };
	}
}

/**
 * Les quais du réseau. Les stations (`location_type` 1) sont écartées : le SAE ne désigne jamais qu'un
 * quai, et indexer les deux ferait se recouvrir des identifiants qui ne diffèrent que par leur casse
 * (« noka11 » le quai, « COM_noka12 » sa station).
 */
function buildStops(csv: string, gtfs: StaticGtfs) {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return;

	const idCol = header.indexOf("stop_id");
	const nameCol = header.indexOf("stop_name");
	const typeCol = header.indexOf("location_type");
	const parentCol = header.indexOf("parent_station");
	if (idCol === -1 || nameCol === -1) return;

	for (const row of rows) {
		const stopId = row[idCol];
		if (!stopId) continue;
		if (typeCol !== -1 && (row[typeCol] ?? "") !== "" && row[typeCol] !== "0") continue;

		gtfs.stops.set(stopId, {
			name: row[nameCol] ?? "",
			parentStation: parentCol === -1 ? "" : (row[parentCol] ?? ""),
		});
		gtfs.stopIdByRef.set(stopId.toUpperCase(), stopId);
	}
}

function buildRoutes(csv: string, gtfs: StaticGtfs) {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return;

	const idCol = header.indexOf("route_id");
	const shortCol = header.indexOf("route_short_name");
	const longCol = header.indexOf("route_long_name");
	const typeCol = header.indexOf("route_type");
	if (idCol === -1) return;

	for (const row of rows) {
		const routeId = row[idCol];
		if (!routeId) continue;

		const shortName = shortCol === -1 ? "" : (row[shortCol] ?? "");
		gtfs.routes.set(routeId, {
			shortName,
			longName: longCol === -1 ? "" : (row[longCol] ?? ""),
			routeType: typeCol === -1 ? 3 : Number.parseInt(row[typeCol] ?? "", 10) || 0,
		});
		if (shortName) gtfs.routeIdByShortName.set(shortName.toUpperCase(), routeId);
	}
}

function buildTrips(csv: string, gtfs: StaticGtfs) {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return;

	const tripCol = header.indexOf("trip_id");
	const routeCol = header.indexOf("route_id");
	const serviceCol = header.indexOf("service_id");
	const headsignCol = header.indexOf("trip_headsign");
	const directionCol = header.indexOf("direction_id");
	const shapeCol = header.indexOf("shape_id");
	if (tripCol === -1 || routeCol === -1) return;

	for (const row of rows) {
		const tripId = row[tripCol];
		const routeId = row[routeCol];
		if (!tripId || !routeId) continue;

		gtfs.trips.set(tripId, {
			routeId,
			directionId: directionCol === -1 ? 0 : Number.parseInt(row[directionCol] ?? "", 10) || 0,
			headsign: headsignCol === -1 ? "" : (row[headsignCol] ?? ""),
			serviceId: serviceCol === -1 ? "" : (row[serviceCol] ?? ""),
			shapeId: shapeCol === -1 ? "" : (row[shapeCol] ?? ""),
		});
	}
}

/** Colonnes des jours de `calendar.txt`, du lundi au dimanche — l'ordre de {@link ServiceCalendar}. */
const DAY_COLUMNS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/**
 * Calendriers hebdomadaires. Un fichier qui ne déclare pas toutes ses colonnes de jours est ignoré en
 * bloc : un service dont on ne saurait pas quels jours il circule ferait rouler des courses n'importe
 * quand, ce qui vaut moins que pas de service du tout.
 */
function buildCalendar(csv: string, gtfs: StaticGtfs) {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return;

	const idCol = header.indexOf("service_id");
	const startCol = header.indexOf("start_date");
	const endCol = header.indexOf("end_date");
	const dayCols = DAY_COLUMNS.map((day) => header.indexOf(day));
	if (idCol === -1 || dayCols.some((col) => col === -1)) return;

	for (const row of rows) {
		const serviceId = row[idCol];
		if (!serviceId) continue;

		gtfs.calendars.set(serviceId, {
			weekdays: dayCols.map((col) => row[col] === "1"),
			startDate: startCol === -1 ? "" : (row[startCol] ?? ""),
			endDate: endCol === -1 ? "" : (row[endCol] ?? ""),
		});
	}
}

function buildCalendarDates(csv: string, gtfs: StaticGtfs) {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return;

	const idCol = header.indexOf("service_id");
	const dateCol = header.indexOf("date");
	const typeCol = header.indexOf("exception_type");
	if (idCol === -1 || dateCol === -1 || typeCol === -1) return;

	for (const row of rows) {
		const serviceId = row[idCol];
		const date = row[dateCol];
		const exceptionType = Number.parseInt(row[typeCol] ?? "", 10);
		if (!serviceId || !date || Number.isNaN(exceptionType)) continue;

		let dates = gtfs.calendarExceptions.get(serviceId);
		if (dates === undefined) {
			dates = new Map();
			gtfs.calendarExceptions.set(serviceId, dates);
		}
		dates.set(date, exceptionType);
	}
}

/**
 * Les horaires théoriques, et les deux index qui retrouvent une course d'après son départ. Le fichier
 * n'est pas tenu d'être ordonné : les arrêts sont triés par rang une fois la course complète, et les
 * bornes de la course se lisent alors sur son premier et son dernier arrêt.
 */
function buildStopTimes(csv: string, gtfs: StaticGtfs) {
	const rows = parseCsv(csv);
	const header = rows.next().value;
	if (!header) return;

	const tripCol = header.indexOf("trip_id");
	const stopCol = header.indexOf("stop_id");
	const seqCol = header.indexOf("stop_sequence");
	const arrivalCol = header.indexOf("arrival_time");
	const departureCol = header.indexOf("departure_time");
	if (tripCol === -1 || stopCol === -1 || seqCol === -1) return;

	for (const row of rows) {
		const tripId = row[tripCol];
		const stopId = row[stopCol];
		if (!tripId || !stopId || !gtfs.trips.has(tripId)) continue;

		const stopSequence = Number.parseInt(row[seqCol] ?? "", 10);
		if (Number.isNaN(stopSequence)) continue;

		const arrival = arrivalCol === -1 ? Number.NaN : parseServiceTime(row[arrivalCol] ?? "");
		const departure = departureCol === -1 ? Number.NaN : parseServiceTime(row[departureCol] ?? "");

		let stops = gtfs.tripStops.get(tripId);
		if (stops === undefined) {
			stops = [];
			gtfs.tripStops.set(tripId, stops);
		}
		stops.push({
			stopSequence,
			stopId,
			// Un arrêt sans horaire déclaré prend celui de l'autre événement : le GTFS autorise à n'en
			// écrire qu'un, et une course dont le premier arrêt n'aurait pas d'heure serait introuvable.
			arrival: Number.isFinite(arrival) ? arrival : departure,
			departure: Number.isFinite(departure) ? departure : arrival,
		});
	}

	for (const [tripId, stops] of gtfs.tripStops) {
		stops.sort((a, b) => a.stopSequence - b.stopSequence);

		const first = stops[0];
		const last = stops.at(-1);
		const meta = gtfs.trips.get(tripId);
		if (first === undefined || last === undefined || meta === undefined) continue;

		if (Number.isFinite(first.departure)) {
			gtfs.tripDepartures.set(tripId, first.departure);
			push(gtfs.originIndex, originKey(meta.routeId, first.stopId, first.departure), tripId);
			push(gtfs.departureIndex, departureKey(meta.routeId, first.departure), tripId);
		}
		if (Number.isFinite(last.arrival)) gtfs.tripArrivals.set(tripId, last.arrival);
	}
}

function push(index: Map<string, string[]>, key: string, tripId: string) {
	const trips = index.get(key);
	if (trips === undefined) index.set(key, [tripId]);
	else trips.push(tripId);
}

/**
 * Un horaire GTFS (« 07:04:00 ») en secondes depuis minuit, ou `NaN` s'il ne s'écrit pas ainsi. Les
 * heures au-delà de 24 sont légitimes et se conservent telles quelles : « 25:10:00 » est une course de
 * la veille qui déborde sur le lendemain, et le réseau en compte plus d'une centaine.
 */
function parseServiceTime(value: string): number {
	const parts = value.split(":");
	if (parts.length < 2) return Number.NaN;

	const hours = Number.parseInt(parts[0] ?? "", 10);
	const minutes = Number.parseInt(parts[1] ?? "", 10);
	const seconds = parts.length > 2 ? Number.parseInt(parts[2] ?? "", 10) : 0;
	if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds)) return Number.NaN;

	return hours * 3600 + minutes * 60 + seconds;
}

/** Un horaire en secondes depuis minuit tel que le GTFS l'écrit (« 25:10:00 »). */
export function formatServiceTime(secondsFromMidnight: number): string {
	const total = Math.max(0, Math.round(secondsFromMidnight));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const seconds = total % 60;

	return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

function pad(value: number): string {
	return value.toString().padStart(2, "0");
}

/** Parseur CSV minimal gérant les champs entre guillemets. */
function* parseCsv(csv: string): Generator<string[]> {
	for (const line of csv.split("\n")) {
		const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
		if (trimmed.length === 0) continue;
		yield parseCsvLine(trimmed);
	}
}

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (inQuotes) {
			if (char === '"') {
				if (line[i + 1] === '"') {
					current += '"';
					i += 1;
				} else {
					inQuotes = false;
				}
			} else {
				current += char;
			}
		} else if (char === '"') {
			inQuotes = true;
		} else if (char === ",") {
			out.push(current);
			current = "";
		} else {
			current += char;
		}
	}

	out.push(current);
	return out;
}
