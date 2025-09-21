// api/search-yachts.ts
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

export default async function handler(req: any, res: any) {
  try {
    const { guests, destinations, budget } = req.query;

    let query = supabase.from("yachts").select("*").eq("is_active", true);

    // Filtra per ospiti
    if (guests) {
      query = query.gte("guests", Number(guests));
    }

    // Filtra per destinazioni (array text[])
    if (destinations) {
      const destArray = (Array.isArray(destinations)
        ? destinations
        : String(destinations).split(",")
      ).map((d) => d.trim());
      for (const d of destArray) {
        query = query.contains("destinations", [d]);
      }
    }

    // Filtra per budget (rate_high <= budget)
    if (budget) {
      query = query.lte("rate_high", Number(budget));
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.status(200).json({
      count: data?.length ?? 0,
      yachts: data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || String(err) });
  }
}
