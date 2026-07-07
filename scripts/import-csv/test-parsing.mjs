// test-parsing.mjs
// Verifica il parsing/mapping (senza Supabase) su un file CSV reale.
// Uso: node test-parsing.mjs "/percorso/Piano di carico - Vamart.csv"

import { parseFileCompleto } from "./parseCsv.mjs";
import { raggruppaInPratiche, estraiClientiUnivoci, estraiFornitoriUnivoci } from "./mapToDomain.mjs";

const percorsoFile = process.argv[2];
if (!percorsoFile) {
  console.error("Uso: node test-parsing.mjs <percorso-file-csv>");
  process.exit(1);
}

const { righe, errori } = parseFileCompleto(percorsoFile);
const pratiche = raggruppaInPratiche(righe);
const clienti = estraiClientiUnivoci(righe);
const fornitori = estraiFornitoriUnivoci(righe);

console.log("=== RISULTATO PARSING ===");
console.log("Righe valide totali:      ", righe.length);
console.log("Righe con errori/warning: ", errori.length);
console.log("Pratiche (commissioni):  ", pratiche.length);
console.log("Clienti univoci:         ", clienti.length);
console.log("Fornitori univoci:       ", fornitori.length);

const conteggioStati = {};
for (const p of pratiche) conteggioStati[p.stato_generale] = (conteggioStati[p.stato_generale] || 0) + 1;
console.log("\nDistribuzione stato_generale pratiche:", conteggioStati);

console.log("\n--- Esempio pratica (prima del dataset) ---");
console.log(JSON.stringify(pratiche[0], null, 2));

console.log("\n--- Prime 5 righe di errore/warning ---");
console.log(JSON.stringify(errori.slice(0, 5), null, 2));

// Controllo di coerenza: la somma delle righe nelle pratiche deve combaciare col totale righe valide
const totaleRigheInPratiche = pratiche.reduce((acc, p) => acc + p.righe.length, 0);
console.log("\nControllo coerenza: righe valide =", righe.length, " | righe raggruppate in pratiche =", totaleRigheInPratiche, totaleRigheInPratiche === righe.length ? "OK" : "MISMATCH");
