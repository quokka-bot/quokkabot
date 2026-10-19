// Fails when tracked text contains an em dash (U+2014). House rule: use an en dash.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
  .split("\n")
  .filter((f) => f && !f.startsWith("private/") && /\.(ts|tsx|js|mjs|cjs|json|md|yaml|yml|sh|conf|html|css|Dockerfile)$|Dockerfile$/.test(f));

// Built from its code point so this file does not contain the character it looks for.
const EM_DASH = String.fromCharCode(0x2014);
const offenders = [];
for (const file of files) {
  const text = readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    if (line.includes(EM_DASH)) offenders.push(`${file}:${i + 1}`);
  });
}
if (offenders.length > 0) {
  console.error(`Em dash (U+2014) found; use an en dash (U+2013):\n${offenders.join("\n")}`);
  process.exit(1);
}
console.log(`check-text: ${files.length} files clean`);
