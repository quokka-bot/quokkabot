// The CocoaPods in a Podfile.lock, each with the licence from its podspec (`readSpec` returns the parsed podspec, or
// null when there is none). A pod whose podspec or licence cannot be read is a problem, as an npm package without a
// licence is: an unread licence never passes.
export function podLicences(lockText, readSpec, allowed) {
  const names = new Set();
  for (const line of lockText.split("\n")) {
    const match = /^ {2}- ([A-Za-z0-9_+.-]+)(?:\/[^ ]+)? \(/.exec(line);
    if (match) names.add(match[1]);
  }
  const problems = [];
  for (const name of names) {
    const spec = readSpec(name);
    if (spec === null) { problems.push(`pod ${name}: no podspec`); continue; }
    const licence = typeof spec.license === "string" ? spec.license : spec.license?.type;
    if (typeof licence !== "string" || licence.trim() === "") { problems.push(`pod ${name}: no licence in its podspec`); continue; }
    if (!allowed(licence)) problems.push(`pod ${name}: ${licence}`);
  }
  return { pods: names.size, problems };
}
