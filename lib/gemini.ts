import "server-only";
import { GoogleGenAI, Type, type Schema } from "@google/genai";
import type { Criterion, Role } from "./rubric";

// The free tier allows ~20 requests/day per model, so each task rotates through a chain of models:
// when one is out of quota (429) or overloaded (503) we move to the next. Scoring uses full Flash
// models (quality matters most); drafting uses Flash-Lite models to save scoring quota.
const list = (v: string | undefined, d: string[]) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : d);
const SCORE_MODELS = list(process.env.GEMINI_SCORE_MODELS, [
  "gemini-3.8-flash", "gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.5-flash", "gemini-3-flash-preview", "gemini-2.5-flash",
]);
const DRAFT_MODELS = list(process.env.GEMINI_DRAFT_MODELS, [
  "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash",
]);

// Models that recently returned 429/503 are skipped for a while (per server instance).
const coolingUntil = new Map<string, number>();

// Daily-quota 429s ("limit: 20" requests) park a model for hours; per-minute 429s ("limit: 5")
// and 503 overloads only for about a minute.
function cooldownMs(status: number, message: string): number {
  if (status === 404) return 24 * 3600e3; // model id not available to this key
  if (status === 503) return 60e3;
  const limit = Number(message.match(/limit:\s*(\d+)/)?.[1] ?? 0);
  return /per ?day/i.test(message) || limit > 10 ? 6 * 3600e3 : 70e3;
}

export class RateLimitedError extends Error {
  status = 429;
}

function client() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  return new GoogleGenAI({ apiKey });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One structured-JSON call at temperature 0. Walks the model chain, skipping models that are
// cooling down; if none can take the call, throws RateLimitedError so the browser backs off and retries.
async function callJson<T>(prompt: string, schema: Schema, models: string[]): Promise<{ data: T; model: string }> {
  const ai = client();
  const started = Date.now();
  for (const model of models) {
    if ((coolingUntil.get(model) ?? 0) > Date.now()) continue;
    if (Date.now() - started > 45000) break; // stay under the 60s route limit
    try {
      const res = await ai.models.generateContent({
        model,
        contents: prompt,
        config: { temperature: 0, responseMimeType: "application/json", responseSchema: schema },
      });
      const text = res.text;
      if (!text) throw new Error("Empty response from Gemini");
      return { data: JSON.parse(text) as T, model };
    } catch (e: unknown) {
      const status = (e as { status?: number }).status;
      if (status === 429 || status === 503 || status === 404) {
        coolingUntil.set(model, Date.now() + cooldownMs(status, String((e as Error).message)));
        continue;
      }
      throw e;
    }
  }
  throw new RateLimitedError("All Gemini models are rate-limited or out of today's free quota — retry later");
}

export type CriterionScore = { criterion: string; score: number; reason: string };
export type ScoreResult = { PM: CriterionScore[]; SPM: CriterionScore[]; model?: string };

function roleArraySchema(names: string[]): Schema {
  return {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        criterion: { type: Type.STRING, enum: names },
        score: { type: Type.INTEGER, minimum: 1, maximum: 5 },
        reason: { type: Type.STRING, description: "One line, quoting evidence from the CV" },
      },
      required: ["criterion", "score", "reason"],
      propertyOrdering: ["criterion", "score", "reason"],
    },
    minItems: String(names.length),
    maxItems: String(names.length),
  };
}

function rubricBlock(criteria: Criterion[], role: Role) {
  return criteria
    .filter((c) => c.role === role)
    .map((c) => `- ${c.name} (weight ${c.weight}%): ${c.description}`)
    .join("\n");
}

export async function scoreCv(redactedCv: string, criteria: Criterion[]): Promise<ScoreResult> {
  const pmNames = criteria.filter((c) => c.role === "PM").map((c) => c.name);
  const spmNames = criteria.filter((c) => c.role === "SPM").map((c) => c.name);
  const prompt = `You are scoring a job application for Kargo, a Series A logistics SaaS company in Mumbai.
Score the CV below against BOTH rubrics: Product Manager (PM) and Senior Product Manager (SPM).
For every criterion give an integer score 1-5 (use the score anchors in the description) and a
one-line reason that quotes or closely paraphrases specific evidence from the CV. If there is no
evidence, score 1 and say so. Judge only what is written. Personal details have been replaced
with [REDACTED]; ignore that.

PM RUBRIC
${rubricBlock(criteria, "PM")}

SPM RUBRIC
${rubricBlock(criteria, "SPM")}

CV (redacted)
"""
${redactedCv.slice(0, 30000)}
"""`;
  const schema: Schema = {
    type: Type.OBJECT,
    properties: { PM: roleArraySchema(pmNames), SPM: roleArraySchema(spmNames) },
    required: ["PM", "SPM"],
  };
  const { data: result, model } = await callJson<ScoreResult>(prompt, schema, SCORE_MODELS);
  for (const [role, names] of [["PM", pmNames], ["SPM", spmNames]] as const) {
    const got = new Set(result[role].map((r) => r.criterion));
    const missing = names.filter((n) => !got.has(n));
    if (missing.length) throw new Error(`Gemini omitted ${role} criteria: ${missing.join(", ")}`);
  }
  return { ...result, model };
}

// sum(score/5 × weight) → 0–100
export function weightedTotal(scores: CriterionScore[], criteria: Criterion[], role: Role): number {
  let total = 0;
  for (const c of criteria.filter((c) => c.role === role)) {
    const s = scores.find((x) => x.criterion === c.name);
    total += ((s?.score ?? 0) / 5) * c.weight;
  }
  return Math.round(total * 10) / 10;
}

export type Draft = { brief: string | null; subject: string; body: string };

export async function writeDraft(opts: {
  type: "invite" | "rejection";
  role: Role;
  redactedCv: string;
  scores: CriterionScore[];
}): Promise<Draft> {
  const roleName = opts.role === "PM" ? "Product Manager" : "Senior Product Manager";
  const scoreLines = opts.scores.map((s) => `- ${s.criterion}: ${s.score}/5 — ${s.reason}`).join("\n");
  const task =
    opts.type === "invite"
      ? `1. "brief": exactly 3 sentences for the founder, Arjun, telling him what to PROBE in the interview — the strongest claims to verify and the weakest criteria to test. Be specific to this CV.
2. "subject" and "body": an email inviting the candidate to an interview for the ${roleName} role. Mention 1-2 specific things from their CV that stood out. Ask them to reply with 2-3 times that work next week. Warm, concise, under 150 words.`
      : `1. "brief": return an empty string.
2. "subject" and "body": a warm, respectful rejection email for the ${roleName} role. Thank them, name one specific genuine strength from their CV, say plainly that we are not moving forward for this role, and wish them well. No false promises. Under 130 words.`;
  const prompt = `You write on behalf of Arjun Mehta, founder of Kargo (Series A logistics SaaS, Mumbai).
${task}

Rules: Start the body with "Dear {{NAME}}," — use the literal placeholder {{NAME}} for the candidate's
name everywhere; never invent a name. Sign off as "Arjun Mehta, Founder, Kargo". Plain text, no markdown.
Format the body with line breaks: the greeting on its own line, a blank line, short paragraphs separated by
blank lines, a blank line, then the sign-off on its own lines.
Personal details in the CV are [REDACTED]; never mention that.

Rubric scores for this candidate:
${scoreLines}

CV (redacted)
"""
${opts.redactedCv.slice(0, 20000)}
"""`;
  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      brief: { type: Type.STRING },
      subject: { type: Type.STRING },
      body: { type: Type.STRING },
    },
    required: ["brief", "subject", "body"],
    propertyOrdering: ["brief", "subject", "body"],
  };
  const { data: d } = await callJson<{ brief: string; subject: string; body: string }>(prompt, schema, DRAFT_MODELS);
  let body = d.body.trim();
  if (!body.includes("{{NAME}}")) body = `Dear {{NAME}},\n\n${body}`;
  return { brief: opts.type === "invite" ? d.brief.trim() : null, subject: d.subject.trim(), body };
}
