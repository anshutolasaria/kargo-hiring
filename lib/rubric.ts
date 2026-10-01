// Parses rubric.txt: "ROLE: PM" / "ROLE: SPM" sections, each with
// "Criterion name:", "What a strong candidate looks like:", "Weight: NN%" blocks.
export type Role = "PM" | "SPM";
export type Criterion = { role: Role; name: string; description: string; weight: number };

export function parseRubric(text: string): Criterion[] {
  const out: Criterion[] = [];
  let role: Role | null = null;
  let cur: Partial<Criterion> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const roleM = line.match(/^ROLE:\s*(PM|SPM)\b/i);
    if (roleM) { role = roleM[1].toUpperCase() as Role; continue; }
    if (!role) continue;
    const nameM = line.match(/^Criterion name:\s*(.+)$/i);
    if (nameM) { cur = { role, name: nameM[1].trim() }; continue; }
    const descM = line.match(/^What a strong candidate looks like:\s*(.+)$/i);
    if (descM && cur) { cur.description = descM[1].trim(); continue; }
    const wM = line.match(/^Weight:\s*(\d+)\s*%?/i);
    if (wM && cur) {
      cur.weight = parseInt(wM[1], 10);
      if (!cur.name || !cur.description) throw new Error(`Incomplete criterion before "${line}"`);
      out.push(cur as Criterion);
      cur = null;
    }
  }
  return out;
}

export function assertWeights(criteria: Criterion[]) {
  for (const role of ["PM", "SPM"] as Role[]) {
    const rows = criteria.filter((c) => c.role === role);
    const sum = rows.reduce((s, c) => s + c.weight, 0);
    if (rows.length === 0) throw new Error(`No criteria found for ${role}`);
    if (sum !== 100) throw new Error(`Weights for ${role} sum to ${sum}, expected 100`);
  }
}
