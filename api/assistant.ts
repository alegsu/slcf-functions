// ... dopo aver ottenuto: const { data: yachts, note } = await queryYachts(filters);

// helper di formattazione deterministica (niente allucinazioni)
function formatYachtItem(y: any) {
  const title = `**[${y.name} (${y.model || y.series || ""})](${y.permalink})**`;
  const len = y.length_m ? `${Number(y.length_m).toFixed(1)} m` : "";
  const yr  = y.year ? `Anno: ${y.year}` : "";
  const gc  = (y.guests || y.cabins) ? `Ospiti/Cabine: ${y.guests || "-"} / ${y.cabins || "-"}` : "";
  const rate = (y.rate_low || y.rate_high)
    ? `Tariffa settimanale: ${y.rate_low ? y.rate_low.toLocaleString("it-IT") : "-"} - ${y.rate_high ? y.rate_high.toLocaleString("it-IT") : "-"} ${y.currency || "EUR"}`
    : "";
  const dest = Array.isArray(y.destinations) && y.destinations.length ? `Destinazioni principali: ${y.destinations.join(", ")}` : "";
  const hl   = y.highlights?.[0] ? `Punto forte: ${y.highlights[0]}` : "";

  // blocco a righe, senza righe vuote doppie
  const lines = [title, len && `Lunghezza: ${len}`, yr, gc, rate, dest, hl].filter(Boolean);
  return `- ${lines[0]}\n` + lines.slice(1).map(l => `  ${l}`).join("\n");
}

let answer = "";
const count = (yachts || []).length;

// Messaggi di contesto solo quando NON ci sono risultati
let contextNote = "";
if (count === 0) {
  if (note?.mode === "nearby") {
    contextNote = language.startsWith("en")
      ? `I couldn’t find exact availability there. Nearby areas you might like: ${(note.used || []).join(", ")}.\n\n`
      : `Non ho trovato disponibilità esatta in quell’area. Zone vicine che potresti considerare: ${(note.used || []).join(", ")}.\n\n`;
  } else if (note?.mode === "macro") {
    contextNote = language.startsWith("en")
      ? `I considered the macro-area “${note.base}”, including: ${(note.used || []).join(", ")}.\n\n`
      : `Ho considerato la macro-area “${note.base}”, includendo: ${(note.used || []).join(", ")}.\n\n`;
  } else if (note?.mode === "relaxed_budget") {
    contextNote = language.startsWith("en")
      ? `Showing some options slightly above the indicated budget.\n\n`
      : `Ti mostro alcune opzioni leggermente oltre il budget indicato.\n\n`;
  } else {
    contextNote = language.startsWith("en")
      ? `No exact matches for your criteria.\n\n`
      : `Nessuna corrispondenza esatta per i criteri richiesti.\n\n`;
  }
}

// Lista yacht (se ci sono)
if (count > 0) {
  const list = (yachts || []).slice(0, 5).map(formatYachtItem).join("\n\n");
  answer =
    (language.startsWith("en")
      ? `Here are some yachts that match your request:\n\n${list}\n\n*Rates per week, VAT & APA excluded.*`
      : `Ecco alcune opzioni in linea con la tua richiesta:\n\n${list}\n\n*Tariffe a settimana, VAT & APA esclusi.*`);
} else {
  // Nessun risultato → spiega / suggerisci di affinare
  answer =
    (language.startsWith("en")
      ? `${contextNote}Would you like to consider nearby areas or adjust guests/budget?`
      : `${contextNote}Vuoi considerare aree vicine o modificare ospiti/budget?`);
}

// NIENTE richiesta dati qui: la CTA avviene nel widget (bottoni)
res.status(200).json({
  answer_markdown: answer,
  language,
  filters_used: filters,
  note,
  results_count: count,
  yachts: yachts || [],
  cta_suggested: true // il front-end deciderà se mostrare bottoni
});
