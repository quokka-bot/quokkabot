import type { ExpoConfig } from "expo/config";

// The iPhone app. APP_VARIANT picks the build: development (a dev client for the simulator), preview (an internal
// build) or production (TestFlight and the App Store). Each variant is its own app on the phone, with its own name,
// bundle id, URL scheme and Keychain.
type Variant = "development" | "preview" | "production";

const VARIANTS: Record<Variant, { name: string; bundleIdentifier: string; scheme: string }> = {
  development: { name: "Quokka Bot Dev", bundleIdentifier: "com.quokkabot.app.dev", scheme: "quokkabot-dev" },
  preview: { name: "Quokka Bot Preview", bundleIdentifier: "com.quokkabot.app.preview", scheme: "quokkabot-preview" },
  production: { name: "Quokka Bot", bundleIdentifier: "com.quokkabot.app", scheme: "quokkabot" },
};

const variantName = process.env.APP_VARIANT ?? "production";
if (!(variantName in VARIANTS)) throw new Error(`APP_VARIANT must be development, preview or production, not ${variantName}`);
const variant = VARIANTS[variantName as Variant];

// The hosted server whose domain is built into the app, so native passkeys work there. A copy of the app built for
// another domain sets QB_PASSKEY_DOMAIN (and that server lists the build in QUOKKABOT_APPLE_APP_IDS).
const passkeyDomain = process.env.QB_PASSKEY_DOMAIN ?? "app.quokkabot.com";
// The EAS project the builds and over-the-air updates belong to, from the environment so a copy of the app builds
// under its own account. Without it the app builds without updates (local builds, CI's bundle check).
const projectId = process.env.QB_EAS_PROJECT_ID;
const owner = process.env.QB_EXPO_OWNER;

const config: ExpoConfig = {
  name: variant.name,
  slug: "quokkabot",
  scheme: variant.scheme,
  version: "0.1.0",
  // Landscape too: the agent's computer is a wide screen, and a takeover is easier with all of it.
  orientation: "default",
  icon: "./assets/icon.png",
  userInterfaceStyle: "light",
  ios: {
    bundleIdentifier: variant.bundleIdentifier,
    supportsTablet: false,
    associatedDomains: [`webcredentials:${passkeyDomain}`],
    infoPlist: {
      // TLS and the system's own cryptography only (Keychain, passkeys): exempt from export documentation.
      ITSAppUsesNonExemptEncryption: false,
      NSCameraUsageDescription: "Scan the QR code your Quokka Bot server shows, to connect to it.",
    },
    // The app sends what the owner does only to the server they sign in to, which they run (or which runs for them);
    // the developer receives none of it, and the app has no analytics or tracking (quokkabot.com/privacy).
    privacyManifests: {
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
      // The app's own code reads UserDefaults only through Expo and React Native, whose manifests declare it.
      NSPrivacyAccessedAPITypes: [],
    },
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-web-browser",
    ["expo-camera", { cameraPermission: "Scan the QR code your Quokka Bot server shows, to connect to it.", microphonePermission: false, recordAudioAndroid: false }],
    ["expo-splash-screen", { image: "./assets/splash.png", imageWidth: 160, backgroundColor: "#1A2F7A" }],
  ],
  // Over-the-air updates reach only builds with the same native code and the same app version: a fix ships over
  // the air, a new feature ships in a reviewed build with a new version (fingerprint.config.js adds the version).
  runtimeVersion: { policy: "fingerprint" },
  ...(projectId ? { updates: { url: `https://u.expo.dev/${projectId}`, checkAutomatically: "ON_LOAD" as const } } : { updates: { enabled: false } }),
  ...(owner ? { owner } : {}),
  extra: {
    passkeyDomain,
    ...(projectId ? { eas: { projectId } } : {}),
  },
};

export default config;
