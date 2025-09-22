import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// ===== Aliases ed espansioni =====
const DEST_ALIASES: Record<string, string> = {
  mediterraneo: "Mar Mediterraneo",
  "mediterranean": "Mar Mediterraneo",
  "west med": "Mediterraneo Occidentale",
  "east med": "Mediterraneo Orientale",
  "french riviera": "Costa Azzurra",
};

const DEST_EXPANDS: Record<string, string[]> = {
  "Mar Mediterraneo": ["Costa Azzurra", "Italia", "Grecia", "Spagna", "Isole Baleari", "Sardegna"],
  "Mediterraneo Occidentale": ["Costa Azzurra", "Isole Baleari", "Corsica", "Sardegna", "Italia"],
  "Mediterraneo Orientale": ["Grecia", "Croazia", "Turchia"],
};

const DEST_NEARBY: Record<string, string[]> = {
  "Costa Azzurra": ["Corsica", "Isole Baleari", "Italia"],
  "Grecia": ["Croazia", "Turchia"],
};

// Normalizza destinazioni
function canonDest(name: string) {
  if (!name) return name;
  const lower = name.toLowerCase();
  return DEST_ALIASES[lower] || name;
}
function expandDest(names: string[]): string[] {
  let out: string[] = [];
  names.forEach((n) => {
    out.push(n);
    if (DEST_EXPANDS[n]) out.push(...DEST_EXPANDS[n]);
  });
  return [...new Set(out)];
}

// ===== OpenAI helpers =====
async function detectLanguage(text: string): Promise<string> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Detect the language of the user input. Reply only with the ISO code (it, en, fr...)." },
      { role: "user", content: text },
    ],
  });
  return resp.choices[0].message.content?.trim().toLowerCase() || "it";
}

async function extractFilters(text: string): Promise<any> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Extract yacht search filters from the text. Return JSON with keys: guests_min, budget_max, destinations (array of strings). If not present, return null or empty." },
      { role: "user", content: text },
    ],
    response_format: { type: "json_object" },
  });
  try {
    return JSON.parse(resp.choices[0].message.content || "{}");
  } catch {
    return {};
  }
}

// ===== Query su Supabase =====
async function queryYachts(filters: any) {
  let query = supabase.from("yachts").select("*");

  if (filters.guests_min) query = query.gte("guests", filters.guests_min);
  if (filters.budget_max) query = query.lte("rate_high", filters.budget_max);

  if (filters.destinations && filters.destinations.length > 0) {
    const expanded = expandDest(filters.destinations);
    const term = expanded[0]; // prendi la prima canonica
    query = query.ilike("destinations::text", `%${term}%`);
  }

  const { data, error } = await query.limit(10);
  if (error) {
    console.error("Supabase query error:", error);
    return { data: [], note: { error: error.message } };
  }
  return { data, note: {} };
}

// ===== Formattazione yacht =====
function formatYachtItem(y: any) {
  const title = `**[${y.name} (${y.model || y.series || ""})](${y.permalink})**`;
  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr  = y.year ? `Anno: ${y.year}` : "";
  const gc  = (y.guests || y.cabins) ? `Ospiti/Cabine: ${y.guests || "-"} / ${y.cabins || "-"}` : "";
  const rate = (y.rate_low || y.rate_high)
    ? `Tariffa settimanale: ${y.rate_low ? y.rate_low.toLocaleString("it-IT") : "-"} - ${y.rate_high ? y.rate_high.toLocaleString("it-IT") : "-"} ${y.currency || "EUR"}`
    : "";
  const dest = Array.isArray(y.destinations) && y.destinations.length ? `Destinazioni principali: ${y.destinations.join(", ")}` : "";
  const hl   = y.highlights?.[0] ? `Punto forte: ${y.highlights[0]}` : "";

  const lines = [title, len && `Lunghezza: ${len}`, yr, gc, rate, dest, hl].filter(Boolean);
  return `- ${lines[0]}\n` + lines.slice(1).map(l => `  ${l}`).join("\n");
}

// ===== Handler principale =====
export default async function handler(req: VercelRequest, res: VercelResponse) {
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

    // lingua + filtri
    const language = await detectLanguage(lastUserMessage);
    const rawFilters = await extractFilters(lastUserMessage);
    const filters = { ...rawFilters };
    if (Array.isArray(filters.destinations)) {
      filters.destinations = filters.destinations.map((d: string) => canonDest(d));
    }

    // query yachts
    const { data: yachts, note } = await queryYachts(filters);
    const count = (yachts || []).length;

    // costruzione risposta
    let answer = "";
    if (count > 0) {
      const list = (yachts || []).slice(0, 5).map(formatYachtItem).join("\n\n");
      answer =
        (language.startsWith("en")
          ? `Here are some yachts matching your request:\n\n${list}\n\n*Rates per week, VAT & APA excluded.*`
          : `Ecco alcune opzioni in linea con la tua richiesta:\n\n${list}\n\n*Tariffe a settimana, VAT & APA esclusi.*`);
    } else {
      answer =
        (language.startsWith("en")
          ? `I couldn't find exact matches. Would you like to adjust budget or guests, or consider nearby areas?`
          : `Non ho trovato corrispondenze esatte. Vuoi modificare budget o ospiti, oppure considerare aree vicine?`);
    }

    res.status(200).json({
      answer_markdown: answer,
      language,
      filters_used: filters,
      note,
      results_count: count,
      yachts: yachts || [],
      cta_suggested: true
    });
  } catch (err: any) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}

