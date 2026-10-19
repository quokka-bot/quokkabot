import * as Device from "expo-device";
import Constants from "expo-constants";

// How this phone appears in the server's list of signed-in devices.
export function deviceName(): string {
  return (Device.deviceName ?? Device.modelName ?? "iPhone").slice(0, 80);
}

// The domain built into this build for native passkeys (app.config.ts).
export function passkeyDomain(): string {
  const domain = (Constants.expoConfig?.extra as { passkeyDomain?: unknown } | undefined)?.passkeyDomain;
  if (typeof domain !== "string") throw new Error("This build has no passkey domain");
  return domain;
}

export const SUPPORT_URL = "https://quokkabot.com/support";
export const SUPPORT_EMAIL = "support@quokkabot.com";
export const PRIVACY_URL = "https://quokkabot.com/privacy";
