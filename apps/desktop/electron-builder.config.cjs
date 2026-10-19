const identity = process.env.QUOKKABOT_MAC_IDENTITY;
if (process.env.QUOKKABOT_E2E_BUILD === "1") throw new Error("Electron test builds cannot be packaged.");
const notarizationValues = [process.env.APPLE_API_KEY, process.env.APPLE_API_KEY_ID, process.env.APPLE_API_ISSUER];
if (identity === "-") throw new Error("Ad-hoc signing is not a Quokka Bot release. Set a Developer ID identity or leave it unset for development.");
if (process.env.QUOKKABOT_RELEASE === "1" && !identity) throw new Error("A release requires QUOKKABOT_MAC_IDENTITY.");
if (notarizationValues.some(Boolean) && !notarizationValues.every(Boolean)) throw new Error("Set all three App Store Connect API key variables for notarization.");
if (notarizationValues.every(Boolean) && !identity) throw new Error("Notarization requires a Developer ID signing identity.");
if (!identity) process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

module.exports = {
  productName: "Quokka Bot",
  appId: process.env.QUOKKABOT_BUNDLE_ID || "com.quokkabot.app",
  asar: true, forceCodeSigning: Boolean(identity),
  directories: { output: "release", buildResources: "build" },
  files: ["dist/**", "build/icon.png", "build/trayTemplate*.png", "build/PUBLIC-SUFFIX-NOTICE.txt", "package.json"],
  artifactName: identity ? "QuokkaBot-${version}-${arch}.${ext}" : "QuokkaBot-${version}-unsigned-development-${arch}.${ext}",
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }],
    category: "public.app-category.productivity", icon: "build/icon.icns",
    hardenedRuntime: true, entitlements: "build/entitlements.mac.plist", entitlementsInherit: "build/entitlements.mac.plist",
    identity: identity || null, notarize: notarizationValues.every(Boolean),
  },
  // electron-builder applies fuses before signing. Packaged apps can only execute their integrity-checked asar.
  electronFuses: {
    runAsNode: false, enableNodeOptionsEnvironmentVariable: false, enableNodeCliInspectArguments: false,
    enableCookieEncryption: true, enableEmbeddedAsarIntegrityValidation: true, onlyLoadAppFromAsar: true,
  },
  // A reserved, unreachable bootstrap address: main always replaces it with the validated server's feed.
  publish: { provider: "generic", url: "https://configure-at-runtime.invalid/desktop/" },
};
