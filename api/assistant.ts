import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY!,
});

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export const config = {
  runtime: "edge",
};

export default async function handler(req: NextRequest) {
  try {
    const body = await req.json();
    const conversation = body.conversation || [];
    const userName = body.user || "ospite";

    // 1) Recupero lingua ultimo messaggio
    const lastUserMessage = conversation.filter((m: any) => m.role === "user").pop()?.content || "";
    let language = "it"; // default italiano
    if (/[a-z]/i.test(lastUserMessage)) {
      // naive detection con modello
      const detect = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: "Identify the language of the user message. Respond only with 'it' for Italian, 'en' for English, 'fr' for French, 'es' for Spanish, etc." },
          { role: "user", content: lastUserMessage }
        ],
        max_tokens: 5
      });
      language = detect.choices[0].message.content?.trim().toLowerCase() || "it";
    }

    // 2) Query su supabase in base all'input (puoi arricchirla)
    // Esempio molto semplice: prendi qualche yacht random come demo
    const { data: yachts } = await supabase
      .from("yachts")
      .select("*")
      .limit(2);

    // 3) Costruisci prompt
    const systemPrompt = `Sei un assistente per Sanlorenzo Charter Fleet. 
Rispondi SEMPRE nella lingua ${language}. 
Se l'utente ha già fornito il suo nome (${userName}), usalo per personalizzare le risposte.
I dati yacht disponibili sono nel seguente JSON (se vuoto rispondi che non hai trovato nulla):

${JSON.stringify(yachts || [], null, 2)}`;

    const messages = [
      { role: "system", content: systemPrompt },
      ...conversation
    ];

    // 4) Chiamata modello
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
      temperature: 0.7,
      max_tokens: 500
    });

    const answer = completion.choices[0].message.content;

    return NextResponse.json({
      answer_markdown: answer,
      language,
      yachts
    });
  } catch (err: any) {
    console.error(err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
