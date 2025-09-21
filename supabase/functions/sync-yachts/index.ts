// supabase/functions/sync-yachts/index.ts
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Client con chiave service role (solo lato server!)
const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
);

type WPYacht = {
  wp_id: number;
  slug: string;
  name: string;
  model?: string;
  series?: string;
  year?: number;
  length_m?: number;
  beam_m?: number;
  draft_m?: number;
  guests?: number;
  cabins?: number;
  crew?: number;
  destinations?: string[];
  flag?: string;
  rate_low?: number;
  rate_high?: number;
  currency?: string;
  rate_notes?: string;
  description?: string;
  brochure_url?: string;
  gallery_urls?: string[];
  permalink?: string;
  modified?: string;
  highlights?: string[];
  toys?: string[];
};

async function upsertYacht(y: WPYacht) {
  const { data, error } = await supabase
    .from("yachts")
    .upsert(
      {
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
      },
      { onConflict: "wp_id,slug" }
    )
    .select()
    .single();

  if (error) throw error;
  const yachtId = data.id;

  // Highlights
  if (y.highlights?.length) {
    for (const h of y.highlights) {
      await supabase.from("yacht_highlights").upsert({
        yacht_id: yachtId,
        highlight: h,
      });
    }
  }
  // Toys
  if (y.toys?.length) {
    for (const t of y.toys) {
      await supabase.from("yacht_toys").upsert({
        yacht_id: yachtId,
        item: t,
      });
    }
  }
}

Deno.serve(async (_req) => {
  try {
    // 👉 Modifica con l'URL del tuo plugin WP
    const wpApi =
      "https://www.sanlorenzocharterfleet.com/wp-json/slcf/v1/yachts";

    const res = await fetch(wpApi);
    if (!res.ok) throw new Error(`WP API error ${res.status}`);
    const items: WPYacht[] = await res.json();

    for (const y of items) {
      await upsertYacht(y);
    }

    return new Response(JSON.stringify({ ok: true, count: items.length }), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

