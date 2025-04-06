import { join } from "node:path";

import { readCsv } from "./csv-reader.js";

export type LoadShapesStrategy = "LOAD-IF-EXISTS" | "IGNORE";

export async function importGtfs(gtfsDirectory: string) {
	const tripIds: string[] = [];
	await readCsv<{ trip_id: string }>(join(gtfsDirectory, "trips.txt"), (record) => {
		tripIds.push(record.trip_id);
	});
	return tripIds;
}
