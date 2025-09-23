import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// --- Destinazioni note dal tuo WP ---
const KNOWN_DESTINATIONS = [
  "Australia","Bahamas","Florida","Hong Kong","Mar Mediterraneo",
  "Costa Azzurra","Croazia","East Med","Grecia","Isole Baleari",
  "Italia","Mar Ionio","Mediterraneo Occidentale","Mediterraneo Orientale",
  "Oceano Indiano","Oceano Pacifico Meridionale"
];

// --- Alias e fallback ---
const DEST_EQUIV: Record<string,string[]> = {
  "cannes": ["Costa Azzurra"],
  "nice": ["Costa Azzurra"],
  "monaco": ["Costa Azzurra"],
  "french riviera": ["Costa Azzurra"],
  "riviera francese": ["Costa Azzurra"],
  "cote d'azur": ["Costa Azzurra"],
  "cote d'azure": ["Costa Azzurra"],
  "caribbean": ["Bahamas"],
  "caraibi": ["Bahamas"],
  "miami": ["Florida"],
};

const DEST_FALLBACK: Record<string,string[]> = {
  "costa azzurra": ["Mediterraneo Occidentale","Italia","Corsica","Isole Baleari"],
  "grecia": ["Mediterraneo Orientale","Croazia","Turchia"],
  "croazia": ["Mediterraneo Orientale","Grecia","Italia"],
};

// --- Intent detection ibrido ---
async function classifyIntent(message: string): Promise<"search"|"booking"|"info"|"smalltalk"|"other"> {
  const msg = message.toLowerCase();

  if (/(ciao|hello|hi|buongiorno|buonasera|hey)/.test(msg)) return "smalltalk";
  if (/(prenot|book|riserv|pagament|costo)/.test(msg)) return "booking";
  if (/(cosa significa|come funziona|explain|spiega|what is)/.test(msg)) return "info";

  if (msg.includes("charter")) {
    const searchHints = ["yacht","barca","noleggio","bahamas","grecia","italia","costa","ospiti","cabine","budget","prezzo"];
    if (!searchHints.some((h) => msg.includes(h))) return "info";
  }

  if (msg.includes("yacht") || msg.includes("barca") || msg.includes("noleggio") ||
      KNOWN_DESTINATIONS.some((d) => msg.includes(d.toLowerCase()))) {
    return "search";
  }

  // fallback via AI
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: "Classifica il messaggio in search | booking | info | smalltalk | other. Rispondi solo con una parola." },
      { role: "user", content: message }
    ],
    temperature: 0
  });
  const intent = resp.choices[0].message.content?.toLowerCase().trim() as any;
  return ["search","booking","info","smalltalk","other"].includes(intent) ? intent : "other";
}

// --- Estrazione filtri ---
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
Scegli la destinazione più simile tra: ${KNOWN_DESTINATIONS.join(", ")}`
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
  let yachts: any[] = [];
  const destinations = filters.destinations || [];

  let expanded: string[] = [];
  for (const d of destinations) {
    const key = d.toLowerCase();
    if (DEST_EQUIV[key]) expanded.push(...DEST_EQUIV[key]);
    expanded.push(d);
  }
  expanded = [...new Set(expanded)];

  // step 1: match diretto
  if (expanded.length > 0) {
    const { data } = await supabase.from("yachts").select("*").overlaps("destinations", expanded).limit(20);
    if (data?.length) yachts = data;
  }

  // step 2: fallback LIKE
  if (yachts.length === 0 && expanded.length > 0) {
    const orFilters = expanded.map((d) => `destinations::text.ilike.%${d}%`).join(",");
    const { data } = await supabase.from("yachts").select("*").or(orFilters).limit(20);
    if (data?.length) yachts = data;
  }

  // step 3: macro fallback
  if (yachts.length === 0 && destinations.length > 0) {
    const key = destinations[0].toLowerCase();
    if (DEST_FALLBACK[key]) {
      const { data } = await supabase.from("yachts").select("*").overlaps("destinations", DEST_FALLBACK[key]).limit(20);
      if (data?.length) yachts = data;
    }
  }

  // deduplica per slug
  const unique: Record<string, any> = {};
  for (const y of yachts) if (!unique[y.slug]) unique[y.slug] = y;
  return Object.values(unique);
}

// --- Format yacht card ---
function formatYachtItem(y: any) {
  const name = y.name || "Yacht";
  const model = y.model || y.series || "";
  const permalink = y.permalink || "#";
  const img = y.gallery_urls?.[0] || null;

  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr = y.year ? `${y.year}` : "";
  const gc = (y.guests || y.cabins) ? `${y.guests||"-"} ospiti / ${y.cabins||"-"} cabine` : "";
  const rate = (y.rate_low || y.rate_high)
    ? `${y.rate_low?.toLocaleString("it-IT") || "-"} - ${y.rate_high?.toLocaleString("it-IT") || "-"} ${y.currency||"EUR"}`
    : "";
  const dest = y.destinations?.length ? y.destinations.join(", ") : "";
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
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if (req.method==="OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body==="string" ? JSON.parse(req.body) : (req.body||{});
    const userMessage = body.message || "";

    const intent = await classifyIntent(userMessage);

    if (intent === "info") {
      return res.status(200).json({
        answer_markdown: "Un charter è il noleggio esclusivo di uno yacht con equipaggio. Puoi scegliere destinazione, periodo e servizi inclusi. Vuoi che ti mostri anche alcune barche disponibili?",
        intent
      });
    }

    if (intent === "booking") {
      return res.status(200).json({
        answer_markdown: "Per prenotare uno yacht basta scegliere la barca e le date. Ti mettiamo in contatto con un nostro consulente che finalizzerà contratto, APA e dettagli. Vuoi lasciare i tuoi contatti?",
        intent
      });
    }

    if (intent === "smalltalk") {
      return res.status(200).json({ answer_markdown: "Ciao 👋 Come posso aiutarti con la tua prossima crociera?", intent });
    }

    if (intent === "search") {
      const filters = await extractFilters(userMessage);
      const yachts = await queryYachts(filters);

      if (yachts.length > 0) {
        const list = yachts.slice(0,5).map(formatYachtItem).join("\n\n");
        return res.status(200).json({
          answer_markdown: `Ho trovato queste opzioni per te:\n\n${list}\n\n*Tariffe a settimana, VAT & APA esclusi.*`,
          intent,
          filters_used: filters,
          yachts
        });
      } else {
        return res.status(200).json({
          answer_markdown: "Non ho trovato nulla con i criteri inseriti. Vuoi modificare budget o destinazione?",
          intent,
          filters_used: filters,
          yachts:[]
        });
      }
    }

    return res.status(200).json({
      answer_markdown: "Posso aiutarti a cercare uno yacht o rispondere a domande sul charter. Cosa preferisci?",
      intent
    });

  } catch(err:any) {
    console.error("Assistant error:",err);
    res.status(500).json({ error: err.message||String(err) });
  }
}

