import { defineProject } from "vitest/config";

// The app's plain TypeScript (API client, sign-in flows, streams) runs under Node; screens are checked on the
// simulator and the phone.
export default defineProject({ test: { name: "mobile", environment: "node", include: ["test/**/*.test.ts"] } });
