// Dashboard data. Real names are substituted into drafts here, server side, for display.
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { rankByRole, RANKABLE } from "@/lib/ranking";
import { fillName } from "@/lib/name";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const sb = db();
  const [cands, pii, criteria] = await Promise.all([
    sb.from("candidates").select("id,applied_role,file_name,pm_score,spm_score,score_json,brief,draft_subject,draft_body,draft_type,status,sent_at,created_at"),
    sb.from("candidate_pii").select("candidate_id,name,email"),
    sb.from("rubric_criteria").select("role,name,weight").order("id"),
  ]);
  const err = cands.error || pii.error || criteria.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });
  const byId = new Map((pii.data ?? []).map((p) => [p.candidate_id, p]));
  const rows = (cands.data ?? []).map((c) => {
    const p = byId.get(c.id);
    const name = p?.name ?? "Candidate";
    return {
      ...c,
      name,
      email: p?.email ?? "",
      display_subject: fillName(c.draft_subject, name),
      display_body: fillName(c.draft_body, name),
    };
  });
  const ranked = rankByRole(rows);
  const unranked = rows.filter((r) => !RANKABLE.includes(r.status));
  return NextResponse.json({ ranked, unranked, criteria: criteria.data });
}
