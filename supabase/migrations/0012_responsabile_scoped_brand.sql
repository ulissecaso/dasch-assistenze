-- 0012_responsabile_scoped_brand.sql
-- Il ruolo 'responsabile' ora rispetta gli stessi "Brand abilitati"
-- dell'operatore (tabella operatore_brand, vedi 0011_multi_brand.sql): un
-- responsabile abilitato solo su Master Mobili vede/gestisce SOLO le
-- pratiche di quel brand, sulle dashboard direzione/consegne e nel pannello
-- admin. Il ruolo 'admin' non cambia: accesso totale, sempre, su tutti i
-- brand.
--
-- Per abilitare un responsabile su un brand si usa lo stesso pannello
-- "Brand abilitati" già usato per gli operatori (app/admin/page.tsx): scrive
-- nella stessa tabella operatore_brand indipendentemente dal ruolo
-- dell'utente. Un responsabile appena creato non ha ancora nessuna riga in
-- operatore_brand, quindi di default non vede nessuna pratica finché non lo
-- si abilita esplicitamente su almeno un brand (comportamento sicuro:
-- nessun accesso finché non concesso).
--
-- Nessuna modifica di codice applicativo necessaria: le dashboard
-- (caricaDatiDirezione.ts, caricaDatiConsegne.ts) e il pannello admin usano
-- già il client Supabase legato alla sessione dell'utente loggato (non il
-- service role), quindi ereditano automaticamente questo filtro tramite RLS.

drop policy if exists "admin_responsabile_full_access_pratiche" on pratiche;

create policy "admin_full_access_pratiche" on pratiche
  for all using (
    exists (select 1 from utenti u where u.id = auth.uid() and u.ruolo = 'admin')
  );

create policy "responsabile_gestisce_proprio_brand" on pratiche
  for all using (
    exists (
      select 1
      from utenti u
      join operatore_brand ob on ob.operatore_id = u.id
      where u.id = auth.uid()
        and u.ruolo = 'responsabile'
        and ob.brand_id = pratiche.brand_id
        and ob.attivo = true
    )
  );

-- Le due policy dell'operatore perdono la clausola "or admin/responsabile":
-- ora sono coperte dalle due policy dedicate sopra (le policy permissive si
-- sommano con OR in Postgres, quindi non serve ripeterla qui).
drop policy if exists "operatore_vede_proprie_pratiche" on pratiche;
create policy "operatore_vede_proprie_pratiche" on pratiche
  for select using (
    operatore_assegnato_id = auth.uid()
    and exists (
      select 1 from operatore_brand ob
      where ob.operatore_id = auth.uid() and ob.brand_id = pratiche.brand_id and ob.attivo = true
    )
  );

drop policy if exists "operatore_aggiorna_proprie_pratiche" on pratiche;
create policy "operatore_aggiorna_proprie_pratiche" on pratiche
  for update using (
    operatore_assegnato_id = auth.uid()
    and exists (
      select 1 from operatore_brand ob
      where ob.operatore_id = auth.uid() and ob.brand_id = pratiche.brand_id and ob.attivo = true
    )
  );
