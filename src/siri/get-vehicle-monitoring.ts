import { randomUUID } from "node:crypto";
import { Temporal } from "temporal-polyfill";

import { readFileSync } from "node:fs";
import type { GetVehicleMonitoringResponse, SoapResponse } from "./types.js";
import { parser } from "./xml-parser.js";

const payload = (requestorRef: string, lineRefs: string[]) => `
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
    <S:Body>
        <sw:GetVehicleMonitoring xmlns:sw="http://wsdl.siri.org.uk" xmlns:siri="http://www.siri.org.uk/siri">
            <ServiceRequestInfo>
								<siri:RequestTimestamp>${Temporal.Now.zonedDateTimeISO().toString({ timeZoneName: "never" })}</siri:RequestTimestamp>
                <siri:RequestorRef>${requestorRef}</siri:RequestorRef>
                <siri:MessageIdentifier>${randomUUID()}</siri:MessageIdentifier>
            </ServiceRequestInfo>
            <Request version="2.0:FR-IDF-2.4">
                ${lineRefs.map((lineRef) => `<siri:LineRef>${lineRef}</siri:LineRef>`).join("\n")}
            </Request>
            <RequestExtension/>
        </sw:GetVehicleMonitoring>
    </S:Body>
</S:Envelope>`;

export async function getVehicleMonitoring(url: string, requestorRef: string, lineRefs: string[]) {
	// const response = await fetch(url, {
	// 	method: "POST",
	// 	body: payload(requestorRef, lineRefs),
	// 	headers: {
	// 		"Content-Type": "application/xml",
	// 	},
	// 	signal: AbortSignal.timeout(30_000),
	// });

	// if (!response.ok) {
	// 	throw new Error(`Failed to perform get vehicle monitoring (HTTP ${response.status})`);
	// }

	// const serializedXml = await response.text();
	// console.log(serializedXml);
	const serializedXml = readFileSync("./sample.xml").toString();
	const soapResponse = parser.parse(serializedXml) as SoapResponse<GetVehicleMonitoringResponse>;

	const vehicleActivities =
		soapResponse.Envelope.Body.GetVehicleMonitoringResponse.Answer.VehicleMonitoringDelivery.VehicleActivity;
	if (typeof vehicleActivities === "undefined") return [];
	if (Array.isArray(vehicleActivities)) return vehicleActivities;
	return [vehicleActivities];
}
