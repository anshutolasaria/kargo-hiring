// Uploads CVs to a running app exactly like the upload page does: one file per /api/process call,
// spaced for the Gemini free tier, backing off on 429.
// Usage: npx tsx scripts/bulk-upload.ts [baseUrl] [--skip file1,file2]
import { config } from "dotenv";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

config({ path: join(__dirname, "..", ".env.local") });
const BASE = process.argv.find((a) => a.startsWith("http")) ?? "http://localhost:3000";
const skipArg = process.argv[process.argv.indexOf("--skip") + 1] ?? "";
const SKIP = new Set(process.argv.includes("--skip") ? skipArg.split(",") : []);
const DIR = join(__dirname, "..", "applications");
const AUTH = "Basic " + Buffer.from(`arjun:${process.env.DASHBOARD_PASSWORD}`).toString("base64");

// Unprefixed files: 5+ years of experience -> SPM (JD: SPM 5–8 yrs, PM 2–4 yrs), else PM.
const SPM_UNPREFIXED = new Set(["02", "03", "08", "10", "11", "13", "27", "28", "29"]);
function roleFor(f: string): "PM" | "SPM" {
  if (f.startsWith("spm_")) return "SPM";
  if (f.startsWith("pm_")) return "PM";
  return SPM_UNPREFIXED.has(f.slice(0, 2)) ? "SPM" : "PM";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const files = readdirSync(DIR).filter((f) => /\.(pdf|docx)$/i.test(f) && !SKIP.has(f));
  for (const [i, f] of files.entries()) {
    let backoff = 30000;
    for (let attempt = 0; attempt < 6; attempt++) {
      const fd = new FormData();
      fd.append("file", new Blob([readFileSync(join(DIR, f))]), f);
      fd.append("role", roleFor(f));
      const res = await fetch(`${BASE}/api/process`, { method: "POST", body: fd, headers: { authorization: AUTH } });
      const j = await res.json().catch(() => ({}));
      if (res.status === 429) {
        console.log(`[${i + 1}/${files.length}] ${f}: rate limited, waiting ${backoff / 1000}s`);
        await sleep(backoff);
        backoff *= 2;
        continue;
      }
      console.log(`[${i + 1}/${files.length}] ${f} (${roleFor(f)}): ${j.status ?? "ERROR"} ${j.pm_score ?? ""} ${j.spm_score ?? ""} ${j.message ?? j.error ?? ""}`);
      if (j.status !== "duplicate") await sleep(13000);
      break;
    }
  }
}
main();
