// "Confirm & send" for ONE candidate. Never called in bulk; nothing auto-sends.
import { NextResponse } from "next/server";
import { Resend } from "resend";
import { db } from "@/lib/supabase";
import { fillName, unfillName } from "@/lib/name";

export const runtime = "nodejs";
export const maxDuration = 60;

const FROM = "Kargo Hiring <onboarding@resend.dev>";
const ALLOWED_DOMAIN = "pg27.mesaschool.co";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { subject, body } = (await req.json()) as { subject: string; body: string };
  if (!subject?.trim() || !body?.trim()) return NextResponse.json({ error: "Subject and body are required" }, { status: 400 });

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "RESEND_API_KEY is not set — add it in Vercel → Settings → Environment Variables, then redeploy." },
      { status: 400 }
    );
  }

  const sb = db();
  const { data: c } = await sb.from("candidates").select("id,status").eq("id", id).single();
  if (!c) return NextResponse.json({ error: "Candidate not found" }, { status: 404 });
  if (c.status === "sent") return NextResponse.json({ error: "Already sent" }, { status: 409 });
  const { data: pii } = await sb.from("candidate_pii").select("name,email").eq("candidate_id", id).single();
  if (!pii) return NextResponse.json({ error: "No contact details on file" }, { status: 400 });

  const override = process.env.TEST_RECIPIENT_OVERRIDE?.trim();
  const to = override || pii.email;
  if (!to) return NextResponse.json({ error: "No email address on file for this candidate" }, { status: 400 });
  const domain = to.split("@")[1]?.toLowerCase();
  if (domain !== ALLOWED_DOMAIN) {
    return NextResponse.json({ error: `Refusing to send: recipient domain "${domain}" is not ${ALLOWED_DOMAIN}` }, { status: 403 });
  }

  const finalSubject = fillName(subject, pii.name);
  const finalBody = fillName(body, pii.name);
  if (finalBody.includes("{{") || finalSubject.includes("{{")) {
    return NextResponse.json({ error: "Draft still contains an unfilled placeholder" }, { status: 400 });
  }

  const { data, error } = await new Resend(apiKey).emails.send({ from: FROM, to, subject: finalSubject, text: finalBody });
  if (error) return NextResponse.json({ error: `Resend error: ${error.message}` }, { status: 502 });

  const sent_at = new Date().toISOString();
  await sb
    .from("candidates")
    .update({ status: "sent", sent_at, draft_subject: unfillName(finalSubject, pii.name), draft_body: unfillName(finalBody, pii.name) })
    .eq("id", id);
  return NextResponse.json({ ok: true, sent_at, to, resend_id: data?.id });
}
