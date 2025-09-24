import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Destinazioni valide (esattamente come nel DB)
const VALID_DESTINATIONS = [
  "Australia",
  "Bahamas",
  "Florida",
  "Hong Kong",
  "Mar Mediterraneo",
  "Costa Azzurra",
  "Croazia",
  "East Med",
  "Grecia",
  "Isole Baleari",
  "Italia",
  "Mar Ionio",
  "Mediterraneo Occidentale",
  "Mediterraneo Orientale",
  "Oceano Indiano",
  "Oceano Pacifico Meridionale"
];

// Mappa di normalizzazione (lowercase → DB name)
const DEST_MAP: Record<string, string> = {};
VALID_DESTINATIONS.forEach((d) => {
  DEST_MAP[d.toLowerCase()] = d;
  DEST_MAP[d.toLowerCase().replace(/-/g, " ")] = d;
});

// --- Estrai filtri dall'AI ---
async function extractFilters(text: string): Promise<any> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Estrai i filtri di ricerca yacht dall'input utente.
Rispondi SOLO in JSON con schema:
{
  "destinations": [string],
  "budget_max": int,
  "guests_min": int
}
Le destinazioni possibili sono: ${VALID_DESTINATIONS.join(", ")}.
Se l'utente scrive varianti (es: cote d'azur, french riviera, caraibi),
scegli la più simile tra queste.`
      },
      { role: "user", content: text }
    ],
    temperature: 0,
    response_format: { type: "json_object" }
  });

  try {
    const parsed = JSON.parse(resp.choices[0].message.content || "{}");

    // normalizza destinazioni
    if (parsed.destinations && Array.isArray(parsed.destinations)) {
      parsed.destinations = parsed.destinations
        .map((d: string) => DEST_MAP[d.toLowerCase()] || d)
        .filter((d: string) => VALID_DESTINATIONS.includes(d));
    }
    return parsed;
  } catch {
    return {};
  }
}

// --- Query yachts ---
async function queryYachts(filters: any) {
  let yachts: any[] = [];
  const destinations = filters.destinations || [];

  if (destinations.length > 0) {
    // Step 1: overlaps
    const { data } = await supabase
      .from("yachts")
      .select("*")
      .overlaps("destinations", destinations)
      .limit(20);
    if (data && data.length > 0) yachts = data;

    // Step 2: fallback LIKE
    if (yachts.length === 0) {
      const term = destinations[0];
      const { data: likeData } = await supabase
        .from("yachts")
        .select("*")
        .ilike("destinations::text", `%${term}%`)
        .limit(20);
      if (likeData && likeData.length > 0) yachts = likeData;
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
  const img =
    Array.isArray(y.gallery_urls) && y.gallery_urls.length > 0
      ? y.gallery_urls[0]
      : null;

  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr = y.year ? `${y.year}` : "";
  const gc =
    y.guests || y.cabins
      ? `${y.guests || "-"} ospiti / ${y.cabins || "-"} cabine`
      : "";
  const rate =
    y.rate_low || y.rate_high
      ? `${y.rate_low ? y.rate_low.toLocaleString("it-IT") : "-"} - ${
          y.rate_high ? y.rate_high.toLocaleString("it-IT") : "-"
        } ${y.currency || "EUR"}`
      : "";
  const dest =
    Array.isArray(y.destinations) && y.destinations.length
      ? y.destinations.join(", ")
      : "";
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
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const userMessage = body.message || "";

    // Estrai filtri
    const filters = await extractFilters(userMessage);
    console.log("Filters estratti:", filters);

    // Query yachts
    const yachts = await queryYachts(filters);

    let answer = "";
    if (yachts.length > 0) {
      const list = yachts.slice(0, 5).map(formatYachtItem).join("\n\n");
      answer = `Ho trovato queste opzioni per te:\n\n${list}\n\nVuoi una proposta personalizzata? Posso raccogliere i tuoi contatti.\n*Tariffe a settimana, VAT & APA esclusi.*`;
    } else {
      answer =
        "Non ho trovato nulla con i criteri inseriti. Vuoi modificare budget o destinazione?";
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
