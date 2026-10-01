import "server-only";
import { findLeaks, type Pii } from "./extract";

// Hard stop before every Gemini call: the text must contain no name token, email, or phone chunk.
export function assertNoPii(text: string, pii: Pii) {
  const leaks = findLeaks(text, pii);
  if (leaks.length) throw new PiiLeakError(leaks);
}

export class PiiLeakError extends Error {
  constructor(public leaks: string[]) {
    super(`PII assertion failed: ${leaks.join("; ")}`);
  }
}
