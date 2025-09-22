// api/assistant.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ===== ALIAS & GEOGRAFIA (IT canonical) =====
const DEST_ALIASES: Record<string, string> = {
  // Macro
  "mediterranean": "Mediterraneo",
  "mediterraneo": "Mediterraneo",
  "west mediterranean": "Mediterraneo Occidentale",
  "mediterraneo occidentale": "Mediterraneo Occidentale",
  "east mediterranean": "Mediterraneo Orientale",
  "mediterraneo orientale": "Mediterraneo Orientale",
  "caribbean": "Caraibi",
  "caraibi": "Caraibi",

  // Bahamas & vicini
  "bahamas": "Bahamas",
  "exuma": "Exumas",
  "exumas": "Exumas",
  "abaco": "Abaco",
  "abacos": "Abaco",
  "nassau": "Bahamas",
  "bimini": "Bahamas",
  "turks and caicos": "Turks e Caicos",
  "turks&caicos": "Turks e Caicos",

  // Riviera francese
  "french riviera": "Costa Azzurra",
  "cote d azur": "Costa Azzurra",
  "côte d'azur": "Costa Azzurra",
  "costa azzurra": "Costa Azzurra",
  "monaco": "Costa Azzurra",
  "st tropez": "Costa Azzurra",
  "saint tropez": "Costa Azzurra",
  "cannes": "Costa Azzurra",
  "antibes": "Costa Azzurra",
  "nice": "Costa Azzurra",

  // Italia / Spagna / Francia
  "italy": "Italia",
  "italia": "Italia",
  "liguria": "Liguria",
  "tuscany": "Toscana",
  "toscana": "Toscana",
  "sardinia": "Sardegna",
  "sardegna": "Sardegna",
  "sicily": "Sicilia",
  "sicilia": "Sicilia",
  "amalfi": "Costiera Amalfitana",
  "costiera amalfitana": "Costiera Amalfitana",
  "eolie": "Isole Eolie",
  "france": "Francia",
  "francia": "Francia",
  "corsica": "Corsica",
  "spain": "Spagna",
  "spagna": "Spagna",
  "balearic": "Baleari",
  "balearic islands": "Baleari",
  "baleari": "Baleari",
  "ibiza": "Baleari",
  "mallorca": "Baleari",
  "menorca": "Baleari",

  // East Med
  "greece": "Grecia",
  "grecia": "Grecia",
  "aegean": "Egeo",
  "egeo": "Egeo",
  "ionian": "Ionio",
  "ionio": "Ionio",
  "cyclades": "Cicladi",
  "dodecanese": "Dodecaneso",
  "croatia": "Croazia",
  "croazia": "Croazia",
  "montenegro": "Montenegro",
  "turkey": "Turchia",
  "turchia": "Turchia",
};

const DEST_EXPANDS: Record<string, string[]> = {
  // Macro → sotto-aree
  "Mediterraneo": [
    "Mediterraneo Occidentale", "Mediterraneo Orientale",
    "Italia", "Francia", "Spagna",
    "Costa Azzurra", "Sardegna", "Corsica", "Sicilia", "Baleari",
    "Liguria", "Toscana", "Grecia", "Croazia", "Montenegro",
    "Ionio", "Egeo", "Turchia", "Costiera Amalfitana", "Isole Eolie",
  ],
  "Mediterraneo Occidentale": [
    "Costa Azzurra", "Corsica", "Sardegna", "Baleari", "Liguria", "Toscana", "Sicilia", "Francia", "Italia", "Spagna",
  ],
  "Mediterraneo Orientale": [
    "Grecia", "Croazia", "Montenegro", "Ionio", "Egeo", "Turchia",
  ],
  // Caraibi → sotto-aree tipiche charter
  "Caraibi": [
    "Bahamas", "Exumas", "Abaco", "Turks e Caicos"
    // (aggiungi: "Isole Vergini", "Leeward", "Windward" se mai servissero)
  ],
  // Costa Azzurra: già specifica, nessuna espansione necessaria
  "Costa Azzurra": ["Costa Azzurra", "Francia"],
  // Bahamas: includi sub-regioni
  "Bahamas": ["Bahamas", "Exumas", "Abaco"],
};

const NEARBY: Record<string, string[]> = {
  "Costa Azzurra": ["Corsica", "Liguria", "Sardegna", "Baleari"],
  "Sardegna": ["Corsica", "Costa Azzurra", "Baleari", "Liguria", "Toscana"],
  "Grecia": ["Ionio", "Egeo", "Turchia", "Croazia"],
  "Croazia": ["Montenegro", "Grecia", "Italia", "Ionio"],
  "Baleari": ["Sardegna", "Corsica", "Costa Azzurra"],
  "Bahamas": ["Exumas", "Abaco", "Turks e Caicos"],
};

function normKey(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, "");
}
function canonDest(dest: string): string {
  return DEST_ALIASES[normKey(dest)] || dest.trim();
}
function expandDestinations(dests: string[]): string[] {
  const set = new Set<string>();
  for (const d of dests) {
    const c = canonDest(d);
    set.add(c);
    (DEST_EXPANDS[c] || []).forEach((x) => set.add(x));
  }
  return Array.from(set);
}

// ===== AI helpers =====
async function detectLanguage(text: string): Promise<string> {
  if (!text) return "it";
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Detect the language. Reply only with 'it','en','fr','es','de'." },
      { role: "user", content: text },
    ],
    max_tokens: 5,
    temperature: 0,
  });
  return (r.choices[0].message.content || "it").trim().toLowerCase();
}

async function extractFilters(lastUserMessage: string) {
  const INSTR = `
Estrai un JSON (solo JSON) con campi opzionali:
- guests_min: number
- budget_max: number (EUR/week)
- destinations: string[] (accetta macro: "Mediterraneo","Caraibi" o specifiche: "Bahamas","Costa Azzurra")
- series: array "SL"|"SD"|"SX"|"SP"
- model_like: string
- length_min: number
- length_max: number
- year_min: number
- year_max: number`;
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: INSTR },
      { role: "user", content: lastUserMessage },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  });
  try {
    return JSON.parse(r.choices[0].message.content || "{}");
  } catch {
    return {};
  }
}

// ===== Query Supabase con espansioni & fallback rigorosi =====
async function queryYachts(filters: any) {
  const guests = filters.guests_min ? Number(filters.guests_min) : undefined;
  const budget = filters.budget_max ? Number(filters.budget_max) : undefined;
  const lengthMin = filters.length_min ? Number(filters.length_min) : undefined;
  const lengthMax = filters.length_max ? Number(filters.length_max) : undefined;
  const yearMin = filters.year_min ? Number(filters.year_min) : undefined;
  const yearMax = filters.year_max ? Number(filters.year_max) : undefined;
  const series = Array.isArray(filters.series) ? filters.series : undefined;
  const modelLike = typeof filters.model_like === "string" && filters.model_like.trim() ? filters.model_like.trim() : undefined;

  const originalDest = Array.isArray(filters.destinations) ? filters.destinations : [];
  const expanded = originalDest.length ? expandDestinations(originalDest) : [];

  const buildBase = () => {
    let q = supabase.from("yachts").select("*").eq("is_active", true);
    if (guests) q = q.gte("guests", guests);
    if (budget) q = q.lte("rate_high", budget);
    if (lengthMin) q = q.gte("length_m", lengthMin);
    if (lengthMax) q = q.lte("length_m", lengthMax);
    if (yearMin) q = q.gte("year", yearMin);
    if (yearMax) q = q.lte("year", yearMax);
    if (series && series.length) q = q.in("series", series);
    if (modelLike) q = q.ilike("model", `%${modelLike}%`);
    return q;
  };

  // 1) Se l'utente ha chiesto destinazioni → filtra SOLO per quelle (espanse).
  if (expanded.length) {
    const { data, error } = await buildBase()
      .overlaps("destinations", expanded)
      .order("rate_low", { ascending: true })
      .limit(5);
    if (!error && data && data.length) return { data, note: { mode: "primary", used: expanded } };
  } else {
    // nessuna destinazione: applica gli altri filtri
    const { data } = await buildBase().order("rate_low", { ascending: true }).limit(5);
    if (data && data.length) return { data, note: { mode: "nofilter" } };
  }

  // 2) Nessun risultato: se c'è UNA destinazione specifica, prova le vicine
  if (originalDest.length === 1) {
    const canon = canonDest(originalDest[0]);
    const near = NEARBY[canon];
    if (near?.length) {
      const { data } = await buildBase()
        .overlaps("destinations", near)
        .order("rate_low", { ascending: true })
        .limit(5);
      if (data && data.length) return { data, note: { mode: "nearby", base: canon, used: near } };
    }
  }

  // 3) Se l'utente ha dato una macro (es. Caraibi), riprova con la sua espansione specifica
  for (const d of originalDest) {
    const canon = canonDest(d);
    const exp = DEST_EXPANDS[canon];
    if (exp?.length) {
      const { data } = await buildBase()
        .overlaps("destinations", exp)
        .order("rate_low", { ascending: true })
        .limit(5);
      if (data && data.length) return { data, note: { mode: "macro", base: canon, used: exp } };
    }
  }

  // 4) Ultimo tentativo (opzionale): rilassa solo il budget (se presente)
  if (budget) {
    let q = supabase.from("yachts").select("*").eq("is_active", true);
    if (guests) q = q.gte("guests", guests);
    if (lengthMin) q = q.gte("length_m", lengthMin);
    if (lengthMax) q = q.lte("length_m", lengthMax);
    if (yearMin) q = q.gte("year", yearMin);
    if (yearMax) q = q.lte("year", yearMax);
    if (series && series.length) q = q.in("series", series);
    if (modelLike) q = q.ilike("model", `%${modelLike}%`);
    if (expanded.length) q = q.overlaps("destinations", expanded);
    const { data } = await q.order("rate_low", { ascending: true }).limit(5);
    if (data && data.length) return { data, note: { mode: "relaxed_budget", removed: "budget", used: expanded } };
  }

  // Nessun risultato in nessun fallback → restituisci vuoto
  return { data: [], note: { mode: "none" } };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const conversation = body.conversation || [];
    const userName = body.user || "ospite";

    const lastUserMessage =
      (conversation as any[]).filter((m) => m.role === "user").pop()?.content || "";

    // 1) lingua
    const language = await detectLanguage(lastUserMessage);

    // 2) filtri
    const rawFilters = await extractFilters(lastUserMessage);
    const filters = { ...rawFilters };
    if (Array.isArray(filters.destinations)) {
      filters.destinations = filters.destinations.map((d: string) => canonDest(d));
    }

    // 3) query yacht con espansioni & fallback RIGOROSI (niente risultati casuali)
    const { data: yachts, note } = await queryYachts(filters);

    // 4) risposta
    const EXPLAIN =
      note.mode === "nearby"
        ? (language.startsWith("en")
            ? `Note: I couldn’t find exact availability in “${note.base}”. I’m showing nearby areas: ${(note.used || []).join(", ")}.`
            : `Nota: non ho trovato disponibilità esatta in “${note.base}”. Ti propongo zone vicine: ${(note.used || []).join(", ")}.`)
        : note.mode === "macro"
        ? (language.startsWith("en")
            ? `I considered the area “${note.base}” including: ${(note.used || []).join(", ")}.`
            : `Ho considerato l'area “${note.base}” includendo: ${(note.used || []).join(", ")}.`)
        : note.mode === "relaxed_budget"
        ? (language.startsWith("en")
            ? `I also included some options slightly above the indicated budget.`
            : `Ho incluso anche alcune opzioni oltre il budget indicato.`)
        : "";

    const SYSTEM = `
You are SLCF's website assistant. Always respond in ${language}.
Use only provided yachts; do NOT invent listings. If no matches, say so and propose the closest alternatives or ask to relax constraints.
Keep a luxury yet concise tone. Always end with: "Vuoi una proposta personalizzata? Lasciami email e (se vuoi) telefono."
Mention: "Tariffe a settimana, VAT & APA esclusi."`;

    const dataBlock = JSON.stringify(
      (yachts || []).slice(0, 5).map((y: any) => ({
        name: y.name, model: y.model, series: y.series,
        year: y.year, length_m: y.length_m,
        guests: y.guests, cabins: y.cabins,
        rate_low: y.rate_low, rate_high: y.rate_high, currency: y.currency,
        destinations: y.destinations, highlight: y.highlights?.[0] || null,
        permalink: y.permalink,
      }))
    );

    const USER = `
User name: ${userName}
User query: ${lastUserMessage}

${EXPLAIN}

Yachts (JSON): ${dataBlock}

If there are 1–5 yachts, list them as bullets with: Name (Model), length m, year, guests/cabins, weekly rate range (EUR), main destinations, one key highlight (if any), and the permalink.
If there are 0 yachts, say no exact matches for that area, suggest nearby areas (if provided above) or propose popular alternatives, and ask a clarifying follow-up. Then close with the CTA.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.5,
      max_tokens: 700,
      messages: [
        { role: "system", content: SYSTEM },
        ...conversation,
        { role: "user", content: USER },
      ],
    });

    const answer = completion.choices[0].message.content || "";

    res.status(200).json({
      answer_markdown: answer,
      language,
      filters_used: filters,
      note,
      results_count: (yachts || []).length,
      yachts: yachts || [],
    });
  } catch (e: any) {
    console.error("Assistant error:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}
