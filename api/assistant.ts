import type { VercelRequest, VercelResponse } from "@vercel/node";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

/* ---------------------- DESTINAZIONI & SINONIMI ---------------------- */

const CANON_DESTS = [
  "Australia","Bahamas","Florida","Hong Kong","Mar Mediterraneo",
  "Costa Azzurra","Croazia","East Med","Grecia","Isole Baleari",
  "Italia","Mar Ionio","Mediterraneo Occidentale","Mediterraneo Orientale",
  "Oceano Indiano","Oceano Pacifico Meridionale"
] as const;

const DEST_SYNONYMS: Record<string, string> = {
  // Costa Azzurra / French Riviera
  "french riviera": "Costa Azzurra",
  "riviera francese": "Costa Azzurra",
  "cote d'azur": "Costa Azzurra",
  "côte d'azur": "Costa Azzurra",
  "cote d azure": "Costa Azzurra",
  "côte d azure": "Costa Azzurra",
  "monaco": "Costa Azzurra",
  "montecarlo": "Costa Azzurra",
  "monte carlo": "Costa Azzurra",
  "cannes": "Costa Azzurra",
  "antibes": "Costa Azzurra",
  "nice": "Costa Azzurra",
  "saint-tropez": "Costa Azzurra",
  "st tropez": "Costa Azzurra",

  // Mediterraneo
  "mediterranean": "Mar Mediterraneo",
  "med": "Mar Mediterraneo",

  // West/East Med
  "west med": "Mediterraneo Occidentale",
  "east med": "Mediterraneo Orientale",

  // Baleari
  "balearics": "Isole Baleari",
  "ibiza": "Isole Baleari",
  "mallorca": "Isole Baleari",
  "majorca": "Isole Baleari",
  "menorca": "Isole Baleari",

  // Grecia
  "greek islands": "Grecia",
  "cyclades": "Grecia",
  "cicladi": "Grecia",

  // Croazia / Italia
  "dalmazia": "Croazia",
  "amalfi": "Italia",
  "napoli": "Italia",
  "naples": "Italia",
  "sardegna": "Italia",
  "sardinia": "Italia",
  "sicilia": "Italia",
  "sicily": "Italia",

  // Caraibi
  "caribbean": "Bahamas",
  "caraibi": "Bahamas",

  // Ionio
  "ionian sea": "Mar Ionio",
  "ionio": "Mar Ionio",
};

function toCanonDestination(token: string): string | null {
  const k = token.trim().toLowerCase();
  if (!k) return null;
  if (DEST_SYNONYMS[k]) return DEST_SYNONYMS[k];
  // match diretto con canon
  const hit = CANON_DESTS.find(d => d.toLowerCase() === k);
  return hit || null;
}

function findDestinationsInText(text: string): string[] {
  const lower = text.toLowerCase();

  // cerca tutte le chiavi di sinonimi presenti
  const hitsFromSyn = Object.keys(DEST_SYNONYMS).filter(k => lower.includes(k));
  const mapped = hitsFromSyn.map(k => DEST_SYNONYMS[k]);

  // cerca match diretti sulle canonical (es. "Costa Azzurra", "Grecia", …)
  const hitsFromCanon = CANON_DESTS.filter(d => lower.includes(d.toLowerCase()));

  // uniq
  return Array.from(new Set([...mapped, ...hitsFromCanon]));
}

/* ---------------------- PARSE BUDGET & OSPITI ---------------------- */

function parseBudget(text: string): number {
  const lower = text.toLowerCase();

  // 1) notazioni con k/m
  const km = lower.match(/(\d+(?:[.,]\d+)?)\s*(k|m|mila|mille|milioni)/);
  if (km) {
    let n = parseFloat(km[1].replace(",", "."));
    const unit = km[2];
    if (unit === "k" || unit === "mila" || unit === "mille") n *= 1000;
    if (unit === "m" || unit === "milioni") n *= 1000000;
    return Math.round(n);
  }

  // 2) numeri con separatori (prendi il più “grande” verosimile come budget)
  const nums = Array.from(lower.matchAll(/\b\d{1,3}(?:[.,]\d{3})*(?:[.,]\d+)?\b/g)).map(m =>
    Math.round(parseFloat(m[0].replace(/\./g, "").replace(/,/g, ".")))
  ).filter(n => !Number.isNaN(n));

  // eur contours: se si vede "€", "eur", "euro", prendi il più grande
  if (/(€|eur|euro)/.test(lower) && nums.length) {
    return Math.max(...nums);
  }

  // fallback: se frasi tipo "massimo 50000" / "max 70k" già beccato sopra; altrimenti nessun budget
  return 0;
}

function parseGuests(text: string): number {
  const lower = text.toLowerCase();
  const m = lower.match(/(\d{1,2})\s*(ospiti|persone|pax|guests?)/);
  if (m) return parseInt(m[1], 10);
  return 0;
}

/* ---------------------- INTENT: GENERAL vs CHARTER ---------------------- */

function shouldRouteToCharter(text: string): boolean {
  // Se cita destinazioni/città riconosciute → charter
  const dests = findDestinationsInText(text);
  if (dests.length > 0) return true;

  // se cita yacht/charter + qualsiasi città/parola geografica (heuristic semplice)
  const lower = text.toLowerCase();
  const charterWords = /(charter|yacht|barca|noleggio|imbarcazione)/.test(lower);
  const hasPlaceLike = /(monaco|cannes|antibes|nice|riviera|tropez|grecia|croazia|bahamas|ibiza|mallorca|baleari|italia|sardegna|sicilia|mediterraneo|east med|west med|côte d'azur|cote d'azur|costa azzurra)/.test(lower);
  if (charterWords && hasPlaceLike) return true;

  // se contiene solo parole “how/what/apa/prenotare/giorno” → general
  return false;
}

/* ---------------------- FAQ (senza parola 'charter'!) ---------------------- */

const FAQ: Record<string, string> = {
  "apa": "💡 **APA (Advance Provisioning Allowance)** è un fondo anticipato (20-30% del noleggio) usato per coprire spese come carburante, porti, cibo e bevande. Alla fine viene rendicontato e l’eccedenza restituita.",
  "prenotare": "📅 Puoi prenotare uno yacht contattandoci: ci indichi destinazione, periodo, n. ospiti e budget; prepariamo una proposta con contratto MYBA e assistenza completa.",
  "giorno": "🌞 Normalmente i charter sono settimanali; alcuni yacht accettano noleggi giornalieri (soprattutto bassa stagione o eventi).",
  "what is apa": "💡 **APA (Advance Provisioning Allowance)** is an advance fund (20–30% of the charter fee) used to cover running expenses (fuel, ports, food & beverages). It is fully accounted at the end; any balance is returned.",
  "meaning of apa": "💡 **APA** = Advance Provisioning Allowance, fondo anticipato 20–30% per spese operative; a consuntivo si regola e l’eventuale eccedenza viene restituita."
};

function checkFAQ(userMessage: string): string | null {
  const lower = userMessage.toLowerCase();
  for (const key in FAQ) {
    if (lower.includes(key)) return FAQ[key];
  }
  // sinonimi semplici
  if (/\bcosa (?:significa|vuol dire)\s*apa\b/.test(lower)) return FAQ["apa"];
  if (/\bwhat (?:is|does).*apa\b/.test(lower)) return FAQ["what is apa"];
  return null;
}

/* ---------------------- AI: estrazione filtri (backup) ---------------------- */

async function extractFiltersAI(text: string): Promise<{ destinations?: string[], budget_max?: number, guests_min?: number }> {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "system",
        content: `Estrai i filtri di ricerca yacht dall'input utente. Rispondi SOLO in JSON valido (json) con schema:
{
  "destinations": [
    "Australia","Bahamas","Florida","Hong Kong","Mar Mediterraneo",
    "Costa Azzurra","Croazia","East Med","Grecia","Isole Baleari",
    "Italia","Mar Ionio","Mediterraneo Occidentale","Mediterraneo Orientale",
    "Oceano Indiano","Oceano Pacifico Meridionale"
  ],
  "budget_max": int,
  "guests_min": int
}
Se la destinazione non è in lista, mappa alla più simile.`
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

/* ---------------------- QUERY DB ---------------------- */

async function supabaseQuery(filters: { destinations?: string[], budget_max?: number, guests_min?: number }) {
  const destinations = filters.destinations || [];
  const budgetMax = filters.budget_max || 0;
  const guestsMin = filters.guests_min || 0;

  let q = supabase.from("yachts").select("*");

  if (destinations.length > 0) q = q.overlaps("destinations", destinations);
  if (guestsMin > 0) q = q.gte("guests", guestsMin);
  if (budgetMax > 0) q = q.lte("rate_low", budgetMax);

  let { data, error } = await q.limit(30);
  if (error) {
    console.error("Supabase query error:", error);
    data = [];
  }

  // Se budget impostato ma 0 risultati, prova su rate_high
  if ((data?.length || 0) === 0 && budgetMax > 0) {
    let q2 = supabase.from("yachts").select("*");
    if (destinations.length > 0) q2 = q2.overlaps("destinations", destinations);
    if (guestsMin > 0) q2 = q2.gte("guests", guestsMin);
    q2 = q2.lte("rate_high", budgetMax);
    const r2 = await q2.limit(30);
    if (!r2.error && r2.data) data = r2.data;
  }

  // dedup per slug
  const uniq: Record<string, any> = {};
  for (const y of data || []) if (!uniq[y.slug]) uniq[y.slug] = y;

  return Object.values(uniq);
}

/* ---------------------- FORMATTING ---------------------- */

function formatYachtItem(y: any) {
  const name = y.name || "Yacht";
  const model = y.model || y.series || "";
  const permalink = y.source_url || y.permalink || "#";
  const img = Array.isArray(y.gallery_urls) && y.gallery_urls.length > 0 ? y.gallery_urls[0] : null;

  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr  = y.year ? `${y.year}` : "";
  const gc  = (y.guests || y.cabins) ? `${y.guests || "-"} ospiti / ${y.cabins || "-"} cabine` : "";
  const rate = (y.rate_low || y.rate_high)
    ? `${y.rate_low ? y.rate_low.toLocaleString("it-IT") : "-"} - ${y.rate_high ? y.rate_high.toLocaleString("it-IT") : "-"} ${y.currency || "EUR"}`
    : "";
  const dest = Array.isArray(y.destinations) && y.destinations.length ? y.destinations.join(", ") : "";
  const hl   = y.highlights?.[0] || "";

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

/* ---------------------- HANDLER ---------------------- */

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const conversation = body.conversation || [];
    const userMessage: string =
      body.message || conversation[conversation.length - 1]?.content || "";

    /* 0) FAQ veloci (no 'charter' qui!) */
    const faq = checkFAQ(userMessage);
    if (faq) {
      return res.status(200).json({
        answer_markdown: faq,
        filters_used: {},
        yachts: [],
        source: "faq"
      });
    }

    /* 1) Router: general vs charter */
    const routeCharter = shouldRouteToCharter(userMessage);

    if (!routeCharter) {
      // GENERAL → AI pura (stessa lingua del messaggio)
      const aiResp = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          {
            role: "system",
            content:
              "Sei l'assistente ufficiale di Sanlorenzo Charter Fleet. Rispondi con informazioni utili e accurate (APA, prenotazioni, durata, ecc.). Rispondi nella stessa lingua del messaggio. Non proporre yacht se non richiesto esplicitamente."
          },
          { role: "user", content: userMessage }
        ],
        temperature: 0.2
      });
      const aiText = aiResp.choices[0].message.content || "Posso aiutarti con altre informazioni.";
      return res.status(200).json({
        answer_markdown: aiText,
        filters_used: {},
        yachts: [],
        source: "ai"
      });
    }

    /* 2) CHARTER → costruisci filtri (dest + budget + ospiti) */
    let dests = findDestinationsInText(userMessage);
    // fallback AI solo se non trova nulla localmente
    let aiFilters: any = {};
    if (dests.length === 0) {
      aiFilters = await extractFiltersAI(userMessage);
      if (Array.isArray(aiFilters.destinations) && aiFilters.destinations.length) {
        dests = aiFilters.destinations;
      }
    }

    // normalizza (toCanonDestination) tutto ciò che è arrivato
    dests = Array.from(
      new Set(
        (dests || [])
          .map(d => toCanonDestination(d) || d)
          .filter(d => !!d && CANON_DESTS.includes(d as any))
      )
    );

    // budget & guests (merge locale + AI)
    const localBudget = parseBudget(userMessage);
    const localGuests = parseGuests(userMessage);

    const filters = {
      destinations: dests,
      budget_max: localBudget || aiFilters.budget_max || 0,
      guests_min: localGuests || aiFilters.guests_min || 0
    };

    /* 3) Query DB */
    const yachts = await supabaseQuery(filters);

    if (yachts.length > 0) {
      // format & risposta
      const list = yachts.slice(0, 5).map(formatYachtItem).join("\n\n");
      const answer =
        `Ho trovato queste opzioni per te:\n\n${list}\n\n` +
        `Vuoi una proposta personalizzata? Posso raccogliere i tuoi contatti.\n` +
        `*Tariffe a settimana, VAT & APA esclusi.*`;

      return res.status(200).json({
        answer_markdown: answer,
        filters_used: filters,
        yachts,
        source: "yacht"
      });
    }

    /* 4) Nessun risultato → AI (stessa lingua), con invito ad affinare */
    const aiResp = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "Sei l'assistente di Sanlorenzo Charter Fleet. Non sono stati trovati yacht col criterio richiesto: chiedi gentilmente budget/destinazione/ospiti/periodo. Rispondi nella stessa lingua del messaggio."
        },
        { role: "user", content: userMessage }
      ],
      temperature: 0.2
    });
    const aiText = aiResp.choices[0].message.content || "Puoi indicarmi destinazione, budget, numero ospiti e periodo?";
    return res.status(200).json({
      answer_markdown: aiText,
      filters_used: filters,
      yachts: [],
      source: "ai-fallback"
    });

  } catch (err: any) {
    console.error("Assistant error:", err);
    res.status(500).json({ error: err.message || String(err) });
  }
}
