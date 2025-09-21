// api/assistant.ts
import OpenAI from "openai";

// ⚙️ Env: imposta OPENAI_API_KEY su Vercel
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });

// Normalizza nomi destinazioni più comuni (IT/EN)
const DEST_ALIASES: Record<string, string> = {
  greece: "Grecia",
  grecia: "Grecia",
  greek: "Grecia",
  croatia: "Croazia",
  croazia: "Croazia",
  france: "Francia",
  francia: "Francia",
  italy: "Italia",
  italia: "Italia",
  sardinia: "Sardegna",
  sardinien: "Sardegna",
  corsica: "Corsica",
  balearic: "Baleari",
  balearicislands: "Baleari",
  baleari: "Baleari",
  aegean: "Egeo",
  ionian: "Ionio",
};

function normalizeDestination(d: string) {
  const key = d.toLowerCase().replace(/\s+/g, "");
  return DEST_ALIASES[key] || d.trim();
}

// Costruiamo la base URL dell’API interna (search-yachts)
function baseUrlFromReq(req: any) {
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  const proto = (req.headers["x-forwarded-proto"] || "https") + "://";
  return `${proto}${host}`;
}

type Filters = {
  language?: "it" | "en";
  guests_min?: number;
  cabins_min?: number;
  budget_max?: number;        // EUR/week
  destinations?: string[];    // es. ["Grecia","Croazia"]
  series?: ("SL" | "SD" | "SX" | "SP")[];
  model_like?: string;        // es. "SL96A" (substring)
  length_min?: number;        // m
  length_max?: number;        // m
  year_min?: number;
  year_max?: number;
  sort_by?: "price_asc" | "length_desc" | "year_desc";
};

type AssistantResponse = {
  answer_markdown: string;
  filters_used: Filters;
  yachts: any[];
  results_count: number;
  needs_followup?: boolean;
  followup_question?: string;
};

// Prompt “system” forte: solo listing SLCF, niente allucinazioni
const SYSTEM = `
You are SLCF's website assistant. Speak the user's language (Italian by default if user is Italian).
STRICT RULES:
- Topic must remain ONLY Sanlorenzo Charter Fleet listings and charter info derived from provided data.
- Do not invent yachts or prices. Use ONLY the provided search results.
- If user asks non-related topics, politely redirect to SLCF listings.
- Be concise, luxury tone, and end with a CTA to leave contact details for recall (name + email/phone).
- Prices are per week, typically VAT and APA excluded; mention this when quoting prices.
`;

// Schema (testuale) per estrazione filtri
const FILTER_INSTRUCTIONS = `
Extract a JSON object with these optional fields:
- language: "it" | "en"
- guests_min: number
- cabins_min: number
- budget_max: number (EUR per week)
- destinations: string[] (Italian names if possible)
- series: array of "SL"|"SD"|"SX"|"SP"
- model_like: string
- length_min: number
- length_max: number
- year_min: number
- year_max: number
- sort_by: "price_asc" | "length_desc" | "year_desc"

Only output pure JSON, no prose.
Examples:
Input: "Yacht per 10 persone tra Grecia e Croazia sotto 100k"
JSON: {"language":"it","guests_min":10,"budget_max":100000,"destinations":["Grecia","Croazia"]}
`;

// “Formatter” risposta
const ANSWER_INSTRUCTIONS = `
Write a short, luxury-styled answer. If there are results, present up to 3 best-fit yachts as bullet points:
- Name (Model), length m, year, guests/cabins, typical weekly rate range (EUR), main destinations
- One key highlight if available
- Add the permalink
Then close with: "Vuoi una proposta personalizzata? Lasciami nome ed email/telefono e ti richiamiamo."
If no results: suggest relaxing constraints (budget, destinations, guests) and ask one clarifying question.
Always note: "Tariffe a settimana, VAT & APA esclusi."
`;

async function extractFilters(userText: string): Promise<Filters> {
  // 1) chiediamo all'AI di estrarre filtri in JSON
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.2,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: FILTER_INSTRUCTIONS + "\n\nInput:\n" + userText }
    ],
    response_format: { type: "json_object" }
  });

  let raw: any = {};
  try {
    raw = JSON.parse(r.choices[0].message.content || "{}");
  } catch {
    raw = {};
  }

  // Normalizzazioni minime lato codice
  const f: Filters = {};
  f.language = raw.language === "en" ? "en" : "it";

  if (typeof raw.guests_min === "number") f.guests_min = raw.guests_min;
  if (typeof raw.cabins_min === "number") f.cabins_min = raw.cabins_min;
  if (typeof raw.budget_max === "number") f.budget_max = raw.budget_max;

  if (Array.isArray(raw.destinations)) {
    f.destinations = raw.destinations.map((d: string) => normalizeDestination(d));
  }

  if (Array.isArray(raw.series)) {
    f.series = raw.series.filter((s: string) => ["SL","SD","SX","SP"].includes(s)) as any;
  }

  if (typeof raw.model_like === "string" && raw.model_like.trim()) f.model_like = raw.model_like.trim();

  if (typeof raw.length_min === "number") f.length_min = raw.length_min;
  if (typeof raw.length_max === "number") f.length_max = raw.length_max;
  if (typeof raw.year_min === "number") f.year_min = raw.year_min;
  if (typeof raw.year_max === "number") f.year_max = raw.year_max;

  if (["price_asc","length_desc","year_desc"].includes(raw.sort_by)) f.sort_by = raw.sort_by;

  return f;
}

function buildSearchUrl(baseUrl: string, f: Filters) {
  const u = new URL(baseUrl + "/api/search-yachts");
  if (f.guests_min) u.searchParams.set("guests", String(f.guests_min));
  if (f.budget_max) u.searchParams.set("budget", String(f.budget_max));
  if (f.destinations?.length) u.searchParams.set("destinations", f.destinations.join(","));
  // Nota: /api/search-yachts attuale filtra guests/destinations/budget.
  // Se vuoi anche series/model/length/year/sort_by, estendi la tua search-yachts di conseguenza.
  return u.toString();
}

async function craftAnswer(
  language: "it" | "en",
  userText: string,
  filters: Filters,
  yachts: any[]
): Promise<string> {
  const langHead = language === "en"
    ? "You are the assistant for Sanlorenzo Charter Fleet."
    : "Sei l’assistente di Sanlorenzo Charter Fleet.";
  const dataBlock = JSON.stringify(
    yachts.slice(0, 5).map((y) => ({
      name: y.name,
      model: y.model,
      series: y.series,
      year: y.year,
      length_m: y.length_m,
      guests: y.guests,
      cabins: y.cabins,
      crew: y.crew,
      rate_low: y.rate_low,
      rate_high: y.rate_high,
      currency: y.currency,
      destinations: y.destinations,
      highlight: (y.highlights && y.highlights[0]) || null,
      permalink: y.permalink
    }))
  );

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: `${langHead}\nUser request:\n${userText}\n\nAvailable yachts (JSON):\n${dataBlock}\n\n${ANSWER_INSTRUCTIONS}` }
    ]
  });

  return r.choices[0].message.content || "";
}

export default async function handler(req: any, res: any) {
  try {
    // CORS base (utile per il widget)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") return res.status(200).end();
    if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

    const { message } = req.body || {};
    if (!message || typeof message !== "string") {
      return res.status(400).json({ error: "Missing 'message' string in body" });
    }

    // 1) Estrai filtri
    const filters = await extractFilters(message);
    const language = filters.language || "it";

    // 2) Chiama la search interna
    const base = baseUrlFromReq(req);
    const url = buildSearchUrl(base, filters);
    const searchResp = await fetch(url);
    if (!searchResp.ok) throw new Error(`search-yachts error ${searchResp.status}`);
    const { yachts = [] } = await searchResp.json();

    // 3) Se non ci sono risultati, proponi follow-up/relax
    if (!yachts.length) {
      const noRes = await craftAnswer(language, message, filters, []);
      const followup =
        language === "en"
          ? "Would you consider a slightly higher budget, fewer guests, or nearby destinations (e.g., Ionian or Aegean)?"
          : "Valuteresti un budget leggermente più alto, meno ospiti o destinazioni vicine (es. Ionio o Egeo)?";

      const out: AssistantResponse = {
        answer_markdown: noRes || (language === "en"
          ? "I couldn’t find a perfect match. Try relaxing budget/guests/destinations. Prices are per week, VAT & APA excluded."
          : "Non ho trovato una corrispondenza perfetta. Prova a rilassare budget/ospiti/destinazioni. Tariffe a settimana, VAT & APA esclusi."),
        filters_used: filters,
        yachts: [],
        results_count: 0,
        needs_followup: true,
        followup_question: followup
      };
      return res.status(200).json(out);
    }

    // 4) Genera risposta naturale
    const answer = await craftAnswer(language, message, filters, yachts);

    const out: AssistantResponse = {
      answer_markdown: answer,
      filters_used: filters,
      yachts: yachts.slice(0, 5),
      results_count: yachts.length
    };

    return res.status(200).json(out);
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
