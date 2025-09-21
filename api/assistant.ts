// api/assistant.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ---------- Normalizzazione & geografia ----------

// Canonical in IT (come nel DB). Aggiungi/ritocca se necessario.
const DEST_ALIASES: Record<string, string> = {
  // macro
  "mediterranean": "Mediterraneo",
  "mediterraneo": "Mediterraneo",
  "westmed": "Mediterraneo Occidentale",
  "west mediterranean": "Mediterraneo Occidentale",
  "mediterraneo occidentale": "Mediterraneo Occidentale",
  "estmed": "Mediterraneo Orientale",
  "east mediterranean": "Mediterraneo Orientale",
  "mediterraneo orientale": "Mediterraneo Orientale",

  // riviera francese
  "frenchriviera": "Costa Azzurra",
  "french riviera": "Costa Azzurra",
  "cotedazur": "Costa Azzurra",
  "côte d'azur": "Costa Azzurra",
  "cote d azur": "Costa Azzurra",
  "riviera francese": "Costa Azzurra",
  "costa azzurra": "Costa Azzurra",
  "monaco": "Costa Azzurra",
  "sttropez": "Costa Azzurra",
  "saint tropez": "Costa Azzurra",
  "cannes": "Costa Azzurra",
  "antibes": "Costa Azzurra",
  "nice": "Costa Azzurra",

  // italia
  "italy": "Italia",
  "italia": "Italia",
  "liguria": "Liguria",
  "toscana": "Toscana",
  "sardinia": "Sardegna",
  "sardegna": "Sardegna",
  "sicily": "Sicilia",
  "sicilia": "Sicilia",
  "amalfi": "Costiera Amalfitana",
  "costiera amalfitana": "Costiera Amalfitana",
  "eolie": "Isole Eolie",

  // spagna
  "spain": "Spagna",
  "spagna": "Spagna",
  "baleari": "Baleari",
  "balearic": "Baleari",
  "balearic islands": "Baleari",
  "ibiza": "Baleari",
  "mallorca": "Baleari",
  "menorca": "Baleari",
  "costa brava": "Spagna",
  "catalunya": "Spagna",

  // francia
  "france": "Francia",
  "francia": "Francia",
  "corsica": "Corsica",
  "corsica (france)": "Corsica",

  // east med
  "greece": "Grecia",
  "grecia": "Grecia",
  "aegean": "Egeo",
  "egeo": "Egeo",
  "ionian": "Ionio",
  "ionio": "Ionio",
  "cyclades": "Cicladi",
  "dodecanese": "Dodecaneso",
  "sporades": "Sporadi",
  "croatia": "Croazia",
  "croazia": "Croazia",
  "montenegro": "Montenegro",
  "albania": "Albania",
  "turkey": "Turchia",
  "turchia": "Turchia",
};

// Espansioni per macro-aree
const DEST_EXPANDS: Record<string, string[]> = {
  "Mediterraneo": [
    "Mediterraneo Occidentale",
    "Mediterraneo Orientale",
    "Italia",
    "Francia",
    "Spagna",
    "Costa Azzurra",
    "Sardegna",
    "Corsica",
    "Sicilia",
    "Baleari",
    "Liguria",
    "Toscana",
    "Grecia",
    "Croazia",
    "Montenegro",
    "Ionio",
    "Egeo",
    "Turchia",
    "Costiera Amalfitana",
    "Isole Eolie",
  ],
  "Mediterraneo Occidentale": [
    "Costa Azzurra",
    "Corsica",
    "Sardegna",
    "Baleari",
    "Liguria",
    "Toscana",
    "Sicilia",
    "Spagna",
    "Francia",
    "Italia",
  ],
  "Mediterraneo Orientale": [
    "Grecia",
    "Croazia",
    "Montenegro",
    "Albania",
    "Ionio",
    "Egeo",
    "Turchia",
  ],
  "Costa Azzurra": ["Costa Azzurra", "Francia"], // includi sinonimi già mappati in aliases
};

// Vicinanze per fallback (se zona specifica vuota)
const NEARBY: Record<string, string[]> = {
  "Costa Azzurra": ["Corsica", "Liguria", "Sardegna", "Baleari", "Francia", "Italia"],
  "Sardegna": ["Corsica", "Costa Azzurra", "Baleari", "Liguria", "Toscana"],
  "Grecia": ["Ionio", "Egeo", "Turchia", "Croazia"],
  "Croazia": ["Montenegro", "Grecia", "Italia", "Ionio"],
  "Baleari": ["Costa Brava", "Sardegna", "Corsica", "Spagna"],
};

function normKey(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\s+/g, "");
}

function canonDest(dest: string): string {
  const k = normKey(dest);
  return DEST_ALIASES[k] || dest.trim();
}

function expandDestinations(dests: string[]): string[] {
  const set = new Set<string>();
  for (const d of dests) {
    const canon = canonDest(d);
    set.add(canon);
    const exp = DEST_EXPANDS[canon];
    if (exp) exp.forEach((e) => set.add(e));
    // Aggiungi sinonimi “impliciti” di Costa Azzurra già normalizzati in ALIASES → diventano "Costa Azzurra"
  }
  return Array.from(set);
}

// ---------- AI helpers ----------

async function detectLanguage(text: string): Promise<string> {
  if (!text) return "it";
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Detect the language. Reply only with a BCP-47 like code such as 'it', 'en', 'fr', 'es', 'de'." },
      { role: "user", content: text },
    ],
    max_tokens: 5,
    temperature: 0,
  });
  return (r.choices[0].message.content || "it").trim().toLowerCase();
}

async function extractFilters(lastUserMessage: string) {
  const INSTR = `
Estrai un JSON con i campi (tutti opzionali):
- guests_min: number
- budget_max: number (EUR/week)
- destinations: string[] (accetta macro come "Mediterraneo" o specifiche come "Costa Azzurra")
- series: array di "SL"|"SD"|"SX"|"SP"
- model_like: string
- length_min: number
- length_max: number
- year_min: number
- year_max: number
Rispondi SOLO con JSON.`;
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

// ---------- Query Supabase con espansioni e fallback ----------

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

  // helper per costruire query base
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

  // 1) Ricerca primaria: overlap con expanded (OR tra destinazioni)
  if (expanded.length) {
    let q = buildBase().overlaps("destinations", expanded).order("rate_low", { ascending: true }).limit(5);
    const { data, error } = await q;
    if (!error && data && data.length) {
      return { data, note: { mode: "primary", used: expanded } };
    }
  } else {
    // nessuna destinazione: solo altri filtri
    let q = buildBase().order("rate_low", { ascending: true }).limit(5);
    const { data } = await q;
    if (data && data.length) return { data, note: { mode: "nofilter" } };
  }

  // 2) Fallback “vicinanze” se una sola destinazione specifica
  if (originalDest.length === 1) {
    const canon = canonDest(originalDest[0]);
    const near = NEARBY[canon];
    if (near && near.length) {
      let q = buildBase().overlaps("destinations", near).order("rate_low", { ascending: true }).limit(5);
      const { data } = await q;
      if (data && data.length) {
        return { data, note: { mode: "nearby", base: canon, used: near } };
      }
    }
  }

  // 3) Fallback macro-area se l’utente ha citato una macro
  if (originalDest.length) {
    // se hanno citato una macro tipo Mediterraneo Occ./Orientale, riprova con quella specifica espansione
    for (const d of originalDest) {
      const canon = canonDest(d);
      const exp = DEST_EXPANDS[canon];
      if (exp && exp.length) {
        let q = buildBase().overlaps("destinations", exp).order("rate_low", { ascending: true }).limit(5);
        const { data } = await q;
        if (data && data.length) {
          return { data, note: { mode: "macro", base: canon, used: exp } };
        }
      }
    }
  }

  // 4) Ultimo tentativo: togli il vincolo budget (se presente), mantieni il resto
  if (budget) {
    let q = buildBase(); // ricrea
    // rimuovi budget
    q = supabase.from("yachts").select("*").eq("is_active", true);
    if (guests) q = q.gte("guests", guests);
    if (lengthMin) q = q.gte("length_m", lengthMin);
    if (lengthMax) q = q.lte("length_m", lengthMax);
    if (yearMin) q = q.gte("year", yearMin);
    if (yearMax) q = q.lte("year", yearMax);
    if (series && series.length) q = q.in("series", series);
    if (modelLike) q = q.ilike("model", `%${modelLike}%`);
    if (expanded.length) q = q.overlaps("destinations", expanded);
    const { data } = await q.order("rate_low", { ascending: true }).limit(5);
    if (data && data.length) {
      return { data, note: { mode: "relaxed_budget", removed: "budget", used: expanded } };
    }
  }

  return { data: [], note: { mode: "none" } };
}

// ---------- Handler ----------

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const { conversation = [], user: userName = "ospite" } = req.body || {};

    const lastUserMessage =
      (conversation as any[]).filter((m) => m.role === "user").pop()?.content || "";

    // 1) lingua
    const language = await detectLanguage(lastUserMessage || "");

    // 2) estrai filtri dal testo
    const rawFilters = await extractFilters(lastUserMessage || "");
    const filters = { ...rawFilters };

    // Normalizza destinazioni
    if (Array.isArray(filters.destinations)) {
      filters.destinations = filters.destinations.map((d: string) => canonDest(d));
    }

    // 3) query con espansioni + fallback
    const { data: yachts, note } = await queryYachts(filters);

    // 4) prompt risposta
    const EXPLAIN_FALLBACK =
      note.mode === "nearby"
        ? `Nota: non ho trovato disponibilità esatta in "${note.base}", ti propongo zone vicine (${(note.used || []).join(", ")}).`
        : note.mode === "macro"
        ? `Ho considerato l'area "${note.base}" includendo: ${(note.used || []).join(", ")}.`
        : note.mode === "relaxed_budget"
        ? `Per darti alternative ho mostrato opzioni anche oltre il budget indicato.`
        : ``;

    const SYSTEM = `
You are SLCF's website assistant. Always respond in ${language}.
Use only the provided yacht data. Keep a luxury yet concise tone.
If no exact match, explain what you relaxed (area or budget) and propose the closest alternatives.
Always end with: "Vuoi una proposta personalizzata? Lasciami email e (se vuoi) telefono."
Mention: "Tariffe a settimana, VAT & APA esclusi."`;

    const dataBlock = JSON.stringify(
      (yachts || []).slice(0, 5).map((y: any) => ({
        name: y.name,
        model: y.model,
        series: y.series,
        year: y.year,
        length_m: y.length_m,
        guests: y.guests,
        cabins: y.cabins,
        rate_low: y.rate_low,
        rate_high: y.rate_high,
        currency: y.currency,
        destinations: y.destinations,
        highlight: y.highlights?.[0] || null,
        permalink: y.permalink,
      }))
    );

    const USER = `
User name: ${userName}
User query: ${lastUserMessage}

${EXPLAIN_FALLBACK}

Yachts (JSON): ${dataBlock}

Write a short answer, list up to 3–5 yachts as bullets with: Name (Model), length m, year, guests/cabins, rate range, main destinations, one highlight if present, and the permalink.
Then close with the CTA.`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.5,
      messages: [
        { role: "system", content: SYSTEM },
        ...conversation, // mantieni il contesto della chat
        { role: "user", content: USER },
      ],
      max_tokens: 700,
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
    console.error(e);
    res.status(500).json({ error: e?.message || String(e) });
  }
}
