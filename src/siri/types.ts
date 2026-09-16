/**
 * La réponse du service, telle que le parseur XML la rend : tout y est chaîne de caractères (les
 * conversions sont désactivées, un `PublishedLineName` « 4 » n'étant pas un nombre mais un nom de
 * ligne), un élément répété est soit unique soit un tableau, et un élément vide — `<OnwardCalls/>` au
 * terminus — donne la chaîne vide.
 */
export type SoapResponse = {
	Envelope?: {
		Body?: {
			GetVehicleMonitoringResponse?: {
				Answer?: {
					VehicleMonitoringDelivery?: {
						ResponseTimestamp?: string;
						VehicleActivity?: RawVehicleActivity | RawVehicleActivity[] | "";
					};
				};
			};
			LinesDiscoveryResponse?: {
				Answer?: {
					ResponseTimestamp?: string;
					Status?: string;
					AnnotatedLineRef?: RawAnnotatedLineRef | RawAnnotatedLineRef[] | "";
				};
			};
		};
	};
};

/** Une ligne telle que `LinesDiscovery` l'annonce. */
export type RawAnnotatedLineRef = {
	LineRef?: string;
	LineName?: string;
	Monitored?: string;
};

export type RawVehicleActivity = {
	RecordedAtTime?: string;
	ItemIdentifier?: string;
	ValidUntilTime?: string;
	VehicleMonitoringRef?: string;
	ProgressBetweenStops?: Empty<{ LinkDistance?: string; Percentage?: string }>;
	MonitoredVehicleJourney?: RawMonitoredVehicleJourney;
};

export type RawMonitoredVehicleJourney = {
	LineRef?: string;
	FramedVehicleJourneyRef?: Empty<{ DataFrameRef?: string; DatedVehicleJourneyRef?: string }>;
	JourneyPatternRef?: string;
	JourneyPatternName?: string;
	VehicleMode?: string;
	RouteRef?: string;
	PublishedLineName?: string;
	DirectionName?: string;
	DirectionRef?: string;
	OriginRef?: string;
	OriginName?: string;
	DestinationRef?: string;
	DestinationName?: string;
	VehicleJourneyName?: string;
	OriginAimedDepartureTime?: string;
	DestinationAimedArrivalTime?: string;
	Monitored?: string;
	DataSource?: string;
	VehicleRef?: string;
	VehicleLocation?: Empty<{ Longitude?: string; Latitude?: string }>;
	Bearing?: string;
	Delay?: string;
	MonitoredCall?: Empty<RawCall>;
	OnwardCalls?: Empty<{ OnwardCall?: RawCall | RawCall[] | "" }>;
};

export type RawCall = {
	StopPointRef?: string;
	Order?: string;
	StopPointName?: string;
	DestinationDisplay?: string;
	AimedArrivalTime?: string;
	ExpectedArrivalTime?: string;
	ActualArrivalTime?: string;
	ArrivalStatus?: string;
	ArrivalProximityText?: string;
	AimedDepartureTime?: string;
	ExpectedDepartureTime?: string;
	ActualDepartureTime?: string;
	DepartureStatus?: string;
	DepartureBoardingActivity?: string;
	DistanceFromStop?: string;
	NumberOfStopsAway?: string;
};

/** Un élément qui peut se présenter vide (`<OnwardCalls/>`), le parseur en faisant une chaîne vide. */
type Empty<T> = T | "";
