import "server-only";
import { db } from "./supabase";
import type { Criterion } from "./rubric";

export async function loadCriteria(): Promise<Criterion[]> {
  const { data, error } = await db().from("rubric_criteria").select("role,name,description,weight").order("id");
  if (error) throw error;
  if (!data?.length) throw new Error("rubric_criteria is empty — run `npm run seed` first");
  return data as Criterion[];
}
