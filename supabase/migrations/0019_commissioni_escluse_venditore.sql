-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Esclusione commissioni per venditore
-- (store di Roma, Vamart Cinquegrana)
-- =====================================================================
-- Richiesto il 24/07/2026: le commissioni generate dai due arredatori dello
-- store di Roma (colonna "Venditore" del CSV "Commissioni" Vamart:
-- "Martina Facchini" e "Iebba Noemi") non vanno mai tracciate da questo
-- sistema. A differenza dei casi in 0017/0018 (pratiche "di prova":
-- mostra/negozio/expo/ufficio, riconosciute dal NOME CLIENTE, che e' finto),
-- qui il cliente e' reale: il problema e' CHI ha venduto, non chi ha
-- comprato. Lo store di Roma segue l'assistenza dei propri clienti per
-- conto suo, quindi seguirla anche qui creerebbe doppioni/notifiche/
-- assegnazioni automatiche per commesse che nessun operatore Dasch deve
-- davvero lavorare.
--
-- Modifica applicativa collegata (stesso giorno): importCommissioniAssistenza.mjs
-- e apps/web/lib/import/eseguiImportazioneCommissioni.ts (uniche letture del
-- CSV "Commissioni", quindi le uniche che vedono la colonna Venditore) non
-- creano piu' una pratica 'assistenza' per queste righe.
--
-- PROBLEMA RISCONTRATO SUBITO DOPO: il CSV "Piano di Carico" (usato da
-- importVamartCsv.mjs per il modulo Consegne, vedi parseCsv.mjs) NON ha una
-- colonna Venditore - solo "Cliente" - quindi non puo' sapere da solo che
-- una commissione appartiene allo store di Roma. Una volta che
-- l'importatore Commissioni smette di creare la pratica 'assistenza' per
-- questi codici, importVamartCsv.mjs la vede come "commissione senza
-- pratica esistente" e ne crea una nuova di tipo 'consegna': la stessa
-- commissione ricompariva quindi nella Dashboard Consegne invece di sparire
-- del tutto.
--
-- SOLUZIONE: una blacklist per CODICE COMMISSIONE (non per nome cliente,
-- che qui e' reale), popolata dall'unico importatore che legge la colonna
-- Venditore, e un trigger BEFORE INSERT su "pratiche" - stessa logica/stile
-- di 0017/0018 (riusa lo stato 'annullata', recuperabile con "Riattiva"
-- dall'admin, agisce solo in inserimento) - che annulla automaticamente
-- QUALUNQUE pratica (assistenza o consegna, da qualunque importatore o
-- percorso futuro: Piano di Carico, email, manuale) il cui
-- codice_commissione compare in questa tabella per lo stesso brand.
--
-- Tabella pensata riusabile anche per casi futuri simili (altra commissione
-- da escludere per motivi non legati al nome cliente): basta un insert
-- manuale in Supabase SQL Editor, nessuna nuova migrazione necessaria.
-- =====================================================================

create table if not exists commissioni_escluse (
  id uuid primary key default uuid_generate_v4(),
  brand_id uuid not null references brands(id),
  codice_commissione text not null,
  motivo text,
  creato_il timestamptz not null default now(),
  unique (brand_id, codice_commissione)
);
comment on table commissioni_escluse is 'Codici commissione (per brand) da non tracciare mai come pratica, indipendentemente dal tipo (assistenza/consegna) o da quale importatore la incontri per primo. Popolata da importCommissioniAssistenza.mjs/eseguiImportazioneCommissioni.ts per le commissioni dei due arredatori dello store di Roma (venditore Martina Facchini/Iebba Noemi su Cinquegrana), riusabile in futuro per altri casi simili con un semplice insert manuale.';

create or replace function trg_fn_escludi_commissioni_blacklist()
returns trigger as $$
begin
  if new.stato_generale is distinct from 'annullata'
     and exists (
       select 1 from commissioni_escluse ce
       where ce.brand_id = new.brand_id
         and ce.codice_commissione = new.codice_commissione
     )
  then
    insert into storico_modifiche (entita, entita_id, campo, valore_precedente, valore_nuovo, origine, modificato_da)
    values ('pratiche', new.id, 'stato_generale', new.stato_generale,
            'annullata (esclusa automaticamente: commissione presente in commissioni_escluse)', 'automazione', null);

    new.stato_generale := 'annullata';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_pratiche_escludi_commissioni_blacklist on pratiche;
create trigger trg_pratiche_escludi_commissioni_blacklist
  before insert on pratiche
  for each row execute function trg_fn_escludi_commissioni_blacklist();

-- ---------------------------------------------------------------------
-- BACKFILL: pratiche gia' esistenti (di qualunque tipo, incluse quelle di
-- tipo 'consegna' create per errore da importVamartCsv.mjs prima di questo
-- fix) per codici gia' presenti in commissioni_escluse. Alla primissima
-- applicazione di questa migrazione la tabella e' vuota (si popola da sola
-- al prossimo giro di importCommissioniAssistenza.mjs): questo blocco serve
-- soprattutto per le esecuzioni successive, o se si inserisce a mano un
-- codice noto in commissioni_escluse.
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.id, p.stato_generale
    from pratiche p
    join commissioni_escluse ce on ce.brand_id = p.brand_id and ce.codice_commissione = p.codice_commissione
    where p.stato_generale is distinct from 'annullata'
  loop
    insert into storico_modifiche (entita, entita_id, campo, valore_precedente, valore_nuovo, origine, modificato_da)
    values ('pratiche', r.id, 'stato_generale', r.stato_generale,
            'annullata (esclusa automaticamente: commissione presente in commissioni_escluse)', 'automazione', null);

    update pratiche set stato_generale = 'annullata' where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- VERIFICA CONSIGLIATA (facoltativa, da eseguire in Supabase SQL Editor
-- dopo il prossimo giro di importazione): elenca le pratiche escluse da
-- questa logica, per controllare che non ci siano falsi positivi. Se ce ne
-- fosse uno, dalla pagina admin -> Gestione pratiche -> cerca il codice
-- pratica -> "Riattiva".
--
-- select p.codice_commissione, p.tipo, c.nome_completo, p.stato_generale, ce.motivo
-- from pratiche p
-- join commissioni_escluse ce on ce.brand_id = p.brand_id and ce.codice_commissione = p.codice_commissione
-- join clienti c on c.id = p.cliente_id
-- order by p.created_at desc;
--
-- Per aggiungere in futuro un altro codice da escludere a mano, senza
-- bisogno di una nuova migrazione:
--   insert into commissioni_escluse (brand_id, codice_commissione, motivo)
--   select id, '1234/26', 'motivo' from brands where codice = 'CINQUEGRANA'
--   on conflict (brand_id, codice_commissione) do nothing;
-- ---------------------------------------------------------------------
