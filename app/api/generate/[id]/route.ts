// Step 2: one Gemini call for one candidate — brief + invite (top 5) or rejection.
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { writeDraft, RateLimitedError } from "@/lib/gemini";
import { assertNoPii, PiiLeakError } from "@/lib/guard";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { type } = (await req.json()) as { type: "invite" | "rejection" };
  if (type !== "invite" && type !== "rejection") return NextResponse.json({ error: "bad type" }, { status: 400 });
  const sb = db();
  const { data: c, error } = await sb.from("candidates").select("*").eq("id", id).single();
  if (error || !c) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (c.status === "sent") return NextResponse.json({ status: "skipped", reason: "already sent" });
  if (!c.score_json) return NextResponse.json({ error: "Not scored yet" }, { status: 400 });
  const { data: pii } = await sb.from("candidate_pii").select("name,email,phone").eq("candidate_id", id).single();
  try {
    assertNoPii(c.cv_content, { name: pii?.name ?? "", email: pii?.email ?? "", phone: pii?.phone ?? "" });
    const d = await writeDraft({ type, role: c.applied_role, redactedCv: c.cv_content, scores: c.score_json[c.applied_role] });
    const { error: upErr } = await sb
      .from("candidates")
      .update({ brief: d.brief, draft_subject: d.subject, draft_body: d.body, draft_type: type, status: "drafted" })
      .eq("id", id)
      .neq("status", "sent");
    if (upErr) throw upErr;
    return NextResponse.json({ status: "drafted", type });
  } catch (e: unknown) {
    if (e instanceof PiiLeakError) {
      await sb.from("candidates").update({ status: "needs_review" }).eq("id", id);
      return NextResponse.json({ status: "needs_review", message: e.message });
    }
    if (e instanceof RateLimitedError) return NextResponse.json({ error: e.message }, { status: 429 });
    console.error(e);
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
