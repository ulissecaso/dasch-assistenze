-- =====================================================================
-- Correzione manuale una tantum — 3 pratiche assegnate all'operatore
-- sbagliato dalla regola automatica (bug corretto per il futuro dalla
-- migrazione 0016_migliora_assegnazione_cognome.sql, che pero' non tocca
-- le pratiche gia' esistenti).
--
-- Segnalato il 22/07/2026:
--   1002/26 -> deve essere Jessica  (nome cliente "Nome Cognome": Gambino
--              iniziava per G, ma la regola vecchia leggeva "Noemi" -> N)
--   1011/26 -> deve essere Jessica  (nome cliente composto/multi-persona)
--   997/25  -> deve risultare NON ASSEGNATA
--
-- COME USARLO (Supabase -> SQL Editor -> New query):
--   1. Incolla ed esegui prima SOLO la sezione "1) VERIFICA PRIMA" qui sotto
--      e controlla che le 3 righe corrispondano a quello che ti aspetti.
--   2. Se e' tutto ok, incolla ed esegui la sezione "2) CORREZIONE".
--   3. Esegui la sezione "3) VERIFICA DOPO" per confermare il risultato.
--
-- Lo script si ferma con un errore (senza modificare nulla) se in
-- "utenti" non trova esattamente un operatore di nome "Jessica" attivo sul
-- brand Cinquegrana: meglio bloccarsi che assegnare alla persona sbagliata.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) VERIFICA PRIMA — esegui e leggi il risultato prima di continuare
-- ---------------------------------------------------------------------
select
  p.codice_commissione,
  c.nome_completo,
  b.nome as marchio,
  coalesce(u.nome || ' ' || u.cognome, 'Non assegnato') as operatore_attuale,
  p.stato_generale
from pratiche p
join clienti c on c.id = p.cliente_id
join brands b on b.id = p.brand_id
left join utenti u on u.id = p.operatore_assegnato_id
where b.codice = 'CINQUEGRANA'
  and p.codice_commissione in ('1002/26', '1011/26', '997/25')
order by p.codice_commissione;

-- ---------------------------------------------------------------------
-- 2) CORREZIONE — esegui solo dopo aver controllato il punto 1
-- ---------------------------------------------------------------------
do $$
declare
  v_jessica_id uuid;
  v_count int;
  r record;
begin
  select count(*) into v_count
  from utenti
  where lower(nome) = 'jessica' and ruolo = 'operatore' and attivo = true;

  if v_count <> 1 then
    raise exception 'Trovati % operatori attivi di nome "Jessica" (atteso esattamente 1): correggi a mano, script interrotto senza modifiche.', v_count;
  end if;

  select id into v_jessica_id from utenti where lower(nome) = 'jessica' and ruolo = 'operatore' and attivo = true;

  -- 1002/26 e 1011/26 -> Jessica
  for r in
    select p.id, p.codice_commissione, p.operatore_assegnato_id, u.nome || ' ' || u.cognome as operatore_precedente
    from pratiche p
    join brands b on b.id = p.brand_id
    left join utenti u on u.id = p.operatore_assegnato_id
    where b.codice = 'CINQUEGRANA' and p.codice_commissione in ('1002/26', '1011/26')
  loop
    update pratiche set operatore_assegnato_id = v_jessica_id where id = r.id;
    insert into storico_modifiche (entita, entita_id, campo, valore_precedente, valore_nuovo, origine, modificato_da)
    values ('pratiche', r.id, 'operatore_assegnato_id', coalesce(r.operatore_precedente, 'Non assegnato'), 'Jessica (correzione manuale 22/07/2026)', 'utente', null);
  end loop;

  -- 997/25 -> non assegnata
  for r in
    select p.id, p.codice_commissione, u.nome || ' ' || u.cognome as operatore_precedente
    from pratiche p
    join brands b on b.id = p.brand_id
    left join utenti u on u.id = p.operatore_assegnato_id
    where b.codice = 'CINQUEGRANA' and p.codice_commissione = '997/25'
  loop
    update pratiche set operatore_assegnato_id = null where id = r.id;
    insert into storico_modifiche (entita, entita_id, campo, valore_precedente, valore_nuovo, origine, modificato_da)
    values ('pratiche', r.id, 'operatore_assegnato_id', coalesce(r.operatore_precedente, 'Non assegnato'), 'Non assegnato (correzione manuale 22/07/2026)', 'utente', null);
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- 3) VERIFICA DOPO — deve mostrare Jessica, Jessica, Non assegnato
-- ---------------------------------------------------------------------
select
  p.codice_commissione,
  c.nome_completo,
  coalesce(u.nome || ' ' || u.cognome, 'Non assegnato') as operatore_attuale
from pratiche p
join clienti c on c.id = p.cliente_id
join brands b on b.id = p.brand_id
left join utenti u on u.id = p.operatore_assegnato_id
where b.codice = 'CINQUEGRANA'
  and p.codice_commissione in ('1002/26', '1011/26', '997/25')
order by p.codice_commissione;
