export type SoapResponse<T> = {
	Envelope: SoapEnvelope<T>;
};

export type SoapEnvelope<T> = {
	Body: SoapBody<T>;
};

export type SoapBody<T> = T;

// --- WS LinesDiscovery

export type LinesDiscoveryResponse = {
	LinesDiscoveryResponse: {
		Answer: {
			ResponseTimestamp: string;
			Status: boolean;
			AnnotatedLineRef?: AnnotatedLineRef[];
		};
	};
};

export type AnnotatedLineRef = {
	LineRef: string;
	Monitored: boolean;
};

// --- WS GetVehicleMonitoring

export type GetVehicleMonitoringResponse = {
	GetVehicleMonitoringResponse: {
		ServiceDeliveryInfo: {
			ResponseTimestamp: string;
			ProducerRef: string;
			RequestMessageRef: string;
		};
		Answer: {
			VehicleMonitoringDelivery: {
				ResponseTimestamp: string;
				RequestMessageRef: string;
				VehicleActivity?: VehicleActivity | VehicleActivity[];
			};
		};
	};
};

export type VehicleActivity = {
	RecordedAtTime: string;
	ItemIdentifier: number;
	ValidUntilTime: string;
	VehicleMonitoringRef: string;
	MonitoredVehicleJourney: {
		LineRef: string;
		DirectionName: 1 | 2;
		VehicleJourneyName: string;
		OriginRef: string;
		OriginAimedDepartureTime: string;
		Monitored: boolean;
		VehicleLocation: {
			Longitude: number;
			Latitude: number;
		};
		Bearing: number;
		Delay: string;
		MonitoredCall?: StopCall;
		OnwardCalls?: {
			OnwardCall?: StopCall | StopCall[];
		};
	};
};

export type StopCall = {
	StopPointRef: string;
	Order: number;
	AimedArrivalTime?: string;
	ExpectedArrivalTime?: string;
	ArrivalStatus?: "noReport" | "cancelled";
	AimedDepartureTime: string;
	ExpectedDepartureTime: string;
	DepartureStatus?: "noReport" | "cancelled";
};
