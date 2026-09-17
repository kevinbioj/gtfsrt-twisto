import type { MonitoredCall, MonitoredJourney } from "../siri/fetch-vehicle-monitoring.js";
import type { TripMatch } from "./match-trip.js";
import { resolveStopId, type StaticGtfs, sameStation, stopSequenceOf } from "./use-static-gtfs.js";

/**
 * Comment le quai annoncé a été rapproché de l'horaire théorique de la course :
 *
 *  - `gtfs` : la référence du SAE désigne un quai que la course dessert bien ;
 *  - `sequence` : elle ne désigne rien que la course desserve, mais le rang annoncé, lui, est celui du
 *    GTFS, et le quai qui l'occupe est le même point d'arrêt (cf. {@link resolveCalls}) ;
 *  - `added` : le quai existe dans le GTFS, mais la course ne le dessert pas — un arrêt supplémentaire,
 *    que le système de modifications de course sait décrire (cf. `build-modifications.ts`) ;
 *  - `unknown` : le GTFS ignore jusqu'au quai lui-même — il lui arrive d'avoir un arrêt de retard sur le
 *    terrain. Rien ne permet alors de le désigner : un identifiant que le GTFS ne porte pas ne renvoie
 *    à rien chez le consommateur, et l'arrêt n'est pas publié (cf. `build-entities.ts`).
 */
export type CallResolution = "gtfs" | "sequence" | "added" | "unknown";

/** Un arrêt annoncé, rapproché de l'horaire théorique de la course. */
export type ResolvedCall = {
	call: MonitoredCall;
	/**
	 * Identifiant GTFS du quai, ou la référence du SAE en minuscules lorsque rien ne la rattache — cette
	 * dernière ne se publie pas (`unknown`), elle ne sert qu'au journal.
	 */
	stopId: string;
	/** Rang dans la course ; celui du GTFS pour un arrêt qu'elle dessert, celui du SAE sinon. */
	stopSequence: number;
	resolution: CallResolution;
};

/**
 * Rapproche chaque arrêt annoncé du GTFS, puis les remet dans l'ordre où la course les dessert. Le tri
 * est indispensable : la source liste ses arrêts SUPPRIMÉS après les autres, si bien qu'un arrêt de rang
 * 39 suit un arrêt de rang 42 dans sa réponse.
 *
 * C'est le rang qu'ANNONCE la source qui ordonne, non celui de l'horaire théorique : une course qui
 * dessert un arrêt de plus voit la source renuméroter tout ce qui suit, et le rang du GTFS y placerait
 * l'arrêt supplémentaire après ceux qu'il précède. Les arrêts de l'horaire théorique, eux, gardent leur
 * rang du GTFS — c'est le seul que le consommateur retrouve —, et c'est à la course théorique de les
 * remettre en ordre croissant lorsqu'elle se publie (cf. `buildTripUpdate`).
 */
export function resolveCalls(gtfs: StaticGtfs, journey: MonitoredJourney, match: TripMatch): ResolvedCall[] {
	const resolved = journey.calls.map((call): ResolvedCall => {
		const stopId = resolveStopId(gtfs, call.stopRef);
		const stops = match.stops;

		// Course supplémentaire : aucun horaire théorique où se retrouver, ce qu'annonce la source fait
		// foi — son rang comme son quai.
		if (stops === undefined) {
			return {
				call,
				stopId: stopId ?? call.stopRef.toLowerCase(),
				stopSequence: call.order,
				resolution: stopId === undefined ? "unknown" : "gtfs",
			};
		}

		const stopSequence = stopId === undefined ? undefined : stopSequenceOf(stops, stopId, call.order);
		if (stopId !== undefined && stopSequence !== undefined) {
			return { call, stopId, stopSequence, resolution: "gtfs" };
		}

		// Le quai annoncé ne figure pas dans l'horaire de la course, mais son rang y est, et c'est le même
		// point d'arrêt : le SAE et le GTFS ne numérotent pas toujours les quais d'un même arrêt de la même
		// façon — « NOKA12 » pour « noka11 », tous deux « Normandika » —, et c'est l'identifiant du GTFS
		// qui doit être publié : lui seul se retrouve chez le consommateur. Un quai d'un AUTRE arrêt, lui,
		// est un arrêt supplémentaire, et le rang qu'il occupe ne lui appartient pas.
		const atOrder = stops.find(({ stopSequence: sequence }) => sequence === call.order);
		if (
			atOrder !== undefined &&
			sameStation(gtfs, { stopId, stopRef: call.stopRef, stopName: call.stopName }, atOrder.stopId)
		) {
			return { call, stopId: atOrder.stopId, stopSequence: atOrder.stopSequence, resolution: "sequence" };
		}

		if (stopId !== undefined) {
			return { call, stopId, stopSequence: call.order, resolution: "added" };
		}

		return { call, stopId: call.stopRef.toLowerCase(), stopSequence: call.order, resolution: "unknown" };
	});

	return resolved.sort((a, b) => a.call.order - b.call.order);
}

/** La source annonce cet arrêt comme non desservi. */
export function isCallCancelled(call: MonitoredCall): boolean {
	return call.arrivalStatus === "cancelled" || call.departureStatus === "cancelled";
}

/** L'arrêt est bien desservi : ni supprimé, ni traversé sans s'arrêter. */
export function isCallServed(call: MonitoredCall): boolean {
	return !isCallCancelled(call) && call.boardingActivity !== "passThru";
}

/** L'arrêt appartient à l'horaire théorique de la course, et son rang est celui du GTFS. */
export function isScheduledCall(resolved: ResolvedCall): boolean {
	return resolved.resolution === "gtfs" || resolved.resolution === "sequence";
}
