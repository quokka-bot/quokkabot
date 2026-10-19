import { defineConfig } from "astro/config";

// Static site for quokkabot.com: plain HTML and CSS, no client JavaScript, no third-party requests.
// Pages build to /privacy.html and are served at /privacy (Cloudflare Pages drops the extension).
export default defineConfig({
  site: "https://quokkabot.com",
  trailingSlash: "never",
  build: { format: "file", inlineStylesheets: "never" },
  devToolbar: { enabled: false },
});
