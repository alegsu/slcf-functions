import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// --- FAQ dictionary ---
const FAQ: Record<string, string> = {
  "apa": "💡 **APA (Advance Provisioning Allowance)** è un fondo anticipato (20-30% del noleggio) usato per coprire spese come carburante, porti, cibo e bevande. Alla fine viene rendicontato e l’eccedenza restituita.",
  "prenotare": "📅 Puoi prenotare uno yacht contattandoci: ti chiederemo destinazione, periodo, numero di ospiti e budget, poi prepareremo una proposta.",
  "giorno": "🌞 In genere i charter sono settimanali, ma in alcune destinazioni sono disponibili anche noleggi giornalieri.",
  "charter": "⛵ **Charter** significa noleggio: puoi noleggiare uno yacht per una settimana (o più) con equipaggio incluso."
};

// --- AI filter extraction ---
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
    response_format: { type: "json_object" }
  });

  try {
    return JSON.parse(resp.choices[0].message.content || "{}");
  } catch {
    return {};
  }
}

// --- Query yachts ---
async function queryYachts(filters: any) {
  const destinations = filters.destinations || [];
  let yachts: any[] = [];

  if (destinations.length > 0) {
    const { data } = await supabase
      .from("yachts")
      .select("*")
      .overlaps("destinations", destinations)
      .limit(20);
    if (data && data.length > 0) yachts = data;
  }

  if (yachts.length === 0) {
    const { data } = await supabase.from("yachts").select("*").limit(10);
    if (data) yachts = data;
  }

  // deduplica per slug
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
  const permalink = y.source_url || y.permalink || "#";
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
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const conversation = body.conversation || [];
    const userMessage = body.message || conversation[conversation.length - 1]?.content || "";

    // 1. Proviamo estrazione e query yacht
    const filters = await extractFilters(userMessage);
    const yachts = await queryYachts(filters);

    if (yachts.length > 0) {
      const list = yachts.slice(0, 5).map(formatYachtItem).join("\n\n");
      return res.status(200).json({
        answer_markdown: `Ho trovato queste opzioni per te:\n\n${list}\n\nVuoi una proposta personalizzata? Posso raccogliere i tuoi contatti.\n*Tariffe a settimana, VAT & APA esclusi.*`,
        filters_used: filters,
        yachts,
        source: "yacht"
      });
    }

    // 2. Se non ci sono yacht, cerchiamo FAQ
    const msgLower = userMessage.toLowerCase();
    for (const key in FAQ) {
      if (msgLower.includes(key)) {
        return res.status(200).json({
          answer_markdown: FAQ[key],
          filters_used: {},
          yachts: [],
          source: "faq"
        });
      }
    }

    // 3. Nessun match
    return res.status(200).json({
      answer_markdown: "Non ho trovato nulla con i criteri inseriti. Vuoi modificare budget o destinazione?",
      filters_used: filters,
      yachts: [],
      source: "none"
    });
  } catch (err: any) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}



 
