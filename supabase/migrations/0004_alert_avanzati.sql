-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Motore alert avanzato
-- Primo Allert (preavviso) -> Secondo Allert (soglia) -> Allert periodici
-- (con tetto di ripetizioni) -> Escalation, come da schema fornito da Direttore.
-- =====================================================================
--
-- Mappatura T1-T4 del diagramma sulle fasi già presenti in fasi_workflow:
--   T1 "Soglia Presa in Carico"  -> fase 'creazione_commissione'
--        (l'azione che chiude il gate è la generazione della commissione)
--   T2 "Soglia Ordine"           -> fase 'ordine_ricambi'
--   T3 "Soglia Arrivo"           -> fase 'arrivo_merce'
--   T4 "Soglia Consegna"         -> fase 'consegna_materiale'
--
-- Se questa mappatura non rispecchia esattamente il vostro flusso reale,
-- è sufficiente cambiare fase_id sulle righe seed qui sotto (o direttamente
-- dal pannello admin una volta pronto) — nessun'altra parte dello schema
-- dipende da questa scelta.

-- ---------------------------------------------------------------------
-- 1. NUOVE COLONNE su regole_alert
-- ---------------------------------------------------------------------
alter table regole_alert
  add column if not exists step text not null default 'secondo'
    check (step in ('primo','secondo','periodico','escalation')),
  add column if not exists ripeti_ogni_valore int,
  add column if not exists ripeti_ogni_unita text
    check (ripeti_ogni_unita in ('ore','giorni')),
  add column if not exists ripeti_max_volte int,
  add column if not exists regola_escalation_id uuid references regole_alert(id);

comment on column regole_alert.step is
  'Fase della catena di alert: primo (preavviso) / secondo (soglia raggiunta) / periodico (ripetuto) / escalation (dopo il tetto di ripetizioni).';
comment on column regole_alert.ripeti_ogni_valore is
  'Se valorizzato insieme a ripeti_ogni_unita, la regola è periodica: si ripete ogni N unità finché la fase non si chiude.';
comment on column regole_alert.ripeti_max_volte is
  'Numero massimo di ripetizioni prima di attivare regola_escalation_id. NULL = ripetizione infinita, nessuna escalation automatica.';
comment on column regole_alert.regola_escalation_id is
  'Regola da attivare (una tantum) quando una regola periodica raggiunge ripeti_max_volte ripetizioni.';

-- ---------------------------------------------------------------------
-- 2. TABELLA DI STATO: quante volte è già stata inviata una regola per
--    una data pratica, e quando l'ultima volta. Necessaria per il
--    dedupe delle regole "primo/secondo/escalation" (una tantum) e per
--    il conteggio delle ripetizioni delle regole "periodico" (fino al
--    tetto ripeti_max_volte). Molto più affidabile che dedurlo dalla
--    tabella notifiche, che può avere più righe per occorrenza (una per
--    destinatario).
-- ---------------------------------------------------------------------
create table if not exists alert_occorrenze (
  id uuid primary key default uuid_generate_v4(),
  regola_alert_id uuid not null references regole_alert(id) on delete cascade,
  pratica_id uuid not null references pratiche(id) on delete cascade,
  volte_inviato int not null default 0,
  ultimo_invio timestamptz,
  escalation_attivata boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (regola_alert_id, pratica_id)
);
create index if not exists idx_alert_occorrenze_pratica on alert_occorrenze(pratica_id);
drop trigger if exists trg_alert_occorrenze_updated on alert_occorrenze;
create trigger trg_alert_occorrenze_updated before update on alert_occorrenze
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------
-- 3. FIX: la vista v_pratiche_in_ritardo non esponeva fase_id, quindi il
--    filtro per fase nella Edge Function check-sla non funzionava mai
--    (confrontava pratica_fasi.id con fasi_workflow.id). La ricreiamo
--    aggiungendo fw.id as fase_id.
--    Nota: usiamo drop+create (non "create or replace") perché Postgres
--    non permette di inserire una colonna a metà elenco con "or replace"
--    (solo in coda), quindi va ricreata da zero.
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
  and p.stato_generale not in ('chiusa','annullata');

-- ---------------------------------------------------------------------
-- 4. Disattivo i 2 seed di 0002 ormai superati dal nuovo modello a
--    catena (restano invariati gli altri 2: 'presa_in_carico' 24h e
--    'Pratica ferma da troppo tempo', che coprono gate diversi da T1-T4).
-- ---------------------------------------------------------------------
update regole_alert set attiva = false
where nome in (
  'Commissione non creata entro 3 giorni',
  'Materiale non arrivato entro 30 giorni'
);

-- ---------------------------------------------------------------------
-- 5. SEED: catena Primo / Secondo / Periodico+Escalation per T1-T4.
--    Tutti i valori numerici sono placeholder di partenza, pensati per
--    essere ritoccati dal pannello admin (sliders Giorni/Ore/Minuti del
--    mockup che ci hai mandato) senza toccare il codice.
-- ---------------------------------------------------------------------

-- === T1: creazione_commissione ===
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T1 - Primo Allert: commissione non ancora creata (preavviso)', id, 'fase_non_completata_entro', 24, 'ore', 'primo', 'info', array[]::text[]
from fasi_workflow where codice = 'creazione_commissione';

insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T1 - Secondo Allert: commissione non creata entro la soglia', id, 'fase_non_completata_entro', 48, 'ore', 'secondo', 'alert', array['responsabile']
from fasi_workflow where codice = 'creazione_commissione';

with ins_escalation as (
  insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
  select 'T1 - Escalation: commissione ancora non creata dopo i solleciti', id, 'fase_non_completata_entro', 84, 'ore', 'escalation', 'escalation', array['responsabile','admin']
  from fasi_workflow where codice = 'creazione_commissione'
  returning id
)
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo, ripeti_ogni_valore, ripeti_ogni_unita, ripeti_max_volte, regola_escalation_id)
select 'T1 - Allert periodico: commissione non ancora creata', fw.id, 'fase_non_completata_entro', 48, 'ore', 'periodico', 'alert', array['responsabile'], 12, 'ore', 3, ins_escalation.id
from fasi_workflow fw, ins_escalation
where fw.codice = 'creazione_commissione';

-- === T2: ordine_ricambi ===
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T2 - Primo Allert: ordine ricambi non ancora inviato (preavviso)', id, 'fase_non_completata_entro', 48, 'ore', 'primo', 'info', array[]::text[]
from fasi_workflow where codice = 'ordine_ricambi';

insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T2 - Secondo Allert: ordine ricambi non inviato entro la soglia', id, 'fase_non_completata_entro', 120, 'ore', 'secondo', 'alert', array['responsabile']
from fasi_workflow where codice = 'ordine_ricambi';

with ins_escalation as (
  insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
  select 'T2 - Escalation: ordine ricambi ancora non inviato dopo i solleciti', id, 'fase_non_completata_entro', 192, 'ore', 'escalation', 'escalation', array['responsabile','admin']
  from fasi_workflow where codice = 'ordine_ricambi'
  returning id
)
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo, ripeti_ogni_valore, ripeti_ogni_unita, ripeti_max_volte, regola_escalation_id)
select 'T2 - Allert periodico: ordine ricambi non ancora inviato', fw.id, 'fase_non_completata_entro', 120, 'ore', 'periodico', 'alert', array['responsabile'], 24, 'ore', 3, ins_escalation.id
from fasi_workflow fw, ins_escalation
where fw.codice = 'ordine_ricambi';

-- === T3: arrivo_merce ===
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T3 - Primo Allert: merce non ancora arrivata (preavviso)', id, 'fase_non_completata_entro', 10, 'giorni', 'primo', 'info', array[]::text[]
from fasi_workflow where codice = 'arrivo_merce';

insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T3 - Secondo Allert: merce non arrivata entro la soglia', id, 'fase_non_completata_entro', 30, 'giorni', 'secondo', 'alert', array['responsabile']
from fasi_workflow where codice = 'arrivo_merce';

with ins_escalation as (
  insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
  select 'T3 - Escalation: merce ancora non arrivata dopo i solleciti', id, 'fase_non_completata_entro', 36, 'giorni', 'escalation', 'escalation', array['responsabile','admin']
  from fasi_workflow where codice = 'arrivo_merce'
  returning id
)
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo, ripeti_ogni_valore, ripeti_ogni_unita, ripeti_max_volte, regola_escalation_id)
select 'T3 - Allert periodico: merce non ancora arrivata', fw.id, 'fase_non_completata_entro', 30, 'giorni', 'periodico', 'alert', array['responsabile'], 2, 'giorni', 3, ins_escalation.id
from fasi_workflow fw, ins_escalation
where fw.codice = 'arrivo_merce';

-- === T4: consegna_materiale ===
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, step, livello, destinatari_ruolo)
select 'T4 - Primo Allert: consegna non ancora effettuata (preavviso)', id, 'fase_non_completata_entro', 24, 'ore', 'primo', 'info', array[]::text[]
from fasi_workflow where codice = 'consegna_materiale';

insert into regole_alert (nome, 