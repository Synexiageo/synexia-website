exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const token = process.env.HUBSPOT_TOKEN;
  if (!token) {
    return { statusCode: 500, body: JSON.stringify({ error: "Missing HUBSPOT_TOKEN" }) };
  }

  let data;
  try {
    data = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { firstname, phone } = data;
  if (!firstname || !phone) {
    return { statusCode: 400, body: JSON.stringify({ error: "firstname and phone are required" }) };
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
      return { statusCode: res.status, body: JSON.stringify(result) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, id: result.id }) };
  } catch (e) {
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
