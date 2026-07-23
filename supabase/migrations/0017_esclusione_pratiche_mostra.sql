-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Esclusione automatica pratiche "mostra"
-- =====================================================================
-- Alcune pratiche corrispondono a commissioni dimostrative/di showroom: il
-- cliente ha la parola "mostra" nel nome (tipicamente tra nome e cognome,
-- es. "Noemi Mostra Gambino") per marcarle come tali nel gestionale. Non
-- sono clienti reali: vanno escluse da tutte le dashboard/monitor/conteggi/
-- alert, esattamente come una pratica annullata manualmente dall'admin (vedi
-- app/admin/pratiche-actions.ts: alternaAnnullataPratica).
--
-- SCELTA DI DESIGN: riusiamo lo stato 'annullata' invece di introdurre un
-- nuovo stato o una nuova colonna. E' gia' escluso ovunque (dashboard-
-- direzione, dashboard-operatore, monitor, v_pratiche_in_ritardo, viste KPI)
-- e resta visibile e recuperabile dall'admin in "Gestione pratiche" con
-- "Riattiva", coerente con come funziona gia' oggi per le pratiche di prova.
--
-- Il confronto usa i confini di parola (\m...\M) e non un semplice "contiene
-- 'mostra'", per non rischiare falsi positivi su nomi/cognomi che
-- contenessero "mostra" come parte di una parola piu' lunga.
--
-- Il trigger agisce SOLO in inserimento (BEFORE INSERT), non in
-- aggiornamento: se l'admin riattiva a mano una pratica marcata per errore
-- (falso positivo), quella scelta resta valida e non viene sovrascritta a
-- ogni successivo aggiornamento da importazione CSV.
-- =====================================================================

create or replace function trg_fn_escludi_pratiche_mostra()
returns trigger as $$
declare
  v_nome_cliente text;
begin
  select nome_completo into v_nome_cliente from clienti where id = new.cliente_id;

  if v_nome_cliente ~* '\mmostra\M' and new.stato_generale is distinct from 'annullata' then
    insert into storico_modifiche (entita, entita_id, campo, valore_precedente, valore_nuovo, origine, modificato_da)
    values ('pratiche', new.id, 'stato_generale', new.stato_generale,
            'annullata (esclusa automaticamente: nome cliente contiene "mostra")', 'automazione', null);

    new.stato_generale := 'annullata';
  end if;

  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_pratiche_escludi_mostra on pratiche;
create trigger trg_pratiche_escludi_mostra
  before insert on pratiche
  for each row execute function trg_fn_escludi_pratiche_mostra();

-- ---------------------------------------------------------------------
-- BACKFILL: pratiche "mostra" gia' esistenti, create prima di questa
-- migrazione (il trigger sopra si applica solo a quelle nuove da qui in
-- avanti). Tocca solo quelle non gia' annullate, e logga ognuna nello
-- storico modifiche per tracciabilita' (stessa logica del trigger).
-- ---------------------------------------------------------------------
do $$
declare
  r record;
begin
  for r in
    select p.id, p.stato_generale
    from pratiche p
    join clienti c on c.id = p.cliente_id
    where c.nome_completo ~* '\mmostra\M'
      and p.stato_generale is distinct from 'annullata'
  loop
    insert into storico_modifiche (entita, entita_id, campo, valore_precedente, valore_nuovo, origine, modificato_da)
    values ('pratiche', r.id, 'stato_generale', r.stato_generale,
            'annullata (esclusa automaticamente: nome cliente contiene "mostra")', 'automazione', null);

    update pratiche set stato_generale = 'annullata' where id = r.id;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- VERIFICA CONSIGLIATA (facoltativa, da eseguire a mano dopo la migrazione):
-- elenca le pratiche appena escluse, per controllare che non ci siano falsi
-- positivi. Se ce ne fosse uno, dalla pagina admin -> Gestione pratiche ->
-- cerca il codice pratica -> "Riattiva".
--
-- select p.codice_commissione, c.nome_completo, p.stato_generale
-- from pratiche p join clienti c on c.id = p.cliente_id
-- where c.nome_completo ~* '\mmostra\M'
-- order by p.created_at desc;
-- ---------------------------------------------------------------------
