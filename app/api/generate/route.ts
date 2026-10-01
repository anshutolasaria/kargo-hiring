// Step 1 of "Generate briefs & drafts": recompute ranking and return the work list.
// The browser then calls /api/generate/[id] once per candidate (keeps each call short).
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { rankByRole, TOP_N } from "@/lib/ranking";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  const { data, error } = await db()
    .from("candidates")
    .select("id,applied_role,pm_score,spm_score,status,created_at,draft_type,draft_body,brief");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const ranked = rankByRole(data ?? []);
  const work: { id: string; type: "invite" | "rejection"; role: string; rank: number }[] = [];
  for (const role of ["PM", "SPM"] as const) {
    ranked[role].forEach((c, i) => {
      if (c.status === "sent") return; // never touch sent candidates
      const type = i < TOP_N ? "invite" : "rejection";
      // skip drafts that already match the candidate's current side of the cutoff (unless forced)
      const upToDate = c.status === "drafted" && c.draft_type === type && !!c.draft_body && (type === "rejection" || !!c.brief);
      if (force || !upToDate) work.push({ id: c.id, type, role, rank: i + 1 });
    });
  }
  return NextResponse.json({ work });
}
