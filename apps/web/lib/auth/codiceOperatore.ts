// lib/auth/codiceOperatore.ts
// Logica condivisa (server e client) per il login degli operatori tramite
// codice: l'email "sintetica" va derivata allo STESSO modo sia quando la
// creiamo (Server Action in app/admin) sia quando l'operatore fa login
// (pagina /login/operatore), altrimenti le due parti non si troverebbero.
export const DOMINIO_EMAIL_SINTETICA = "operatori.dasch-assistenze.local";

export function emailSinteticaDaCodice(codice: string): string {
  return `op-${codice.trim().toLowerCase()}@${DOMINIO_EMAIL_SINTETICA}`;
}
