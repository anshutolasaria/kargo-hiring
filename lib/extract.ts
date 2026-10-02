// Local-only extraction + PII redaction. Nothing in this file calls an AI.
import mammoth from "mammoth";
import { extractText, getDocumentProxy } from "unpdf";
import { createHash } from "crypto";

export type Pii = { name: string; email: string; phone: string };

export type Extracted = {
  pii: Pii;
  redacted: string;
  fileHash: string;
  warnings: string[];
  safe: boolean; // assertion passed — OK to send redacted text to Gemini
  leaks: string[];
};

const REDACTED = "[REDACTED]";

export async function fileToText(fileName: string, buf: Buffer): Promise<string> {
  const lower = fileName.toLowerCase();
  let text: string;
  if (lower.endsWith(".pdf")) {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const out = await extractText(pdf, { mergePages: true });
    text = Array.isArray(out.text) ? out.text.join("\n") : out.text;
  } else if (lower.endsWith(".docx")) {
    text = (await mammoth.extractRawText({ buffer: buf })).value;
  } else {
    throw new Error(`Unsupported file type: ${fileName} (PDF or DOCX only)`);
  }
  // Postgres rejects NUL characters; some PDFs contain them (and other stray control chars).
  return text.replace(/\u0000/g, "").replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/g, " ");
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

// "pm_01_priya_krishnan.pdf" -> "Priya Krishnan"; "06_kavya_patel.pdf" -> "Kavya Patel"
export function nameFromFileName(fileName: string): string {
  const base = fileName.replace(/\.[^.]+$/, "");
  const tokens = base
    .split(/[_\-\s.]+/)
    .filter((t) => t && !/^\d+$/.test(t) && !/^(pm|spm|cv|resume)$/i.test(t));
  return tokens.map((t) => t[0].toUpperCase() + t.slice(1).toLowerCase()).join(" ");
}

export function roleFromFileName(fileName: string): "PM" | "SPM" | null {
  const f = fileName.toLowerCase();
  if (f.startsWith("spm_")) return "SPM";
  if (f.startsWith("pm_")) return "PM";
  return null;
}

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;
// Profile / portfolio URLs: any URL with a scheme, or a bare domain on a common TLD (with optional
// path). The label before the TLD must be 3+ chars so degrees like "B.Tech" / "B.Com" survive.
const URL_RE =
  /(?:https?:\/\/\S+)|(?:\b(?:www\.)?(?:[A-Za-z0-9\-]+\.)*[A-Za-z0-9\-]{3,}\.(?:com|in|io|me|dev|co|org|net|app|xyz|site|page|ai|tech)\b(?:\/[^\s|,;)]*)?)/gi;
// Phone-like span: digits with spaces/dashes/dots/brackets, at least 7 digits in total.
const PHONE_SPAN_RE = /\+?\(?\d[\d\s\-().]{5,}\d/g;

export function extractEmail(text: string): string {
  return text.match(EMAIL_RE)?.[0] ?? "";
}

// PDFs here duplicate/split phone digits: "+91 98202 1134598202 11345", "90491 53824".
// The real number is the first 10 digits of the span (after a leading +91), and must look like
// an Indian mobile (starts 6-9). Spans starting "+91" or right after an email are tried first.
export function extractPhone(text: string): string {
  const spans: { s: string; pri: number }[] = [];
  for (const m of text.matchAll(PHONE_SPAN_RE)) {
    const before = text.slice(Math.max(0, m.index! - 40), m.index!);
    const pri = m[0].startsWith("+91") ? 0 : /@\S*$/.test(before) ? 1 : 2;
    spans.push({ s: m[0], pri });
  }
  spans.sort((a, b) => a.pri - b.pri);
  for (const { s } of spans) {
    let digits = s.replace(/\D/g, "");
    if (/^\+?\s*91/.test(s) && digits.length > 10) digits = digits.slice(2);
    const phone = digits.slice(0, 10);
    if (/^[6-9]\d{9}$/.test(phone)) return phone;
  }
  return "";
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Name tokens are matched case-insensitively WITHOUT word boundaries so mangled forms like
// "ROHAN MEHTARohan Mehta" are caught. Exception for very short tokens (<= 3 letters, e.g.
// "Sen", "Roy", "Das"): skip a match that sits inside an ordinary lowercase word ("senior",
// "destroy", "dashboard") — i.e. a lowercase letter right before it, or the match is in
// lowercase and continues into more lowercase letters. Mangled joins ("ARNAV SENArnav") still match.
function shortTokenMatches(text: string, token: string): { index: number; length: number }[] {
  const out: { index: number; length: number }[] = [];
  const re = new RegExp(escapeRe(token), "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const before = text[m.index - 1] ?? "";
    const after = text[m.index + token.length] ?? "";
    const insideBefore = /[a-z]/.test(before);
    const insideAfter = /[a-z]/.test(m[0].slice(1)) && /[a-z]/.test(after);
    if (!insideBefore && !insideAfter) out.push({ index: m.index, length: token.length });
  }
  return out;
}

export function nameTokens(name: string): string[] {
  return name
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z]/g, ""))
    .filter((t) => t.length >= 2);
}

function redactNameToken(text: string, token: string): string {
  if (token.length >= 4) return text.replace(new RegExp(escapeRe(token), "gi"), REDACTED);
  const hits = shortTokenMatches(text, token);
  for (let i = hits.length - 1; i >= 0; i--) {
    text = text.slice(0, hits[i].index) + REDACTED + text.slice(hits[i].index + hits[i].length);
  }
  return text;
}

function sharesChunk(digits: string, phone: string, min = 4): boolean {
  if (!phone || digits.length < min) return false;
  const targets = [phone, "91" + phone];
  if (targets.some((t) => t.includes(digits) || digits.includes(t))) return true;
  for (let i = 0; i + min <= digits.length; i++) {
    if (phone.includes(digits.slice(i, i + min))) return true;
  }
  return false;
}

export function redact(text: string, pii: Pii): string {
  let out = text;
  out = out.replace(EMAIL_RE, REDACTED);
  if (pii.email) out = out.split(pii.email).join(REDACTED);
  out = out.replace(URL_RE, (m) => (/@/.test(m) ? m : REDACTED));
  for (const tok of nameTokens(pii.name)) out = redactNameToken(out, tok);
  if (pii.phone) {
    // whole phone-like spans that overlap the phone ("+91 98202 98202 11345 11345")
    out = out.replace(PHONE_SPAN_RE, (span) =>
      sharesChunk(span.replace(/\D/g, ""), pii.phone) ? REDACTED : span
    );
    // any remaining 4+ digit run that shares a 4-digit chunk with the phone (covers runs that are
    // substrings of it and mangled runs like "1134598202"). May also hit a year like "2021" if
    // the phone happens to contain it — over-redacting is the safe direction.
    out = out.replace(/\d{4,}/g, (run) => (sharesChunk(run, pii.phone) ? REDACTED : run));
  }
  return out;
}

// Must pass before ANY Gemini call.
export function findLeaks(text: string, pii: Pii): string[] {
  const leaks: string[] = [];
  for (const tok of nameTokens(pii.name)) {
    const found = tok.length >= 4 ? new RegExp(escapeRe(tok), "i").test(text) : shortTokenMatches(text, tok).length > 0;
    if (found) leaks.push(`name token "${tok}"`);
  }
  const emails = text.match(EMAIL_RE);
  if (emails) leaks.push(`email (${emails.length})`);
  if (pii.phone) {
    for (const run of text.match(/\d{4,}/g) ?? []) {
      for (let i = 0; i + 4 <= run.length; i++) {
        if (pii.phone.includes(run.slice(i, i + 4))) {
          leaks.push(`digits "${run}" overlap phone`);
          break;
        }
      }
    }
  }
  return leaks;
}

export async function extractAndRedact(fileName: string, buf: Buffer): Promise<Extracted> {
  const raw = await fileToText(fileName, buf);
  const warnings: string[] = [];
  const name = nameFromFileName(fileName);
  // cross-check against the top of the CV (mangled text has no spaces, so compare squashed)
  // Some of these PDFs put the header block (name/contact) at the END of the extracted text, so
  // check the first and last 600 chars, then fall back to anywhere in the document.
  const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const header = squash(raw.slice(0, 600) + raw.slice(-600));
  const whole = squash(raw);
  const toks = nameTokens(name);
  const notAnywhere = toks.filter((t) => !whole.includes(t.toLowerCase()));
  if (notAnywhere.length) warnings.push(`Name from file name ("${name}") not found in CV: ${notAnywhere.join(", ")}`);
  else if (toks.some((t) => !header.includes(t.toLowerCase())))
    warnings.push(`Name "${name}" found in CV but not in its header block`);
  // Mangled PDFs glue the name onto the email ("HARSH REDDYsquad_5@…"): strip name tokens from the local part.
  let email = extractEmail(raw);
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of toks) {
      if (email.toLowerCase().startsWith(t.toLowerCase()) && email.length > t.length + 3) {
        email = email.slice(t.length);
        changed = true;
      }
    }
  }
  const pii: Pii = { name, email, phone: extractPhone(raw) };
  if (!pii.email) warnings.push("No email found");
  if (!pii.phone) warnings.push("No phone found");
  const redacted = redact(raw, pii);
  const leaks = findLeaks(redacted, pii);
  return { pii, redacted, fileHash: sha256(buf), warnings, safe: leaks.length === 0, leaks };
}
