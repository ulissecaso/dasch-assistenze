// app/admin/page.tsx
// Pannello amministratore: operatori, regole di assegnazione, SLA/alert, importazioni.
import { creaSupabaseClientServer } from "@/lib/supabase/server";
import { aggiornaRegoleFase } from "./sla-actions";
import { separaGiorniOre } from "./sla-utils";
import { creaOperatore, creaAdmin, alternaAttivoUtente, cambiaPasswordAdmin, rigeneraCodiceOperatore } from "./operatori-actions";
import { creaRegolaAssegnazione, alternaAttivaRegola, eliminaRegolaAssegnazione } from "./regole-actions";
import { alternaAnnullataPratica, eliminaDefinitivamentePratica } from "./pratiche-actions";
import UploadCsvForm from "@/components/admin/UploadCsvForm";
import { richiediAdmin } from "@/lib/auth/richiediUtente";

export const dynamic = "force-dynamic";

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

export default async function AdminPage({
  searchParams,
}: {
  searchParams?: { q?: string };
}) {
  await richiediAdmin();
  const supabase = creaSupabaseClientServer();

  const filtroPratiche = searchParams?.q?.trim() ?? "";

  let queryPratiche = supabase
    .from("pratiche")
    .select("id, codice_commissione, stato_generale, created_at, clienti(nome_completo), utenti:operatore_assegnato_id(nome, cognome)")
    .order("created_at", { ascending: false })
    .limit(50);
  if (filtroPratiche) {
    // Cerca sia nel codice commissione sia nel nome cliente: copre sia il
    // caso "conosco il numero pratica" sia "conosco solo il cliente".
    //
    // NOTA: non si puo' costruire un .or() con un riferimento diretto a una
    // tabella embedded (es. "clienti.nome_completo") in una stringa unica:
    // PostgREST puo' fallire nel fare il parsing ("failed to parse logic
    // tree"), specialmente con codici commissione che contengono "/" (es.
    // "1053/25", formato standard di Vamart). Per evitarlo, cerchiamo prima
    // i clienti il cui nome corrisponde, poi filtriamo pratiche per
    // codice_commissione OPPURE cliente_id in quell'elenco: sono entrambe
    // colonne della tabella "pratiche" stessa, nessun riferimento embedded.
    const { data: clientiTrovati } = await supabase
      .from("clienti")
      .select("id")
      .ilike("nome_completo", `%${filtroPratiche}%`);
    const idClientiTrovati = (clientiTrovati ?? []).map((c: any) => c.id);

    // Prefisso (non "contiene ovunque"): i codici Vamart sono nel formato
    // "NUMERO/ANNO" (es. "68/25"), e una ricerca "contiene" farebbe comparire
    // anche "168/25", "768/25", "1068/25" ecc. Chi cerca un codice pratica
    // conosce sempre l'inizio esatto, mai una porzione a caso nel mezzo.
    if (idClientiTrovati.length > 0) {
      queryPratiche = queryPratiche.or(
        `codice_commissione.ilike.${filtroPratiche}%,cliente_id.in.(${idClientiTrovati.join(",")})`
      );
    } else {
      queryPratiche = queryPratiche.ilike("codice_commissione", `${filtroPratiche}%`);
    }
  }

  const [
    { data: operatori, error: erroreOperatori },
    { data: regoleAssegnazione, error: erroreRegoleAssegnazione },
    { data: regoleAlert, error: erroreRegoleAlert },
    { data: importazioni, error: erroreImportazioni },
    { data: pratiche, error: errorePratiche },
  ] = await Promise.all([
    supabase.from("utenti").select("*").order("cognome"),
    supabase.from("regole_assegnazione").select("*, utenti(nome, cognome)").order("priorita"),
    supabase.from("regole_alert").select("*, fasi_workflow(nome, codice, ordine)").eq("attiva", true),
    supabase.from("importazioni_csv").select("*").order("iniziata_il", { ascending: false }).limit(20),
    queryPratiche,
  ]);

  const erroriQuery = [
    erroreOperatori && `utenti: ${erroreOperatori.message}`,
    erroreRegoleAssegnazione && `regole_assegnazione: ${erroreRegoleAssegnazione.message}`,
    erroreRegoleAlert && `regole_alert: ${erroreRegoleAlert.message}`,
    erroreImportazioni && `importazioni_csv: ${erroreImportazioni.message}`,
    errorePratiche && `pratiche: ${errorePratiche.message}`,
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
        <table className="w-full text-sm mb-4">
          <thead><tr className="text-left text-gray-500"><th>Nome</th><th>Criterio</th><th>Intervallo</th><th>Operatore</th><th>Priorità</th><th>Attiva</th><th></th></tr></thead>
          <tbody>
            {(regoleAssegnazione ?? []).map((r: any) => (
              <tr key={r.id} className="border-t">
                <td className="py-1">{r.nome}</td>
                <td>{r.criterio}</td>
                <td>{r.valore_da} - {r.valore_a}</td>
                <td>{r.utenti?.nome} {r.utenti?.cognome}</td>
                <td>{r.priorita}</td>
                <td>{r.attiva ? "Sì" : "No"}</td>
                <td className="flex gap-3 py-1">
                  <form action={alternaAttivaRegola}>
                    <input type="hidden" name="id" value={r.id} />
                    <input type="hidden" name="nuovo_stato" value={(!r.attiva).toString()} />
                    <button type="submit" className="text-xs underline text-gray-500">
                      {r.attiva ? "Disattiva" : "Riattiva"}
                    </button>
                  </form>
                  <form action={eliminaRegolaAssegnazione}>
                    <input type="hidden" name="id" value={r.id} />
                    <button type="submit" className="text-xs underline text-red-600">
                      Elimina
                    </button>
                  </form>
                </td>
              </tr>
            ))}
            {(regoleAssegnazione ?? []).length === 0 && (
              <tr><td colSpan={7} className="py-2 text-gray-400">Nessuna regola configurata ancora.</td></tr>
            )}
          </tbody>
        </table>

        <details className="text-sm">
          <summary className="cursor-pointer text-gray-600 font-medium">+ Aggiungi regola di assegnazione</summary>
          <form action={creaRegolaAssegnazione} className="mt-3 grid gap-3 md:grid-cols-6 items-end max-w-3xl">
            <label className="md:col-span-2">
              <span className="block text-xs text-gray-500">Nome regola</span>
              <input name="nome" required placeholder="Cognomi A-G" className="w-full border rounded px-2 py-1" />
            </label>
            <label>
              <span className="block text-xs text-gray-500">Da lettera</span>
              <input name="valore_da" required maxLength={1} placeholder="A" className="w-full border rounded px-2 py-1 uppercase" />
            </label>
            <label>
              <span className="block text-xs text-gray-500">A lettera</span>
              <input name="valore_a" required maxLength={1} placeholder="G" className="w-full border rounded px-2 py-1 uppercase" />
            </label>
            <label className="md:col-span-2">
              <span className="block text-xs text-gray-500">Operatore</span>
              <select name="operatore_id" required className="w-full border rounded px-2 py-1">
                <option value="">-- seleziona --</option>
                {(operatori ?? []).filter((u: any) => u.attivo).map((u: any) => (
                  <option key={u.id} value={u.id}>{u.nome} {u.cognome} ({u.ruolo})</option>
                ))}
              </select>
            </label>
            <label>
              <span className="block text-xs text-gray-500">Priorità</span>
              <input type="number" name="priorita" defaultValue={100} className="w-full border rounded px-2 py-1" />
            </label>
            <button type="submit" className="bg-gray-900 text-white text-sm rounded px-3 py-1.5 md:col-span-1">
              Crea regola
            </button>
          </form>
        </details>
        <p className="text-xs text-gray-400 mt-3">
          Il criterio è sempre "iniziale del cognome del cliente": la pratica va all&apos;operatore la cui regola copre quella lettera.
          Le modifiche si applicano immediatamente alle nuove pratiche.
        </p>
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
        <h2 className="text-lg font-medium mb-1">Importazioni CSV</h2>
        <p className="text-xs text-gray-400 mb-3">
          Scarica il &quot;Piano di Carico&quot; da Vamart e caricalo qui: puoi farlo quante volte vuoi durante la giornata,
          non solo una volta — più spesso lo fai, più aggiornata resta la dashboard per gli operatori.
        </p>
        <UploadCsvForm />
        <table className="w-full text-sm mt-4">
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
      </section>

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-1">Gestione pratiche</h2>
        <p className="text-xs text-gray-400 mb-3">
          Solo admin e responsabili possono annullare una pratica (es. pratiche di prova/test): l&apos;operatore non ha questa possibilità e deve sempre chiedere qui.
          Annullare NON cancella i dati: la pratica sparisce da dashboard, conteggi e alert ma resta recuperabile con &quot;Riattiva&quot;.
        </p>
        <form method="get" className="mb-3 flex gap-2 max-w-md">
          <input
            type="text"
            name="q"
            defaultValue={filtroPratiche}
            placeholder="Cerca per codice pratica o nome cliente..."
            className="flex-1 border rounded px-2 py-1 text-sm"
          />
          <button type="submit" className="bg-gray-900 text-white text-sm rounded px-3 py-1.5">
            Cerca
          </button>
        </form>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-1">Pratica</th><th>Cliente</th><th>Operatore</th><th>Stato</th><th>Aperta il</th><th></th>
            </tr>
          </thead>
          <tbody>
            {(pratiche ?? []).map((p: any) => (
              <tr key={p.id} className="border-t">
                <td className="py-1">
                  <a href={`/pratiche/${p.id}`} className="text-blue-700 underline">{p.codice_commissione}</a>
                </td>
                <td>{p.clienti?.nome_completo ?? "—"}</td>
                <td>{p.utenti ? `${p.utenti.nome} ${p.utenti.cognome}` : "Non assegnato"}</td>
                <td>
                  <span className={p.stato_generale === "annullata" ? "text-red-600 font-medium" : ""}>
                    {p.stato_generale}
                  </span>
                </td>
                <td>{new Date(p.created_at).toLocaleDateString("it-IT")}</td>
                <td>
                  <form action={alternaAnnullataPratica}>
                    <input type="hidden" name="pratica_id" value={p.id} />
                    <input type="hidden" name="nuovo_stato" value={p.stato_generale === "annullata" ? "aperta" : "annullata"} />
                    <button
                      type="submit"
                      className={`text-xs underline ${p.stato_generale === "annullata" ? "text-green-700" : "text-red-600"}`}
                    >
                      {p.stato_generale === "annullata" ? "Riattiva" : "Annulla pratica"}
                    </button>
                  </form>
                  {p.stato_generale === "annullata" && (
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-red-800">Elimina definitivamente</summary>
                      <form action={eliminaDefinitivamentePratica} className="mt-1 flex flex-col items-start gap-1">
                        <input type="hidden" name="pratica_id" value={p.id} />
                        <label className="flex items-center gap-1 text-xs text-red-800">
                          <input type="checkbox" name="conferma" value="si" required />
                          Confermo: cancella per sempre, non recuperabile
                        </label>
                        <button type="submit" className="bg-red-800 text-white text-xs rounded px-2 py-1">
                          Elimina DEFINITIVAMENTE
                        </button>
                      </form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
            {(pratiche ?? []).length === 0 && (
              <tr><td colSpan={6} className="py-2 text-gray-400">Nessuna pratica trovata{filtroPratiche ? " per questa ricerca" : ""}.</td></tr>
            )}
          </tbody>
        </table>
        <p className="text-xs text-gray-400 mt-2">
          Mostrate al massimo 50 pratiche{filtroPratiche ? " per questa ricerca" : " (le più recenti)"}: usa la ricerca per trovarne altre.
        </p>
      </section>

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-3">Operatori e utenti</h2>
        <table className="w-full text-sm mb-4">
          <thead><tr className="text-left text-gray-500"><th>Nome</th><th>Ruolo</th><th>Accesso</th><th>Attivo</th><th></th></tr></thead>
          <tbody>
            {(operatori ?? []).map((u: any) => (
              <tr key={u.id} className="border-t">
                <td className="py-1">{u.nome} {u.cognome}</td>
                <td>{u.ruolo}</td>
                <td>
                  {u.codice_accesso ? (
                    <details>
                      <summary className="cursor-pointer text-blue-700">mostra codice</summary>
                      <span className="font-mono bg-gray-100 px-2 py-0.5 rounded">{u.codice_accesso}</span>
                    </details>
                  ) : (
                    <span className="text-gray-500">{u.email}</span>
                  )}
                </td>
                <td>{u.attivo ? "Sì" : "No"}</td>
                <td className="flex flex-wrap items-start gap-3 py-1">
                  <form action={alternaAttivoUtente}>
                    <input type="hidden" name="id" value={u.id} />
                    <input type="hidden" name="nuovo_stato" value={(!u.attivo).toString()} />
                    <button type="submit" className="text-xs underline text-gray-500">
                      {u.attivo ? "Disattiva" : "Riattiva"}
                    </button>
                  </form>

                  {u.ruolo === "operatore" ? (
                    <form action={rigeneraCodiceOperatore}>
                      <input type="hidden" name="id" value={u.id} />
                      <button
                        type="submit"
                        className="text-xs underline text-blue-700"
                        title="Genera un nuovo codice di accesso: il vecchio smette subito di funzionare"
                      >
                        Rigenera codice
                      </button>
                    </form>
                  ) : (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-blue-700 underline">Cambia password</summary>
                      <form action={cambiaPasswordAdmin} className="mt-2 flex items-center gap-2">
                        <input type="hidden" name="id" value={u.id} />
                        <input
                          type="password"
                          name="password"
                          required
                          minLength={6}
                          placeholder="Nuova password"
                          className="border rounded px-2 py-1"
                        />
                        <button type="submit" className="bg-gray-900 text-white rounded px-2 py-1">
                          Salva
                        </button>
                      </form>
                    </details>
                  )}
                </td>
              </tr>
            ))}
            {(operatori ?? []).length === 0 && (
              <tr><td colSpan={5} className="py-2 text-gray-400">Nessun utente creato ancora.</td></tr>
            )}
          </tbody>
        </table>

        <div className="grid gap-6 md:grid-cols-2">
          <details className="text-sm border rounded-lg p-3" open>
            <summary className="cursor-pointer text-gray-700 font-medium">+ Nuovo operatore (accesso con codice)</summary>
            <form action={creaOperatore} className="mt-3 space-y-2">
              <input type="hidden" name="ruolo" value="operatore" />
              <label className="block">
                <span className="block text-xs text-gray-500">Nome</span>
                <input name="nome" required className="w-full border rounded px-2 py-1" />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500">Cognome</span>
                <input name="cognome" required className="w-full border rounded px-2 py-1" />
              </label>
              <button type="submit" className="bg-gray-900 text-white text-sm rounded px-3 py-1.5">
                Crea operatore
              </button>
              <p className="text-xs text-gray-400">
                Genera un codice univoco (visibile dopo nella tabella sopra, "mostra codice") da consegnare all&apos;operatore: lo userà per accedere all&apos;app, senza bisogno di una sua email.
              </p>
            </form>
          </details>

          <details className="text-sm border rounded-lg p-3">
            <summary className="cursor-pointer text-gray-700 font-medium">+ Nuovo admin/responsabile (accesso con email)</summary>
            <form action={creaAdmin} className="mt-3 space-y-2">
              <label className="block">
                <span className="block text-xs text-gray-500">Ruolo</span>
                <select name="ruolo" className="w-full border rounded px-2 py-1">
                  <option value="admin">Admin</option>
                  <option value="responsabile">Responsabile</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500">Nome</span>
                <input name="nome" required className="w-full border rounded px-2 py-1" />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500">Cognome</span>
                <input name="cognome" required className="w-full border rounded px-2 py-1" />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500">Email</span>
                <input type="email" name="email" required className="w-full border rounded px-2 py-1" />
              </label>
              <label className="block">
                <span className="block text-xs text-gray-500">Password iniziale</span>
                <input type="text" name="password" required minLength={6} className="w-full border rounded px-2 py-1" />
              </label>
              <button type="submit" className="bg-gray-900 text-white text-sm rounded px-3 py-1.5">
                Crea utente
              </button>
            </form>
          </details>
        </div>
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
