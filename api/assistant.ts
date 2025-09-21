import type { VercelRequest, VercelResponse } from '@vercel/node';
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const body = req.body || {};
    const conversation = body.conversation || [];
    const userName = body.user || "ospite";

    // --- 1) Ultimo messaggio utente ---
    const lastUserMessage = conversation.filter((m: any) => m.role === "user").pop()?.content || "";
    let language = "it";

    if (lastUserMessage) {
      const detect = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Detect the language of the message. Respond only with 'it', 'en', 'fr', 'es', etc." },
          { role: "user", content: lastUserMessage }
        ],
        max_tokens: 5
      });
      language = detect.choices[0].message.content?.trim().toLowerCase() || "it";
    }

    // --- 2) Estrai filtri dal messaggio ---
    const extract = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: "Estrai i criteri di ricerca yacht dal messaggio. Rispondi SOLO in JSON con campi: guests_min, budget_max, destinations (array di stringhe), year_min, length_min, length_max." },
        { role: "user", content: lastUserMessage }
      ],
      temperature: 0,
      max_tokens: 200
    });

    let filters: any = {};
    try {
      filters = JSON.parse(extract.choices[0].message.content || "{}");
    } catch {
      filters = {};
    }

    // --- 3) Query su Supabase ---
    let query = supabase.from("yachts").select("*");

    if (filters.guests_min) {
      query = query.gte("guests", filters.guests_min);
    }
    if (filters.budget_max) {
      query = query.lte("rate_high", filters.budget_max);
    }
    if (filters.year_min) {
      query = query.gte("year", filters.year_min);
    }
    if (filters.length_min) {
      query = query.gte("length_m", filters.length_min);
    }
    if (filters.length_max) {
      query = query.lte("length_m", filters.length_max);
    }
    if (filters.destinations && filters.destinations.length > 0) {
      query = query.contains("destinations", filters.destinations);
    }

    const { data: yachts } = await query.limit(3);

    // --- 4) Prompt finale per risposta ---
    const systemPrompt = `Sei un assistente per Sanlorenzo Charter Fleet.
Rispondi sempre nella lingua ${language}.
Se l'utente ha fornito il nome (${userName}), usalo nelle risposte.
Ecco gli yacht trovati nel database:
${JSON.stringify(yachts || [], null, 2)}

Genera una risposta amichevole e persuasiva, con elenco yacht in stile marketing.
Alla fine invita l'utente a lasciare i suoi contatti (nome già raccolto).`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversation
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 600
    });

    const answer = completion.choices[0].message.content;

    res.status(200).json({
      answer_markdown: answer,
      language,
      filters,
      yachts
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
