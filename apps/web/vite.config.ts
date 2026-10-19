import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// version.json names the entry chunk of this build. Its file name carries a content hash, so an open window compares it
// with its own entry to notice that the server has a newer app.
function versionFile(): Plugin {
  return {
    name: "quokkabot-version-file",
    apply: "build",
    generateBundle(_options, bundle) {
      const entries = Object.values(bundle).filter(file => file.type === "chunk" && file.isEntry);
      const entry = entries[0];
      if (entries.length !== 1 || !entry) throw new Error(`Expected one entry chunk, found ${entries.length}`);
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ entry: entry.fileName })}\n` });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionFile()],
  resolve: {
    alias: {
      "@quokkabot/client": fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)),
      "@quokkabot/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  // Every asset is a file: the CSP allows fonts and images from this origin only, never data: URLs.
  build: { target: "es2024", assetsInlineLimit: 0 },
});
