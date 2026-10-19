import * as SecureStore from "expo-secure-store";
import { File, Paths } from "expo-file-system";
import { z } from "zod";

// The server this phone is signed in to and its session token. In the Keychain, readable only while the phone is
// unlocked and never leaving this device: not in backups, not synced to another phone. A replacement phone signs in
// again (a synced passkey, a link or a code) and the old one is signed out from Settings, Signed-in devices.
export const Connection = z.object({
  origin: z.string().url(),
  viewOrigin: z.string().url(),
  token: z.string().min(32).max(100),
});
export type Connection = z.infer<typeof Connection>;

const KEY = "connection";
const OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };

// Keychain items outlive the app: deleting and installing it again would find the old session. The marker file lives
// in the app's own folder, which deletion removes, so a fresh install starts signed out.
export async function forgetIfReinstalled(): Promise<void> {
  const marker = new File(Paths.document, "installed");
  if (marker.exists) return;
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
  marker.create();
}

// A damaged entry is deleted and the phone starts signed out: the owner signs in again from the welcome screen.
export async function loadConnection(): Promise<Connection | null> {
  const stored = await SecureStore.getItemAsync(KEY, OPTIONS);
  if (stored === null) return null;
  let value: unknown;
  try { value = JSON.parse(stored); } catch { value = null; }
  const parsed = Connection.safeParse(value);
  if (parsed.success) return parsed.data;
  console.warn("The saved sign-in is damaged; signing out.");
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
  return null;
}

export async function saveConnection(connection: Connection): Promise<void> {
  await SecureStore.setItemAsync(KEY, JSON.stringify(Connection.parse(connection)), OPTIONS);
}

export async function clearConnection(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY, OPTIONS);
}
