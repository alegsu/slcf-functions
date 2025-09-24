import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// --- Destinazioni note dal WP ---
const KNOWN_DESTINATIONS = [
  "Australia","Bahamas","Florida","Hong Kong","Mar Mediterraneo",
  "Costa Azzurra","Croazia","East Med","Grecia","Isole Baleari",
  "Italia","Mar Ionio","Mediterraneo Occidentale","Mediterraneo Orientale",
  "Oceano Indiano","Oceano Pacifico Meridionale"
];

// --- Sinonimi manuali ---
const DEST_EQUIV: Record<string, string> = {
  "cannes": "Costa Azzurra",
  "côte d'azur": "Costa Azzurra",
  "cote d'azur": "Costa Azzurra",
  "french riviera": "Costa Azzurra",
  "riviera francese": "Costa Azzurra",
  "caribbean": "Bahamas",
  "caraibi": "Bahamas",
  "miami": "Florida",
};

// --- Fallback macro-aree ---
const DEST_FALLBACK: Record<string, string[]> = {
  "Costa Azzurra": ["Mediterraneo Occidentale","Italia","Corsica","Isole Baleari"],
  "Grecia": ["Mediterraneo Orientale","Croazia","Turchia"],
  "Croazia": ["Mediterraneo Orientale","Grecia","Italia"],
};

// --- AI extraction ---
async function extractFilters(text: string): Promise<any> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Estrai i filtri yacht dall'input utente.
Rispondi SOLO in JSON:
{
  "destinations": ["..."],
  "budget_max": int,
  "guests_min": int
}
Le destinazioni possibili sono solo queste: ${KNOWN_DESTINATIONS.join(", ")}.
Se l'utente scrive un luogo non presente, scegli il più simile o lascia vuoto.`
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

// --- Normalizza destinazione ---
function normalizeDest(dest: string): string {
  if (!dest) return dest;
  const key = dest.toLowerCase();
  return DEST_EQUIV[key] || dest;
}

// --- Query yachts ---
async function queryYachts(filters: any) {
  let yachts: any[] = [];
  const destinations: string[] = (filters.destinations || []).map(normalizeDest);

  // 1. match diretto
  if (destinations.length > 0) {
    const { data } = await supabase
      .from("yachts")
      .select("*")
      .overlaps("destinations", destinations)
      .limit(20);
    if (data && data.length > 0) yachts = data;
  }

  // 2. fallback macro
  if (yachts.length === 0 && destinations.length > 0) {
    const fb = DEST_FALLBACK[destinations[0]];
    if (fb) {
      const { data } = await supabase
        .from("yachts")
        .select("*")
        .overlaps("destinations", fb)
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

// --- Format yacht ---
function formatYachtItem(y: any) {
  const name = y.name || "Yacht";
  const model = y.model || y.series || "";
  const permalink = y.permalink || "#";
  const img = Array.isArray(y.gallery_urls) && y.gallery_urls.length > 0 ? y.gallery_urls[0] : null;

  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr = y.year ? `${y.year}` : "";
  const gc = (y.guests || y.cabins) ? `${y.guests || "-"} ospiti / ${y.cabins || "-"} cabine` : "";
  const rate = (y.rate_low || y.rate_high)
    ? `${y.rate_low?.toLocaleString("it-IT") || "-"} - ${y.rate_high?.toLocaleString("it-IT") || "-"} ${y.currency || "EUR"}`
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

// --- Handler ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const userMessage = body.message || "";

    // Estrai filtri AI
    const filters = await extractFilters(userMessage);

    // Query yachts
    const yachts = await queryYachts(filters);

    let answer = "";
    if (yachts.length > 0) {
      const list = yachts.slice(0, 5).map(formatYachtItem).join("\n\n");
      answer = `Ho trovato queste opzioni per te:\n\n${list}\n\nVuoi una proposta personalizzata? Posso raccogliere i tuoi contatti.\n*Tariffe a settimana, VAT & APA esclusi.*`;
    } else {
      answer = "Non ho trovato yacht disponibili. Vuoi modificare budget o destinazione?";
    }

    res.status(200).json({
      answer_markdown: answer,
      filters_used: filters,
      yachts,
    });
  } catch (err: any) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
