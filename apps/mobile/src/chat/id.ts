// Idempotency only, never a token or secret. Hermes uses randomUUID when present; older runtimes use UUID v4 shape.
export function draftId(
  source: { randomUUID?: () => string } | undefined = globalThis.crypto,
  random: () => number = Math.random,
): string {
  if (source?.randomUUID) return source.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (letter) => {
    const value = Math.floor(random() * 16);
    return (letter === "x" ? value : (value & 3) | 8).toString(16);
  });
}
