import type { Role } from "./rubric";

export const TOP_N = 5;
export const RANKABLE = ["scored", "drafted", "sent"];

type Row = { id: string; applied_role: Role; pm_score: number | null; spm_score: number | null; status: string; created_at: string };

export function roleScore(r: Pick<Row, "applied_role" | "pm_score" | "spm_score">): number {
  return Number((r.applied_role === "PM" ? r.pm_score : r.spm_score) ?? 0);
}

// Rank within applied_role by that role's score (ties: earlier upload first).
export function rankByRole<T extends Row>(rows: T[]): Record<Role, T[]> {
  const out: Record<Role, T[]> = { PM: [], SPM: [] };
  for (const r of rows) if (RANKABLE.includes(r.status)) out[r.applied_role].push(r);
  for (const role of ["PM", "SPM"] as Role[]) {
    out[role].sort((a, b) => roleScore(b) - roleScore(a) || a.created_at.localeCompare(b.created_at));
  }
  return out;
}
