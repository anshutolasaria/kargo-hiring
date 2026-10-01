// Confirms the public anon key cannot read any table (only server routes with the service role can).
// Usage: npx tsx scripts/check-rls.ts
import { config } from "dotenv";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";

config({ path: join(__dirname, "..", ".env.local") });

async function main() {
  const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    auth: { persistSession: false },
  });
  let ok = true;
  for (const table of ["candidate_pii", "candidates", "rubric_criteria"]) {
    const { data, error } = await anon.from(table).select("*").limit(1);
    const blocked = !!error || (data ?? []).length === 0;
    if (!blocked) ok = false;
    console.log(`${blocked ? "BLOCKED" : "READABLE!"}  anon -> ${table}${error ? ` (${error.message})` : ""}`);
  }
  process.exit(ok ? 0 : 1);
}
main();
