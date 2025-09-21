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

    // 1) Recupero ultimo messaggio utente
    const lastUserMessage = conversation.filter((m: any) => m.role === "user").pop()?.content || "";
    let language = "it";

    if (lastUserMessage) {
      const detect = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Detect the language of the message. Respond with 'it', 'en', 'fr', 'es', etc." },
          { role: "user", content: lastUserMessage }
        ],
        max_tokens: 5
      });
      language = detect.choices[0].message.content?.trim().toLowerCase() || "it";
    }

    // 2) Recupera yacht demo (limite 2)
    const { data: yachts } = await supabase
      .from("yachts")
      .select("*")
      .limit(2);

    // 3) Prompt system
    const systemPrompt = `Sei un assistente per Sanlorenzo Charter Fleet.
Rispondi SEMPRE nella lingua ${language}.
Se l'utente ha già fornito il suo nome (${userName}), usalo per personalizzare le risposte.
Dati yacht disponibili (JSON): ${JSON.stringify(yachts || [], null, 2)}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversation
    ];

    // 4) Chiamata al modello
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 500
    });

    const answer = completion.choices[0].message.content;

    res.status(200).json({
      answer_markdown: answer,
      language,
      yachts
    });
  } catch (err: any) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
}
