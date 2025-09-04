import { fetchAndValidateJson } from "@/utils/fetchAndValidateJson";
import { parseHinfahrtRecon, parseHinfahrtReconWithAPI } from "@/utils/parseHinfahrtRecon";
import { vbidSchema } from "@/utils/schemas";
import type { ExtractedData } from "@/utils/types";
import { apiErrorHandler } from "../_lib/error-handler";

// POST-Route für URL-Parsing
const handler = async (request: Request) => {
	const body = await request.json();
	const { url } = body;

	if (!url) {
		return Response.json(
			{ error: "Missing required parameter: url" },
			{ status: 400 }
		);
	}

	const journeyDetails = extractJourneyDetails(
		await getResolvedUrlBrowserless(url)
	);

	if ("error" in journeyDetails) {
		return Response.json({ error: journeyDetails.error });
	}

	if (!journeyDetails.fromStationId || !journeyDetails.toStationId) {
		return Response.json(
			{ error: "journeyDetails is missing fromStationId or toStationId" },
			{ status: 500 }
		);
	}

	displayJourneyInfo(journeyDetails);

	return Response.json({
		success: true,
		journeyDetails,
	});
};

export async function POST(request: Request) {
	return await apiErrorHandler(() => handler(request));
}

const extractStationName = (value: string | null) => {
    if (!value) return null;

    // Handle HAFAS LID strings (e.g. "...@O=Aachen Hbf...@L=8000001...")
    const oMatch = value.match(/@O=([^@]+)/);
    if (oMatch) {
        return decodeURIComponent(oMatch[1]).replaceAll("+", " ").trim();
    }

    // If value is just a numeric id, we can't infer the name here
    if (/^\d+$/.test(value)) return null;

    // Fallback: value might be a plain station name or URL-encoded string
    const parts = value.split("@L=");
    return parts.length > 0
        ? decodeURIComponent(parts[0]).replaceAll("+", " ").trim()
        : decodeURIComponent(value);
};

const extractStationId = (value: string | null) => {
    if (!value) return null;
    // Support both LID strings containing @L=... and plain numeric ids
    const fromLid = value.match(/@L=(\d+)/)?.[1];
    if (fromLid) return fromLid;
    if (/^\d+$/.test(value)) return value;
    return null;
};

const parseDateTime = (value: string | null) => {
	if (!value) {
		return {};
	}

	if (value.includes("T")) {
		const [datePart, timePart] = value.split("T");
		const timeOnly = timePart.split("+")[0].split("-")[0];
		const [hours, minutes] = timeOnly.split(":");
		return { date: datePart, time: `${hours}:${minutes}` };
	}

	return { date: value };
};

function extractJourneyDetails(url: string) {
	try {
		const urlObj = new URL(url);
		const hash = urlObj.hash;

		const details: ExtractedData = {
			fromStation: null,
			fromStationId: null,
			toStation: null,
			toStationId: null,
			date: null,
			time: null,
			class: null,
		};

		// Extract from hash parameters (consistent approach)
		const params = new URLSearchParams(hash.replace("#", ""));
		
		const soidValue = params.get("soid");
		const zoidValue = params.get("zoid");
		const dateValue = params.get("hd");
		const timeValue = params.get("ht");
		const classValue = params.get("kl");

		if (soidValue) {
			details.fromStationId = extractStationId(soidValue);
			details.fromStation = extractStationName(soidValue);
		}

		if (zoidValue) {
			details.toStationId = extractStationId(zoidValue);
			details.toStation = extractStationName(zoidValue);
		}

		// Handle date/time extraction
		const dateTimeInfo = parseDateTime(dateValue);
		if (dateTimeInfo.date) details.date = dateTimeInfo.date;
		if (dateTimeInfo.time && !details.time) details.time = dateTimeInfo.time;
		if (timeValue && !details.time) details.time = timeValue;

		if (classValue) details.class = parseInt(classValue, 10);

		return details;
	} catch (error) {
		console.error("❌ Error extracting journey details:", error);
		return {
			error: "Failed to extract journey details",
			details: (error as Error).message,
		};
	}
}

function displayJourneyInfo(journeyDetails: ExtractedData) {
	if (!journeyDetails || "error" in journeyDetails) {
		console.log("❌ Failed to extract journey information");
		return;
	}

	const formatInfo = [
		`From: ${journeyDetails.fromStation || "Unknown"} (${
			journeyDetails.fromStationId || "N/A"
		})`,
		`To: ${journeyDetails.toStation || "Unknown"} (${
			journeyDetails.toStationId || "N/A"
		})`,
		`Date: ${journeyDetails.date || "N/A"}`,
		`Time: ${journeyDetails.time || "N/A"}`,
		`Class: ${journeyDetails.class === 1 ? "First" : "Second"}`,
	].join(" | ");

	console.log(formatInfo);
}

async function getResolvedUrlBrowserless(url: string) {
    const vbid = new URL(url).searchParams.get("vbid");

    if (!vbid) {
        throw new Error("No vbid parameter found in URL");
    }

    const vbidRequest = await fetchAndValidateJson({
        url: `https://www.bahn.de/web/api/angebote/verbindung/${vbid}`,
        schema: vbidSchema,
    });

    // Build the target URL we want to return
    const newUrl = new URL("https://www.bahn.de/buchung/fahrplan/suche");
    const hashParams = new URLSearchParams();

    // Try the official recon API first (more reliable when available)
    try {
        const getSetCookie =
            // @ts-expect-error: getSetCookie exists in Node/undici fetch
            typeof vbidRequest.response.headers.getSetCookie === "function"
                ? // @ts-ignore
                  vbidRequest.response.headers.getSetCookie()
                : (() => {
                      const sc = vbidRequest.response.headers.get("set-cookie");
                      // If multiple Set-Cookie headers were coalesced into a single string,
                      // we cannot reliably split by comma because of Expires=...,
                      // but sending the first header is often enough to pass the recon gate.
                      return sc ? [sc] : [];
                  })();

        const { data } = await parseHinfahrtReconWithAPI(
            vbidRequest.data,
            getSetCookie
        );

        hashParams.set(
            "soid",
            data.verbindungen[0].verbindungsAbschnitte.at(0)!.halte.at(0)!.id
        );
        hashParams.set(
            "zoid",
            data.verbindungen[0].verbindungsAbschnitte.at(-1)!.halte.at(-1)!.id
        );
    } catch (e) {
        // Fallback 1: Try extracting from the HKI section of hinfahrtRecon (simple regex)
        const hki = extractLidsFromHinfahrtReconHKI(vbidRequest.data.hinfahrtRecon);
        if (hki) {
            hashParams.set("soid", hki.departLid);
            hashParams.set("zoid", hki.arrLid);
        } else {
            // Fallback 2: Try the more complex SC JSON parsing
            const { departLid, arrLid } = parseHinfahrtRecon(
                vbidRequest.data.hinfahrtRecon
            );
            hashParams.set("soid", departLid);
            hashParams.set("zoid", arrLid);
        }
    }

    // Add date information from the booking if present
    if (vbidRequest.data.hinfahrtDatum) {
        hashParams.set("hd", vbidRequest.data.hinfahrtDatum);
    }

    newUrl.hash = hashParams.toString();
    return newUrl.toString();
}

function extractLidsFromHinfahrtReconHKI(hinfahrtRecon: string):
    | { departLid: string; arrLid: string }
    | null {
    try {
        const ids = Array.from(hinfahrtRecon.matchAll(/@L=(\d{7,})/g)).map(
            (m) => m[1]
        );
        if (ids.length >= 2) {
            return { departLid: ids[0]!, arrLid: ids[1]! };
        }
        return null;
    } catch {
        return null;
    }
}
