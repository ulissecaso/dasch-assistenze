-- Riallinea la data_prevista delle fasi "Programma consegna" e "Pagamento
-- ricevuto" (ancora aperte) alla VERA data di consegna gia' presente su
-- pratiche.data_consegna_prevista.
--
-- Bug corretto in apps/web/lib/import/eseguiImportazione.ts e
-- scripts/import-csv/importVamartCsv.mjs: finora pratica_fasi.data_prevista
-- per queste due fasi veniva scritta una sola volta dal trigger DB alla
-- creazione della pratica (now() + SLA ore, vedi
-- trg_fn_inizializza_fasi_pratica in 0010_modulo_consegne.sql) e non veniva
-- mai piu' aggiornata: se l'operatore spostava la data di consegna su
-- Vamart, il Monitor Consegne continuava a mostrare/ordinare la pratica in
-- base alla vecchia stima (es. pratica 1100/26). Da ora ogni import CSV la
-- riallinea automaticamente; questo script sistema subito le pratiche gia'
-- aperte, senza aspettare il prossimo import.
--
-- NOTA: prima di questa correzione anche pratiche.data_consegna_prevista
-- non veniva mai aggiornata dopo la creazione della pratica, quindi il
-- valore letto qui sotto potrebbe essere a sua volta non aggiornatissimo.
-- Il PROSSIMO import CSV (automatico entro un'ora, o lanciato a mano da
-- pannello admin / workflow_dispatch su GitHub) correggera' anche quello e
-- ripropaghera' la data corretta qui. Questo script e' solo un sollievo
-- immediato sull'ordinamento/urgenza mostrati in dashboard.
update pratica_fasi pf
set data_prevista = p.data_consegna_prevista::timestamptz
from pratiche p, fasi_workflow fw
where pf.pratica_id = p.id
  and pf.fase_id = fw.id
  and fw.codice in ('pianificazione_consegna', 'pagamento')
  and pf.stato <> 'completata'
  and p.tipo = 'consegna'
  and p.stato_generale not in ('chiusa', 'annullata')
  and p.data_consegna_prevista is not null;
