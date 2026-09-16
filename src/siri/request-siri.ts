import { readFile } from "node:fs/promises";
import { XMLParser } from "fast-xml-parser";

import { FIXTURE_MODE, SIRI_API_KEY, SIRI_FIXTURE_PATH, SIRI_TIMEOUT } from "../config.js";
import type { SoapResponse } from "./types.js";

const parser = new XMLParser({
	removeNSPrefix: true,
	// Aucune valeur n'est convertie : les noms de ligne (« 4 », « T1 ») et les sens du tramway (« 1 »,
	// « 2 ») sont des libellés, et les lire comme des nombres perdrait les zéros initiaux d'un
	// identifiant d'arrêt comme de tout code du réseau.
	parseTagValue: false,
	parseAttributeValue: false,
	trimValues: true,
});

/**
 * Interroge le service SIRI et rend la réponse désérialisée. En mode enregistrement
 * ({@link SIRI_FIXTURE_PATH}), le fichier remplace la requête : rien n'est envoyé.
 */
export async function requestSiri(endpoint: string, body: string): Promise<SoapResponse> {
	const serialized = FIXTURE_MODE ? await readFile(SIRI_FIXTURE_PATH as string, "utf8") : await post(endpoint, body);
	return parser.parse(serialized) as SoapResponse;
}

async function post(endpoint: string, body: string): Promise<string> {
	if (!endpoint) {
		throw new Error(
			"SIRI_ENDPOINT n'est pas renseigné — déclarez l'endpoint du service, ou rejouez un enregistrement avec SIRI_FIXTURE_PATH.",
		);
	}

	const response = await fetch(endpoint, {
		body,
		headers: {
			"Content-Type": "application/xml",
			// Le portail qui protège le service attend la clé sous ce nom ; sans clé renseignée, rien
			// n'est envoyé plutôt qu'une en-tête vide, que la passerelle rejetterait.
			...(SIRI_API_KEY ? { "X-Gravitee-Api-Key": SIRI_API_KEY } : {}),
		},
		method: "POST",
		signal: AbortSignal.timeout(SIRI_TIMEOUT),
	});

	if (!response.ok) {
		throw new Error(`Le service SIRI a répondu HTTP ${response.status}.`);
	}

	return response.text();
}
