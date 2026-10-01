import "server-only";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Service-role client. Server routes only — bypasses RLS, so never import this in client code.
let client: SupabaseClient | null = null;
export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error("Supabase env vars missing (NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)");
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}
