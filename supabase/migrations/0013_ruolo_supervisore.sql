-- 0013_ruolo_supervisore.sql
-- Nuovo ruolo 'supervisore': accesso con CODICE come un operatore (non
-- email/password), ma pensato per chi deve "vedere tutto" di uno o più
-- brand senza poter modificare nulla:
--   - vede Monitoraggio Assistenze e Monitoraggio Consegne (stesse pagine
--     della direzione), filtrate sui brand su cui è abilitato in
--     operatore_brand (stessa tabella/pannello "Brand abilitati" usato per
--     operatori e responsabili) — quindi TUTTI gli operatori e TUTTE le
--     pratiche di quel brand, non solo le proprie;
--   - NON ha accesso al pannello /admin (niente creazione/eliminazione
--     operatori, niente modifica soglie SLA, niente import CSV);
--   - sola lettura sulle pratiche: nessuna policy di UPDATE/INSERT/DELETE
--     per questo ruolo, a differenza di 'responsabile'
--     (0012_responsabile_scoped_brand.sql) che ha accesso completo.

alter table utenti drop constraint if exists utenti_ruolo_check;
alter table utenti add constraint utenti_ruolo_check
  check (ruolo in ('admin', 'responsabile', 'operatore', 'supervisore'));

create policy "supervisore_legge_proprio_brand" on pratiche
  for select using (
    exists (
      select 1
      from utenti u
      join operatore_brand ob on ob.operatore_id = u.id
      where u.id = auth.uid()
        and u.ruolo = 'supervisore'
        and ob.brand_id = pratiche.brand_id
        and ob.attivo = true
    )
  );
