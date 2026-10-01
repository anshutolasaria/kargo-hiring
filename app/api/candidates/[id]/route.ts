// Save an edited draft. The real name is turned back into {{NAME}} before storing.
import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";
import { unfillName } from "@/lib/name";

export const runtime = "nodejs";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { subject, body } = (await req.json()) as { subject: string; body: string };
  const sb = db();
  const { data: pii } = await sb.from("candidate_pii").select("name").eq("candidate_id", id).single();
  const name = pii?.name ?? "";
  const { error } = await sb
    .from("candidates")
    .update({ draft_subject: unfillName(subject, name), draft_body: unfillName(body, name) })
    .eq("id", id)
    .neq("status", "sent");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
