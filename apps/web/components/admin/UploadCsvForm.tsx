"use client";
// components/admin/UploadCsvForm.tsx
// Form di caricamento manuale del CSV "Piano di Carico" Vamart dal pannello
// admin: chiunque scarica l'export da Vamart puo' trascinarlo qui e vederlo
// importato in pochi secondi, senza bisogno di un terminale. Fa POST a
// /api/import-csv, che ora scrive davvero a database (vedi
// lib/import/eseguiImportazione.ts).
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Stato = "idle" | "invio" | "ok" | "errore";

export default function UploadCsvForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stato, setStato] = useState<Stato>("idle");
  const [messaggio, setMessaggio] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) return;

    setStato("invio");
    setMessaggio(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/import-csv", { method: "POST", body: formData });
      const dati = await res.json();
      if (!res.ok) throw new Error(dati.errore || "Errore durante l'importazione");

      setStato("ok");
      setMessaggio(
        `Fatto: ${dati.righe_totali} righe lette, ${dati.pratiche_rilevate} pratiche trovate ` +
          `(${dati.pratiche_aggiornate} aggiornate, ${dati.pratiche_invariate} invariate, ${dati.pratiche_ignorate} non di assistenza)` +
          (dati.errori > 0 ? `, ${dati.errori} errori.` : ".")
      );
      if (inputRef.current) inputRef.current.value = "";
      router.refresh(); // ricarica la tabella importazioni/pratiche sotto, senza ricaricare la pagina
    } catch (err: any) {
      setStato("errore");
      setMessaggio(err?.message ?? "Errore sconosciuto durante l'importazione");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex flex-wrap items-center gap-3">
      <input ref={inputRef} type="file" name="file" accept=".csv" required className="text-sm" />
      <button
        type="submit"
        disabled={stato === "invio"}
        className="bg-gray-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50"
      >
        {stato === "invio" ? "Importazione in corso..." : "Carica ed importa CSV"}
      </button>
      {messaggio && (
        <span className={`text-xs ${stato === "errore" ? "text-red-600" : "text-green-700"}`}>{messaggio}</span>
      )}
    </form>
  );
}
