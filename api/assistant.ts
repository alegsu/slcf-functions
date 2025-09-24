import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Destinazioni note (come salvate in Supabase/WordPress)
const KNOWN_DESTINATIONS = [
  "Australia","Bahamas","Florida","Hong Kong","Mar Mediterraneo",
  "Costa Azzurra","Croazia","East Med","Grecia","Isole Baleari",
  "Italia","Mar Ionio","Mediterraneo Occidentale","Mediterraneo Orientale",
  "Oceano Indiano","Oceano Pacifico Meridionale"
];

// Sinonimi → destinazione ufficiale
const DEST_EQUIV: Record<string,string> = {
  "cannes": "Costa Azzurra",
  "nice": "Costa Azzurra",
  "monaco": "Costa Azzurra",
  "french riviera": "Costa Azzurra",
  "riviera francese": "Costa Azzurra",
  "cote d'azur": "Costa Azzurra",
  "cote d'azure": "Costa Azzurra",
  "caribbean": "Bahamas",
  "caraibi": "Bahamas",
  "miami": "Florida",
};

// --- Estrai filtri con AI ---
async function extractFilters(text: string): Promise<any> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Estrai i filtri di ricerca yacht dall'input utente.
Rispondi SOLO in JSON con schema:
{
  "destinations": ["..."],
  "budget_max": int,
  "guests_min": int
}
Se la destinazione non è tra queste: ${KNOWN_DESTINATIONS.join(", ")}, mappa a quella più simile.`
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

// --- Query Supabase ---
async function queryYachts(filters: any) {
  let yachts: any[] = [];
  let destinations = filters.destinations || [];

  // normalizza sinonimi + capitalizzazione
  destinations = destinations.map((d: string) => {
    const key = d.toLowerCase();
    const mapped = DEST_EQUIV[key] || d;
    const known = KNOWN_DESTINATIONS.find(k => k.toLowerCase() === mapped.toLowerCase());
    return known || mapped;
  });

  // Step 1: match diretto (array overlap)
  if (destinations.length > 0) {
    const { data } = await supabase
      .from("yachts")
      .select("*")
      .overlaps("destinations", destinations)
      .limit(20);
    if (data?.length) yachts = data;
  }

  // Step 2: fallback LIKE
  if (yachts.length === 0 && destinations.length > 0) {
    const orFilters = destinations.map((d) => `destinations::text.ilike.%${d}%`).join(",");
    const { data } = await supabase
      .from("yachts")
      .select("*")
      .or(orFilters)
      .limit(20);
    if (data?.length) yachts = data;
  }

  // Deduplica per slug
  const unique: Record<string, any> = {};
  for (const y of yachts) if (!unique[y.slug]) unique[y.slug] = y;
  return Object.values(unique);
}

// --- Prepara dati per AI ---
function summarizeYacht(y: any) {
  return {
    name: y.name,
    model: y.model,
    year: y.year,
    length_m: y.length_m,
    guests: y.guests,
    cabins: y.cabins,
    rate_low: y.rate_low,
    rate_high: y.rate_high,
    currency: y.currency,
    destinations: y.destinations,
    permalink: y.permalink,
    image: y.gallery_urls?.[0] || null,
    highlight: y.highlights?.[0] || null
  };
}

// --- Handler principale ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body==="string" ? JSON.parse(req.body) : (req.body||{});
    const userMessage = body.message || "";

    // 1) Estrai filtri dall’AI
    const filters = await extractFilters(userMessage);

    // 2) Query DB
    const yachts = await queryYachts(filters);
    const simplified = yachts.slice(0,5).map(summarizeYacht);

    // 3) Genera risposta con AI
    const resp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `Sei l’assistente di Sanlorenzo Charter Fleet. 
Hai accesso ai seguenti yacht (in JSON).
Usa solo questi dati per rispondere. 
Se non ci sono yacht, chiedi chiarimenti (es. budget, ospiti, destinazione). 
Quando proponi yacht, usa Markdown con:
- Nome e modello
- Immagine preview
- Lunghezza, anno, ospiti/cabine
- Tariffa settimanale
- Destinazioni
- Punto forte se disponibile
- Link "Scopri di più"`
        },
        { role: "user", content: `Domanda utente: ${userMessage}` },
        { role: "assistant", content: `Risultati disponibili: ${JSON.stringify(simplified)}` }
      ],
      temperature: 0.4
    });

    const answer = resp.choices[0].message.content || "Non ho trovato nulla.";

    res.status(200).json({
      answer_markdown: answer,
      filters_used: filters,
      yachts: simplified
    });

  } catch(err:any) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message||String(err) });
  }
}
