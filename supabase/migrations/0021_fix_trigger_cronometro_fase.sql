-- =====================================================================
-- FIX: trg_fn_avvia_cronometro_fase impostava data_prevista = now()
-- senza aggiungere lo SLA della fase.
-- =====================================================================
--
-- Contesto: questo trigger (creato direttamente in produzione, non
-- ancora tracciato in una migrazione precedente - da qui il numero 0021
-- che documenta finalmente cosa gira gia' sul database) scatta ogni
-- volta che una pratica_fasi passa a stato = 'in_corso' (BEFORE UPDATE
-- ON pratica_fasi). Doveva far ripartire il "cronometro" della fase
-- impostando la nuova scadenza a "adesso + SLA della fase" (vedi
-- fasi_workflow.sla_ore_default), ma la versione live si limitava a
-- new.data_prevista := now(), senza aggiungere alcuno SLA: la scadenza
-- risultava quindi identica al momento in cui la fase partiva, quindi
-- gia' scaduta all'istante zero -> alert "critica"/"grave" immediati
-- anche per pratiche appena avanzate (es. 1100/26, 1104/26 del
-- 06/08/2026: "Arrivo merce in deposito" partito e gia' fuori SLA nello
-- stesso secondo).
--
-- Colpiva in pratica ogni avanzamento automatico di fase fatto
-- dall'importatore CSV (scripts/import-csv/importVamartCsv.mjs e
-- apps/web/lib/import/eseguiImportazione.ts, funzione
-- sincronizzaFasiAssistenza/sincronizzaFasiConsegna: quando una fase
-- passa a "in_corso" li' dentro viene aggiornato solo lo stato, la
-- data_prevista è delegata a questo trigger) e ogni riattivazione
-- manuale (vedi annullaConfermaOrdine in
-- apps/web/app/pratiche/[id]/pratica-actions.ts, che si affida
-- esplicitamente a questo trigger per far ripartire il conto alla
-- rovescia).
--
-- Non toccava invece: la creazione iniziale della pratica (trigger
-- separato, BEFORE INSERT) e riavviaContoConfermaOrdine (che scrive
-- gia' la propria data_prevista corretta senza cambiare stato, quindi
-- la condizione "old.stato is distinct from 'in_corso'" restava falsa).
--
-- ---------------------------------------------------------------------
-- 1. Fix del trigger: aggiunge lo SLA della fase.
-- ---------------------------------------------------------------------
create or replace function public.trg_fn_avvia_cronometro_fase()
returns trigger
language plpgsql
as $function$
declare
  v_sla_ore numeric;
begin
  if new.stato = 'in_corso' and (old.stato is distinct from 'in_corso') then
    select sla_ore_default into v_sla_ore from fasi_workflow where id = new.fase_id;
    new.data_prevista := now() + make_interval(hours => coalesce(v_sla_ore, 0));
  end if;
  return new;
end;
$function$;

-- ---------------------------------------------------------------------
-- 2. Backfill una tantum: le fasi attualmente "in_corso" con scadenza
--    gia' superata sono quasi certamente vittime di questo bug (nessun
--    altro percorso del codice lascia una fase in_corso con una
--    data_prevista nel passato senza passare da qui). Fanno eccezione i
--    posticipi manuali dell'operatore (posticipaScadenza in
--    pratica-actions.ts), riconoscibili dalla nota che scrivono sempre:
--    quelli restano intoccati, anche se nel frattempo la nuova scadenza
--    scelta dall'operatore fosse gia' passata.
-- ---------------------------------------------------------------------
update pratica_fasi pf
set data_prevista = now() + make_interval(hours => coalesce(fw.sla_ore_default, 0))
from fasi_workflow fw
where pf.fase_id = fw.id
  and pf.stato = 'in_corso'
  and pf.data_prevista <= now()
  and coalesce(pf.note, '') not like 'Posticipata manualmente%';
