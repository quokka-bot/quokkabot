// Fails when a pull request description lacks the Harness, Model and Effort lines (CONTRIBUTING.md, "Agents").
// Usage: PR_BODY="$(cat body.md)" node scripts/check-pr-description.mjs
const body = process.env.PR_BODY ?? "";
const fields = ["Harness", "Model", "Effort"];
const missing = fields.filter((field) => {
  const line = body.split(/\r?\n/).find((text) => new RegExp(`^${field}:`, "i").test(text.trim()));
  const value = line?.trim().slice(field.length + 1).trim() ?? "";
  return value === "";
});
if (missing.length > 0) {
  console.error(`The PR description needs these lines filled in: ${missing.map((field) => `${field}:`).join(", ")}`);
  console.error("Name the tool, the model id and the reasoning effort that wrote the change, or none for each when a person wrote it.");
  process.exit(1);
}
console.log("check-pr-description: Harness, Model and Effort are filled in");
