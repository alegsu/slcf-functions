// api/sync-yachts.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

type WPYacht = {
  wp_id: number;
  slug: string;
  name: string;
  model?: string;
  year?: number;
  length_m?: number;
  beam_m?: number;
  draft_m?: number;
  guests?: number;
  cabins?: number;
  crew?: number;
  flag?: string;
  rate_low?: number;
  rate_high?: number;
  currency?: string;
  description?: string;
  brochure_url?: string;
  gallery_urls?: string[];
  highlights?: string[];
  destinations?: string[];
  permalink?: string;
  modified?: string;
};

export default async function handler(req: any, res: any) {
  try {
    const wpApi =
      process.env.WP_API_URL ||
      "https://www.sanlorenzocharterfleet.com/wp-json/slcf/v1/yachts";

    const r = await fetch(wpApi, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`WP API ${r.status}`);
    const items: WPYacht[] = await r.json();

    const rows = items.map((y) => {
      // ricavo la serie dal modello
      const series = y.model ? y.model.substring(0, 2) : null;

      return {
        wp_id: y.wp_id,
        slug: y.slug,
        name: y.name,
        model: y.model ?? null,
        series,
        year: y.year ?? null,

        // misure arrotondate (1 decimale)
        length_m: y.length_m ? Math.round(y.length_m * 10) / 10 : null,
        beam_m: y.beam_m ? Math.round(y.beam_m * 10) / 10 : null,
        draft_m: y.draft_m ? Math.round(y.draft_m * 10) / 10 : null,

        guests: y.guests ?? null,
        cabins: y.cabins ?? null,
        crew: y.crew ?? null,
        flag: y.flag ?? null,

        // tariffe arrotondate a intero
        rate_low: y.rate_low ? Math.round(y.rate_low) : null,
        rate_high: y.rate_high ? Math.round(y.rate_high) : null,
        currency: y.currency ?? "EUR",

        description: y.description ?? null,
        brochure_url: y.brochure_url ?? null,
        gallery_urls: y.gallery_urls ?? [],
        highlights: y.highlights ?? [],
        destinations: y.destinations ?? [],

        source_url: y.permalink ?? null,
        last_synced_at: new Date().toISOString(),
        is_active: true,
      };
    });

    const { error } = await supabase
      .from("yachts")
      .upsert(rows, { onConflict: "wp_id" });

    if (error) throw error;

    return res.status(200).json({ ok: true, count: rows.length });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || String(e) });
  }
}
