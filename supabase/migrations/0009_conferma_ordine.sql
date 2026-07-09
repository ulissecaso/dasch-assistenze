-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Nuova fase "Conferma ordine"
-- + vista di supporto per la percentuale di merce arrivata in deposito
-- =====================================================================
--
-- Contesto: tra "Invio ordine ricambi" (ordine=50) e "Arrivo merce in
-- deposito" (ordine=60) inseriamo una fase intermedia "Conferma ordine"
-- (ordine=55) che l'operatore deve dichiarare MANUALMENTE (pulsante
-- "Dichiaro: conferma ordine ricevuta" sulla schermata pratica, vedi
-- app/pratiche/[id]/pratica-actions.ts). Finche' non viene dichiarata,
-- "Arrivo merce in deposito" non avanza in automatico dall'importatore
-- CSV, anche se Vamart segnala gia' merce arrivata: e' un controllo
-- umano voluto (vedi la modifica a sincronizzaFasiDaRighe in
-- scripts/import-csv/importVamartCsv.mjs).
--
-- NOTA: fasi_workflow.ordine ha "buchi" di 10 in 10 (10,20,...90), quindi
-- 55 si inserisce senza dover rinumerare nessun'altra fase.

-- ---------------------------------------------------------------------
-- 1. Nuova fase
-- ---------------------------------------------------------------------
insert into fasi_workflow (codice, nome, ordine, sla_ore_default)
values ('conferma_ordine', 'Conferma ordine', 55, 48)
on conflict (codice) do nothing;

-- ---------------------------------------------------------------------
-- 2. Backfill: crea la riga pratica_fasi "conferma_ordine" per tutte le
--    pratiche gia' esistenti (il trigger trg_pratiche_inizializza_fasi,
--    migrazione 0002, crea questa riga solo per le pratiche NUOVE create
--    da qui in poi, dato che gira "after insert on pratiche").
--    Stato iniziale in base a quanto la pratica e' gia' avanzata:
--      - se "Arrivo merce in deposito" e' gia' completata: la conferma
--        d'ordine e' evidentemente gia' avvenuta in passato -> segnata
--        completata automaticamente, nessun blocco retroattivo su
--        pratiche gia' avanzate o chiuse.
--      - se "Invio ordine ricambi" e' completata ma "Arrivo merce" no:
--        la fase parte adesso (in_corso, cronometro da oggi), l'operatore
--        deve dichiararla quanto prima.
--      - altrimenti: la pratica non e' ancora arrivata a quel punto ->
--        da_iniziare, con una data_prevista stimata (stessa logica di
--        trg_fn_inizializza_fasi_pratica: now() + sla_ore_default);
--        verra' sovrascritta dal cronometro quando la fase partira' sul serio.
-- ---------------------------------------------------------------------
do $$
declare
  v_fase_conferma_ordine uuid;
  v_fase_ordine_ricambi uuid;
  v_fase_arrivo_merce uuid;
begin
  select id into v_fase_conferma_ordine from fasi_workflow where codice = 'conferma_ordine';
  select id into v_fase_ordine_ricambi from fasi_workflow where codice = 'ordine_ricambi';
  select id into v_fase_arrivo_merce from fasi_workflow where codice = 'arrivo_merce';

  insert into pratica_fasi (pratica_id, fase_id, stato, data_prevista, data_effettiva, note)
  select
    p.id,
    v_fase_conferma_ordine,
    case
      when pf_arrivo.stato = 'completata' then 'completata'
      when pf_ordine.stato = 'completata' then 'in_corso'
      else 'da_iniziare'
    end,
    case
      when pf_arrivo.stato = 'completata' then now()
      when pf_ordine.stato = 'completata' then now()
      else now() + make_interval(hours => 48)
    end,
    case when pf_arrivo.stato = 'completata' then now() else null end,
    case
      when pf_arrivo.stato = 'completata' then 'Completata automaticamente in fase di migrazione: la pratica era gia'' oltre questo punto del workflow (arrivo merce gia'' completato) prima che questa fase esistesse.'
      else null
    end
  from pratiche p
  join pratica_fasi pf_ordine on pf_ordine.pratica_id = p.id and pf_ordine.fase_id = v_fase_ordine_ricambi
  join pratica_fasi pf_arrivo on pf_arrivo.pratica_id = p.id and pf_arrivo.fase_id = v_fase_arrivo_merce
  where not exists (
    select 1 from pratica_fasi pf_esistente
    where pf_esistente.pratica_id = p.id and pf_esistente.fase_id = v_fase_conferma_ordine
  );
end $$;

-- ---------------------------------------------------------------------
-- 3. Soglie SLA (catena Primo/Secondo/Periodico+Escalation), stesso
--    modello T1-T4 di 0004_alert_avanzati.sql. Comparira' in automatico
--    nel pannello admin: raggruppaPerFase (app/admin/page.tsx) legge
--    dinamicamente qualsiasi fase con la catena primo+secondo+periodico
--    configurata, non serve toccare quel codice.
-- ---------------------------------------------------------------------
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T2b - Primo Allert: conferma ordine non ancora dichiarata (preavviso)', id, 'fase_non_completata_entro', 24, 'ore', 'primo', 'info', array[]::text[]
from fasi_workflow where codice = 'conferma_ordine';

insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T2b - Secondo Allert: conferma ordine non dichiarata entro la soglia', id, 'fase_non_completata_entro', 72, 'ore', 'secondo', 'alert', array['responsabile']
from fasi_workflow where codice = 'conferma_ordine';

with ins_escalation as (
  insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
  select 'T2b - Escalation: conferma ordine ancora non dichiarata dopo i solleciti', id, 'fase_non_completata_entro', 120, 'ore', 'escalation', 'escalation', array['responsabile','admin']
  from fasi_workflow where codice = 'conferma_ordine'
  returning id
)
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo, ripeti_ogni_valore, ripeti_ogni_unita, ripeti_max_volte, regola_escalation_id)
select 'T2b - Allert periodico: conferma ordine non ancora dichiarata', fw.id, 'fase_non_completata_entro', 72, 'ore', 'periodico', 'alert', array['responsabile'], 24, 'ore', 3, ins_escalation.id
from fasi_workflow fw, ins_escalation
where fw.codice = 'conferma_ordine';

-- ---------------------------------------------------------------------
-- 4. Vista di supporto: percentuale di merce arrivata in deposito per
--    pratica, aggregando le righe di pratica_righe (una riga per
--    articolo, gia' popolate da importVamartCsv.mjs con le quantita' del
--    Piano di Carico). "Arrivata" = quantita_giacente (ancora in
--    deposito) + quantita_consegnata (gia' consegnata al cliente, quindi
--    e' comunque gia' arrivata in deposito prima) sul totale
--    quantita_venduta (il fabbisogno reale della commissione,
--    indipendente da quante righe sono gia' state messe in ordine finora).
-- ---------------------------------------------------------------------
create or replace view v_percentuale_merce_arrivata as
select
  pratica_id,
  sum(coalesce(quantita_venduta, 0)) as quantita_totale,
  sum(coalesce(quantita_giacente, 0) + coalesce(quantita_consegnata, 0)) as quantita_arrivata,
  case
    when sum(coalesce(quantita_venduta, 0)) > 0
      then round(100.0 * sum(coalesce(quantita_giacente, 0) + coalesce(quantita_consegnata, 0)) / sum(quantita_venduta), 1)
    else 0
  end as percentuale_arrivata
from pratica_righe
group by pratica_id;

comment on view v_percentuale_merce_arrivata is
  'Percentuale di merce arrivata in deposito per pratica (quantita_giacente + quantita_consegnata sul totale quantita_venduta). Usata per mostrare "Merce parzialmente pronta in deposito" quando supera la soglia di default (80%, vedi SOGLIA_MERCE_PARZIALE in apps/web/lib/monitor/mappature.ts).';
