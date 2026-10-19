// Fails when a pull request description does not end with the Harness, Model and Effort lines (CONTRIBUTING.md,
// "Agents"). Only the last three lines count, so an example earlier in the text, fenced or not, never passes.
// Usage: PR_BODY="$(cat body.md)" node scripts/check-pr-description.mjs
const fields = ["Harness", "Model", "Effort"];
const summaryStart = "<!-- This is an auto-generated comment: release notes by coderabbit.ai -->";
const summaryEnd = "<!-- end of auto-generated comment: release notes by coderabbit.ai -->";
let body = process.env.PR_BODY ?? "";
// CodeRabbit appends its summary to the description between these two markers; the author's text is the rest.
const start = body.indexOf(summaryStart);
if (start !== -1) {
  const end = body.indexOf(summaryEnd, start);
  body = body.slice(0, start) + (end === -1 ? "" : body.slice(end + summaryEnd.length));
}
const last = body.split(/\r?\n/).map((line) => line.trim())
  // Blank lines and one-line HTML comments are not part of the text.
  .filter((line) => line !== "" && !(line.startsWith("<!--") && line.endsWith("-->")))
  .slice(-fields.length);
const missing = fields.filter((field, index) => !new RegExp(`^${field}:\\s*\\S`, "i").test(last[index] ?? ""));
if (missing.length > 0) {
  console.error(`The PR description must end with these lines, filled in and in this order: ${fields.map((field) => `${field}:`).join(", ")}`);
  console.error(`Missing or out of place: ${missing.map((field) => `${field}:`).join(", ")}`);
  console.error("Name the tool, the model id and the reasoning effort that wrote the change, or none for each when a person wrote it.");
  process.exit(1);
}
console.log("check-pr-description: the description ends with Harness, Model and Effort");
