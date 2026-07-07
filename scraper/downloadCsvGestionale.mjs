// downloadCsvGestionale.mjs
// Template di scraper automatico per il download programmato del CSV dal
// portale del gestionale, quando questo non offre un export via API/email.
//
// Da personalizzare con: URL di login, selettori dei campi, percorso del
// report/export, e credenziali (da variabili d'ambiente, MAI hardcoded).
//
// Richiede: npm install playwright && npx playwright install chromium
//
// Uso tipico:
//   GESTIONALE_URL=... GESTIONALE_USER=... GESTIONALE_PASS=... \
//     node downloadCsvGestionale.mjs
//
// Va poi incatenato all'importatore:
//   node downloadCsvGestionale.mjs && node ../scripts/import-csv/importVamartCsv.mjs ./downloads/ultimo.csv
//
// Pianificazione consigliata: cron di sistema, GitHub Actions schedule,
// oppure un piccolo worker sempre attivo (Railway/Render) con node-cron.

import { chromium } from "playwright";
import { mkdirSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

const {
  GESTIONALE_URL,      // es. https://gestionale.azienda.it/login
  GESTIONALE_USER,
  GESTIONALE_PASS,
  CARTELLA_DOWNLOAD = "./downloads",
} = process.env;

async function scaricaCsv() {
  if (!GESTIONALE_URL || !GESTIONALE_USER || !GESTIONALE_PASS) {
    throw new Error("Impostare GESTIONALE_URL, GESTIONALE_USER, GESTIONALE_PASS come variabili d'ambiente");
  }
  if (!existsSync(CARTELLA_DOWNLOAD)) mkdirSync(CARTELLA_DOWNLOAD, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // 1. LOGIN — selettori indicativi, da adattare al portale reale
    await page.goto(GESTIONALE_URL, { waitUntil: "networkidle" });
    await page.fill('input[name="username"], #username, input[type="email"]', GESTIONALE_USER);
    await page.fill('input[name="password"], #password, input[type="password"]', GESTIONALE_PASS);
    await page.click('button[type="submit"], #loginButton');
    await page.waitForLoadState("networkidle");

    // Verifica login riuscito (adattare al selettore reale, es. logo dashboard)
    await page.waitForSelector("body", { timeout: 15000 });

    // 2. NAVIGAZIONE alla sezione di export (es. "Piano di carico")
    // await page.click('text=Report');
    // await page.click('text=Piano di carico');

    // 3. DOWNLOAD — Playwright intercetta l'evento di download del browser
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.click('text=Esporta CSV, button:has-text("Esporta")'), // selettore indicativo
    ]);

    const nomeFile = `piano-di-carico-${new Date().toISOString().slice(0, 10)}.csv`;
    const percorsoFinale = path.join(CARTELLA_DOWNLOAD, nomeFile);
    await download.saveAs(percorsoFinale);

    // mantiene anche un riferimento fisso "ultimo.csv" per lo step successivo della pipeline
    renameSync(percorsoFinale, path.join(CARTELLA_DOWNLOAD, "ultimo.csv"));
    console.log(`CSV scaricato: ${percorsoFinale}`);

    return percorsoFinale;
  } finally {
    await browser.close();
  }
}

scaricaCsv().catch((err) => {
  console.error("Errore durante lo scraping del gestionale:", err);
  process.exit(1);
});
