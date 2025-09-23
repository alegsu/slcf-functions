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

// === Mini FAQ (statiche) ===
const FAQ: Record<string, string> = {
  "come posso prenotare": "Puoi prenotare lasciando i tuoi dati qui in chat 📩. Ti contatteremo entro poche ore per confermare i dettagli.",
  "posso prenotare per un giorno": "I charter sono normalmente settimanali ⛵️, ma in alcuni casi particolari possiamo valutare richieste più brevi.",
  "cosa significa charter": "Charter significa noleggio esclusivo di uno yacht con equipaggio 👨‍✈️ per un periodo determinato.",
  "cosa significa apa": "APA = Advance Provisioning Allowance. È un fondo anticipato (circa 30% del noleggio) che copre carburante, porti, cibo, bevande e altre spese di bordo.",
};

// === Intent classifier (5 categorie) ===
async function classifyIntent(message: string): Promise<"search"|"booking"|"info"|"smalltalk"|"other"> {
  const msg = message.toLowerCase();

  // --- smalltalk ---
  if (/(ciao|hello|hi|buongiorno|buonasera|hey)/.test(msg)) {
    return "smalltalk";
  }

  // --- booking keywords ---
  if (/(prenot|book|riserv|pagament|costo)/.test(msg)) {
    return "booking";
  }

  // --- info keywords ---
  if (/(cosa significa|come funziona|spiega|explain|what is)/.test(msg)) {
    return "info";
  }

  // --- charter special case ---
  if (msg.includes("charter")) {
    // se non ci sono parole di ricerca "forti", lo tratto come info
    const searchHints = ["yacht","barca","noleggio","bahamas","grecia","italia","costa","ospiti","cabine","budget","prezzo"];
    if (!searchHints.some((h) => msg.includes(h))) {
      return "info";
    }
  }

  // --- search keywords / destinazioni note ---
  if (
    msg.includes("yacht") ||
    msg.includes("barca") ||
    msg.includes("noleggio") ||
    KNOWN_DESTINATIONS.some((d) => msg.includes(d.toLowerCase()))
  ) {
    return "search";
  }

  // --- fallback AI classification ---
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Classifica l'intento dell'utente in una di queste categorie:
- "search"
- "booking"
- "info"
- "smalltalk"
- "other"

Rispondi SOLO con la parola.`,
      },
      { role: "user", content: message },
    ],
    temperature: 0,
  });

  const intent = resp.choices[0].message.content?.toLowerCase().trim() as any;
  return ["search","booking","info","smalltalk","other"].includes(intent) ? intent : "other";
}


  // AI classification
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Classifica l'intento dell'utente in una di queste categorie:
- "search": cerca uno yacht (destinazione, budget, ospiti, charter, noleggio).
- "booking": domande su prenotazioni, durata, pagamenti.
- "info": definizioni o spiegazioni (es. cosa significa charter, cos'è APA).
- "smalltalk": saluti, battute, convenevoli.
- "other": tutto il resto.

Rispondi SOLO con una di queste parole.`,
      },
      { role: "user", content: message },
    ],
    temperature: 0,
  });

  const intent = resp.choices[0].message.content?.toLowerCase().trim() as any;
  return ["search","booking","info","smalltalk","other"].includes(intent) ? intent : "other";
}

// === Estrazione filtri yacht ===
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

// === Query su Supabase ===
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

// === Deduplica yachts ===
function dedupYachts(yachts: any[]) {
  const seen = new Set();
  return yachts.filter((y) => {
    const key = y.slug || y.wp_id || y.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// === Formattazione yacht ===
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

// === Handler principale ===
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body =
      typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

    // Supporto sia message che conversation
    let userMessage = body.message || "";
    if (!userMessage && Array.isArray(body.conversation)) {
      const lastUser = body.conversation
        .filter((m: any) => m.role === "user")
        .pop();
      if (lastUser) userMessage = lastUser.content;
    }

    if (!userMessage) {
      return res.status(400).json({ error: "No user message provided" });
    }

    // 1) Classifica intento
    const intent = await classifyIntent(userMessage);

    // 2) Gestione per intento
    if (intent === "smalltalk") {
      return res.status(200).json({
        answer_markdown: "🙂 Certo! Dimmi pure, sono qui per aiutarti.",
        mode: "smalltalk",
      });
    }

    if (intent === "booking" || intent === "info") {
      // Match su FAQ
      const key = Object.keys(FAQ).find((q) =>
        userMessage.toLowerCase().includes(q)
      );
      if (key) {
        return res.status(200).json({
          answer_markdown: FAQ[key],
          mode: intent,
        });
      }

      // fallback GPT
      const resp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Sei l'assistente di Sanlorenzo Charter Fleet. Rispondi in modo breve e chiaro a domande su prenotazioni e informazioni.",
          },
          { role: "user", content: userMessage },
        ],
      });
      const reply = resp.choices[0].message.content || "🙂";
      return res.status(200).json({ answer_markdown: reply, mode: intent });
    }

    if (intent === "search") {
      const filters = await extractFilters(userMessage);
      let yachts = await queryYachts(filters);
      yachts = dedupYachts(yachts);

      let answer = "";
      if (yachts.length > 0) {
        const list = yachts.slice(0, 5).map(formatYachtItem).join("\n\n");
        answer = `Ecco alcune opzioni in linea con la tua richiesta:\n\n${list}\n\n*Tariffe a settimana, VAT & APA esclusi.*`;
      } else {
        answer =
          "Non ho trovato yacht esatti per questi criteri. Vuoi che ti proponga aree vicine o con budget leggermente diverso?";
      }

      return res.status(200).json({
        answer_markdown: answer,
        mode: "search",
        filters_used: filters,
        yachts,
      });
    }

    // other
    return res.status(200).json({
      answer_markdown:
        "Posso aiutarti a trovare il tuo prossimo yacht o darti informazioni sui nostri servizi. Dimmi pure cosa cerchi 🚤",
      mode: "other",
    });
  } catch (err: any) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
