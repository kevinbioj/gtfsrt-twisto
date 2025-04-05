import { randomUUID } from "node:crypto";
import { Temporal } from "temporal-polyfill";

import type { LinesDiscoveryResponse, SoapResponse } from "./types.js";
import { parser } from "./xml-parser.js";

const payload = (requestorRef: string) => `
<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
    <S:Body>
        <sw:LinesDiscovery xmlns:sw="http://wsdl.siri.org.uk" xmlns:siri="http://www.siri.org.uk/siri">
            <Request>
                <siri:RequestTimestamp>${Temporal.Now.zonedDateTimeISO().toString({ timeZoneName: "never" })}</siri:RequestTimestamp>
                <siri:RequestorRef>${requestorRef}</siri:RequestorRef>
                <siri:MessageIdentifier>${randomUUID()}</siri:MessageIdentifier>
            </Request>
            <RequestExtension/>
        </sw:LinesDiscovery>
    </S:Body>
</S:Envelope>`;

export async function linesDiscovery(url: string, requestorRef: string) {
	const response = await fetch(url, {
		method: "POST",
		body: payload(requestorRef),
		headers: {
			"Content-Type": "application/xml",
		},
		signal: AbortSignal.timeout(30_000),
	});

	if (!response.ok) {
		throw new Error(`Failed to perform lines discovery (HTTP ${response.status})`);
	}

	const serializedXml = await response.text();
	const soapResponse = parser.parse(serializedXml) as SoapResponse<LinesDiscoveryResponse>;

	return soapResponse.Envelope.Body.LinesDiscoveryResponse.Answer.AnnotatedLineRef ?? [];
}
