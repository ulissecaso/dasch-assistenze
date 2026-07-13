"use client";
// app/login/operatore/page.tsx
// Login operatore: solo il codice univoco consegnato dall'admin. Nessuna
// email/password da ricordare — internamente il codice viene tradotto
// nell'email sintetica dell'operatore e usato anche come password.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { creaSupabaseClientBrowser } from "@/lib/supabase/client";
import { emailSinteticaDaCodice } from "@/lib/auth/codiceOperatore";

export default function LoginOperatorePage() {
  const router = useRouter();
  const [codice, setCodice] = useState("");
  const [errore, setErrore] = useState<string | null>(null);
  const [caricamento, setCaricamento] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrore(null);
    setCaricamento(true);
    const supabase = creaSupabaseClientBrowser();
    const { data: sessione, error } = await supabase.auth.signInWithPassword({
      email: emailSinteticaDaCodice(codice),
      password: codice,
    });
    if (error) {
      setCaricamento(false);
      setErrore("Codice non valido. Controlla di averlo digitato correttamente.");
      return;
    }
    // Il supervisore accede con codice come un operatore, ma deve atterrare
    // sulla dashboard di monitoraggio (vede tutti gli operatori del suo
    // brand), non sulla propria "Le mie pratiche" (che per lui è vuota/non
    // pertinente): controlliamo il ruolo appena ottenuta la sessione.
    let destinazione = "/dashboard-operatore";
    const utenteId = sessione?.user?.id;
    if (utenteId) {
      const { data: profilo } = await supabase.from("utenti").select("ruolo").eq("id", utenteId).maybeSingle();
      if (profilo?.ruolo === "supervisore") {
        destinazione = "/dashboard-direzione";
      }
    }
    setCaricamento(false);
    router.push(destinazione);
    router.refresh();
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <form onSubmit={handleSubmit} className="bg-white shadow rounded-xl p-8 w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Accesso operatore</h1>
        <p className="text-sm text-gray-500">Inserisci il codice che ti ha consegnato l&apos;amministratore.</p>
        {errore && <p className="text-sm text-red-600">{errore}</p>}
        <label className="block text-sm">
          <span className="text-gray-600">Codice</span>
          <input
            type="text"
            required
            autoFocus
            value={codice}
            onChange={(e) => setCodice(e.target.value)}
            placeholder="Es. K7M4PQXR"
            className="mt-1 w-full border rounded px-3 py-2 tracking-widest uppercase text-center text-lg font-mono"
          />
        </label>
        <button
          type="submit"
          disabled={caricamento}
          className="w-full bg-gray-900 text-white rounded py-2 text-sm disabled:opacity-50"
        >
          {caricamento ? "Accesso in corso..." : "Accedi"}
        </button>
        <p className="text-xs text-gray-400 text-center">
          Sei l&apos;amministratore? <a href="/login/admin" className="underline">Accedi con email e password</a>
        </p>
      </form>
    </main>
  );
}
