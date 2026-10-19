// @ts-check
const fs = require("node:fs");
const path = require("node:path");

// Expo's fingerprint covers native code only, so two app versions with the same native code would share a runtime
// version and an over-the-air update from one would reach the other. Hashing the app version keeps each version's
// updates on its own reviewed builds.
const appConfig = fs.readFileSync(path.join(__dirname, "app.config.ts"), "utf8");
const version = appConfig.match(/^ {2}version: "([0-9.]+)",$/m)?.[1];
if (!version) throw new Error("fingerprint.config.js could not read the app version from app.config.ts");

module.exports = {
  extraSources: [{ type: "contents", id: "appVersion", contents: version }],
};
