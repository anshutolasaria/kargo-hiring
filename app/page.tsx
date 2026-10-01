"use client";
// Upload page: drag-and-drop many files, pick a role per file, process ONE file per API call.
import { useState } from "react";

type Role = "PM" | "SPM" | "";
type Item = { file: File; role: Role; state: "waiting" | "working" | "done" | "error" | "review" | "dup"; msg: string };

const SPACING_MS = 13000; // free tier allows 5 requests/minute per model -> ~13s apart
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultRole(name: string): Role {
  const n = name.toLowerCase();
  if (n.startsWith("spm_")) return "SPM";
  if (n.startsWith("pm_")) return "PM";
  return "";
}

export default function UploadPage() {
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const [running, setRunning] = useState(false);

  const add = (files: FileList | null) => {
    if (!files) return;
    const next = Array.from(files)
      .filter((f) => /\.(pdf|docx)$/i.test(f.name))
      .map((f) => ({ file: f, role: defaultRole(f.name), state: "waiting" as const, msg: "" }));
    setItems((cur) => [...cur, ...next.filter((n) => !cur.some((c) => c.file.name === n.file.name))]);
  };
  const update = (i: number, patch: Partial<Item>) => setItems((cur) => cur.map((it, j) => (j === i ? { ...it, ...patch } : it)));

  const missingRole = items.some((it) => it.state === "waiting" && !it.role);

  async function run() {
    setRunning(true);
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.state !== "waiting" && it.state !== "error") continue;
      update(i, { state: "working", msg: "Extracting, redacting, scoring…" });
      let backoff = 10000;
      for (let attempt = 0; ; attempt++) {
        const fd = new FormData();
        fd.append("file", it.file);
        fd.append("role", it.role);
        let res: Response, json: Record<string, unknown>;
        try {
          res = await fetch("/api/process", { method: "POST", body: fd });
          json = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        } catch (e) {
          update(i, { state: "error", msg: String(e) });
          break;
        }
        if (res.status === 429 && attempt < 5) {
          update(i, { msg: `Gemini rate limit — retrying in ${backoff / 1000}s…` });
          await sleep(backoff);
          backoff *= 2;
          continue;
        }
        if (!res.ok) update(i, { state: "error", msg: String(json.error ?? res.status) });
        else if (json.status === "duplicate") update(i, { state: "dup", msg: String(json.message) });
        else if (json.status === "needs_review") update(i, { state: "review", msg: String(json.message) });
        else {
          const w = (json.warnings as string[] | undefined)?.length ? ` · ${(json.warnings as string[]).join("; ")}` : "";
          update(i, { state: "done", msg: `PM ${json.pm_score} · SPM ${json.spm_score}${w}` });
        }
        if (json.status !== "duplicate" && i < items.length - 1) await sleep(SPACING_MS);
        break;
      }
    }
    setRunning(false);
  }

  const done = items.filter((i) => i.state === "done").length;
  return (
    <>
      <h1>Upload CVs</h1>
      <div
        className={`drop ${over ? "over" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); }}
      >
        Drag PDF / DOCX files here, or{" "}
        <label style={{ textDecoration: "underline", cursor: "pointer" }}>
          choose files
          <input type="file" multiple accept=".pdf,.docx" hidden onChange={(e) => add(e.target.files)} />
        </label>
        <div className="muted">Role defaults from the file name (pm_ → PM, spm_ → SPM). Others need a role.</div>
      </div>

      {items.length > 0 && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <button className="primary" disabled={running || missingRole} onClick={run}>
              {running ? "Processing…" : "Process files"}
            </button>
            {missingRole && <span className="error">Choose a role for every file first.</span>}
            <span className="muted">{done}/{items.length} scored · one file at a time, ~13s apart</span>
            {!running && <button onClick={() => setItems([])}>Clear list</button>}
          </div>
          <table>
            <thead><tr><th>File</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>
              {items.map((it, i) => (
                <tr key={it.file.name}>
                  <td>{it.file.name}</td>
                  <td>
                    <select value={it.role} disabled={running || it.state !== "waiting"} onChange={(e) => update(i, { role: e.target.value as Role })}>
                      <option value="">— choose —</option>
                      <option value="PM">PM</option>
                      <option value="SPM">SPM</option>
                    </select>
                  </td>
                  <td className={it.state === "error" || it.state === "review" ? "error" : it.state === "done" ? "ok" : "muted"}>
                    {{ waiting: "Waiting", working: "Working", done: "Scored", error: "Error", review: "Needs review", dup: "Duplicate" }[it.state]}
                    {it.msg && ` — ${it.msg}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
