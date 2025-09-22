import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// === Destinazioni note ===
const KNOWN_DESTINATIONS = [
  "Australia","Bahamas","Florida","Hong Kong","Mar Mediterraneo",
  "Costa Azzurra","Croazia","East Med","Grecia","Isole Baleari",
  "Italia","Mar Ionio","Mediterraneo Occidentale","Mediterraneo Orientale",
  "Oceano Indiano","Oceano Pacifico Meridionale"
];

// === 1. Classificazione intento (ibrida) ===
async function classifyIntent(message: string): Promise<"search" | "chat"> {
  const msg = message.toLowerCase();

  // Regole: parole chiave o destinazioni
  if (
    msg.includes("charter") ||
    msg.includes("yacht") ||
    msg.includes("barca") ||
    msg.includes("crociera") ||
    KNOWN_DESTINATIONS.some((d) => msg.includes(d.toLowerCase()))
  ) {
    return "search";
  }

  // Fallback AI
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Separa messaggi in due categorie:
- "search" se l'utente cerca uno yacht, parla di destinazioni, budget, ospiti, barca, noleggio, charter ecc.
- "chat" se è saluto, battuta, domanda generica, o non riguarda yacht.
Rispondi SOLO con "search" o "chat".`,
      },
      { role: "user", content: message },
    ],
    temperature: 0,
  });

  return (resp.choices[0].message.content || "chat").toLowerCase() as any;
}

// === 2. Estrazione filtri yacht ===
async function extractFilters(text: string): Promise<any> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Estrai i filtri di ricerca yacht dall'input utente.
Rispondi SOLO in JSON con schema:
{
  "destinations": ["Australia","Bahamas","Florida","Hong Kong","Mar Mediterraneo","Costa Azzurra","Croazia","East Med","Grecia","Isole Baleari","Italia","Mar Ionio","Mediterraneo Occidentale","Mediterraneo Orientale","Oceano Indiano","Oceano Pacifico Meridionale"],
  "budget_max": int,
  "guests_min": int
}
Se l'utente scrive una destinazione non presente, scegli la più simile tra quelle indicate.`,
      },
      { role: "user", content: text },
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

// === 3. Query su Supabase ===
async function queryYachts(filters: any) {
  let query = supabase.from("yachts").select("*").limit(10);

  if (filters.guests_min) query = query.gte("guests", filters.guests_min);
  if (filters.budget_max) query = query.lte("rate_high", filters.budget_max);

  if (filters.destinations?.length > 0) {
    query = query.overlaps("destinations", filters.destinations);
  }

  const { data, error } = await query;
  if (error) {
    console.error("Supabase query error:", error);
    return [];
  }
  return data || [];
}

// === 4. Formattazione yacht ===
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
      ? `${y.rate_low?.toLocaleString("it-IT") || "-"} - ${
          y.rate_high?.toLocaleString("it-IT") || "-"
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

// === 5. Handler principale ===
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const userMessage = body.message || "";

    // 1) Classifica intento
    const intent = await classifyIntent(userMessage);

    if (intent === "chat") {
      // Risposta AI pura
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Sei l'assistente di Sanlorenzo Charter Fleet. Rispondi in modo gentile, breve e professionale.",
          },
          { role: "user", content: userMessage },
        ],
      });
      const reply = resp.choices[0].message.content || "🙂";
      return res.status(200).json({ answer_markdown: reply, mode: "chat" });
    }

    // 2) Se è ricerca: estrai filtri
    const filters = await extractFilters(userMessage);
    const yachts = await queryYachts(filters);

    let answer = "";
    if (yachts.length > 0) {
      const list = yachts.slice(0, 5).map(formatYachtItem).join("\n\n");
      answer = `Ecco alcune opzioni in linea con la tua richiesta:\n\n${list}\n\n*Tariffe a settimana, VAT & APA esclusi.*`;
    } else {
      answer =
        "Non ho trovato yacht esatti per questi criteri. Vuoi che ti proponga aree vicine o con budget leggermente diverso?";
    }

    res.status(200).json({
      answer_markdown: answer,
      mode: "search",
      filters_used: filters,
      yachts,
    });
  } catch (err: any) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
