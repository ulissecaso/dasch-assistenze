-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Amplia l'esclusione automatica pratiche
-- "di prova" (fiere/showroom/negozio/ufficio) oltre alla sola parola
-- "mostra" introdotta in 0017_esclusione_pratiche_mostra.sql
-- =====================================================================
-- Richiesto il 22/07/2026: escludere anche "negozio", "expo", "expo'"
-- (con o senza accento), "ufficio", "uffici".
--
-- Invece di aggiungere altre parole fisse nel trigger (che richiederebbe
-- una nuova migrazione ogni volta che ne serve una in piu'), spostiamo la
-- lista in una tabella dedicata, modificabile dal pannello admin (o da SQL)
-- senza bisogno di toccare codice o schema: aggiungere/togliere una riga
-- cambia subito cosa viene escluso.
--
-- Il trigger/funzione di 0017 restano con lo stesso nome (nessun impatto su
-- chi li referenzia): cambia solo la logica interna, che ora legge la
-- tabella invece di un'unica parola fissa. Stessa scelta di design di
-- prima: riusa lo stato 'annullata' (recuperabile con "Riattiva"), agisce
-- solo in inserimento (BEFORE INSERT, non tocca una riattivazione manuale),
-- e fa anche un backfill una tantum delle pratiche gia' esistenti.
-- =====================================================================

create table if not exists parole_esclusione_pratiche (
  parola text primary key
);
comment on table parole_esclusione_pratiche is 'Parole che, se presenti come parola intera (non come parte di un''altra parola) nel nome cliente, escludono automaticamente la pratica da dashboard/conteggi/alert (fiere, showroom, negozio, ufficio: non sono clienti reali). Usare solo parole semplici, senza caratteri speciali di regex (. * + ? [ ] ( ) | \ ^ $), altrimenti il confronto puo'' comportarsi in modo imprevisto.';

insert into parole_esclusione_pratiche (parola) values
  ('mostra'), ('negozio'), ('expo'), ('expò'), ('ufficio'), ('uffici')
on conflict (parola) do nothing;

create or replace function trg_fn_escludi_pratiche_mostra()
returns trigger as $$
declare
  v_nome_cliente text;
  v_parola_trovata text;
begin
  select nome_completo into v_nome_cliente from clienti where id = new.cliente_id;

  if v_nome_cliente is not null then
    select pe.parola into v_parola_trovata
    from parole_esclusione_pratiche pe
    where v_nome_cliente ~* ('\y' || pe.parola || '\y')
    limit 1;
  end if;

  if v_parola_trovata is not null and new.stato_generale is distinct from 'annullata' then
    insert into storico_modifiche (entita, entita_id, campo, valore_precedente, valore_nuovo, origine, modificato_da)
    values ('pratiche', new.id, 'stato_generale', new.stato_generale,
            format('annullata (esclusa automaticamente: nome cliente contiene "%s")', v_parola_trovata),
            'automazione', null);

    new.stato_generale := 'annullata';
  end if;

  return new;
end;
$$ language plpgsql;

-- Gia' creato da 0017: qui serve solo se questa migrazione venisse applicata
-- da sola su un database che non ha ancora eseguito 0017 (idempotente).
drop trigger if exists trg_pratiche_escludi_mostra on pratiche;
create trigger trg_pratiche_escludi_mostra
  before insert on pratiche
  for each row execute function trg_fn_escludi_pratiche_mostra();

-- ---------------------------------------------------------------------
-- BACKFILL: pratiche gia' esistenti che contengono una delle NUOVE parole
-- (negozio/expo/expo'/ufficio/uffici) e non erano state escluse da 0017
-- (che controllava solo "mostra").
-- ---------------------------------------------------------------------
do $$
declare
  r record;
  v_parola_trovata text;
begin
  for r in
    select p.id, p.stato_generale, c.nome_completo
    from pratiche p
    join clienti c on c.id = p.cliente_id
    where p.stato_generale is distinct from 'annullata'
  loop
    select pe.parola into v_parola_trovata
    from parole_esclusione_pratiche pe
    where r.nome_completo ~* ('\y' || pe.parola || '\y')
    limit 1;

    if v_parola_trovata is not null then
      insert into storico_modifiche (entita, entita_id, campo, valore_precedente, valore_nuovo, origine, modificato_da)
      values ('pratiche', r.id, 'stato_generale', r.stato_generale,
              format('annullata (esclusa automaticamente: nome cliente contiene "%s")', v_parola_trovata),
              'automazione', null);

      update pratiche set stato_generale = 'annullata' where id = r.id;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- VERIFICA CONSIGLIATA (facoltativa): elenca tutte le pratiche escluse
-- da questa logica (vecchie e nuove parole), per controllare falsi positivi.
--
-- select p.codice_commissione, c.nome_completo, p.stato_generale
-- from pratiche p join clienti c on c.id = p.cliente_id
-- where exists (
--   select 1 from parole_esclusione_pratiche pe where c.nome_completo ~* ('\y' || pe.parola || '\y')
-- )
-- order by p.created_at desc;
--
-- Per aggiungere in futuro un'altra parola da escludere, senza bisogno di
-- me o di una nuova migrazione, basta eseguire (in Supabase SQL Editor):
--   insert into parole_esclusione_pratiche (parola) values ('nuova_parola');
-- ---------------------------------------------------------------------
