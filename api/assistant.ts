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

// ===== Query di base =====
async function baseQuery(filters: any, destinations: string[]) {
  let query = supabase.from("yachts").select("*");

  if (filters.guests_min) query = query.gte("guests", filters.guests_min);
  if (filters.budget_max) query = query.lte("rate_high", filters.budget_max);

  if (destinations && destinations.length > 0) {
    // ✅ Usa overlaps con array
    query = query.overlaps("destinations", destinations);
  }

  const { data, error } = await query.limit(10);
  if (error) {
    console.error("Supabase query error:", error);
    return [];
  }
  return data || [];
}

// ===== Query con fallback =====
async function queryYachts(filters: any) {
  let note: any = {};

  // Step 1: diretta
  let data = await baseQuery(filters, filters.destinations || []);
  if (data.length > 0) return { data, note: { mode: "direct" } };

  // Step 2: macro-area
  if (filters.destinations?.length) {
    const expanded = expandDest(filters.destinations);
    for (const d of expanded) {
      data = await baseQuery(filters, [d]);
      if (data.length > 0) return { data, note: { mode: "macro", base: filters.destinations[0], used: [d] } };
    }
  }

  // Step 3: nearby
  if (filters.destinations?.length) {
    const nearList = DEST_NEARBY[filters.destinations[0]] || [];
    for (const d of nearList) {
      data = await baseQuery(filters, [d]);
      if (data.length > 0) return { data, note: { mode: "nearby", base: filters.destinations[0], used: [d] } };
    }
  }

  // Step 4: rilassa budget +20%
  if (filters.budget_max) {
    const relaxed = { ...filters, budget_max: Math.round(filters.budget_max * 1.2) };
    data = await baseQuery(relaxed, filters.destinations || []);
    if (data.length > 0) return { data, note: { mode: "relaxed_budget" } };
  }

  return { data: [], note: { mode: "none" } };
}

// ===== Formattazione yacht =====
function formatYachtItem(y: any) {
  const name = y.name || "Yacht";
  const model = y.model || y.series || "";
  const permalink = y.permalink || "#";
  const img = Array.isArray(y.gallery_urls) && y.gallery_urls.length > 0 ? y.gallery_urls[0] : null;

  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr  = y.year ? `${y.year}` : "";
  const gc  = (y.guests || y.cabins) ? `${y.guests || "-"} ospiti / ${y.cabins || "-"} cabine` : "";
  const rate = (y.rate_low || y.rate_high)
    ? `${y.rate_low ? y.rate_low.toLocaleString("it-IT") : "-"} - ${y.rate_high ? y.rate_high.toLocaleString("it-IT") : "-"} ${y.currency || "EUR"}`
    : "";
  const dest = Array.isArray(y.destinations) && y.destinations.length ? y.destinations.join(", ") : "";
  const hl   = y.highlights?.[0] || "";

  let md = `### ${name} (${model})\n`;
  if (img) md += `![Preview](${img})\n`;
  md += `- **Lunghezza:** ${len}\n`;
  if (yr) md += `- **Anno:** ${yr}\n`;
  if (gc) md += `- **Ospiti/Cabine:** ${gc}\n`;
  if (rate) md += `- **Tariffa settimanale:** ${rate}\n`;
  if (dest) md += `- **Destinazioni:** ${dest}\n`;
  if (hl) md += `- **Punto forte:** ${hl}\n`;
  md += `- [Scopri di più](${permalink})\n`;

  return md;
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
      const list = yachts.slice(0, 5).map(formatYachtItem).join("\n\n");
      answer =
        (language.startsWith("en")
          ? `Here are some yachts matching your request:\n\n${list}\n\n*Rates per week, VAT & APA excluded.*`
          : `Ecco alcune opzioni in linea con la tua richiesta:\n\n${list}\n\n*Tariffe a settimana, VAT & APA esclusi.*`);
    } else {
      answer =
        (language.startsWith("en")
          ? `No exact matches found. Would you like to adjust budget or guests, or consider nearby areas?`
          : `Nessuna corrispondenza esatta trovata. Vuoi modificare budget o ospiti, oppure considerare aree vicine?`);
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
