import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "egress", include: ["test/**/*.test.ts"] } });
