// CRM → Meta (Conversions API for CRM).
//
// მეტას „Conversion leads" ოპტიმიზაცია მხოლოდ მაშინ ირთვება, როცა CRM მეტას
// უბრუნებს, რა დაემართა ფეისბუქის ლიდს: შევეხმიანეთ, ონბორდზე გავიდა, უარყოფილია.
// ბაზის ტრიგერი (SQL 47) ამ ეტაპებს `meta_crm_events` რიგში წერს; ეს ფუნქცია
// 15 წუთში ერთხელ (netlify.toml) რიგს მეტას უგზავნის და გაგზავნილს ნიშნავს.
//
// ENV: META_CRM_DATASET_ID, META_CRM_TOKEN — Events Manager-იდან (CRM dataset)
//      SUPABASE_SERVICE_KEY
//      META_CRM_TEST_CODE (არასავალდებულო) — Events Manager → Test events-ის კოდი
// ⚠️ META_CRM_TOKEN dataset-ის ტოკენია, Events Manager-ში გენერირებული. Graph API
//    Explorer-ში ტოკენი არ გენერირდება — ის fb-leads-ის ტოკენს კლავს.

const SB_URL = "https://tsfzuyujfcacultjexsy.supabase.co";
const GRAPH = `https://graph.facebook.com/${process.env.FB_GRAPH_VERSION || "v27.0"}`;
const BATCH = 200;           // მეტა 1000-მდე იღებს, მაგრამ ერთი ცუდი მოვლენა მთელ პაკეტს აგდებს
const MAX_AGE = 7 * 86400;   // მეტა 7 დღეზე ძველ მოვლენას არ იღებს
const LEAD_WINDOW = 28 * 86400;  // ეტაპი ლიდიდან 28 დღის შემდეგ მეტასთვის უსარგებლოა

async function sb(path, init = {}) {
  const k = process.env.SUPABASE_SERVICE_KEY;
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json",
               Prefer: "return=minimal", ...(init.headers || {}) },
  });
  if (!r.ok) throw new Error(`Supabase ${path} → ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r;
}

const mark = (ids, body) =>
  sb(`meta_crm_events?id=in.(${ids.join(",")})`, { method: "PATCH", body: JSON.stringify(body) });

function toEvent(row) {
  return {
    event_name: row.event_name,
    event_time: Math.floor(new Date(row.event_time).getTime() / 1000),
    action_source: "system_generated",
    user_data: { lead_id: row.lead_id.slice(3) },          // „FB-1234…" → „1234…"
    custom_data: { event_source: "crm", lead_event_source: "Synexia CRM" },
  };
}

// lead_id 15–17 ციფრიანია და JS-ის რიცხვში ზუსტად ვერ ეტევა — JSON-ში რიცხვად ტექსტით ჩავსვამთ
const toJson = (events) =>
  JSON.stringify(events).replace(/"lead_id":"(\d{15,17})"/g, '"lead_id":$1');

async function send(events) {
  const ds = process.env.META_CRM_DATASET_ID, tok = process.env.META_CRM_TOKEN;
  const test = process.env.META_CRM_TEST_CODE;
  const body = `{"data":${toJson(events)}${test ? `,"test_event_code":${JSON.stringify(test)}` : ""}}`;
  const r = await fetch(`${GRAPH}/${ds}/events?access_token=${encodeURIComponent(tok)}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(JSON.stringify(j.error || j).slice(0, 400));
  return j;
}

exports.handler = async () => {
  if (!process.env.META_CRM_DATASET_ID || !process.env.META_CRM_TOKEN || !process.env.SUPABASE_SERVICE_KEY) {
    console.log("meta-crm-events: ENV ჯერ არ არის — არაფერს ვაგზავნი");
    return { statusCode: 200, body: "not configured" };
  }
  let sent = 0, failed = 0, stale = 0, skipped = 0;
  for (let round = 0; round < 10; round++) {
    const r = await sb(`meta_crm_events?select=id,lead_id,event_name,event_time&sent_at=is.null&error=is.null&order=id&limit=${BATCH}`,
                       { headers: { Prefer: "" } });
    let rows = await r.json();
    if (!rows.length) break;

    // ძველი ლიდის ეტაპი მეტას არ სჭირდება: ის მხოლოდ ლიდიდან 28 დღეში მომხდარ ეტაპს
    // ითვლის, 90 დღეზე ძველ ლიდს კი საერთოდ აღარ იცნობს („Invalid Lead ID") და
    // ასეთი ერთი მოვლენა მთელ პაკეტს აგდებს.
    const ids = [...new Set(rows.map(x => x.lead_id))];
    const born = new Map((await (await sb(`leads?select=id,created_at&id=in.(${ids.map(encodeURIComponent).join(",")})`,
                                          { headers: { Prefer: "" } })).json())
                           .map(l => [l.id, new Date(l.created_at).getTime() / 1000]));
    const now = Date.now() / 1000;
    const late = rows.filter(x => x.event_name !== "Lead" && born.has(x.lead_id)
                                  && new Date(x.event_time).getTime() / 1000 - born.get(x.lead_id) > LEAD_WINDOW);
    if (late.length) { await mark(late.map(x => x.id), { error: "ლიდი 28 დღეზე ძველია" }); skipped += late.length; }
    rows = rows.filter(x => !late.includes(x));

    const old = rows.filter(x => now - new Date(x.event_time).getTime() / 1000 > MAX_AGE);
    const fresh = rows.filter(x => !old.includes(x));
    if (old.length) { await mark(old.map(x => x.id), { error: "7 დღეზე ძველია" }); stale += old.length; }
    if (!fresh.length) continue;

    try {
      await send(fresh.map(toEvent));
      await mark(fresh.map(x => x.id), { sent_at: new Date().toISOString() });
      sent += fresh.length;
    } catch (e) {
      // პაკეტი ჩავარდა — სათითაოდ ვცდით, რომ ერთმა ცუდმა მოვლენამ დანარჩენი არ დაბლოკოს
      console.log("batch failed:", e.message);
      for (const x of fresh) {
        try { await send([toEvent(x)]); await mark([x.id], { sent_at: new Date().toISOString() }); sent++; }
        catch (e1) { await mark([x.id], { error: e1.message.slice(0, 400) }); failed++; }
      }
    }
  }
  const msg = `meta-crm-events: sent=${sent} failed=${failed} stale=${stale} old_lead=${skipped}`;
  console.log(msg);
  return { statusCode: 200, body: msg };
};
