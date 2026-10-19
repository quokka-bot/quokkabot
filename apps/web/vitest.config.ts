import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@quokkabot/client": fileURLToPath(new URL("../../packages/client/src/index.ts", import.meta.url)),
      "@quokkabot/shared": fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "web",
    environment: "jsdom",
    include: ["test/**/*.test.tsx", "test/**/*.test.ts"],
    setupFiles: ["test/setup.ts"],
    restoreMocks: true,
  },
});
