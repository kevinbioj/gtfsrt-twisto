import { LINES_DISCOVERY_TTL, REQUESTOR_REF, SIRI_ENDPOINT } from "../config.js";
import { list } from "../utils/siri-ref.js";
import { LINES_DISCOVERY } from "./payloads.js";
import { requestSiri } from "./request-siri.js";

/** Les lignes retenues au dernier relevé, et l'instant où il a été fait (cf. {@link LINES_DISCOVERY_TTL}). */
let cached: { lineRefs: string[]; fetchedAt: number } | undefined;

/**
 * Les `LineRef` — entiers, tels que le service les écrit — des lignes qu'il annonce suivre. Une ligne
 * déclarée non suivie (`Monitored` à « false ») est écartée : la demander ne rendrait aucun véhicule.
 *
 * Le résultat est gardé un temps ({@link LINES_DISCOVERY_TTL}) : le réseau ne change pas d'une
 * interrogation à l'autre, et le redemander toutes les trente secondes doublerait les requêtes pour
 * la même réponse. Une découverte qui échoue laisse la liste précédente en place plutôt que de priver
 * le relevé suivant de ses lignes.
 */
export async function fetchLinesDiscovery(): Promise<string[]> {
	if (cached !== undefined && Date.now() - cached.fetchedAt < LINES_DISCOVERY_TTL) {
		return cached.lineRefs;
	}

	let lineRefs: string[];
	try {
		lineRefs = await discover();
	} catch (error) {
		if (cached === undefined) throw error;
		console.warn("La découverte des lignes a échoué, la liste précédente est conservée.", error);
		return cached.lineRefs;
	}

	cached = { lineRefs, fetchedAt: Date.now() };
	return lineRefs;
}

// ---

async function discover(): Promise<string[]> {
	const response = await requestSiri(SIRI_ENDPOINT, LINES_DISCOVERY(REQUESTOR_REF));

	const answer = response.Envelope?.Body?.LinesDiscoveryResponse?.Answer;
	if (answer === undefined) {
		throw new Error("La réponse du service ne porte aucun LinesDiscoveryResponse.");
	}

	const lineRefs = [
		...new Set(
			list(answer.AnnotatedLineRef)
				.filter((line) => line.Monitored !== "false")
				.map((line) => line.LineRef ?? "")
				.filter((lineRef) => lineRef !== ""),
		),
	];

	if (lineRefs.length === 0) {
		throw new Error("Le service n'annonce aucune ligne suivie.");
	}

	return lineRefs;
}
