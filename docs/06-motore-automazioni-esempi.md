# 6. Motore di automazioni — esempi pratici

## 6.1 Assegnazione automatica (esempio dalla specifica)

```sql
insert into regole_assegnazione (nome, criterio, valore_da, valore_a, operatore_id, priorita) values
 ('Cognomi A-C', 'iniziale_cognome', 'A', 'C', '<uuid-maria>', 10),
 ('Cognomi D-M', 'iniziale_cognome', 'D', 'M', '<uuid-giorgio>', 20),
 ('Cognomi N-Z', 'iniziale_cognome', 'N', 'Z', '<uuid-luca>', 30);
```

Con questi dati, una pratica del cliente "Bortone Mariniello Anna Giuseppe" (iniziale "B") viene assegnata automaticamente a Maria. La logica è nella funzione `assegna_operatore_automatico()` in `supabase/migrations/0002_automazioni.sql`, eseguita da un trigger `before insert` su `pratiche`.

## 6.2 Esempi di regole SLA/alert (già seminate in `0002_automazioni.sql`)

| Regola | Condizione | Soglia | Livello | Destinatari |
|---|---|---|---|---|
| Presa in carico non avvenuta | fase "presa_in_carico" non iniziata | 24 ore | alert | responsabile |
| Commissione non creata | fase "creazione_commissione" non completata | 3 giorni | alert | responsabile |
| Materiale non arrivato | fase "arrivo_merce" non completata | 30 giorni | escalation | responsabile, admin |
| Pratica ferma | nessun aggiornamento | 10 giorni | escalation | responsabile, admin |

Tutte modificabili da `/admin` (tabella `regole_alert`) senza toccare il codice: cambiare una soglia è un semplice update di riga.

## 6.3 Esecuzione del motore SLA

Due opzioni equivalenti, a scelta in base a dove si preferisce ospitare il cron:

**A. Supabase Edge Function + pg_cron** (`supabase/functions/check-sla/index.ts`):
```sql
select cron.schedule(
  'check-sla-ogni-15-min',
  '*/15 * * * *',
  $$ select net.http_post(url := 'https://<project>.functions.supabase.co/check-sla') $$
);
```

**B. Vercel Cron** (`apps/web/vercel.json`, già configurato):
```json
{ "crons": [{ "path": "/api/cron/check-sla", "schedule": "*/15 * * * *" }] }
```

## 6.4 Esempio di notifica generata

Quando la fase "Ordine ricambi" della pratica `977/26` supera le 120 ore previste, il motore crea automaticamente:

```json
{
  "utente_id": "<id-operatore-assegnato>",
  "pratica_id": "<id-pratica-977-26>",
  "tipo": "alert_sla",
  "titolo": "Presa in carico non avvenuta entro 24 ore",
  "messaggio": "Pratica 977/26: fase \"Invio ordine ricambi\" in ritardo di 36 ore.",
  "canale": "app"
}
```

L'operatore la vede nella sezione "Alert e notifiche" della propria dashboard; se il livello è `escalation`, la notifica viene creata anche per responsabile e admin.
