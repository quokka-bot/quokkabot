// @ts-check
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
const workspace = path.resolve(__dirname, "../..");
// The workspace packages are TypeScript sources with NodeNext imports: "./api.js" names "./api.ts". Metro reads the
// source (their "react-native" export condition) and maps those imports.
const sources = ["packages/shared/src", "packages/client/src"].map((dir) => path.join(workspace, dir) + path.sep);

config.watchFolders = [...new Set([...(config.watchFolders ?? []), workspace])];
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js") && sources.some((dir) => context.originModulePath.startsWith(dir))) {
    return context.resolveRequest(context, `${moduleName.slice(0, -3)}.ts`, platform);
  }
  // Node-only code (node:crypto, the Public Suffix List) never belongs in the app.
  if (moduleName === "@quokkabot/shared/node") throw new Error(`${context.originModulePath} imports @quokkabot/shared/node, which is for the server only`);
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
