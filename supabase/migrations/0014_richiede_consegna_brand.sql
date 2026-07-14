-- 0014_richiede_consegna_brand.sql
-- Rende opzionale, PER BRAND, l'ultima fase del workflow di Assistenza
-- ("Consegna materiale", codice 'consegna_materiale', vedi 0001_init.sql).
--
-- Oggi (per Arredamenti Cinquegrana e Master Mobili) una pratica di
-- assistenza si chiude SOLO quando risulta anche "Consegnato" su Vamart
-- (vedi sincronizzaFasiAssistenza in apps/web/lib/import/eseguiImportazione.ts
-- e scripts/import-csv/importVamartCsv.mjs): la riparazione da sola non
-- basta, serve anche la riconsegna del materiale al cliente.
--
-- In vista di un nuovo brand separato (pensato per essere ceduto come
-- prodotto finito a un'altra azienda), serve poter scegliere: per quel
-- brand la pratica di assistenza potrebbe chiudersi già quando il materiale
-- risulta arrivato in deposito, SENZA aspettare una consegna tracciata a
-- parte (es. ritiro diretto in negozio da parte del cliente).
--
-- Questo flag NON tocca il modulo "Consegne" (tipo_pratica = 'consegna',
-- le commissioni normali non di assistenza): quello resta un modulo a se'
-- stante, sempre presente, indipendente da questa impostazione.
--
-- Default true su tutte le righe esistenti: Cinquegrana e Master Mobili
-- continuano a comportarsi ESATTAMENTE come oggi finche' un admin non
-- decide esplicitamente di disattivarlo dal pannello (nuovo toggle in
-- Admin -> Brand).
alter table brands add column if not exists richiede_consegna_assistenza boolean not null default true;

comment on column brands.richiede_consegna_assistenza is
  'Se true (default), una pratica di assistenza di questo brand si chiude solo dopo che anche "Consegna materiale" risulta completata (comportamento storico). Se false, si chiude gia'' quando "Arrivo merce in deposito" e'' completo, e la fase "Consegna materiale" viene marcata automaticamente come non richiesta.';
