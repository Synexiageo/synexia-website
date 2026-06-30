const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://synexia.ge",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers: CORS_HEADERS, body: "Method Not Allowed" };
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: "Missing HUBSPOT_TOKEN" }) };
  }

  if (event.queryStringParameters && event.queryStringParameters.debug === "1") {
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({ length: token.length, prefix: token.slice(0, 8), suffix: token.slice(-4) })
    };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { firstname, phone } = data;
  if (!firstname || !phone) {
    return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "firstname and phone are required" }) };
  }

  // Only standard HubSpot contact properties are sent here — custom properties
  // (referral_code, message) must exist in HubSpot before being added, or the
  // whole request fails (unlike the Forms API, which silently drops unknown fields).
  const properties = { firstname, phone };

  try {
    const res = await fetch("https://api.hubapi.com/crm/v3/objects/contacts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
      },
      body: JSON.stringify({ properties })
    });

    const result = await res.json();

    if (!res.ok) {
      return { statusCode: res.status, headers: CORS_HEADERS, body: JSON.stringify(result) };
    }

    return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ ok: true, id: result.id }) };
  } catch (e) {
    return { statusCode: 500, headers: CORS_HEADERS, body: JSON.stringify({ error: e.message }) };
  }
};
