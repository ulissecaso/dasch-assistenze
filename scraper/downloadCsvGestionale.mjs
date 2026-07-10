// downloadCsvGestionale.mjs
// Scraper automatico per il download programmato, da Vamart, di DUE file
// nella stessa sessione (un solo login):
//
//  1. Il CSV "commissioni di assistenza" (pagina Commissioni -> filtro
//     "Commissioni Assistenza" = "Solo di assistenza"): serve a intercettare
//     le pratiche di assistenza aperte direttamente dal personale su
//     Vamart, che non passano dal flusso app/email del cliente.
//  2. Il CSV "Piano di Carico" (Magazzino -> Piano di Carico, filtro
//     "Commissioni Assistenza" = "Tutti", esplicitamente forzato: questa
//     pagina condivide lo stesso filtro della pagina Commissioni e, nella
//     stessa sessione browser, resta impostato su "Solo di assistenza" se
//     non lo si azzera qui -- servono invece TUTTE le commissioni, vendite
//     normali comprese, per riconoscere correttamente lo stato di ogni riga.
//
// Richiede: npm install playwright && npx playwright install chromium
//
// Uso tipico (esegue solo il download):
//   GESTIONALE_URL=... GESTIONALE_USER=... GESTIONALE_PASS=... \
//     node downloadCsvGestionale.mjs
//
// Pipeline completa (download + import in Supabase, entrambi i file):
//   npm run pipeline
//
// Pianificazione: vedi .github/workflows/scraper-vamart.yml (GitHub Actions,
// ogni ora durante l'orario lavorativo, avviabile anche a mano).
//
// Debug: ad ogni fase viene salvato uno screenshot in CARTELLA_DOWNLOAD
// (debug-01-*.png, debug-02-*.png, ...), caricato come artifact dal
// workflow, cosi' se qualcosa si blocca si vede esattamente lo stato
// della pagina in quel momento senza dover riprodurre il problema a mano.

import { chromium } from "playwright";
import { mkdirSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

const {
  GESTIONALE_URL,      // URL di login di Vamart, es. https://cinquegrana.azurewebsites.net/Account/Login
  GESTIONALE_USER,
  GESTIONALE_PASS,
  CARTELLA_DOWNLOAD = "./downloads",
  // URL diretti delle pagine: stabili, non serve passare dai menu.
  VAMART_URL_COMMISSIONI = "https://cinquegrana.azurewebsites.net/Commissioni",
  VAMART_URL_PIANO_DI_CARICO = "https://cinquegrana.azurewebsites.net/PianoDiCarico",
} = process.env;

let contatoreScreenshot = 0;
async function debugScreenshot(page, etichetta) {
  contatoreScreenshot += 1;
  const nome = `debug-${String(contatoreScreenshot).padStart(2, "0")}-${etichetta}.png`;
  try {
    await page.screenshot({ path: path.join(CARTELLA_DOWNLOAD, nome), fullPage: true });
    console.log(`  [debug] screenshot salvato: ${nome} (pagina: ${page.url()})`);
  } catch (err) {
    console.log(`  [debug] impossibile salvare screenshot ${nome}: ${err.message}`);
  }
}

// Individua il selettore del dropdown "Commissioni Assistenza" (condiviso
// tra la pagina Commissioni e la pagina Piano di Carico) e lo imposta sul
// valore richiesto ("Solo di assistenza" oppure "Tutti").
function locatorFiltroAssistenza(page) {
  return page.locator(
    'xpath=//label[contains(normalize-space(.),"Commissioni Assistenza")]/following::select[1] ' +
    '| //*[contains(normalize-space(text()),"Commissioni Assistenza")]/following::select[1]'
  ).first();
}

async function scaricaCsv() {
  if (!GESTIONALE_URL || !GESTIONALE_USER || !GESTIONALE_PASS) {
    throw new Error("Impostare GESTIONALE_URL, GESTIONALE_USER, GESTIONALE_PASS come variabili d'ambiente");
  }
  if (!existsSync(CARTELLA_DOWNLOAD)) mkdirSync(CARTELLA_DOWNLOAD, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  const risultato = { percorsoCommissioni: null, percorsoPiano: null };

  try {
    // ── 1. LOGIN ──────────────────────────────────────────────────────────
    console.log("1. Login su Vamart...");
    await page.goto(GESTIONALE_URL, { waitUntil: "networkidle" });
    await page.locator('input[type="text"], input[type="email"]').first().fill(GESTIONALE_USER);
    await page.locator('input[type="password"]').first().fill(GESTIONALE_PASS);
    await page.getByRole("button", { name: /accedi/i }).click();
    await page.waitForLoadState("networkidle");
    console.log(`   Login completato, pagina attuale: ${page.url()}`);

    // ── 2. COMMISSIONI DI ASSISTENZA ────────────────────────────────────
    try {
      console.log("2. Navigazione alla pagina Commissioni...");
      await page.goto(VAMART_URL_COMMISSIONI, { waitUntil: "networkidle" });
      if (page.url().includes("/Account/Login")) {
        throw new Error("Login su Vamart fallito: credenziali non valide o cambiate (controllare i secret VAMART_USER/VAMART_PASS).");
      }
      await debugScreenshot(page, "commissioni-prima-filtro");

      console.log('   Imposto filtro "Commissioni Assistenza" = "Solo di assistenza"...');
      await locatorFiltroAssistenza(page).selectOption({ label: "Solo di assistenza" });
      await page.getByRole("button", { name: "Filtra" }).click();
      await page.waitForLoadState("networkidle");
      await debugScreenshot(page, "commissioni-dopo-filtro");

      console.log('   Click su pulsante "CSV" e attesa download...');
      const [downloadCommissioni] = await Promise.all([
        page.waitForEvent("download", { timeout: 60000 }),
        page.getByRole("button", { name: "CSV" }).click(),
      ]);

      const nomeFileCommissioni = `commissioni-assistenza-${new Date().toISOString().slice(0, 10)}.csv`;
      const percorsoCommissioni = path.join(CARTELLA_DOWNLOAD, nomeFileCommissioni);
      await downloadCommissioni.saveAs(percorsoCommissioni);
      renameSync(percorsoCommissioni, path.join(CARTELLA_DOWNLOAD, "ultimo.csv"));
      risultato.percorsoCommissioni = percorsoCommissioni;
      console.log(`   OK: CSV commissioni di assistenza scaricato: ${percorsoCommissioni}`);
    } catch (err) {
      await debugScreenshot(page, "ERRORE-commissioni");
      console.error(`   ERRORE nella fase Commissioni: ${err.message}`);
      throw err; // senza le commissioni non ha senso proseguire: e' il primo file della pipeline
    }

    // ── 3. PIANO DI CARICO (stessa sessione) ────────────────────────────
    try {
      console.log("3. Navigazione alla pagina Piano di Carico...");
      await page.goto(VAMART_URL_PIANO_DI_CARICO, { waitUntil: "networkidle" });
      console.log(`   Pagina attuale: ${page.url()}`);
      await debugScreenshot(page, "piano-prima-filtro");

      // IMPORTANTE: questa pagina condivide lo stesso filtro "Commissioni
      // Assistenza" della pagina Commissioni. Nella stessa sessione browser
      // resta impostato su "Solo di assistenza" se non lo azzeriamo qui:
      // il Piano di Carico deve invece contenere TUTTE le commissioni.
      console.log('   Reimposto filtro "Commissioni Assistenza" = "Tutti" (evita di ereditare il filtro della pagina Commissioni)...');
      const filtroPiano = locatorFiltroAssistenza(page);
      if (await filtroPiano.count() > 0) {
        await filtroPiano.selectOption({ label: "Tutti" });
        await page.getByRole("button", { name: "Filtra" }).click();
        await page.waitForLoadState("networkidle");
      } else {
        console.log('   [attenzione] Nessun dropdown "Commissioni Assistenza" trovato su questa pagina: proseguo senza toccarlo.');
      }
      await debugScreenshot(page, "piano-dopo-filtro");

      console.log('   Click su pulsante "CSV" e attesa download (puo\' richiedere piu\' tempo: file piu\' grande)...');
      const [downloadPiano] = await Promise.all([
        page.waitForEvent("download", { timeout: 90000 }),
        page.getByRole("button", { name: "CSV" }).click(),
      ]);

      const nomeFilePiano = `piano-di-carico-${new Date().toISOString().slice(0, 10)}.csv`;
      const percorsoPiano = path.join(CARTELLA_DOWNLOAD, nomeFilePiano);
      await downloadPiano.saveAs(percorsoPiano);
      renameSync(percorsoPiano, path.join(CARTELLA_DOWNLOAD, "ultimo-piano-di-carico.csv"));
      risultato.percorsoPiano = percorsoPiano;
      console.log(`   OK: CSV Piano di Carico scaricato: ${percorsoPiano}`);
    } catch (err) {
      await debugScreenshot(page, "ERRORE-piano-di-carico");
      console.error(`   ERRORE nella fase Piano di Carico: ${err.message}`);
      throw err;
    }

    return risultato;
  } finally {
    await browser.close();
  }
}

scaricaCsv()
  .then((r) => {
    console.log("Scraping completato:", r);
  })
  .catch((err) => {
    console.error("Errore fatale durante lo scraping da Vamart:", err);
    process.exitCode = 1;
  });
