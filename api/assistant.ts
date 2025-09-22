import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY! // ⚠️ service role key su Vercel
);

// --- Sinonimi destinazioni ---
const destinationSynonyms: Record<string, string[]> = {
  "costa azzurra": ["Costa Azzurra", "French Riviera", "Riviera Francese"],
  "mediterraneo": ["Mar Mediterraneo", "Mediterraneo Occidentale", "Mediterraneo Orientale"],
  "grecia": ["Grecia", "Isole Greche", "Cyclades", "Cicladi"],
  "croazia": ["Croazia", "Dalmazia", "Dubrovnik", "Spalato"],
  "bahamas": ["Bahamas", "Caraibi", "Caribbean"],
};

function expandDestinations(input: string[]): string[] {
  const expanded: string[] = [];
  for (const d of input) {
    const key = d.toLowerCase();
    if (destinationSynonyms[key]) {
      expanded.push(...destinationSynonyms[key]);
    } else {
      expanded.push(d);
    }
  }
  return [...new Set(expanded)];
}

// --- Query yachts ---
async function queryYachts(filters: any, destinations: string[]) {
  let query = supabase.from("yachts").select("*");

  if (filters.guests_min) query = query.gte("guests", filters.guests_min);
  if (filters.budget_max) query = query.lte("rate_high", filters.budget_max);

  if (destinations && destinations.length > 0) {
    const expanded = expandDestinations(destinations);

    // 🔹 Primo tentativo: array overlap
    query = query.overlaps("destinations", expanded);

    // 🔹 Fallback: se fosse jsonb o text → usa ilike
    const orFilters = expanded.map((d) => `destinations::text.ilike.%${d}%`).join(",");
    query = query.or(orFilters);
  }

  const { data, error } = await query.limit(10);
  if (error) {
    console.error("❌ Supabase query error:", error);
    return [];
  }
  return data || [];
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

// --- API handler ---
export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const userMessage = body.message || "";

    console.log("💬 User message:", userMessage);

    // estrai filtri con AI
    const aiExtract = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Estrai dai messaggi destinazioni, budget massimo e numero minimo ospiti." },
        { role: "user", content: userMessage }
      ],
      temperature: 0,
      response_format: { type: "json_object" }
    });

    console.log("🤖 Raw AI response:", aiExtract.choices[0].message);

    let filters: any = {};
    let destinations: string[] = [];
    try {
      const raw = aiExtract.choices[0].message.content;
      filters = raw ? JSON.parse(raw) : {};
      destinations = filters.destinations || [];
    } catch (err) {
      console.error("❌ Parse error:", err);
      filters = {};
    }

    const yachts = await queryYachts(filters, destinations);

    let answer = "";
    if (yachts.length > 0) {
      answer += "Ho trovato queste opzioni per te:\n\n";
      yachts.forEach((y) => {
        answer += formatYachtItem(y) + "\n\n";
      });
      answer += "\nVuoi una proposta personalizzata? Posso raccogliere i tuoi contatti.  \n*Tariffe a settimana, VAT & APA esclusi.*";
    } else {
      answer = "Non ho trovato nulla con i criteri inseriti. Vuoi modificare budget o destinazione?";
    }

    res.status(200).json({
      answer_markdown: answer,
      filters_used: filters,
      yachts: yachts,
    });
  } catch (err: any) {
    console.error("❌ Assistant fatal error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}

