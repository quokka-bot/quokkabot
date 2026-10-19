import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "desktop", include: ["test/**/*.test.ts"], exclude: ["test/e2e/**"] } });
