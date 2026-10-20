import { AccessibilityInfo } from "react-native";

// iOS Reduce Motion, read once for the whole app and kept current. Until iOS answers, it counts as on: nothing moves
// before the app knows it may.
let reduceMotion = true;
let watching = false;
const listeners = new Set<() => void>();

function update(value: boolean) {
  reduceMotion = value;
  for (const listener of listeners) listener();
}

export function subscribeReduceMotion(listener: () => void): () => void {
  if (!watching) {
    watching = true;
    AccessibilityInfo.addEventListener("reduceMotionChanged", update);
    void AccessibilityInfo.isReduceMotionEnabled().then(update);
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function reduceMotionNow(): boolean {
  return reduceMotion;
}
