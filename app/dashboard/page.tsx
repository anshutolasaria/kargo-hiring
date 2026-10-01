"use client";
// Dashboard: PM / SPM tabs, ranked cards, cutoff after #5, one "Confirm & send" per card.
import { useCallback, useEffect, useState } from "react";

type Score = { criterion: string; score: number; reason: string };
type Cand = {
  id: string; applied_role: "PM" | "SPM"; file_name: string; name: string; email: string;
  pm_score: number | null; spm_score: number | null; score_json: { PM: Score[]; SPM: Score[]; model?: string } | null;
  brief: string | null; draft_type: "invite" | "rejection" | null; status: string; sent_at: string | null;
  display_subject: string; display_body: string;
};
type Data = { ranked: { PM: Cand[]; SPM: Cand[] }; unranked: Cand[]; criteria: { role: string; name: string; weight: number }[] };

const TOP_N = 5;
const SPACING_MS = 13000; // free tier allows 5 requests/minute per model
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function Dashboard() {
  const [tab, setTab] = useState<"PM" | "SPM">("PM");
  const [data, setData] = useState<Data | null>(null);
  const [err, setErr] = useState("");
  const [gen, setGen] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch("/api/candidates", { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) setErr(j.error ?? "Failed to load");
    else { setErr(""); setData(j); }
  }, []);
  useEffect(() => { load(); }, [load]);

  async function generate(force: boolean) {
    setBusy(true);
    setGen("Recomputing ranking…");
    const r = await fetch(`/api/generate${force ? "?force=1" : ""}`, { method: "POST" });
    const j = await r.json();
    if (!r.ok) { setGen(`Error: ${j.error}`); setBusy(false); return; }
    const work: { id: string; type: string; role: string; rank: number }[] = j.work;
    if (!work.length) { setGen("All drafts are up to date."); setBusy(false); return; }
    let ok = 0, failed = 0;
    for (let i = 0; i < work.length; i++) {
      const w = work[i];
      setGen(`Drafting ${i + 1}/${work.length} — ${w.role} #${w.rank} (${w.type})…`);
      let backoff = 10000;
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`/api/generate/${w.id}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: w.type }),
        });
        if (res.status === 429 && attempt < 5) {
          setGen(`Rate limited — retrying in ${backoff / 1000}s (${i + 1}/${work.length})`);
          await sleep(backoff); backoff *= 2; continue;
        }
        if (res.ok) ok++; else failed++;
        break;
      }
      if (i < work.length - 1) await sleep(SPACING_MS);
      if (i % 5 === 4) load();
    }
    setGen(`Done: ${ok} drafted${failed ? `, ${failed} failed` : ""}.`);
    setBusy(false);
    load();
  }

  if (err) return <p className="error">{err}</p>;
  if (!data) return <p>Loading…</p>;
  const list = data.ranked[tab];
  const criteria = data.criteria.filter((c) => c.role === tab);

  return (
    <>
      <h1>Dashboard</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="primary" disabled={busy} onClick={() => generate(false)}>Generate briefs &amp; drafts</button>
        <button disabled={busy} onClick={() => generate(true)} title="Regenerate every unsent draft">Regenerate all</button>
        <button disabled={busy} onClick={load}>Refresh</button>
        <span className="muted">{gen}</span>
      </div>
      <div className="tabs">
        {(["PM", "SPM"] as const).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t} ({data.ranked[t].length})
          </button>
        ))}
      </div>
      <p className="muted">
        Rubric ({tab}): {criteria.map((c) => `${c.name} ${c.weight}%`).join(" · ")}
      </p>
      {list.length === 0 && <p>No scored candidates for {tab} yet.</p>}
      {list.map((c, i) => (
        <div key={c.id}>
          {i === TOP_N && <div className="cutoff"><span>Cutoff — below this line: rejection drafts</span></div>}
          <CandidateCard c={c} rank={i + 1} onChange={load} />
        </div>
      ))}
      {data.unranked.length > 0 && (
        <>
          <h2 style={{ fontSize: 16, marginTop: 24 }}>Not ranked ({data.unranked.length})</h2>
          <table>
            <tbody>
              {data.unranked.map((c) => (
                <tr key={c.id}>
                  <td>{c.file_name}</td><td>{c.applied_role}</td>
                  <td><span className={`badge ${c.status}`}>{c.status === "needs_review" ? "Needs review — PII check failed, not sent to AI" : "Pending — re-upload to score"}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

function CandidateCard({ c, rank, onChange }: { c: Cand; rank: number; onChange: () => void }) {
  const [subject, setSubject] = useState(c.display_subject);
  const [body, setBody] = useState(c.display_body);
  const [msg, setMsg] = useState<{ t: "ok" | "error"; s: string } | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => { setSubject(c.display_subject); setBody(c.display_body); }, [c.display_subject, c.display_body]);

  const role = c.applied_role;
  const other = role === "PM" ? "SPM" : "PM";
  const score = role === "PM" ? c.pm_score : c.spm_score;
  const otherScore = role === "PM" ? c.spm_score : c.pm_score;
  const sent = c.status === "sent";
  const hasDraft = !!c.display_body;
  const dirty = subject !== c.display_subject || body !== c.display_body;

  async function save() {
    const r = await fetch(`/api/candidates/${c.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject, body }) });
    setMsg(r.ok ? { t: "ok", s: "Saved" } : { t: "error", s: "Save failed" });
    if (r.ok) onChange();
  }

  async function send() {
    if (!confirm(`Send this ${c.draft_type ?? ""} email to ${c.name}?`)) return;
    setSending(true); setMsg(null);
    const r = await fetch(`/api/send/${c.id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ subject, body }) });
    const j = await r.json().catch(() => ({}));
    setSending(false);
    if (r.ok) { setMsg({ t: "ok", s: `Sent to ${j.to}` }); onChange(); }
    else setMsg({ t: "error", s: j.error ?? `Send failed (${r.status})` });
  }

  return (
    <div className="card">
      <div className="row">
        <h3>#{rank} · {c.name}</h3>
        <strong>{role} {score ?? "–"}</strong>
        <span className="muted">{other} {otherScore ?? "–"}</span>
        {sent ? <span className="badge sent">Sent {c.sent_at ? new Date(c.sent_at).toLocaleString() : ""}</span>
          : <span className={`badge ${c.status}`}>{c.status === "drafted" ? `Drafted · ${c.draft_type}` : "Scored · no draft yet"}</span>}
        <span className="muted">{c.file_name}</span>
        {c.score_json?.model && <span className="muted">scored by {c.score_json.model}</span>}
      </div>

      {c.score_json && (
        <table style={{ marginTop: 6 }}>
          <tbody>
            {c.score_json[role].map((s) => (
              <tr key={s.criterion}><td style={{ width: 230 }}>{s.criterion}</td><td style={{ width: 40 }}><strong>{s.score}/5</strong></td><td>{s.reason}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {c.score_json && (
        <details>
          <summary className="muted">{other} breakdown ({otherScore})</summary>
          <table><tbody>
            {c.score_json[other].map((s) => (
              <tr key={s.criterion}><td style={{ width: 230 }}>{s.criterion}</td><td style={{ width: 40 }}>{s.score}/5</td><td>{s.reason}</td></tr>
            ))}
          </tbody></table>
        </details>
      )}

      {rank <= TOP_N && c.brief && <div className="brief"><strong>Interview brief:</strong> {c.brief}</div>}

      {hasDraft ? (
        <div style={{ marginTop: 8 }}>
          <div className="muted">Draft {c.draft_type} → {c.email}</div>
          <input className="subject" value={subject} disabled={sent} onChange={(e) => setSubject(e.target.value)} />
          <textarea value={body} disabled={sent} onChange={(e) => setBody(e.target.value)} />
          {!sent && (
            <div className="row" style={{ marginTop: 6 }}>
              <button className="primary" disabled={sending} onClick={send}>{sending ? "Sending…" : "Confirm & send"}</button>
              <button disabled={!dirty || sending} onClick={save}>Save edits</button>
            </div>
          )}
        </div>
      ) : (
        <p className="muted">No draft yet — click “Generate briefs &amp; drafts”.</p>
      )}
      {msg && <p className={msg.t}>{msg.s}</p>}
    </div>
  );
}
