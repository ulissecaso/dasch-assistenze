"use client";
// app/login/admin/page.tsx
// Login per admin/responsabile: email + password standard Supabase Auth.
import { useState } from "react";
import { useRouter } from "next/navigation";
import { creaSupabaseClientBrowser } from "@/lib/supabase/client";

export default function LoginAdminPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errore, setErrore] = useState<string | null>(null);
  const [caricamento, setCaricamento] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrore(null);
    setCaricamento(true);
    const supabase = creaSupabaseClientBrowser();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setCaricamento(false);
    if (error) {
      setErrore("Email o password non corrette.");
      return;
    }
    router.push("/admin");
    router.refresh();
  }

  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <form onSubmit={handleSubmit} className="bg-white shadow rounded-xl p-8 w-full max-w-sm space-y-4">
        <h1 className="text-xl font-semibold">Accesso amministratore</h1>
        {errore && <p className="text-sm text-red-600">{errore}</p>}
        <label className="block text-sm">
          <span className="text-gray-600">Email</span>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 w-full border rounded px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          <span className="text-gray-600">Password</span>
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 w-full border rounded px-3 py-2"
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
          Sei un operatore? <a href="/login/operatore" className="underline">Accedi con il tuo codice</a>
        </p>
      </form>
    </main>
  );
}
