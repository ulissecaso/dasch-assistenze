// app/admin/page.tsx
// Pannello amministratore: operatori, regole di assegnazione, SLA/alert, importazioni.
import { creaSupabaseClientServer } from "@/lib/supabase/server";
import { aggiornaRegoleFase } from "./sla-actions";
import { separaGiorniOre } from "./sla-utils";

type RegolaFase = {
  fase_id: string;
  nome: string;
  codice: string;
  ordine: number;
  primo?: any;
  secondo?: any;
  periodico?: any;
  escalation?: any;
};

function raggruppaPerFase(regoleAlert: any[]): RegolaFase[] {
  const gruppi = new Map<string, RegolaFase>();
  for (const r of regoleAlert ?? []) {
    if (!r.fase_id) continue; // regole generiche (es. "pratica ferma da") non legate a una fase
    if (!gruppi.has(r.fase_id)) {
      gruppi.set(r.fase_id, {
        fase_id: r.fase_id,
        nome: r.fasi_workflow?.nome ?? "Fase sconosciuta",
        codice: r.fasi_workflow?.codice ?? "",
        ordine: r.fasi_workflow?.ordine ?? 0,
      });
    }
    (gruppi.get(r.fase_id) as any)[r.step] = r;
  }
  return [...gruppi.values()]
    .filter((g) => g.primo && g.secondo && g.periodico) // solo le fasi con la catena completa configurata
    .sort((a, b) => a.ordine - b.ordine);
}

export default async function AdminPage() {
  const supabase = creaSupabaseClientServer();

  const [
    { data: operatori, error: erroreOperatori },
    { data: regoleAssegnazione, error: erroreRegoleAssegnazione },
    { data: regoleAlert, error: erroreRegoleAlert },
    { data: importazioni, error: erroreImportazioni },
  ] = await Promise.all([
    supabase.from("utenti").select("*").order("cognome"),
    supabase.from("regole_assegnazione").select("*, utenti(nome, cognome)").order("priorita"),
    supabase.from("regole_alert").select("*, fasi_workflow(nome, codice, ordine)").eq("attiva", true),
    supabase.from("importazioni_csv").select("*").order("iniziata_il", { ascending: false }).limit(20),
  ]);

  const erroriQuery = [
    erroreOperatori && `utenti: ${erroreOperatori.message}`,
    erroreRegoleAssegnazione && `regole_assegnazione: ${erroreRegoleAssegnazione.message}`,
    erroreRegoleAlert && `regole_alert: ${erroreRegoleAlert.message}`,
    erroreImportazioni && `importazioni_csv: ${erroreImportazioni.message}`,
  ].filter(Boolean) as string[];

  const fasiConfigurabili = raggruppaPerFase(regoleAlert ?? []);
  const regoleGeneriche = (regoleAlert ?? []).filter((r: any) => !r.fase_id);

  return (
    <main className="p-6 space-y-8">
      <h1 className="text-2xl font-semibold">Pannello amministratore</h1>

      {erroriQuery.length > 0 && (
        <section className="bg-red-50 border border-red-300 rounded-xl p-4 text-sm text-red-800">
          <p className="font-semibold mb-2">Errore nel leggere i dati da Supabase:</p>
          <ul className="list-disc list-inside space-y-1">
            {erroriQuery.map((e) => <li key={e}>{e}</li>)}
          </ul>
        </section>
      )}

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-3">Regole di assegnazione</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500"><th>Nome</th><th>Criterio</th><th>Intervallo</th><th>Operatore</th><th>Priorità</th><th>Attiva</th></tr></thead>
          <tbody>
            {(regoleAssegnazione ?? []).map((r: any) => (
              <tr key={r.id} className="border-t">
                <td className="py-1">{r.nome}</td>
                <td>{r.criterio}</td>
                <td>{r.valore_da} - {r.valore_a}</td>
                <td>{r.utenti?.nome} {r.utenti?.cognome}</td>
                <td>{r.priorita}</td>
                <td>{r.attiva ? "Sì" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-xs text-gray-400 mt-2">Modificabile via form CRUD (componente client) — le modifiche si applicano immediatamente alle nuove pratiche.</p>
      </section>

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-1">Soglie SLA per fase</h2>
        <p className="text-xs text-gray-400 mb-4">
          Ogni fase ha una catena di alert: un preavviso (Primo), la soglia vera e propria (Secondo),
          poi solleciti ripetuti (Periodico) fino a un tetto, dopo il quale scatta l&apos;escalation
          automatica ai responsabili/admin. I valori valgono per tutte le pratiche, non per la singola pratica.
        </p>
        <div className="grid gap-4 md:grid-cols-2">
          {fasiConfigurabili.map((fase) => (
            <form
              key={fase.fase_id}
              action={aggiornaRegoleFase}
              className="border rounded-lg p-4 space-y-3"
            >
              <input type="hidden" name="primo_id" value={fase.primo.id} />
              <input type="hidden" name="secondo_id" value={fase.secondo.id} />
              <input type="hidden" name="periodico_id" value={fase.periodico.id} />

              <h3 className="font-semibold text-gray-800">{fase.nome}</h3>

              <CampoDurata
                label="Primo Allert (preavviso)"
                nomeGiorni="primo_giorni"
                nomeOre="primo_ore"
                valore={separaGiorniOre(fase.primo.soglia_valore, fase.primo.soglia_unita)}
              />
              <CampoDurata
                label="Secondo Allert (soglia)"
                nomeGiorni="secondo_giorni"
                nomeOre="secondo_ore"
                valore={separaGiorniOre(fase.secondo.soglia_valore, fase.secondo.soglia_unita)}
              />
              <CampoDurata
                label="Ripeti ogni (allert periodico)"
                nomeGiorni="intervallo_giorni"
                nomeOre="intervallo_ore"
                valore={separaGiorniOre(fase.periodico.ripeti_ogni_valore, fase.periodico.ripeti_ogni_unita)}
              />
              <label className="block text-sm">
                <span className="text-gray-600">Numero massimo di solleciti prima dell&apos;escalation</span>
                <input
                  type="number"
                  min={1}
                  name="tetto"
                  defaultValue={fase.periodico.ripeti_max_volte ?? 3}
                  className="mt-1 w-24 border rounded px-2 py-1"
                />
              </label>
              {fase.escalation && (
                <p className="text-xs text-gray-400">
                  Dopo il tetto: <span className="font-medium">{fase.escalation.nome}</span> (notifica {fase.escalation.destinatari_ruolo?.join(", ")})
                </p>
              )}

              <button type="submit" className="mt-2 bg-gray-900 text-white text-sm rounded px-3 py-1.5">
                Salva soglie
              </button>
            </form>
          ))}
        </div>

        {regoleGeneriche.length > 0 && (
          <div className="mt-6">
            <h3 className="text-sm font-medium text-gray-600 mb-2">Regole generali (non legate a una singola fase)</h3>
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500"><th>Nome</th><th>Condizione</th><th>Soglia</th><th>Livello</th></tr></thead>
              <tbody>
                {regoleGeneriche.map((r: any) => (
                  <tr key={r.id} className="border-t">
                    <td className="py-1">{r.nome}</td>
                    <td>{r.tipo_condizione}</td>
                    <td>{r.soglia_valore} {r.soglia_unita}</td>
                    <td>{r.livello}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-3">Importazioni CSV</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500"><th>File</th><th>Stato</th><th>Nuove</th><th>Aggiornate</th><th>Errori</th><th>Data</th></tr></thead>
          <tbody>
            {(importazioni ?? []).map((i: any) => (
              <tr key={i.id} className="border-t">
                <td className="py-1">{i.nome_file}</td>
                <td>{i.stato}</td>
                <td>{i.righe_nuove}</td>
                <td>{i.righe_aggiornate}</td>
                <td className={i.righe_errore > 0 ? "text-red-600" : ""}>{i.righe_errore}</td>
                <td>{new Date(i.iniziata_il).toLocaleString("it-IT")}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {/* Upload manuale: componente client che fa POST a /api/import-csv */}
      </section>

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-3">Operatori e utenti</h2>
        <table className="w-full text-sm">
          <thead><tr className="text-left text-gray-500"><th>Nome</th><th>Email</th><th>Ruolo</th><th>Attivo</th></tr></thead>
          <tbody>
            {(operatori ?? []).map((u: any) => (
              <tr key={u.id} className="border-t">
                <td className="py-1">{u.nome} {u.cognome}</td>
                <td>{u.email}</td>
                <td>{u.ruolo}</td>
                <td>{u.attivo ? "Sì" : "No"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}

/** Coppia di campi numerici Giorni + Ore con etichetta, per i form delle soglie SLA. */
function CampoDurata({
  label,
  nomeGiorni,
  nomeOre,
  valore,
}: {
  label: string;
  nomeGiorni: string;
  nomeOre: string;
  valore: { giorni: number; ore: number };
}) {
  return (
    <div className="text-sm">
      <span className="text-gray-600">{label}</span>
      <div className="flex gap-2 mt-1">
        <label className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            name={nomeGiorni}
            defaultValue={valore.giorni}
            className="w-16 border rounded px-2 py-1"
          />
          <span className="text-xs text-gray-500">giorni</span>
        </label>
        <label className="flex items-center gap-1">
          <input
            type="number"
            min={0}
            max={23}
            name={nomeOre}
            defaultValue={valore.ore}
            className="w-16 border rounded px-2 py-1"
          />
          <span className="text-xs text-gray-500">ore</span>
        </label>
      </div>
    </div>
  );
}
