import { build } from "esbuild";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const release = Boolean(process.env.QUOKKABOT_MAC_IDENTITY);
const e2e = process.env.QUOKKABOT_E2E_BUILD === "1";
if (release && e2e) throw new Error("Test hooks must never be included in a signed release.");
if (process.env.QUOKKABOT_MAC_IDENTITY === "-") throw new Error("Ad-hoc signing is not a Quokka Bot release.");
if (process.env.QUOKKABOT_RELEASE === "1" && !release) throw new Error("A release requires QUOKKABOT_MAC_IDENTITY.");
await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(join(root, "dist"), { recursive: true });
for (const name of ["main", "preload", "connect-preload"]) {
  await build({
    entryPoints: [join(root, `src/${name}.ts`)], outfile: join(root, `dist/${name}.cjs`),
    bundle: true, format: "cjs", platform: "node", target: "node24", external: ["electron"],
    conditions: ["development"], sourcemap: !release, minifySyntax: true, logLevel: "info",
    define: { __QUOKKABOT_APP_VERSION__: JSON.stringify(pkg.version), __QUOKKABOT_RELEASE__: String(release), __QUOKKABOT_E2E__: String(e2e) },
  });
}
for (const name of ["connect.html", "connect.js", "connect.css"]) await copyFile(join(root, "src", name), join(root, "dist", name));
// Bundled dependency comments and source maps follow the repository's text policy too.
for (const name of ["main.cjs", "main.cjs.map", "preload.cjs", "preload.cjs.map", "connect-preload.cjs", "connect-preload.cjs.map"]) {
  if (release && name.endsWith(".map")) continue;
  const path = join(root, "dist", name);
  await writeFile(path, (await readFile(path, "utf8")).replaceAll(String.fromCodePoint(0x2014), "–"));
}
