import "./globals.css";
import Link from "next/link";
import { headers } from "next/headers";
import { creaSupabaseClientServer } from "@/lib/supabase/server";

export const metadata = {
  title: "Dasch Gestione Assistenze",
  description: "Gestione e monitoraggio automatizzato delle pratiche di assistenza post-vendita",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Le rotte /monitor/* sono la vista pubblica per il monitor a parete:
  // niente sidebar, niente link verso login/admin, niente lettura di sessione
  // utente. Il pathname arriva dall'header impostato in middleware.ts perché
  // i layout non ricevono la rotta corrente come prop.
  const pathname = headers().get("x-pathname") ?? "";
  const isMonitorPubblico = pathname.startsWith("/monitor");

  if (isMonitorPubblico) {
    return (
      <html lang="it">
        <body className="bg-gray-50 text-gray-900" style={{ margin: 0 }}>
          {children}
        </body>
      </html>
    );
  }

  const supabase = creaSupabaseClientServer();
  const { data: { user } } = await supabase.auth.getUser();

  let profilo: { nome: string; cognome: string; ruolo: string } | null = null;
  if (user) {
    const { data } = await supabase.from("utenti").select("nome, cognome, ruolo").eq("id", user.id).maybeSingle();
    profilo = data;
  }
  const isAdmin = profilo?.ruolo === "admin" || profilo?.ruolo === "responsabile";

  return (
    <html lang="it">
      <body className="bg-gray-50 text-gray-900">
        <div className="flex min-h-screen">
          <nav className="w-56 bg-white border-r p-4 space-y-2 flex flex-col">
            <p className="font-semibold mb-4">Dasch Assistenze</p>
            {isAdmin && (
              <Link className="block py-1 text-sm hover:text-blue-600" href="/dashboard-direzione">Monitoraggio Assistenze</Link>
            )}
            {isAdmin && (
              <Link className="block py-1 text-sm hover:text-blue-600" href="/dashboard-direzione-consegne">Monitoraggio Consegne</Link>
            )}
            <Link className="block py-1 text-sm hover:text-blue-600" href="/dashboard-operatore">Le mie pratiche</Link>
            {isAdmin && (
              <Link className="block py-1 text-sm hover:text-blue-600" href="/admin">Admin</Link>
            )}
            <div className="flex-1" />
            {profilo ? (
              <div className="text-xs text-gray-500 border-t pt-3">
                <p>{profilo.nome} {profilo.cognome}</p>
                <p className="text-gray-400">{profilo.ruolo}</p>
                <form action="/logout" method="post" className="mt-2">
                  <button type="submit" className="underline">Esci</button>
                </form>
              </div>
            ) : (
              <div className="text-xs border-t pt-3 space-y-1">
                <Link className="block underline" href="/login/admin">Accesso admin</Link>
                <Link className="block underline" href="/login/operatore">Accesso operatore</Link>
              </div>
            )}
          </nav>
          <div className="flex-1">{children}</div>
        </div>
      </body>
    </html>
  );
}
