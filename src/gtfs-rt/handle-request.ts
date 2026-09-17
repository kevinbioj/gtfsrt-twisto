import GtfsRealtime from "gtfs-realtime-bindings";
import type { Context } from "hono";
import { stream } from "hono/streaming";

import { createFeed } from "./create-feed.js";
import type { FeedSnapshot } from "./use-realtime-store.js";

/**
 * Répond un instantané du feed, daté de la dernière modification du store.
 *
 * La réponse porte ce `Last-Modified`, et une requête conditionnelle qui l'a déjà vu reçoit un `304` :
 * le producteur ne parle à la source qu'une fois par minute (cf. `POLL_INTERVAL`), là où ses
 * consommateurs interrogent souvent plus vite, et leur renvoyer un feed inchangé ne leur apprendrait
 * rien qu'ils n'aient déjà — au prix de l'encodage et de la bande passante.
 */
export function handleRequest(c: Context, output: "protobuf" | "json", snapshot: FeedSnapshot) {
	const lastModified = new Date(snapshot.lastModified * 1000);
	c.header("Last-Modified", lastModified.toUTCString());

	// Un `304` porte lui aussi le `Last-Modified` : c'est ce que le consommateur revalidera ensuite.
	if (notModifiedSince(c.req.header("If-Modified-Since"), snapshot.lastModified)) {
		return c.body(null, 304);
	}

	const feed = createFeed(snapshot);

	if (output === "json") {
		c.header("Content-Type", "application/json");
		return c.json(feed, 200);
	}

	c.header("Content-Type", "application/octet-stream");
	return stream(c, async (stream) => {
		const encoded = GtfsRealtime.transit_realtime.FeedMessage.encode(feed).finish();
		await stream.write(encoded);
	});
}

/**
 * Le consommateur a-t-il déjà l'état que l'on s'apprête à lui rendre ? Les dates HTTP ne portent pas
 * les fractions de seconde, et la comparaison se fait donc à la seconde — celle du store est déjà
 * arrondie de même. Un en-tête absent ou illisible se lit comme une absence de condition : la réponse
 * est alors rendue en entier, ce que RFC 9110 § 13.1.3 demande d'une date que l'on ne sait pas lire.
 */
function notModifiedSince(header: string | undefined, lastModified: number): boolean {
	if (header === undefined) return false;

	const since = Date.parse(header);
	if (Number.isNaN(since)) return false;

	return lastModified <= Math.floor(since / 1000);
}
