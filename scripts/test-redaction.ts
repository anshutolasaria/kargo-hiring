// Runs local extraction + redaction (no AI, no network) and prints redacted text for review.
// Usage: npm run test:redaction            -> the 5 default files, full redacted text
//        npm run test:redaction -- --all   -> leak summary for every file in applications/
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { extractAndRedact, nameTokens } from "../lib/extract";

const DIR = join(__dirname, "..", "applications");
const DEFAULT = [
  "01_rohan_mehta.pdf",
  "14_sneha_kulkarni.pdf",
  "03_arnav_sen.pdf",
  "pm_01_priya_krishnan.pdf",
  "spm_25_sourav_das.pdf",
];

async function main() {
  const all = process.argv.includes("--all");
  const files = all ? readdirSync(DIR).filter((f) => /\.(pdf|docx)$/i.test(f)) : DEFAULT;
  let failures = 0;
  for (const f of files) {
    const r = await extractAndRedact(f, readFileSync(join(DIR, f)));
    // independent raw-substring check (simpler than findLeaks, catches regressions in it)
    const lower = r.redacted.toLowerCase();
    const rawHits = [
      ...nameTokens(r.pii.name).filter((t) => t.length >= 4 && lower.includes(t.toLowerCase())),
      ...(r.pii.email && lower.includes(r.pii.email.toLowerCase()) ? [r.pii.email] : []),
      ...(r.pii.phone && r.redacted.replace(/\D/g, " ").split(/\s+/).some((d) => d.length >= 4 && r.pii.phone.includes(d)) ? ["phone digits"] : []),
    ];
    const ok = r.safe && rawHits.length === 0;
    if (!ok) failures++;
    console.log("\n" + "=".repeat(80));
    console.log(`${ok ? "PASS" : "FAIL"}  ${f}`);
    console.log(`  name=${r.pii.name} | email=${r.pii.email || "(none)"} | phone=${r.pii.phone || "(none)"}`);
    if (r.warnings.length) console.log(`  warnings: ${r.warnings.join("; ")}`);
    if (r.leaks.length) console.log(`  LEAKS: ${r.leaks.join("; ")}`);
    if (rawHits.length) console.log(`  RAW HITS: ${rawHits.join("; ")}`);
    if (!all) console.log("-".repeat(80) + "\n" + r.redacted);
  }
  console.log(`\n${files.length - failures}/${files.length} files passed the no-PII assertion.`);
  process.exit(failures ? 1 : 0);
}
main();
