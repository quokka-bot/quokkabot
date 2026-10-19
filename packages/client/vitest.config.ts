import { defineProject } from "vitest/config";

export default defineProject({
  resolve: { conditions: ["development"] },
  test: { name: "client", include: ["test/**/*.test.ts"] },
});
