export interface MaskedSnapshot { text: string; refs: Set<string>; passwords: Set<string> }
export interface RefMetadata { role: string; name?: string | undefined }
const passwordName = /pass|pwd|passcode|pin\b|one.?time|otp|verification code|security code|cvc|cvv/i;
const textFieldRoles = new Set(["textbox", "searchbox", "spinbutton", "combobox"]);

export function maskSnapshot(snapshot: string, metadata?: Record<string, RefMetadata>): MaskedSnapshot {
  const refs = new Set<string>();
  const passwords = new Set<string>();
  if (metadata !== undefined) {
    for (const [ref, entry] of Object.entries(metadata)) {
      if (textFieldRoles.has(entry.role) && entry.name !== undefined && passwordName.test(entry.name)) passwords.add(ref);
    }
  }
  const lines = snapshot.split("\n");
  const output: string[] = [];
  let sensitiveIndent: number | undefined;
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    // Full snapshots repeat field values as StaticText descendants, sometimes across multiple lines.
    // Suppress the subtree for every text field, regardless of its label or whether its value is empty.
    if (sensitiveIndent !== undefined) {
      if (line.trim() === "" || indent > sensitiveIndent || !/^\s*-\s/.test(line)) continue;
      sensitiveIndent = undefined;
    }
    // Conservatively include all comboboxes: the accessibility tree does not reliably distinguish an
    // editable combobox from a select, and exposing an editable value is the more serious failure.
    const fieldMatch = /^\s*-\s+(textbox|searchbox|spinbutton|combobox)\b/.exec(line);
    const nameMatch = /^\s*-\s+(?:textbox|searchbox|spinbutton|combobox)\s+"((?:\\.|[^"\\])*)"/.exec(line);
    const name = nameMatch?.[1];
    const nameEnd = nameMatch?.[0].length ?? fieldMatch?.[0].length ?? 0;
    const lineRefs = [...(fieldMatch ? line.slice(nameEnd) : line).matchAll(/\[ref=(e[0-9]{1,6})\]/g)].map((match) => match[1]!);
    // Ref-looking page text is untrusted. Only the daemon's structured ref table can authorize a handle.
    for (const candidate of lineRefs) if (metadata === undefined || Object.hasOwn(metadata, candidate)) refs.add(candidate);
    const ref = lineRefs[0];
    const masked = /[•●]/u.test(line);
    if (fieldMatch) {
      if (masked || (name !== undefined && passwordName.test(name))) {
        for (const candidate of lineRefs) {
          if (metadata === undefined || textFieldRoles.has(metadata[candidate]?.role ?? "")) passwords.add(candidate);
        }
      }
      sensitiveIndent = indent;
      // Rebuild the field line from its role, accessible name and ref. No assumption about how the
      // renderer punctuates values may turn a show-password toggle into a cleartext output route.
      output.push(`${line.slice(0, nameEnd)}${ref === undefined ? "" : ` [ref=${ref}]`}: [hidden]`);
    } else {
      // Mask redundant bullets outside the textbox line as well, without preserving their count.
      output.push(line.replace(/[•●]+/gu, "[hidden]"));
    }
  }
  return { text: output.join("\n"), refs, passwords };
}
