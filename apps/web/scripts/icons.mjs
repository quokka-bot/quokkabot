// Renders the PNG icons in public/ from the SVG sources in src/icons. Run after changing an icon: node scripts/icons.mjs
import { readFile } from "node:fs/promises";
import sharp from "sharp";

const root = new URL("..", import.meta.url);
const mac = await readFile(new URL("src/icons/icon-mac.svg", root));
const ios = await readFile(new URL("src/icons/icon-ios.svg", root));
const outputs = [
  // The macOS icon has transparent corners; crop to its rounded square for the favicon and the manifest icons.
  { svg: mac, size: 192, file: "public/icon-192.png", crop: true },
  { svg: mac, size: 512, file: "public/icon-512.png", crop: true },
  // iOS rounds the corners itself, so the touch icon is full-bleed.
  { svg: ios, size: 180, file: "public/apple-touch-icon.png", crop: false },
];
for (const { svg, size, file, crop } of outputs) {
  let image = sharp(svg, { density: 300 });
  if (crop) image = image.extract({ left: 417, top: 417, width: 3433, height: 3433 });
  await image.resize(size, size).png({ compressionLevel: 9 }).toFile(new URL(file, root).pathname);
  console.log(file);
}
