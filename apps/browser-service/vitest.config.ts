import { defineProject } from "vitest/config";

// Several tests spawn the fake agent-browser once per operation (about 25 processes); 5 s is too tight under a
// full parallel run.
export default defineProject({ test: { name: "browser-service", include: ["test/**/*.test.ts"], testTimeout: 20_000 } });
