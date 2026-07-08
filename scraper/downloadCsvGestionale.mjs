// downloadCsvGestionale.mjs
// Scraper automatico per il download programmato, da Vamart, del CSV
// "commissioni di assistenza" (filtro dedicato gia' presente nel portale:
// pagina Commissioni -> filtro "Commissioni Assistenza" = "Solo di assistenza").
//
// Serve a intercettare anche le pratiche di assistenza aperte direttamente
// dal personale su Vamart, che non passano dal flusso app/email del cliente
// e quindi non arriverebbero altrimenti al sistema di monitoraggio.
//
// Richiede: npm install playwright && npx playwright install chromium
//
// Uso tipico (esegue solo il download):
//   GESTIONALE_URL=... GESTIONALE_USER=... GESTIONALE_PASS=... \
//     node downloadCsvGestionale.mjs
//
// Pipeline completa (download + import in Supabase):
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
  // URL diretto della pagina "Commissioni": stabile, non serve passare dal menu.
  VAMART_URL_COMMISSIONI = "https://cinquegrana.azurewebsites.net/Commissioni",
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

    // ── 4. DOWNLOAD CSV ──────────────────────────────────────────────────
    // Nota: il pulsante "CSV" (DataTables) esporta di norma tutte le righe
    // filtrate, non solo quelle della pagina visibile. Se in futuro il CSV
    // dovesse risultare incompleto, controllare qui il dropdown "Visualizza"
    // sopra la tabella (potrebbe servire portarlo al massimo prima di esportare).
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: 30000 }),
      page.getByRole("button", { name: "CSV" }).click(),
    ]);

    const nomeFile = `commissioni-assistenza-${new Date().toISOString().slice(0, 10)}.csv`;
    const percorsoFinale = path.join(CARTELLA_DOWNLOAD, nomeFile);
    await download.saveAs(percorsoFinale);

    // mantiene anche un riferimento fisso "ultimo.csv" per lo step successivo della pipeline
    renameSync(percorsoFinale, path.join(CARTELLA_DOWNLOAD, "ultimo.csv"));
    console.log(`CSV commissioni di assistenza scaricato: ${percorsoFinale}`);

    return percorsoFinale;
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
