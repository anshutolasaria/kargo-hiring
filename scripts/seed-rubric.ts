// Seeds rubric_criteria from rubric.txt. Fails loudly if weights don't sum to 100 per role.
// Usage: npm run seed
import { config } from "dotenv";
import { readFileSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { parseRubric, assertWeights } from "../lib/rubric";

config({ path: join(__dirname, "..", ".env.local") });

async function main() {
  const criteria = parseRubric(readFileSync(join(__dirname, "..", "rubric.txt"), "utf8"));
  assertWeights(criteria); // throws -> non-zero exit
  for (const role of ["PM", "SPM"]) {
    const rows = criteria.filter((c) => c.role === role);
    console.log(`${role}: ${rows.length} criteria, weights = ${rows.map((r) => r.weight).join(" + ")} = 100`);
  }
  if (process.argv.includes("--dry-run")) return;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key || url.includes("YOUR-PROJECT")) throw new Error("Set Supabase keys in .env.local first");
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { error: delErr } = await db.from("rubric_criteria").delete().neq("id", -1);
  if (delErr) throw delErr;
  const { error } = await db.from("rubric_criteria").insert(criteria);
  if (error) throw error;
  console.log(`Seeded ${criteria.length} rubric criteria.`);
}

main().catch((e) => {
  console.error("SEED FAILED:", e.message ?? e);
  process.exit(1);
});
