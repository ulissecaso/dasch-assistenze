// middleware.ts
// Protezione delle rotte per ruolo. Gira prima di ogni richiesta (Edge runtime).
//  - /admin, /dashboard-direzione: solo admin/responsabile
//  - /dashboard-operatore, /pratiche: qualsiasi utente autenticato
//  - /login/*, /api/*, /monitor/*: sempre pubblici. /monitor/* è la vista di
//    sola lettura per il monitor a parete: NON deve mai passare da una
//    sessione admin (si autentica con una chiave nell'URL, controllata
//    dentro la pagina stessa), così il PC collegato al monitor non ha mai
//    accesso privilegiato al resto del portale.
import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

const ROTTE_SOLO_ADMIN = ["/admin", "/dashboard-direzione"];
const ROTTE_AUTENTICATE = ["/dashboard-operatore", "/pratiche"];

// Propaga il pathname come header interno: serve al layout radice per
// capire se è una rotta /monitor/* (nessuna sidebar/nav in quel caso).
function conPathname(request: NextRequest, response: NextResponse) {
  response.headers.set("x-pathname", request.nextUrl.pathname);
  return response;
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  const pubblica =
    pathname.startsWith("/login") ||
    pathname.startsWith("/api") ||
    pathname.startsWith("/monitor") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico";
  if (pubblica) return conPathname(request, NextResponse.next());

  const richiedeSoloAdmin = ROTTE_SOLO_ADMIN.some((r) => pathname.startsWith(r));
  const richiedeAutenticazione = richiedeSoloAdmin || ROTTE_AUTENTICATE.some((r) => pathname.startsWith(r));

  if (!richiedeAutenticazione) return conPathname(request, NextResponse.next());

  let response = conPathname(request, NextResponse.next({ request: { headers: request.headers } }));
  const destinazioneLogin = richiedeSoloAdmin ? "/login/admin" : "/login/operatore";

  try {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(name: string) {
            return request.cookies.get(name)?.value;
          },
          set(name: string, value: string, options: any) {
            response.cookies.set({ name, value, ...options });
          },
          remove(name: string, options: any) {
            response.cookies.set({ name, value: "", ...options });
          },
        },
      }
    );

    // Destrutturazione difensiva: se getUser() torna un errore (nessuna
    // sessione), "data" può non avere la forma attesa. Non fidarsi del
    // destructuring diretto: qui un'eccezione andrebbe intercettata dal
    // catch sotto, ma meglio evitarla proprio e trattarla come "non loggato".
    const { data, error: erroreSessione } = await supabase.auth.getUser();
    const user = data?.user ?? null;

    if (!user || erroreSessione) {
      return NextResponse.redirect(new URL(destinazioneLogin, request.url));
    }

    if (richiedeSoloAdmin) {
      const { data: profilo } = await supabase.from("utenti").select("ruolo").eq("id", user.id).maybeSingle();
      if (!profilo || !["admin", "responsabile"].includes(profilo.ruolo)) {
        return NextResponse.redirect(new URL("/dashboard-operatore", request.url));
      }
    }

    // Le pagine protette non vanno mai servite da cache (CDN/browser): sono
    // specifiche per utente e già forzate a dynamic rendering lato pagina,
    // ma questo header è una rete di sicurezza in più contro risposte stantie.
    response.headers.set("Cache-Control", "no-store, must-revalidate");
    return response;
  } catch (err) {
    // Fail-closed: se il controllo di sessione fallisce per qualsiasi motivo
    // imprevisto, meglio rimandare al login piuttosto che lasciar passare
    // la richiesta senza controlli.
    return NextResponse.redirect(new URL(destinazioneLogin, request.url));
  }
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
