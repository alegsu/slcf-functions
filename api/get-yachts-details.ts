import { createClient } from '@supabase/supabase-js';

// Inizializza Supabase
const supabaseUrl = 'YOUR_SUPABASE_URL';
const supabaseKey = 'YOUR_SUPABASE_KEY';
const supabase = createClient(supabaseUrl, supabaseKey);

export const getYachtsDetails = async ({
    destinations,
    guests_min,
    budget_max,
    series,
    model_like,
    length_min,
    length_max,
    year_min,
    year_max,
    sort_by,
}) => {
    // Costruisci la query per filtrare gli yacht
    let query = supabase
        .from('yachts')
        .select('*');

    if (destinations) {
        query = query.in('destination', destinations);
    }
    if (guests_min) {
        query = query.gte('guests', guests_min);
    }
    if (budget_max) {
        query = query.lte('budget', budget_max);
    }
    if (series) {
        query = query.in('series', series);
    }
    if (model_like) {
        query = query.ilike('model', `%${model_like}%`);
    }
    if (length_min) {
        query = query.gte('length', length_min);
    }
    if (length_max) {
        query = query.lte('length', length_max);
    }
    if (year_min) {
        query = query.gte('year', year_min);
    }
    if (year_max) {
        query = query.lte('year', year_max);
    }
    if (sort_by) {
        query = query.order(sort_by);
    }

    // Esegui la query e restituisci i risultati
    const { data, error } = await query;

    if (error) {
        throw new Error(error.message);
    }

    return data;
};
