-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Fix: alert/SLA che scavalcavano il tipo
-- pratica (assistenza vs consegna).
--
-- NOTA STORICA: la colonna fasi_workflow.tipo_pratica e il modulo Consegne
-- (fasi 'pianificazione_consegna'/'pagamento') sono gia' live sul database
-- di produzione, ma la migrazione che li ha introdotti non risulta
-- committata in questo repository (manca un equivalente di un
-- "0010_modulo_consegne.sql" in supabase/migrations/): probabilmente
-- applicata a mano dall'SQL editor di Supabase in passato. Questo file non
-- la duplica, si limita a correggere v_pratiche_in_ritardo assumendo che
-- tipo_pratica esista gia' (verificato: e' cosi' in produzione).
--
-- CONTESTO: v_pratiche_in_ritardo (usata da check-sla per generare
-- alert/notifiche, e dalle viste KPI in 0003_viste_kpi.sql) non filtrava
-- per tipo_pratica. Se una pratica di CONSEGNA aveva ancora agganciata una
-- fase del workflow di assistenza (es. residuo di una pratica poi
-- riclassificata da riclassificaAdAssistenza in
-- scripts/import-csv/importCommissioniAssistenza.mjs, o di un'inizializzazione
-- fasi non ancora tipo-aware), quella fase poteva generare un alert
-- incrociato (es. "Commissione non creata entro 3 giorni" su una pratica
-- che l'operatore riconosce come consegna).
-- =====================================================================

-- ---------------------------------------------------------------------
-- v_pratiche_in_ritardo: ricreata (drop+create, non "create or replace":
-- Postgres non permette di rimuovere/spostare colonne con "or replace") con
-- le stesse colonne gia' in produzione (0004_alert_avanzati.sql aveva
-- aggiunto fw.id as fase_id a meta' elenco), aggiungendo solo il filtro
-- fw.tipo_pratica = pratiche.tipo in fondo al where.
-- ---------------------------------------------------------------------
drop view if exists v_pratiche_in_ritardo;
create view v_pratiche_in_ritardo as
select
  p.id as pratica_id,
  p.codice_commissione,
  p.stato_generale,
  p.operatore_assegnato_id,
  pf.id as pratica_fase_id,
  fw.id as fase_id,
  fw.nome as fase_nome,
  pf.stato as fase_stato,
  pf.data_prevista,
  extract(epoch from (now() - pf.data_prevista)) / 3600 as ore_di_ritardo
from pratiche p
join pratica_fasi pf on pf.pratica_id = p.id
join fasi_workflow fw on fw.id = pf.fase_id
where pf.stato in ('da_iniziare','in_corso')
  and pf.data_prevista < now()
  and p.stato_generale not in ('chiusa','annullata')
  and fw.tipo_pratica = coalesce(p.tipo, 'assistenza');

comment on view v_pratiche_in_ritardo is
  'Fasi in ritardo (usata da check-sla e dalle viste KPI): filtra sempre per fw.tipo_pratica = pratiche.tipo, cosi'' le fasi dell''altro modulo non generano mai alert incrociati assistenza/consegna.';

-- ---------------------------------------------------------------------
-- Ripulitura dati storici: eventuali fasi dell'altro modulo ancora aperte
-- su pratiche esistenti (mai toccate da nessun codice applicativo per
-- quel tipo di pratica) vengono marcate "saltata" (non "completata": non
-- e' mai successo davvero, semplicemente non si applica), cosi'
-- spariscono da qualsiasi vista basata su stato in
-- ('da_iniziare','in_corso') senza alterare lo storico di cio' che e'
-- realmente avvenuto.
-- ---------------------------------------------------------------------
update pratica_fasi pf
set stato = 'saltata',
    note = coalesce(pf.note, '') ||
      case when coalesce(pf.note, '') = '' then '' else E'\n' end ||
      'Fase non pertinente per il tipo di questa pratica: marcata automaticamente come non applicabile dalla migrazione 0015.'
from pratiche p, fasi_workflow fw
where pf.pratica_id = p.id
  and pf.fase_id = fw.id
  and pf.stato in ('da_iniziare','in_corso')
  and fw.tipo_pratica is not null
  and fw.tipo_pratica <> coalesce(p.tipo, 'assistenza');
