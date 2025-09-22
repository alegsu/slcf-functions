// api/assistant.ts
import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// === (alias, expansions, nearby) identici alla versione precedente ===
// ... omesso per brevità ma incolla tutto quello che avevamo definito (DEST_ALIASES, DEST_EXPANDS, ecc.) ...

// helper format yacht
function formatYachtItem(y: any) {
  const title = `**[${y.name} (${y.model || y.series || ""})](${y.permalink})**`;
  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr  = y.year ? `Anno: ${y.year}` : "";
  const gc  = (y.guests || y.cabins) ? `Ospiti/Cabine: ${y.guests || "-"} / ${y.cabins || "-"}` : "";
  const rate = (y.rate_low || y.rate_high)
    ? `Tariffa settimanale: ${y.rate_low ? y.rate_low.toLocaleString("it-IT") : "-"} - ${y.rate_high ? y.rate_high.toLocaleString("it-IT") : "-"} ${y.currency || "EUR"}`
    : "";
  const dest = Array.isArray(y.destinations) && y.destinations.length ? `Destinazioni principali: ${y.destinations.join(", ")}` : "";
  const hl   = y.highlights?.[0] ? `Punto forte: ${y.highlights[0]}` : "";

  const lines = [title, len && `Lunghezza: ${len}`, yr, gc, rate, dest, hl].filter(Boolean);
  return `- ${lines[0]}\n` + lines.slice(1).map(l => `  ${l}`).join("\n");
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const conversation = body.conversation || [];
    const userName = body.user || "ospite";

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

    // costruzione risposta deterministica
    let contextNote = "";
    if (count === 0) {
      if (note?.mode === "nearby") {
        contextNote = language.startsWith("en")
          ? `I couldn’t find exact availability there. Nearby areas: ${(note.used || []).join(", ")}.\n\n`
          : `Non ho trovato disponibilità esatta in quell’area. Zone vicine: ${(note.used || []).join(", ")}.\n\n`;
      } else if (note?.mode === "macro") {
        contextNote = language.startsWith("en")
          ? `I considered the macro-area “${note.base}”, including: ${(note.used || []).join(", ")}.\n\n`
          : `Ho considerato la macro-area “${note.base}”, includendo: ${(note.used || []).join(", ")}.\n\n`;
      } else if (note?.mode === "relaxed_budget") {
        contextNote = language.startsWith("en")
          ? `Showing some options slightly above budget.\n\n`
          : `Alcune opzioni superano leggermente il budget indicato.\n\n`;
      } else {
        contextNote = language.startsWith("en")
          ? `No exact matches for your criteria.\n\n`
          : `Nessuna corrispondenza esatta per i criteri richiesti.\n\n`;
      }
    }

    let answer = "";
    if (count > 0) {
      const list = (yachts || []).slice(0, 5).map(formatYachtItem).join("\n\n");
      answer =
        (language.startsWith("en")
          ? `Here are some yachts matching your request:\n\n${list}\n\n*Rates per week, VAT & APA excluded.*`
          : `Ecco alcune opzioni in linea con la tua richiesta:\n\n${list}\n\n*Tariffe a settimana, VAT & APA esclusi.*`);
    } else {
      answer =
        (language.startsWith("en")
          ? `${contextNote}Would you like to consider nearby areas or adjust guests/budget?`
          : `${contextNote}Vuoi considerare aree vicine o modificare ospiti/budget?`);
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
