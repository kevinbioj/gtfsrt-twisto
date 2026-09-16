import { randomUUID } from "node:crypto";

/**
 * Requête `LinesDiscovery` : la liste des lignes que le service suit, avec leur `LineRef` complet.
 * C'est elle qui alimente {@link GET_VEHICLE_MONITORING}, lequel exige de déclarer ses lignes.
 */
export const LINES_DISCOVERY = (requestorRef: string) => {
	const { requestTimestamp, messageIdentifier } = envelopeIdentity();

	return `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
      <S:Body>
        <sw:LinesDiscovery xmlns:sw="http://wsdl.siri.org.uk" xmlns:siri="http://www.siri.org.uk/siri">
          <Request version="2.0:FR-IDF-2.4">
            <siri:RequestTimestamp>${requestTimestamp}</siri:RequestTimestamp>
            <siri:RequestorRef>${requestorRef}</siri:RequestorRef>
            <siri:MessageIdentifier>${messageIdentifier}</siri:MessageIdentifier>
          </Request>
          <RequestExtension/>
        </sw:LinesDiscovery>
      </S:Body>
    </S:Envelope>`;
};

/**
 * Requête `GetVehicleMonitoring` portant sur les lignes déclarées : le service n'accepte pas de
 * requête sans `LineRef`, mais il en accepte autant que voulu dans la même — une seule requête par
 * relevé suffit donc, là où un producteur contraint à une ligne par requête doit les balayer une à
 * une. Les références attendues sont celles que rend `LinesDiscovery`, entières
 * (« SIRI_NVP_037:Line::T1:LOC ») et non réduites à leur identifiant.
 */
export const GET_VEHICLE_MONITORING = (requestorRef: string, lineRefs: readonly string[]) => {
	const { requestTimestamp, messageIdentifier } = envelopeIdentity();

	const lines = lineRefs.map((lineRef) => `\n            <siri:LineRef>${escapeXml(lineRef)}</siri:LineRef>`).join("");

	return `<S:Envelope xmlns:S="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
      <S:Body>
        <sw:GetVehicleMonitoring xmlns:sw="http://wsdl.siri.org.uk" xmlns:siri="http://www.siri.org.uk/siri">
          <ServiceRequestInfo>
            <siri:RequestTimestamp>${requestTimestamp}</siri:RequestTimestamp>
            <siri:RequestorRef>${requestorRef}</siri:RequestorRef>
            <siri:MessageIdentifier>${messageIdentifier}</siri:MessageIdentifier>
          </ServiceRequestInfo>
          <Request version="2.0:FR-IDF-2.4">
            <siri:RequestTimestamp>${requestTimestamp}</siri:RequestTimestamp>
            <siri:MessageIdentifier>${messageIdentifier}</siri:MessageIdentifier>${lines}
          </Request>
          <RequestExtension/>
        </sw:GetVehicleMonitoring>
      </S:Body>
    </S:Envelope>`;
};

// ---

function envelopeIdentity() {
	return {
		requestTimestamp: Temporal.Now.instant().toString(),
		messageIdentifier: `BUS-TRACKER.FR::Message::${randomUUID()}`,
	};
}

/** Une référence rendue par le service est recopiée dans la requête : elle y est donnée à échapper. */
function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}
