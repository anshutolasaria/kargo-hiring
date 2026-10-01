// {{NAME}} placeholder <-> real name. Real names only ever come from candidate_pii, server side.
export const NAME_TOKEN = "{{NAME}}";
export const fillName = (text: string | null, name: string) => (text ?? "").split(NAME_TOKEN).join(name);
export const unfillName = (text: string, name: string) => (name ? text.split(name).join(NAME_TOKEN) : text);
