// Renders the app icon (icns and png) and the menu-bar template icons from build/*.svg. Run after editing the SVGs.
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const build = fileURLToPath(new URL("../build/", import.meta.url));
const iconset = join(build, "icon.iconset");
rmSync(iconset, { recursive: true, force: true });
mkdirSync(iconset);
for (const size of [16, 32, 64, 128, 256, 512, 1024]) {
  const png = sharp(join(build, "icon.svg"), { density: 300 }).resize(size, size);
  if (size <= 512) await png.clone().toFile(join(iconset, `icon_${size}x${size}.png`));
  if (size >= 32) await png.clone().toFile(join(iconset, `icon_${size / 2}x${size / 2}@2x.png`));
}
await sharp(join(build, "icon.svg"), { density: 300 }).resize(1024, 1024).toFile(join(build, "icon.png"));
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(build, "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });
// Menu-bar icons are "template" images: black on transparent; macOS recolours them for light and dark menu bars.
await sharp(join(build, "tray.svg"), { density: 300 }).resize(16, 16).toFile(join(build, "trayTemplate.png"));
await sharp(join(build, "tray.svg"), { density: 300 }).resize(32, 32).toFile(join(build, "trayTemplate@2x.png"));
console.log("icons written to", build);
