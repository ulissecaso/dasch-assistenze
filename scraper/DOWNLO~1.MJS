// downloadCsvGestionale.mjs
// Scraper automatico per il download programmato, da Vamart, di DUE file
// nella stessa sessione (un solo login):
//
//  1. Il CSV "commissioni di assistenza" (pagina Commissioni -> filtro
//     "Commissioni Assistenza" = "Solo di assistenza"): serve a intercettare
//     le pratiche di assistenza aperte direttamente dal personale su
//     Vamart, che non passano dal flusso app/email del cliente.
//  2. Il CSV "Piano di Carico" (Magazzino -> Piano di Carico, nessun filtro):
//     serve a far avanzare automaticamente le fasi "Invio ordine ricambi",
//     "Arrivo merce in deposito" e "Consegna materiale" in base allo stato
//     di ogni riga/articolo (Da ordinare/Ordinato/In giacenza/Consegnato).
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
// 2 volte al giorno, avviabile anche a mano).

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

async function scaricaCsv() {
  if (!GESTIONALE_URL || !GESTIONALE_USER || !GESTIONALE_PASS) {
    throw new Error("Impostare GESTIONALE_URL, GESTIONALE_USER, GESTIONALE_PASS come variabili d'ambiente");
  }
  if (!existsSync(CARTELLA_DOWNLOAD)) mkdirSync(CARTELLA_DOWNLOAD, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    // ── 1. LOGIN ──────────────────────────────────────────────────────────
    await page.goto(GESTIONALE_URL, { waitUntil: "networkidle" });
    await page.locator('input[type="text"], input[type="email"]').first().fill(GESTIONALE_USER);
    await page.locator('input[type="password"]').first().fill(GESTIONALE_PASS);
    await page.getByRole("button", { name: /accedi/i }).click();
    await page.waitForLoadState("networkidle");

    // ── 2. NAVIGAZIONE alla pagina "Commissioni" ────────────────────────────
    await page.goto(VAMART_URL_COMMISSIONI, { waitUntil: "networkidle" });
    if (page.url().includes("/Account/Login")) {
      throw new Error("Login su Vamart fallito: credenziali non valide o cambiate (controllare i secret GESTIONALE_USER/GESTIONALE_PASS).");
    }

    // ── 3. FILTRO "Commissioni Assistenza" = "Solo di assistenza" ──────────
    const selectAssistenza = page.locator(
      'xpath=//label[contains(normalize-space(.),"Commissioni Assistenza")]/following::select[1] ' +
      '| //*[contains(normalize-space(text()),"Commissioni Assistenza")]/following::select[1]'
    ).first();
    await selectAssistenza.selectOption({ label: "Solo di assistenza" });
    await page.getByRole("button", { name: "Filtra" }).click();
    await page.waitForLoadState("networkidle");

    // ── 4. DOWNLOAD CSV commissioni di assistenza ───────────────────────
    // Nota: il pulsante "CSV" (DataTables) esporta di norma tutte le righe
    // filtrate, non solo quelle della pagina visibile. Se in futuro il CSV
    // dovesse risultare incompleto, controllare qui il dropdown "Visualizza"
    // sopra la tabella (potrebbe servire portarlo al massimo prima di esportare).
    const [downloadCommissioni] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.getByRole("button", { name: "CSV" }).click(),
    ]);

    const nomeFileCommissioni = `commissioni-assistenza-${new Date().toISOString().slice(0, 10)}.csv`;
    const percorsoCommissioni = path.join(CARTELLA_DOWNLOAD, nomeFileCommissioni);
    await downloadCommissioni.saveAs(percorsoCommissioni);
    renameSync(percorsoCommissioni, path.join(CARTELLA_DOWNLOAD, "ultimo.csv"));
    console.log(`CSV commissioni di assistenza scaricato: ${percorsoCommissioni}`);

    // ── 5. DOWNLOAD CSV Piano di Carico (stessa sessione, nessun filtro) ──
    await page.goto(VAMART_URL_PIANO_DI_CARICO, { waitUntil: "networkidle" });

    const [downloadPiano] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.getByRole("button", { name: "CSV" }).click(),
    ]);

    const nomeFilePiano = `piano-di-carico-${new Date().toISOString().slice(0, 10)}.csv`;
    const percorsoPiano = path.join(CARTELLA_DOWNLOAD, nomeFilePiano);
    await downloadPiano.saveAs(percorsoPiano);
    renameSync(percorsoPiano, path.join(CARTELLA_DOWNLOAD, "ultimo-piano-di-carico.csv"));
    console.log(`CSV Piano di Carico scaricato: ${percorsoPiano}`);

    return { percorsoCommissioni, percorsoPiano };
  } catch (err) {
    // In caso di errore (layout cambiato, 2FA, timeout) salviamo uno
    // screenshot: aiuta a capire dove si e' bloccato lo script senza
    // doverlo riprodurre manualmente.
    try {
      await page.screenshot({ path: path.join(CARTELLA_DOWNLOAD, "errore-scraper.png"), fullPage: true });
    } catch {
      // se anche lo screenshot fallisce, ignoriamo: l'errore originale e' gia' sufficiente
    }
    throw err;
  } finally {
    await browser.close();
  }
}

scaricaCsv().catch((err) => {
  console.error("Errore durante lo scraping delle commissioni di assistenza da Vamart:", err);
  process.exit(1);
});
