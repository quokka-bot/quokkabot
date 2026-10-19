import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: ".", testMatch: "*.spec.ts", workers: 1, retries: 0, timeout: 30000,
  reporter: "list", outputDir: "../../test-results",
});
