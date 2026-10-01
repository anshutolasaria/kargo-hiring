// One file per call: extract + redact locally, store, then score with ONE Gemini call.
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { extractAndRedact, sha256 } from "@/lib/extract";
import { loadCriteria } from "@/lib/criteria";
import { scoreCv, weightedTotal, RateLimitedError } from "@/lib/gemini";
import { assertNoPii, PiiLeakError } from "@/lib/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const role = String(form.get("role") ?? "");
    if (!(file instanceof File)) return NextResponse.json({ error: "No file" }, { status: 400 });
    if (role !== "PM" && role !== "SPM") return NextResponse.json({ error: "Choose a role (PM or SPM)" }, { status: 400 });
    const buf = Buffer.from(await file.arrayBuffer());
    const hash = sha256(buf);
    const sb = db();

    let { data: cand } = await sb.from("candidates").select("id,status,cv_content").eq("file_hash", hash).maybeSingle();
    let warnings: string[] = [];
    // 'pending' = stored but never scored (e.g. an earlier 429) — fall through and score it now.
    if (cand && cand.status !== "pending") {
      return NextResponse.json({ status: "duplicate", id: cand.id, message: `Already uploaded (${cand.status})` });
    }
    if (!cand) {
      const ex = await extractAndRedact(file.name, buf);
      warnings = ex.warnings;
      const { data: ins, error } = await sb
        .from("candidates")
        .insert({
          applied_role: role,
          cv_content: ex.redacted,
          file_name: file.name,
          file_hash: hash,
          status: ex.safe ? "pending" : "needs_review",
        })
        .select("id,status,cv_content")
        .single();
      if (error) throw error;
      const { error: piiErr } = await sb.from("candidate_pii").insert({ candidate_id: ins.id, ...ex.pii });
      if (piiErr) throw piiErr;
      if (!ex.safe) {
        return NextResponse.json({ status: "needs_review", id: ins.id, message: `Redaction check failed: ${ex.leaks.join("; ")}`, warnings });
      }
      cand = ins;
    }
    const c = cand!;

    // Re-assert against the stored PII right before the AI call.
    const { data: pii } = await sb.from("candidate_pii").select("name,email,phone").eq("candidate_id", c.id).single();
    try {
      assertNoPii(c.cv_content, { name: pii?.name ?? "", email: pii?.email ?? "", phone: pii?.phone ?? "" });
    } catch (e) {
      if (e instanceof PiiLeakError) {
        await sb.from("candidates").update({ status: "needs_review" }).eq("id", c.id);
        return NextResponse.json({ status: "needs_review", id: c.id, message: e.message });
      }
      throw e;
    }

    const criteria = await loadCriteria();
    const scores = await scoreCv(c.cv_content, criteria);
    const pm = weightedTotal(scores.PM, criteria, "PM");
    const spm = weightedTotal(scores.SPM, criteria, "SPM");
    const { error: upErr } = await sb
      .from("candidates")
      .update({ pm_score: pm, spm_score: spm, score_json: scores, status: "scored" })
      .eq("id", c.id);
    if (upErr) throw upErr;
    return NextResponse.json({ status: "scored", id: c.id, pm_score: pm, spm_score: spm, warnings });
  } catch (e: unknown) {
    if (e instanceof RateLimitedError) return NextResponse.json({ error: e.message }, { status: 429 });
    console.error(e);
    return NextResponse.json({ error: (e as Error).message ?? "Processing failed" }, { status: 500 });
  }
}
