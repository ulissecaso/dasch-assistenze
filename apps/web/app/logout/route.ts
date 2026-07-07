// app/logout/route.ts
// Route Handler per il logout: invalida la sessione e reindirizza al login.
import { NextResponse } from "next/server";
import { creaSupabaseClientServer } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = creaSupabaseClientServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login/admin", request.url));
}

export async function GET(request: Request) {
  const supabase = creaSupabaseClientServer();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL("/login/admin", request.url));
}
