# 9. Scraper automatico per il download del CSV

Da usare **solo se** il gestionale non offre alcun export automatico (email programmata o API). Template in `scraper/downloadCsvGestionale.mjs`, basato su Playwright.

## 9.1 Come funziona il template

1. Apre un browser headless e naviga alla pagina di login del gestionale.
2. Compila utente/password (letti da variabili d'ambiente, mai hardcoded) e invia il form.
3. Naviga alla sezione di export (es. "Piano di carico") — passo da personalizzare in base al portale reale.
4. Intercetta l'evento di download del browser e salva il file in `scraper/downloads/`, mantenendo anche una copia fissa `ultimo.csv`.
5. Il file scaricato viene passato all'importatore (`npm run pipeline` esegue download + import in sequenza).

## 9.2 Personalizzazione necessaria

I selettori CSS/testo nel template (`input[name="username"]`, `text=Esporta CSV`, ecc.) sono **indicativi**: vanno adattati ispezionando il portale reale del gestionale (con gli strumenti sviluppatore del browser, tasto destro → Ispeziona). Se il portale usa autenticazione a due fattori, sarà necessario un passo aggiuntivo (es. codice OTP inviato via email, gestibile con una casella dedicata).

## 9.3 Pianificazione

- **Cron di sistema** (Linux `cron` / Windows Task Scheduler) su una macchina sempre accesa, oppure
- **GitHub Actions** con uno `schedule` (es. due volte al giorno), oppure
- **Worker sempre attivo** (Railway, Render, piccola VM) con `node-cron`, utile se il download richiede sessioni persistenti.

## 9.4 Monitoraggio

Va previsto un alert (email/Slack) se lo scraping fallisce (es. cambio password, modifica del layout del portale, timeout di rete), per evitare che l'assenza di aggiornamenti passi inosservata. Un controllo semplice: se `ultimo.csv` non viene rinnovato entro il doppio dell'intervallo previsto, inviare un avviso.

## 9.5 Alternative da preferire, se disponibili

In ordine di preferenza (dalla più alla meno robusta):
1. **Export automatico via email programmata dal gestionale stesso** (se il software lo supporta) — nessuno scraping necessario, basta un parser email.
2. **API del gestionale** (vedi `08-piano-evolutivo-integrazione-api.md`) — soluzione definitiva.
3. **Scraper** (questo documento) — soluzione di ripiego, più fragile perché dipende dal layout del portale e si rompe se questo cambia.
