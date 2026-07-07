-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Automazioni: assegnazione automatica + SLA
-- =====================================================================

-- ---------------------------------------------------------------------
-- SEED: regole di assegnazione di esempio (come da specifica)
--   A-C -> Maria, D-M -> Giorgio, N-Z -> Luca
--   Il criterio "iniziale_cognome" guarda alla prima lettera della
--   PRIMA PAROLA del campo clienti.nome_completo (di norma il cognome
--   nei documenti del gestionale). Le regole sono interamente
--   modificabili dal pannello amministratore (tabella regole_assegnazione).
-- ---------------------------------------------------------------------
-- Nota: gli operatore_id qui sotto sono placeholder. In fase di setup reale
-- l'admin li seleziona dalla UI (dropdown utenti con ruolo 'operatore').
-- Esempio (da eseguire dopo aver creato gli utenti):
--
-- insert into regole_assegnazione (nome, criterio, valore_da, valore_a, operatore_id, priorita) values
--  ('Cognomi A-C', 'iniziale_cognome', 'A', 'C', '<uuid-maria>', 10),
--  ('Cognomi D-M', 'iniziale_cognome', 'D', 'M', '<uuid-giorgio>', 20),
--  ('Cognomi N-Z', 'iniziale_cognome', 'N', 'Z', '<uuid-luca>', 30);

-- ---------------------------------------------------------------------
-- FUNZIONE: assegna_operatore_automatico
-- Determina l'operatore da assegnare a una pratica in base alle regole attive.
-- ---------------------------------------------------------------------
create or replace function assegna_operatore_automatico(p_cliente_nome text)
returns uuid as $$
declare
  v_iniziale char(1);
  v_operatore_id uuid;
begin
  -- prima lettera della prima parola del nome cliente, maiuscola
  v_iniziale := upper(substring(trim(p_cliente_nome) from 1 for 1));

  select ra.operatore_id into v_operatore_id
  from regole_assegnazione ra
  where ra.attiva = true
    and ra.criterio = 'iniziale_cognome'
    and v_iniziale between upper(ra.valore_da) and upper(ra.valore_a)
  order by ra.priorita asc
  limit 1;

  return v_operatore_id; -- null se nessuna regola corrisponde (assegnazione manuale)
end;
$$ language plpgsql stable;

-- ---------------------------------------------------------------------
-- TRIGGER: assegna automaticamente l'operatore quando si crea una pratica
-- (solo se operatore_assegnato_id non è già stato impostato manualmente)
-- ---------------------------------------------------------------------
create or replace function trg_fn_assegna_operatore()
returns trigger as $$
declare
  v_nome_cliente text;
  v_abilitato boolean;
begin
  select (valore::text)::boolean into v_abilitato
  from configurazioni where chiave = 'regole_assegnazione_attive';

  if coalesce(v_abilitato, true) and new.operatore_assegnato_id is null then
    select nome_completo into v_nome_cliente from clienti where id = new.cliente_id;
    new.operatore_assegnato_id := assegna_operatore_automatico(v_nome_cliente);
  end if;

  return new;
end;
$$ language plpgsql;

create trigger trg_pratiche_assegna_operatore
  before insert on pratiche
  for each row execute function trg_fn_assegna_operatore();

-- Quando una pratica viene creata, inizializza automaticamente tutte le
-- righe di pratica_fasi (una per ogni fase attiva di fasi_workflow),
-- calcolando la data_prevista in base allo SLA di default della fase.
create or replace function trg_fn_inizializza_fasi_pratica()
returns trigger as $$
begin
  insert into pratica_fasi (pratica_id, fase_id, stato, data_prevista)
  select
    new.id,
    fw.id,
    case when fw.ordine = (select min(ordine) from fasi_workflow where attiva) then 'in_corso' else 'da_iniziare' end,
    now() + make_interval(hours => coalesce(fw.sla_ore_default, 24))
  from fasi_workflow fw
  where fw.attiva = true
  order by fw.ordine;

  return new;
end;
$$ language plpgsql;

create trigger trg_pratiche_inizializza_fasi
  after insert on pratiche
  for each row execute function trg_fn_inizializza_fasi_pratica();

-- ---------------------------------------------------------------------
-- SEED: regole di alert/SLA di esempio (soglie configurabili da admin)
-- ---------------------------------------------------------------------
insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, livello, destinatari_ruolo)
select
  'Presa in carico non avvenuta entro 24 ore',
  id, 'fase_non_iniziata_entro', 24, 'ore', 'alert', array['responsabile']
from fasi_workflow where codice = 'presa_in_carico';

insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, livello, destinatari_ruolo)
select
  'Commissione non creata entro 3 giorni',
  id, 'fase_non_completata_entro', 3, 'giorni', 'alert', array['responsabile']
from fasi_workflow where codice = 'creazione_commissione';

insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, livello, destinatari_ruolo)
select
  'Materiale non arrivato entro 30 giorni',
  id, 'fase_non_completata_entro', 30, 'giorni', 'escalation', array['responsabile','admin']
from fasi_workflow where codice = 'arrivo_merce';

insert into regole_alert (nome, fase_id, tipo_condizione, soglia_valore, soglia_unita, livello, destinatari_ruolo)
values
  ('Pratica ferma da troppo tempo', null, 'pratica_ferma_da', 10, 'giorni', 'escalation', array['responsabile','admin']);

-- ---------------------------------------------------------------------
-- VISTA DI SUPPORTO: pratiche_in_ritardo
-- Usata sia dalla dashboard direzione sia dall'edge function check-sla.
-- ---------------------------------------------------------------------
create or replace view v_pratiche_in_ritardo as
select
  p.id as pratica_id,
  p.codice_commissione,
  p.stato_generale,
  p.operatore_assegnato_id,
  pf.id as pratica_fase_id,
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
