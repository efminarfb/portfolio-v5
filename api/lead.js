// POST /api/lead — stores a portfolio enquiry in Supabase (table: portfolio_leads).
// Runs as a Vercel serverless function. The Supabase service key never reaches the browser.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const ALLOWED_ORIGINS = [
  "https://portfolio-v5.vercel.app",
  "https://efminarfb.github.io",
];

// crude per-instance rate limit: 5 enquiries per IP per 10 minutes
const hits = new Map();
const WINDOW = 10 * 60 * 1000;
const MAX = 5;

function throttled(ip) {
  if (!ip) return false;
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 500) {
    for (const [key, times] of hits) {
      if (!times.some((t) => now - t < WINDOW)) hits.delete(key);
    }
  }
  return list.length > MAX;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  const allow = ALLOWED_ORIGINS.indexOf(origin) >= 0 ? origin : ALLOWED_ORIGINS[0];

  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  const send = (status, payload) => {
    res.status(status).json(payload);
  };

  if (req.method !== "POST") {
    send(405, { ok: false, error: "Use POST." });
    return;
  }
  if (!SUPABASE_URL || !SERVICE_KEY) {
    console.error("lead: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    send(500, { ok: false, error: "The backend is not configured yet." });
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch (e) {
      body = null;
    }
  }
  if (!body || typeof body !== "object") {
    send(400, { ok: false, error: "Malformed request." });
    return;
  }

  const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

  const name = str(body.name, 120);
  const email = str(body.email, 200).toLowerCase();
  const business = str(body.business, 160);
  const budget = str(body.budget, 80);
  const message = str(body.message, 4000);
  const trap = str(body.company, 100); // honeypot field, humans never see it
  const page = str(body.page, 200);

  if (trap) {
    send(200, { ok: true });
    return;
  }
  if (name.length < 2) {
    send(422, { ok: false, error: "Please add your name." });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    send(422, { ok: false, error: "That email looks incomplete." });
    return;
  }
  if (message.length < 10) {
    send(422, { ok: false, error: "Tell me a little more about the project." });
    return;
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || null;
  if (throttled(ip)) {
    send(429, { ok: false, error: "Too many messages just now. Try again in a few minutes." });
    return;
  }

  const row = {
    name,
    email,
    business: business || null,
    budget: budget || null,
    message,
    page: page || "/",
    source: "portfolio-v5",
    user_agent: str(req.headers["user-agent"], 300) || null,
    ip,
  };

  try {
    const upstream = await fetch(`${SUPABASE_URL}/rest/v1/portfolio_leads`, {
      method: "POST",
      headers: {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error("lead: supabase rejected the insert", upstream.status, detail.slice(0, 300));
      send(502, { ok: false, error: "Could not save your message. Email me instead." });
      return;
    }

    send(200, { ok: true });
  } catch (err) {
    console.error("lead: fetch failed", err && err.message);
    send(502, { ok: false, error: "Could not reach the database. Email me instead." });
  }
};
