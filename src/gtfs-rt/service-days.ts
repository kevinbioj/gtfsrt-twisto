import { NIGHT_SERVICE_CUTOFF_HOUR, TIME_ZONE } from "../config.js";
import { SERVICE_ADDED, SERVICE_REMOVED, type StaticGtfs } from "./use-static-gtfs.js";

/** Une journée de service : sa date au format GTFS, son minuit, et les services qui y circulent. */
export type ServiceDay = { date: string; midnight: number; services: Set<string> };

/**
 * Les journées de service voisines d'aujourd'hui, aux décalages demandés.
 *
 * Les bornes sont calculées par `startOfDay` et non par tranches de 86 400 s : les jours de changement
 * d'heure ne durent pas vingt-quatre heures, et toutes leurs courses seraient décalées d'une heure.
 */
export function serviceDays(gtfs: StaticGtfs, offsets: readonly number[]): ServiceDay[] {
	const today = Temporal.Now.zonedDateTimeISO(TIME_ZONE).startOfDay();

	return offsets.map((offset) => {
		const day = today.add({ days: offset });
		const date = toGtfsDate(day.toPlainDate());

		return {
			date,
			midnight: Math.floor(day.epochMilliseconds / 1000),
			services: activeServices(gtfs, day.dayOfWeek, date),
		};
	});
}

/**
 * Services actifs une journée donnée : le calendrier hebdomadaire d'abord, que les exceptions datées
 * viennent ensuite amender.
 */
function activeServices(gtfs: StaticGtfs, dayOfWeek: number, date: string): Set<string> {
	const services = new Set<string>();

	for (const [serviceId, calendar] of gtfs.calendars) {
		// `dayOfWeek` numérote la semaine à partir de 1 pour le lundi, comme les colonnes du GTFS.
		if (calendar.weekdays[dayOfWeek - 1] !== true) continue;
		if (calendar.startDate && date < calendar.startDate) continue;
		if (calendar.endDate && date > calendar.endDate) continue;
		services.add(serviceId);
	}

	for (const [serviceId, exceptions] of gtfs.calendarExceptions) {
		const exceptionType = exceptions.get(date);
		if (exceptionType === SERVICE_ADDED) services.add(serviceId);
		else if (exceptionType === SERVICE_REMOVED) services.delete(serviceId);
	}

	return services;
}

/**
 * La journée de service dont relève un instant, pour une course que le GTFS ne connaît pas : sa date
 * locale, ou la veille lorsqu'il tombe avant {@link NIGHT_SERVICE_CUTOFF_HOUR}. Une course partie à
 * 00h30 prolonge le service de la soirée précédente, que le GTFS écrirait « 24:30:00 ».
 */
export function serviceDateOf(epochSeconds: number): string {
	const zoned = Temporal.Instant.fromEpochMilliseconds(epochSeconds * 1000).toZonedDateTimeISO(TIME_ZONE);
	const day = zoned.hour < NIGHT_SERVICE_CUTOFF_HOUR ? zoned.toPlainDate().subtract({ days: 1 }) : zoned.toPlainDate();

	return toGtfsDate(day);
}

/** Le minuit d'une journée de service, en secondes epoch, ou `undefined` si la date est illisible. */
export function midnightOf(date: string): number | undefined {
	try {
		const day = Temporal.PlainDate.from(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`);
		return Math.floor(day.toZonedDateTime(TIME_ZONE).epochMilliseconds / 1000);
	} catch {
		return undefined;
	}
}

function toGtfsDate(day: Temporal.PlainDate): string {
	return day.toString().replaceAll("-", "");
}
