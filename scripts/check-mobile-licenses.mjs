// Checks the licences of what the iPhone app ships: every npm package with code in the app's JavaScript bundle (read
// from the bundle's source map) and, after `expo prebuild`, every CocoaPod in apps/mobile/ios/Podfile.lock. Fails on
// GPL, AGPL, LGPL or SSPL code (an "X OR GPL" choice passes when X is permissive) and on any package whose licence it
// cannot read. Build tools (Metro, Babel, the Expo CLI) never reach the app and are not checked.
//
//   node scripts/check-mobile-licenses.mjs <expo export dir>
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyleftFree } from "./licence-expression.mjs";
import { podLicences } from "./pod-licences.mjs";

const COPYLEFT = /\b(A?GPL|LGPL|SSPL)/i;
// Metro writes source paths relative to its server root, the workspace.
const workspace = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exportDir = resolve(process.argv[2] ?? "apps/mobile/dist");
const mapsDir = join(exportDir, "_expo/static/js/ios");
const maps = existsSync(mapsDir) ? readdirSync(mapsDir).filter((file) => file.endsWith(".map")) : [];
if (maps.length === 0) throw new Error(`No source map in ${mapsDir}: run expo export with --dump-sourcemap first`);

// A licence expression passes when some way of meeting it uses no copyleft licence.
function allowed(expression) {
  return copyleftFree(expression, (licence) => COPYLEFT.test(licence));
}

const packages = new Map();
for (const map of maps) {
  const { sources } = JSON.parse(readFileSync(join(mapsDir, map), "utf8"));
  for (const source of sources) {
    const at = source.lastIndexOf("node_modules/");
    if (at === -1) continue;
    const rest = source.slice(at + "node_modules/".length).split("/");
    const name = rest[0]?.startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
    if (!name || name === ".pnpm") continue;
    const prefix = source.slice(0, at + "node_modules/".length);
    const root = existsSync(prefix) ? prefix + name : join(workspace, prefix, name);
    if (!packages.has(name)) packages.set(name, root);
  }
}

const problems = [];
const licences = new Map();
for (const [name, root] of packages) {
  const manifest = join(root, "package.json");
  if (!existsSync(manifest)) { problems.push(`${name}: no package.json at ${root}`); continue; }
  const data = JSON.parse(readFileSync(manifest, "utf8"));
  const licence = typeof data.license === "string" ? data.license : typeof data.license?.type === "string" ? data.license.type : null;
  if (licence === null || licence === "UNLICENSED") { problems.push(`${name}@${data.version}: no licence in package.json`); continue; }
  if (!allowed(licence)) problems.push(`${name}@${data.version}: ${licence}`);
  licences.set(licence, (licences.get(licence) ?? 0) + 1);
}

// The native side: CocoaPods resolved by prebuild. Each pod's licence is read from its podspec in the Pods folder.
// Paths start at the workspace: `pnpm build` runs this from apps/mobile. After a prebuild the lockfile must be there.
const ios = join(workspace, "apps/mobile/ios");
const lock = join(ios, "Podfile.lock");
let pods = 0;
if (existsSync(ios) && !existsSync(lock)) problems.push(`no Podfile.lock in ${ios}: run pod install, or remove the folder`);
if (existsSync(lock)) {
  const specs = join(ios, "Pods/Local Podspecs");
  const readSpec = (name) => {
    const spec = join(specs, `${name}.podspec.json`);
    return existsSync(spec) ? JSON.parse(readFileSync(spec, "utf8")) : null;
  };
  const result = podLicences(readFileSync(lock, "utf8"), readSpec, allowed);
  pods = result.pods;
  problems.push(...result.problems);
}

const summary = [...licences].sort((a, b) => b[1] - a[1]).map(([licence, count]) => `${licence} ${count}`).join(", ");
console.log(`check-mobile-licenses: ${packages.size} packages in the app bundle (${summary})${pods ? `, ${pods} pods` : ""}`);
if (problems.length > 0) {
  console.error(`Not allowed in the App Store build:\n${problems.join("\n")}`);
  process.exit(1);
}
