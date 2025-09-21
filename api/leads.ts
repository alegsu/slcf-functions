// api/leads.ts
import { createClient } from "@supabase/supabase-js";
import nodemailer from "nodemailer";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export default async function handler(req: any, res: any) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });

  try {
    const { name, email, phone, message, yacht_id, yacht_name, filters } = req.body || {};

    if (!name || !email) {
      return res.status(400).json({ error: "Missing name or email" });
    }

    // 1. Salva in Supabase
    const { error } = await supabase.from("leads").insert([
      { name, email, phone, message, yacht_id, yacht_name, filters }
    ]);
    if (error) throw error;

    // 2. Invia email
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });

    const info = await transporter.sendMail({
      from: `"SLCF AI Lead" <${process.env.SMTP_USER}>`,
      to: process.env.LEAD_EMAIL_TO, // la tua email
      subject: `Nuovo lead: ${name}`,
      text: `
Nuovo lead ricevuto dal sito SLCF

Nome: ${name}
Email: ${email}
Telefono: ${phone || "-"}
Messaggio: ${message || "-"}
Yacht richiesto: ${yacht_name || "-"}
Filtri: ${JSON.stringify(filters || {}, null, 2)}

Data: ${new Date().toISOString()}
      `
    });

    return res.status(200).json({ ok: true, email_id: info.messageId });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
