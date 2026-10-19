import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "supervisor", include: ["test/**/*.test.ts"] } });
