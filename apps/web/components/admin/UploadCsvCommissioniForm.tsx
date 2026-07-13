"use client";
// components/admin/UploadCsvCommissioniForm.tsx
// Form gemello di UploadCsvForm.tsx, ma per il file "Commissioni" di Vamart
// (filtro "Solo di assistenza") invece del "Piano di Carico": finora questo
// import era possibile solo tramite lo scraper automatico (GitHub Actions),
// mai a mano dal pannello. Fa POST a /api/import-csv-commissioni.
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Stato = "idle" | "invio" | "ok" | "errore";

export default function UploadCsvCommissioniForm() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stato, setStato] = useState<Stato>("idle");
  const [messaggio, setMessaggio] = useState<string | null>(null);

  const [brandCodice, setBrandCodice] = useState("CINQUEGRANA");

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const file = inputRef.current?.files?.[0];
    if (!file) return;

    setStato("invio");
    setMessaggio(null);

    const formData = new FormData();
    formData.append("file", file);
    formData.append("brand", brandCodice);

    try {
      const res = await fetch("/api/import-csv-commissioni", { method: "POST", body: formData });
      const dati = await res.json();
      if (!res.ok) throw new Error(dati.errore || "Errore durante l'importazione");

      setStato("ok");
      setMessaggio(
        `Fatto: ${dati.righe_totali} righe lette, ${dati.nuove} nuove pratiche, ${dati.ricollegate} ricollegate a segnalazioni via mail, ${dati.gia_presenti} già presenti` +
          (dati.errori > 0 ? `, ${dati.errori} errori.` : ".")
      );
      if (inputRef.current) inputRef.current.value = "";
      router.refresh();
    } catch (err: any) {
      setStato("errore");
      setMessaggio(err?.message ?? "Errore sconosciuto durante l'importazione");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-3 flex flex-wrap items-center gap-3">
      <select
        value={brandCodice}
        onChange={(e) => setBrandCodice(e.target.value)}
        className="text-sm border rounded px-2 py-1.5"
        aria-label="Brand del CSV da importare"
      >
        <option value="CINQUEGRANA">Arredamenti Cinquegrana</option>
        <option value="MASTERMOBILI">Master Mobili</option>
      </select>
      <input ref={inputRef} type="file" name="file" accept=".csv" required className="text-sm" />
      <button
        type="submit"
        disabled={stato === "invio"}
        className="bg-gray-900 text-white text-sm rounded px-3 py-1.5 disabled:opacity-50"
      >
        {stato === "invio" ? "Importazione in corso..." : "Carica ed importa Commissioni"}
      </button>
      {messaggio && (
        <span className={`text-xs ${stato === "errore" ? "text-red-600" : "text-green-700"}`}>{messaggio}</span>
      )}
    </form>
  );
}
