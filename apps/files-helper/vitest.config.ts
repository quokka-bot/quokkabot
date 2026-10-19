import { defineProject } from "vitest/config";

export default defineProject({ test: { name: "files-helper", include: ["test/**/*.test.ts"] } });
