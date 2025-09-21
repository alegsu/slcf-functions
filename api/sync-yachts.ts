// api/sync-yachts.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

type WPYacht = {
  wp_id: number; slug: string; name: string;
  model?: string; series?: string; year?: number;
  length_m?: number; beam_m?: number; draft_m?: number;
  guests?: number; cabins?: number; crew?: number;
  destinations?: string[]; flag?: string;
  rate_low?: number; rate_high?: number; currency?: string; rate_notes?: string;
  description?: string; brochure_url?: string; gallery_urls?: string[];
  permalink?: string; modified?: string; highlights?: string[]; toys?: string[];
};

export default async function handler(req: any, res: any) {
  try {
    // opzionale: protezione semplice con secret (aggiungi CRON_SECRET su Vercel e invia header x-cron-secret)
    const secret = process.env.CRON_SECRET;
    if (secret && req.headers["x-cron-secret"] !== secret) {
      return res.status(401).json({ error: "unauthorized" });
    }

    const wpApi =
      process.env.WP_API_URL ||
      "https://www.sanlorenzocharterfleet.com/wp-json/slcf/v1/yachts";

    const r = await fetch(wpApi, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`WP API ${r.status}`);
    const items: WPYacht[] = await r.json();

    // mappo tutto in un'unica upsert bulk (veloce per i limiti delle serverless)
    const rows = items.map((y) => ({
      wp_id: y.wp_id,
      slug: y.slug,
      name: y.name,
      model: y.model ?? null,
      series: y.series ?? null,
      year: y.year ?? null,
      length_m: y.length_m ?? null,
      beam_m: y.beam_m ?? null,
      draft_m: y.draft_m ?? null,
      guests: y.guests ?? null,
      cabins: y.cabins ?? null,
      crew: y.crew ?? null,
      destinations: y.destinations ?? [],
      flag: y.flag ?? null,
      rate_low: y.rate_low ?? null,
      rate_high: y.rate_high ?? null,
      currency: y.currency ?? null,
      rate_notes: y.rate_notes ?? null,
      description: y.description ?? null,
      brochure_url: y.brochure_url ?? null,
      gallery_urls: y.gallery_urls ?? [],
      source_url: y.permalink ?? null,
      last_synced_at: new Date().toISOString(),
      is_active: true,
    }));

    const { error } = await supabase
      .from("yachts")
      .upsert(rows, { onConflict: "wp_id" });

    if (error) throw error;

    return res.status(200).json({ ok: true, count: rows.length });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
