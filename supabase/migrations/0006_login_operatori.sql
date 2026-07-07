-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Login operatori con codice, admin con email
-- =====================================================================
-- Modello di autenticazione scelto:
--  - Admin/responsabile: email + password standard (Supabase Auth).
--  - Operatore: un CODICE univoco (generato dall'admin dal pannello, non
--    ha bisogno di una casella email propria). Sotto al cofano l'operatore
--    resta comunque un utente Supabase Auth vero e proprio: gli viene
--    creata un'email "sintetica" interna (mai realmente usata per inviare
--    posta) derivata in modo deterministico dal codice, e il codice stesso
--    funge anche da password. Così l'app continua a usare le sessioni e le
--    policy RLS standard di Supabase, senza dover reinventare un sistema
--    di autenticazione parallelo.
--
-- Nota di sicurezza: il codice viene salvato anche in chiaro in
-- codice_accesso per permettere all'admin di rivederlo/consegnarlo di
-- nuovo all'operatore in caso lo smarrisca. Per un contesto interno a un
-- piccolo team è un compromesso accettabile; se in futuro servisse un
-- livello di sicurezza più alto, il codice andrebbe reso visibile una
-- sola volta al momento della creazione.
-- =====================================================================

alter table utenti add column if not exists codice_accesso text;
create unique index if not exists idx_utenti_codice_accesso on utenti(codice_accesso) where codice_accesso is not null;

comment on column utenti.codice_accesso is
  'Codice di accesso univoco per il login degli operatori (senza email/password). Null per admin/responsabile, che usano email+password.';
