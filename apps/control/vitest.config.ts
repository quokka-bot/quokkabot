import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "control", include: ["test/**/*.test.ts"] } });
