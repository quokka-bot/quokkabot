// Fails when a pull request description does not end with the Harness, Model and Effort lines (CONTRIBUTING.md,
// "Agents"). Only the last three lines count, so an example earlier in the text, fenced or not, never passes.
// Usage: PR_BODY="$(cat body.md)" node scripts/check-pr-description.mjs
const fields = ["Harness", "Model", "Effort"];
const summaryStart = "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->";
const summaryEnd = "<!-- end of auto-generated comment: release notes by coderabbit.ai -->";
let body = process.env.PR_BODY ?? "";
// CodeRabbit appends its summary to the description between these two markers; the author's text is the rest. Without
// the end marker nothing is cut.
const start = body.indexOf(summaryStart);
const end = start === -1 ? -1 : body.indexOf(summaryEnd, start);
if (end !== -1) body = body.slice(0, start) + body.slice(end + summaryEnd.length);
// The text as it shows on the page: no blank lines, and no line inside an HTML comment, one line or several. A line
// that opens a comment is dropped whole.
const shown = [];
let inComment = false;
for (const raw of body.split(/\r?\n/)) {
  const line = raw.trim();
  if (inComment) {
    if (line.includes("-->")) inComment = false;
  } else if (line.startsWith("<!--")) {
    inComment = !line.includes("-->", 4);
  } else if (line !== "") {
    shown.push(line);
  }
}
const last = shown.slice(-fields.length);
const missing = fields.filter((field, index) => !new RegExp(`^${field}:\\s*\\S`, "i").test(last[index] ?? ""));
if (missing.length > 0) {
  console.error(`The PR description must end with these lines, filled in and in this order: ${fields.map((field) => `${field}:`).join(", ")}`);
  console.error(`Missing or out of place: ${missing.map((field) => `${field}:`).join(", ")}`);
  console.error("Name the tool, the model id and the reasoning effort that wrote the change, or none for each when a person wrote it.");
  process.exit(1);
}
console.log("check-pr-description: the description ends with Harness, Model and Effort");
