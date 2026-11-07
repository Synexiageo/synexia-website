// Facebook Lead Ads → Supabase, Make.com-ის გარეშე.
//
// Meta webhook მხოლოდ `leadgen_id`-ს გვაგზავნის; პასუხებს Graph API-დან ვიღებთ.
// ყოველი ლიდის ნედლი JSON ჯერ `fb_leads_raw`-ში ჩაიწერება და მხოლოდ მერე ვარჩევთ —
// ასე ფორმულირების ცვლილებამ პასუხები ვეღარ დაგვაკარგვინოს (იხ. 2026-08-18/19).
//
// ENV: FB_APP_SECRET, FB_PAGE_TOKEN, FB_VERIFY_TOKEN, SUPABASE_SERVICE_KEY
//      FB_GRAPH_VERSION (არასავალდებულო, ნაგულისხმევი v21.0)

const crypto = require("crypto");

const SB_URL = "https://tsfzuyujfcacultjexsy.supabase.co";
const GRAPH_V = process.env.FB_GRAPH_VERSION || "v27.0";
const GRAPH = `https://graph.facebook.com/${GRAPH_V}`;

/* ─── ველების გარჩევა ──────────────────────────────────────────────────────
   Make კითხვის ზუსტი ტექსტით კითხულობდა ველებს და ერთი უხილავი ჰარი
   ყველაფერს შლიდა. აქ ჯერ გასაღებში საკვანძო სიტყვას ვეძებთ, და თუ ვერ
   ვიპოვეთ — რიგითობით ვიღებთ. ორივე რომ ავცდეთ, ნედლი JSON მაინც გვრჩება. */

const STD = new Set(["full_name", "first_name", "last_name", "phone_number", "email"]);

// რიგითობა ფორმაში: სფერო, სამუშაო, დასაქმება, ქალაქი, ტელეფონი
const ORDER = ["sphere", "job", "employment", "city", "phone_model"];

const KEYWORDS = {
  sphere:      ["სფერო", "sfero"],
  job:         ["დეტალურად", "სამუშაო", "samushao"],
  employment:  ["კომპანია", "დასაქმებულ", "თვითდასაქმებულ"],
  city:        ["ქალაქ", "qalaq", "city"],
  phone_model: ["მობილურ", "ბრენდი", "მოდელი", "brand", "model"],
};

function parseFields(fieldData) {
  const out = {};
  const get = (f) => (Array.isArray(f.values) && f.values.length ? String(f.values[0]).trim() : "");

  for (const f of fieldData || []) {
    const key = String(f.name || "").toLowerCase();
    if (key === "full_name") out.name = get(f);
    else if (key === "phone_number") out.phone = get(f);
    else if (key === "email") out.email = get(f);
  }
  // First/Last-ზე აწყობილი ფორმის სათადარიგო გზა (იხ. meta-form-fullname-rule)
  if (!out.name) {
    const fn = (fieldData || []).find((f) => String(f.name).toLowerCase() === "first_name");
    const ln = (fieldData || []).find((f) => String(f.name).toLowerCase() === "last_name");
    out.name = [fn && get(fn), ln && get(ln)].filter(Boolean).join(" ").trim();
  }

  const custom = (fieldData || []).filter((f) => !STD.has(String(f.name).toLowerCase()));
  const taken = new Set();

  // 1. საკვანძო სიტყვით
  for (const slot of ORDER) {
    const hit = custom.find((f, i) => {
      if (taken.has(i)) return false;
      const k = String(f.name || "").toLowerCase();
      return KEYWORDS[slot].some((w) => k.includes(w.toLowerCase()));
    });
    if (hit) {
      taken.add(custom.indexOf(hit));
      out[slot] = get(hit);
    }
  }
  // 2. დარჩენილები რიგითობით
  const leftover = custom.filter((_, i) => !taken.has(i));
  let li = 0;
  for (const slot of ORDER) {
    if (out[slot] === undefined && li < leftover.length) out[slot] = get(leftover[li++]);
  }
  return out;
}

function normPhone(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (d.length < 9) return null;
  return "+995" + d.slice(-9);
}

function buildNote(f) {
  return [
    `სფერო: ${f.sphere || ""}`,
    `სამუშაო: ${f.job || ""}`,
    `დასაქ: ${f.employment || ""}`,
    `მობ: ${f.phone_model || ""}`,
    "წყარო: Facebook Ads",
  ].join(" | ");
}

/* ─── Supabase ─────────────────────────────────────────────────────────── */

async function sb(path, body, extraPrefer) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Prefer: extraPrefer || "return=minimal",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Supabase ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

async function logFailure(leadgenId, formId, stage, message, raw) {
  try {
    await sb("fb_leads_raw", {
      leadgen_id: String(leadgenId || `unknown-${Date.now()}`),
      form_id: formId ? String(formId) : null,
      raw: raw || null,
      status: "error",
      error: `${stage}: ${String(message).slice(0, 500)}`,
    }, "return=minimal,resolution=merge-duplicates");
  } catch (e) {
    console.error("ჟურნალშიც ვერ ჩაიწერა:", e.message);
  }
}

/* ─── ერთი ლიდი ────────────────────────────────────────────────────────── */

async function handleLead(value) {
  const leadgenId = value.leadgen_id;
  const formId = value.form_id ? String(value.form_id) : null;
  let raw = null;

  try {
    const url = `${GRAPH}/${encodeURIComponent(leadgenId)}` +
      `?fields=id,created_time,ad_id,form_id,field_data` +
      `&access_token=${encodeURIComponent(await pageToken())}`;
    const res = await fetch(url);
    raw = await res.json();
    if (!res.ok || raw.error) {
      throw new Error(raw.error ? `${raw.error.code} ${raw.error.message}` : `HTTP ${res.status}`);
    }
  } catch (e) {
    await logFailure(leadgenId, formId, "graph", e.message, raw);
    return { leadgenId, ok: false, stage: "graph", error: e.message };
  }

  // ნედლი ჯერ ინახება — გარჩევა მერე
  try {
    await sb("fb_leads_raw", {
      leadgen_id: String(leadgenId),
      form_id: raw.form_id ? String(raw.form_id) : formId,
      raw,
      status: "fetched",
    }, "return=minimal,resolution=merge-duplicates");
  } catch (e) {
    console.error("ნედლის შენახვა ჩაფლავდა:", e.message);
  }

  try {
    const f = parseFields(raw.field_data);
    const phone = normPhone(f.phone);
    if (!phone) throw new Error("ტელეფონი ვერ გაირჩა");

    const lead = {
      id: `FB-${leadgenId}`,
      name: f.name || null,
      phone,
      ref_code: "Facebook Lead",
      reg_date: raw.created_time || new Date().toISOString(),
      note: buildNote(f),
      city: f.city || null,
      phone_model: f.phone_model || null,
      form_id: raw.form_id ? String(raw.form_id) : formId,
    };

    // Make-ის იდენტური ქცევა: დუბლიკატი ჩუმად გამოტოვდეს
    await sb("leads?on_conflict=phone", lead, "return=minimal,resolution=ignore-duplicates");
    await sb("fb_leads_raw", {
      leadgen_id: String(leadgenId),
      form_id: lead.form_id,
      raw,
      status: "inserted",
      error: null,
    }, "return=minimal,resolution=merge-duplicates");

    return { leadgenId, ok: true };
  } catch (e) {
    await logFailure(leadgenId, formId, "insert", e.message, raw);
    return { leadgenId, ok: false, stage: "insert", error: e.message };
  }
}

/* ─── ხელმოწერა ────────────────────────────────────────────────────────── */

function validSignature(event, rawBody) {
  const secret = process.env.FB_APP_SECRET;
  if (!secret) return false;
  const h = event.headers["x-hub-signature-256"] || event.headers["X-Hub-Signature-256"];
  if (!h || !h.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(h), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ─── სამსახურებრივი შესამოწმებელი ─────────────────────────────────────── */
// დაცულია FB_VERIFY_TOKEN-ით. ტოკენებს არასდროს აბრუნებს — მხოლოდ იმას,
// მუშაობს თუ არა. საჭიროა, რადგან სეკრეტები Netlify-შია და აქედან ვერ ვკითხულობ.

const PAGE_ID = "964973310043012"; // Synexia

// ─── ტოკენი ───────────────────────────────────────────────────────────────
// მიზანი: ტოკენს ადამიანი ერთხელ ჩასვამს და აღარასდროს შეეხება.
//
// Explorer მოკლევადიან ტოკენს იძლევა (რამდენიმე საათი), და „new Pages
// experience"-ში გვერდის ზოგი ენდპოინტი პირად ტოკენს საერთოდ არ იღებს.
// ამიტომ რასაც არ უნდა ჩასვა — პირადს თუ გვერდისას, მოკლეს თუ გრძელს —
// ჯაჭვს თვითონ ვატარებთ:
//   მოკლევადიანი → გრძელვადიანი (60 დღე) → გვერდის ტოკენი (უვადო)
// და მიღებულს `fb_config`-ში ვინახავთ, რომ 60 დღეში ჩუმად არ გაწყდეს.
//
// გვერდს ყოველთვის ID-ით ვარჩევთ, არა რიგითობით — ანგარიშზე სხვა გვერდებიც
// რომ იყოს, ვერასდროს აირჩევა არასწორი.

const APP_ID = process.env.FB_APP_ID || "2203525220564556";
let PAGE_TOKEN_CACHE = null;

const fbJson = (url) => fetch(url).then((r) => r.json()).catch((e) => ({ error: { message: e.message } }));
const tok = (t) => `access_token=${encodeURIComponent(t || "")}`;

async function cfgGet(key) {
  const k = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${SB_URL}/rest/v1/fb_config?key=eq.${key}&select=value`, {
    headers: { apikey: k, Authorization: `Bearer ${k}` },
  });
  if (!r.ok) return null;
  const d = await r.json();
  return Array.isArray(d) && d.length ? d[0].value : null;
}

async function cfgSet(key, value) {
  const k = process.env.SUPABASE_SERVICE_KEY;
  await fetch(`${SB_URL}/rest/v1/fb_config?on_conflict=key`, {
    method: "POST",
    headers: {
      apikey: k, Authorization: `Bearer ${k}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal,resolution=merge-duplicates",
    },
    body: JSON.stringify({ key, value }),
  });
}

async function isPageToken(t) {
  if (!t) return false;
  const me = await fbJson(`${GRAPH}/me?fields=id&${tok(t)}`);
  return me && String(me.id) === PAGE_ID;
}

async function derivePageToken(envToken) {
  // 1. უკვე გვერდის ტოკენია?
  if (await isPageToken(envToken)) return { token: envToken, how: "env უკვე გვერდის ტოკენი იყო" };

  // 2. პირადი ტოკენი — ჯერ გრძელვადიანად ვაქციოთ, რომ მიღებული
  //    გვერდის ტოკენი უვადო გამოვიდეს (მოკლედან მოკლე გამოდის).
  let userToken = envToken;
  const ex = await fbJson(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token` +
    `&client_id=${encodeURIComponent(APP_ID)}` +
    `&client_secret=${encodeURIComponent(process.env.FB_APP_SECRET || "")}` +
    `&fb_exchange_token=${encodeURIComponent(envToken || "")}`
  );
  const extended = !!(ex && ex.access_token);
  if (extended) userToken = ex.access_token;

  // 3. გვერდის ტოკენი — ID-ით, არა რიგითობით
  const acc = await fbJson(`${GRAPH}/me/accounts?fields=id,access_token&limit=200&${tok(userToken)}`);
  const p = (acc.data || []).find((x) => String(x.id) === PAGE_ID);
  if (p && p.access_token) {
    return { token: p.access_token, how: extended ? "გრძელვადიანიდან მიღებული (უვადო)" : "პირადიდან მიღებული" };
  }
  return {
    token: null,
    how: "ვერ მოიძებნა",
    pages: (acc.data || []).map((x) => x.id),
    error: acc.error || ex.error || null,
  };
}

async function pageToken() {
  if (PAGE_TOKEN_CACHE) return PAGE_TOKEN_CACHE;
  try {
    const stored = await cfgGet("page_token");
    if (stored && (await isPageToken(stored))) return (PAGE_TOKEN_CACHE = stored);
    const got = await derivePageToken(process.env.FB_PAGE_TOKEN);
    if (got.token) {
      await cfgSet("page_token", got.token);
      await cfgSet("page_token_note", got.how);
      return (PAGE_TOKEN_CACHE = got.token);
    }
    console.error("გვერდის ტოკენი ვერ მივიღე:", JSON.stringify(got));
  } catch (e) {
    console.error("ტოკენის მოძიება ჩავარდა:", e.message);
  }
  return process.env.FB_PAGE_TOKEN || "";
}

async function fbGet(path, params) {
  const u = new URL(`${GRAPH}/${path}`);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
  u.searchParams.set("access_token", await pageToken());
  const res = await fetch(u);
  return res.json();
}

async function adminAction(q) {
  const out = {
    env: {
      FB_VERIFY_TOKEN: !!process.env.FB_VERIFY_TOKEN,
      FB_APP_SECRET: !!process.env.FB_APP_SECRET,
      FB_PAGE_TOKEN: !!process.env.FB_PAGE_TOKEN,
      SUPABASE_SERVICE_KEY: !!process.env.SUPABASE_SERVICE_KEY,
    },
    graph_version: GRAPH_V,
  };

  if (q.action === "subscribe") {
    const u = new URL(`${GRAPH}/${PAGE_ID}/subscribed_apps`);
    u.searchParams.set("subscribed_fields", "leadgen");
    u.searchParams.set("access_token", await pageToken());
    const res = await fetch(u, { method: "POST" });
    out.subscribe = await res.json();
  }

  if (q.action === "lead" && q.id) {
    out.lead = await handleLead({ leadgen_id: q.id, form_id: q.form_id || null });
  }

  out.token = await fbGet("me", { fields: "id,name" });
  out.page_token_derived = !!PAGE_TOKEN_CACHE && PAGE_TOKEN_CACHE !== process.env.FB_PAGE_TOKEN;
  out.page_token_note = await cfgGet("page_token_note");

  if (q.diag) {
    const raw = encodeURIComponent(process.env.FB_PAGE_TOKEN || "");
    const j = (p) => fetch(`${GRAPH}/${p}&access_token=${raw}`).then((r) => r.json()).catch((e) => ({ error: e.message }));
    const acc = await j("me/accounts?fields=id,name,tasks&limit=100");
    out.diag = {
      // ტოკენები არ ბრუნდება — მხოლოდ რა გვერდებს წვდება და რა უფლებებით
      accounts: acc.error ? acc : (acc.data || []).map((p) => ({ id: p.id, name: p.name, tasks: p.tasks })),
      permissions: await j("me/permissions?"),
      // ამ ორით ვარჩევთ, გრანტის პრობლემაა თუ გვერდზე როლის
      page_direct: await j(`${PAGE_ID}?fields=id,name`),
      derive: await (async () => { const g = await derivePageToken(process.env.FB_PAGE_TOKEN); delete g.token; return g; })(),
      businesses: await j("me/businesses?fields=id,name"),
    };
    if (q.revoke) {
      // უფლებების მოხსნა — შემდეგ ჯერზე ფეისბუქი თავიდან იკითხავს გვერდებს
      out.diag.revoked = await fetch(`${GRAPH}/me/permissions?access_token=${raw}`, { method: "DELETE" })
        .then((r) => r.json()).catch((e) => ({ error: e.message }));
    }
  }
  out.subscribed_apps = await fbGet(`${PAGE_ID}/subscribed_apps`, { fields: "id,name,subscribed_fields" });
  if (q.forms) out.forms = await fbGet(`${PAGE_ID}/leadgen_forms`, { fields: "id,name,status,leads_count", limit: "10" });

  try {
    const key = process.env.SUPABASE_SERVICE_KEY;
    const r = await fetch(`${SB_URL}/rest/v1/fb_leads_raw?select=leadgen_id`, {
      headers: { apikey: key, Authorization: `Bearer ${key}`, Prefer: "count=exact", Range: "0-0" },
    });
    out.supabase = { ok: r.ok, status: r.status, count: r.headers.get("content-range") };
    if (!r.ok) out.supabase.body = (await r.text()).slice(0, 200);
  } catch (e) {
    out.supabase = { ok: false, error: e.message };
  }
  return out;
}

/* ─── შესასვლელი ───────────────────────────────────────────────────────── */

exports.handler = async (event) => {
  // Meta-ს ვერიფიკაცია
  if (event.httpMethod === "GET") {
    const q = event.queryStringParameters || {};
    if (q["hub.mode"] === "subscribe" && q["hub.verify_token"] === process.env.FB_VERIFY_TOKEN) {
      return { statusCode: 200, headers: { "Content-Type": "text/plain" }, body: q["hub.challenge"] || "" };
    }
    const vt = process.env.FB_VERIFY_TOKEN || "";
    if (q.admin && vt && q.admin.length === vt.length &&
        crypto.timingSafeEqual(Buffer.from(q.admin), Buffer.from(vt))) {
      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(await adminAction(q), null, 1),
      };
    }
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  if (!validSignature(event, rawBody)) {
    console.error("ხელმოწერა არ ემთხვევა — მოთხოვნა უარყოფილია");
    return { statusCode: 401, body: "Bad signature" };
  }

  let payload;
  try { payload = JSON.parse(rawBody); }
  catch { return { statusCode: 200, body: "ok" }; } // Meta-ს 200 სჭირდება, თორემ ხელახლა აგზავნის

  const jobs = [];
  for (const entry of payload.entry || []) {
    for (const ch of entry.changes || []) {
      if (ch.field === "leadgen" && ch.value && ch.value.leadgen_id) jobs.push(handleLead(ch.value));
    }
  }

  const results = await Promise.all(jobs);
  const failed = results.filter((r) => !r.ok);
  if (failed.length) console.error("ჩავარდნილი ლიდები:", JSON.stringify(failed));
  else if (results.length) console.log(`✅ ${results.length} ლიდი ჩაიწერა`);

  // ყოველთვის 200 — თორემ Meta იმავეს ხელახლა აგზავნის და ჟურნალს ავავსებთ.
  // ჩავარდნილები `fb_leads_raw`-ში status='error'-ით ზის და ხელახლა გაშვებადია.
  return { statusCode: 200, body: "ok" };
};
