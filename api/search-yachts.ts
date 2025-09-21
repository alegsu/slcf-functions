// api/search-yachts.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export default async function handler(req: any, res: any) {
  try {
    const {
      guests,
      destinations,
      budget,
      series,
      model_like,
      length_min,
      length_max,
      year_min,
      year_max,
      sort_by
    } = req.query;

    let query = supabase.from("yachts").select("*").eq("is_active", true);

    // 👥 ospiti
    if (guests) {
      query = query.gte("guests", Number(guests));
    }

    // 🌍 destinazioni (array text[])
    if (destinations) {
      const destArray = (Array.isArray(destinations)
        ? destinations
        : String(destinations).split(",")
      ).map((d) => d.trim());
      for (const d of destArray) {
        query = query.contains("destinations", [d]);
      }
    }

    // 💰 budget massimo
    if (budget) {
      query = query.lte("rate_high", Number(budget));
    }

    // 🔠 series (SL, SD, SX, SP)
    if (series) {
      const arr = (Array.isArray(series)
        ? series
        : String(series).split(",")
      ).map((s) => s.trim().toUpperCase());
      query = query.in("series", arr);
    }

    // 🔍 ricerca modello (LIKE)
    if (model_like) {
      query = query.ilike("model", `%${String(model_like)}%`);
    }

    // 📏 lunghezza min/max
    if (length_min) {
      query = query.gte("length_m", Number(length_min));
    }
    if (length_max) {
      query = query.lte("length_m", Number(length_max));
    }

    // 📅 anno min/max
    if (year_min) {
      query = query.gte("year", Number(year_min));
    }
    if (year_max) {
      query = query.lte("year", Number(year_max));
    }

    // 📊 ordinamenti
    if (sort_by === "price_asc") {
      query = query.order("rate_low", { ascending: true });
    } else if (sort_by === "length_desc") {
      query = query.order("length_m", { ascending: false });
    } else if (sort_by === "year_desc") {
      query = query.order("year", { ascending: false });
    } else {
      query = query.order("rate_low", { ascending: true }); // default
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      count: data?.length ?? 0,
      yachts: data ?? []
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
