import { join } from "node:path";

import { readCsv } from "./csv-reader.js";

export type LoadShapesStrategy = "LOAD-IF-EXISTS" | "IGNORE";

export async function importGtfs(gtfsDirectory: string) {
	const tripIds: string[] = [];
	const stops = new Map<string, string>();

	await readCsv<{ trip_id: string }>(join(gtfsDirectory, "trips.txt"), (record) => {
		tripIds.push(record.trip_id);
	});

	await readCsv<{ stop_id: string; stop_name: string }>(join(gtfsDirectory, "stops.txt"), (record) => {
		stops.set(record.stop_id, record.stop_name);
	});

	return { tripIds, stops };
}
