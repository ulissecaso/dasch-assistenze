// lib/monitor/caricaAvvisiImportazione.ts
// Controlla se le due fonti di alimentazione automatica dei dati (import CSV
// Vamart e lettura email di segnalazione) hanno avuto problemi di recente, e
// restituisce un elenco di avvisi da mostrare come banner in cima al Monitor
// (sia Assistenze che Consegne, sia le dashboard autenticate sia il monitor
// pubblico a parete): l'idea è che chi guarda quello schermo tutto il giorno
// (in ufficio) se ne accorga subito e possa avvisare l'amministratore, invece
// di scoprirlo solo quando qualcuno nota "a mano" che manca una pratica.
//
// Volutamente conservativo: segnala solo ERRORI ESPLICITI già registrati dai
// due importatori (righe_errore > 0 per il CSV, esito='errore' per le email),
// non tenta di indovinare una "assenza di importazione" (rischierebbe falsi
// allarmi nei weekend o fuori orario). Finestra di 3 giorni: oltre, il
// problema si considera ormai gestito o irrilevante.
export type AvvisoImportazione = {
  tipo: "csv" | "email";
  messaggio: string;
  dettaglio: string;
  quando: string; // gia' formattato it-IT, pronto per la UI
};

const FINESTRA_GIORNI = 3;

export async function caricaAvvisiImportazione(supabase: any): Promise<AvvisoImportazione[]> {
  const da = new Date();
  da.setDate(da.getDate() - FINESTRA_GIORNI);
  const daIso = da.toISOString();

  const [{ data: csvConErrori }, { data: emailConErrori }] = await Promise.all([
    supabase
      .from("importazioni_csv")
      .select("nome_file, righe_errore, iniziata_il")
      .gt("righe_errore", 0)
      .gte("iniziata_il", daIso)
      .order("iniziata_il", { ascending: false })
      .limit(5),
    supabase
      .from("importazioni_email")
      .select("oggetto, mittente, messaggio_errore, ricevuta_il, created_at")
      .eq("esito", "errore")
      .gte("created_at", daIso)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const avvisi: AvvisoImportazione[] = [];

  for (const c of csvConErrori ?? []) {
    avvisi.push({
      tipo: "csv",
      messaggio: `Import CSV "${c.nome_file}": ${c.righe_errore} righe in errore`,
      dettaglio: "Controllare in Admin → Importazioni CSV",
      quando: c.iniziata_il ? new Date(c.iniziata_il).toLocaleString("it-IT") : "",
    });
  }

  for (const e of emailConErrori ?? []) {
    const quando = e.ricevuta_il ?? e.created_at;
    avvisi.push({
      tipo: "email",
      messaggio: `Segnalazione email non importata: ${e.messaggio_errore ?? "errore sconosciuto"}`,
      dettaglio: e.oggetto ? `Oggetto: "${e.oggetto}"` : "Controllare la casella segnalazioni",
      quando: quando ? new Date(quando).toLocaleString("it-IT") : "",
    });
  }

  return avvisi;
}
