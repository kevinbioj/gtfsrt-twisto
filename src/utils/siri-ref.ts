/**
 * L'identifiant utile d'une référence SIRI : l'avant-dernier segment, le dernier n'étant que le
 * suffixe de portée (« LOC »).
 *
 *  - « SIRI_NVP_037:StopPoint:BP:HECC11:LOC » → « HECC11 » ;
 *  - « SIRI_NVP_037:Line::4:LOC » → « 4 » ;
 *  - « SIRI_NVP_037:Vehicle::Keolis_5210:LOC » → « Keolis_5210 ».
 *
 * Une chaîne qui ne suit pas cette forme est rendue telle quelle : mieux vaut relayer un identifiant
 * inattendu que rien du tout.
 */
export function siriRef(value: string | undefined): string {
	if (!value) return "";

	const parts = value.split(":");
	if (parts.length < 2) return value;

	return parts.at(-2) || value;
}

/**
 * Développe les entités que la source laisse échapper dans ses libellés. Elle les encode deux fois —
 * « Caen Presqu&amp;apos;ile » —, si bien que le parseur XML n'en défait qu'une couche et laisse
 * « Presqu&apos;ile » dans le texte.
 */
export function decodeSiriText(value: string | undefined): string {
	if (!value) return "";

	return value
		.replaceAll("&apos;", "'")
		.replaceAll("&#39;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&amp;", "&")
		.trim();
}

/** Un élément que la source a publié vide (`<OnwardCalls/>`) n'est pas un élément. */
export function present<T>(value: T | "" | undefined): T | undefined {
	return value === "" || value === undefined ? undefined : value;
}

/** Un élément répétable, que le parseur rend seul, en tableau, ou vide. */
export function list<T>(value: T | T[] | "" | undefined): T[] {
	if (value === undefined || value === "") return [];
	return Array.isArray(value) ? value : [value];
}
