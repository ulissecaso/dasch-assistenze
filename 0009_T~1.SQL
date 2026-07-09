-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Fix: timer delle fasi sequenziali, non
-- tutti dalla nascita della pratica.
-- =====================================================================
-- Prima di questa migrazione, trg_fn_inizializza_fasi_pratica calcolava
-- data_prevista per TUTTE le fasi nello stesso istante (creazione della
-- pratica), usando lo sla_ore_default di ciascuna fase. Risultato: il
-- cronometro di "Arrivo merce in deposito" (es. 35 giorni) partiva gia'
-- dalla nascita della pratica, non da quando l'ordine ricambi viene
-- davvero inviato -- quindi le soglie configurate dal pannello admin
-- ("Soglie SLA per fase") non corrispondevano al comportamento reale.
--
-- Da qui in poi: data_prevista rappresenta "quando questa fase e'
-- diventata attiva", non piu' una scadenza calcolata in anticipo.
--  - Alla creazione della pratica, solo la prima fase riceve
--    data_prevista = now(); le altre restano NULL finche' non partono.
--  - Un trigger su pratica_fasi azzera automaticamente data_prevista a
--    now() ogni volta che una fase passa allo stato 'in_corso', da
--    qualunque codice arrivi il cambiamento (mail, scraper Vamart,
--    futura azione manuale dell'operatore) -- cosi' non bisogna
--    ricordarsene in ogni singolo script che fa avanzare una pratica.
--  - v_pratiche_in_ritardo (ore_di_ritardo = now() - data_prevista) e le
--    soglie in regole_alert continuano a funzionare invariate, ma ora
--    misurano davvero "da quanto tempo questa fase e' in corso".

create or replace function trg_fn_inizializza_fasi_pratica()
returns trigger as $$
begin
  insert into pratica_fasi (pratica_id, fase_id, stato, data_prevista)
  select
    new.id,
    fw.id,
    case when fw.ordine = (select min(ordine) from fasi_workflow where attiva) then 'in_corso' else 'da_iniziare' end,
    case when fw.ordine = (select min(ordine) from fasi_workflow where attiva) then now() else null end
  from fasi_workflow fw
  where fw.attiva = true
  order by fw.ordine;

  return new;
end;
$$ language plpgsql;

create or replace function trg_fn_avvia_cronometro_fase()
returns trigger as $$
begin
  if new.stato = 'in_corso' and (old.stato is distinct from 'in_corso') then
    new.data_prevista := now();
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_pratica_fasi_avvia_cronometro on pratica_fasi;
create trigger trg_pratica_fasi_avvia_cronometro
  before update on pratica_fasi
  for each row execute function trg_fn_avvia_cronometro_fase();

-- Backfill una tantum: le fasi gia' 'in_corso' su pratiche esistenti
-- ripartono da adesso, invece di restare con una data_prevista calcolata
-- con la logica vecchia (piu' equo che farle risultare improvvisamente
-- in ritardo o, al contrario, con margine falsato).
update pratica_fasi set data_prevista = now() where stato = 'in_corso';

comment on column pratica_fasi.data_prevista is
  'Da quando questa fase e'' diventata attiva (stato=in_corso). Aggiornata automaticamente da trg_pratica_fasi_avvia_cronometro. NON e'' piu'' una scadenza pre-calcolata.';
