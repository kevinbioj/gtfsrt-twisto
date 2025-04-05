export const OPERATOR_ID = 0;
export const TYPE_ID = 1;
export const SUBTYPE_ID = 2;
export const VALUE_ID = 3;
export const LOC_ID = 4;

export function parseRef(ref: string) {
	const components = ref.split(":");
	if (components.length !== 5) throw new Error(`Invalid SIRI ref: "${ref}"`);
	return components as [string, string, string, string, "LOC"];
}
