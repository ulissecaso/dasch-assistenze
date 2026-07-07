// components/monitor/icone.tsx
// Libreria icone inline (stroke="currentColor"), stesso set usato nel
// prototipo approvato (demo-prototipo.html), riportato in componenti React
// così da poter essere usato nelle pagine reali senza dipendenze esterne.
"use client";

type NomeIcona =
  | "person" | "person-sm" | "warning" | "warn-sm" | "filter" | "box" | "doc"
  | "cart" | "truck" | "check" | "bell" | "clock" | "alert-circle" | "check-circle" | "calendar";

const PATH: Record<NomeIcona, JSX.Element> = {
  person: <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" /></>,
  "person-sm": <><circle cx="12" cy="8" r="4" /><path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" /></>,
  warning: <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  "warn-sm": <><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /><path d="M12 9v4" /><path d="M12 17h.01" /></>,
  filter: <polygon points="22 3 2 3 10 12.5 10 19 14 21 14 12.5 22 3" />,
  box: <><path d="m21 8-9-5-9 5 9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></>,
  doc: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" /><path d="M14 2v6h6" /><path d="M9 13h6" /><path d="M9 17h6" /></>,
  cart: <><circle cx="8" cy="21" r="1" /><circle cx="19" cy="21" r="1" /><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 2-1.58l1.65-7.42H5.12" /></>,
  truck: <><path d="M14 18V6a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h1" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.28a1 1 0 0 0-.11-.45l-2.5-5A1 1 0 0 0 18.5 8H14" /><circle cx="7" cy="18" r="2" /><circle cx="17" cy="18" r="2" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  bell: <><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  "alert-circle": <><circle cx="12" cy="12" r="10" /><path d="M12 8v4" /><path d="M12 16h.01" /></>,
  "check-circle": <><path d="M21.8 10A10 10 0 1 1 17 3.3" /><path d="m9 11 3 3L22 4" /></>,
  calendar: <><rect x="3" y="4" width="18" height="18" rx="2" /><path d="M16 2v4" /><path d="M8 2v4" /><path d="M3 10h18" /></>,
};

export function Icona({ nome, className }: { nome: NomeIcona; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className}>
      {PATH[nome]}
    </svg>
  );
}
