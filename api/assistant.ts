import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// --- Macro aree per fallback ---
const DEST_EQUIV: Record<string, string[]> = {
  "cote d'azure": ["Costa Azzurra"],
  "cote d'azur": ["Costa Azzurra"],
  "riviera francese": ["Costa Azzurra","French Riviera"],
  "mediterranean": ["Mar Mediterraneo"],
  "west med": ["Mediterraneo Occidentale"],
  "east med": ["East Med","Mediterraneo Orientale"],
  "caribbean": ["Bahamas"],
  "caraibi": ["Bahamas"],
  "miami": ["Florida"],
};

const DEST_FALLBACK: Record<string, string[]> = {
  "costa azzurra": ["Mediterraneo Occidentale", "Italia", "Corsica", "Baleari"],
  "grecia": ["Mediterraneo Orientale", "Croazia", "Turchia"],
  "croazia": ["Mediterraneo Orientale", "Grecia", "Italia"],
};

// --- OpenAI: normalizza i filtri ---
async function extractFilters(text: string): Promise<any> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
       content: `Estrai i filtri di ricerca yacht dall'input utente.
Rispondi SOLO in JSON con schema:
{
  "destinations": [
    "Australia","Bahamas","Florida","Hong Kong","Mar Mediterraneo",
    "Costa Azzurra","Croazia","East Med","Grecia","Isole Baleari",
    "Italia","Mar Ionio","Mediterraneo Occidentale","Mediterraneo Orientale",
    "Oceano Indiano","Oceano Pacifico Meridionale"
  ],
  "budget_max": int,
  "guests_min": int
}
Se l'utente scrive una destinazione non presente, scegli la più simile tra queste.`

      },
      { role: "user", content: text }
    ],
    temperature: 0,
    response_format: { type: "json_object" },
  });

  try {
    return JSON.parse(resp.choices[0].message.content || "{}");
  } catch {
    return {};
  }
}

// --- Query yachts ---
async function queryYachts(filters: any) {
  let yachts: any[] = [];
  const destinations = filters.destinations || [];

  // Sinonimi espansi
  let expanded: string[] = [];
  for (const d of destinations) {
    const key = d.toLowerCase();
    if (DEST_EQUIV[key]) expanded.push(...DEST_EQUIV[key]);
    expanded.push(d);
  }
  expanded = [...new Set(expanded)];

  // Step 1: match diretto/esatto
  if (expanded.length > 0) {
    const { data } = await supabase
      .from("yachts")
      .select("*")
      .overlaps("destinations", expanded)
      .limit(20);
    if (data && data.length > 0) yachts = data;
  }

  // Step 2: fallback LIKE
  if (yachts.length === 0 && expanded.length > 0) {
    const orFilters = expanded.map((d) => `destinations::text.ilike.%${d}%`).join(",");
    const { data } = await supabase
      .from("yachts")
      .select("*")
      .or(orFilters)
      .limit(20);
    if (data && data.length > 0) yachts = data;
  }

  // Step 3: macro fallback
  if (yachts.length === 0 && destinations.length > 0) {
    const key = destinations[0].toLowerCase();
    if (DEST_FALLBACK[key]) {
      const { data } = await supabase
        .from("yachts")
        .select("*")
        .overlaps("destinations", DEST_FALLBACK[key])
        .limit(20);
      if (data && data.length > 0) yachts = data;
    }
  }

  // Deduplica per slug
  const unique: Record<string, any> = {};
  for (const y of yachts) {
    if (!unique[y.slug]) unique[y.slug] = y;
  }

  return Object.values(unique);
}

// --- Format yacht card ---
function formatYachtItem(y: any) {
  const name = y.name || "Yacht";
  const model = y.model || y.series || "";
  const permalink = y.permalink || "#";
  const img = Array.isArray(y.gallery_urls) && y.gallery_urls.length > 0 ? y.gallery_urls[0] : null;

  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr = y.year ? `${y.year}` : "";
  const gc = (y.guests || y.cabins) ? `${y.guests || "-"} ospiti / ${y.cabins || "-"} cabine` : "";
  const rate = (y.rate_low || y.rate_high)
    ? `${y.rate_low ? y.rate_low.toLocaleString("it-IT") : "-"} - ${y.rate_high ? y.rate_high.toLocaleString("it-IT") : "-"} ${y.currency || "EUR"}`
    : "";
  const dest = Array.isArray(y.destinations) && y.destinations.length ? y.destinations.join(", ") : "";
  const hl = y.highlights?.[0] || "";

  let md = `### ${name} (${model})\n`;
  if (img) md += `![Preview](${img})\n`;
  if (len) md += `- **Lunghezza:** ${len}\n`;
  if (yr) md += `- **Anno:** ${yr}\n`;
  if (gc) md += `- **Ospiti/Cabine:** ${gc}\n`;
  if (rate) md += `- **Tariffa settimanale:** ${rate}\n`;
  if (dest) md += `- **Destinazioni:** ${dest}\n`;
  if (hl) md += `- **Punto forte:** ${hl}\n`;
  md += `- [Scopri di più](${permalink})\n`;

  return md;
}

// --- Handler principale ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const userMessage = body.message || "";

    // Estrai filtri normalizzati dall'AI
    const filters = await extractFilters(userMessage);

    // Query yachts
    const yachts = await queryYachts(filters);

    let answer = "";
    if (yachts.length > 0) {
      const list = yachts.slice(0, 5).map(formatYachtItem).join("\n\n");
      answer = `Ho trovato queste opzioni per te:\n\n${list}\n\nVuoi una proposta personalizzata? Posso raccogliere i tuoi contatti.\n*Tariffe a settimana, VAT & APA esclusi.*`;
    } else {
      answer = "Non ho trovato nulla con i criteri inseriti. Vuoi modificare budget o destinazione?";
    }

    res.status(200).json({
      answer_markdown: answer,
      filters_used: filters,
      yachts: yachts,
    });
  } catch (err: any) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
