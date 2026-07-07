import "./globals.css";
import Link from "next/link";

export const metadata = {
  title: "Dasch Gestione Assistenze",
  description: "Gestione e monitoraggio automatizzato delle pratiche di assistenza post-vendita",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it">
      <body className="bg-gray-50 text-gray-900">
        <div className="flex min-h-screen">
          <nav className="w-56 bg-white border-r p-4 space-y-2">
            <p className="font-semibold mb-4">Dasch Assistenze</p>
            <Link className="block py-1 text-sm hover:text-blue-600" href="/dashboard-direzione">Dashboard Direzione</Link>
            <Link className="block py-1 text-sm hover:text-blue-600" href="/dashboard-operatore">Le mie pratiche</Link>
            <Link className="block py-1 text-sm hover:text-blue-600" href="/admin">Admin</Link>
          </nav>
          <div className="flex-1">{children}</div>
        </div>
      </body>
    </html>
  );
}
