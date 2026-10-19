// The web app's palette (apps/web/src/style.css), so the phone and the browser look like one product.
export const colors = {
  background: "#FCFCFC",
  sidebar: "#F5F5F5",
  card: "#FFFFFF",
  line: "#E6E6E6",
  text: "#1C1C1C",
  textSoft: "#4B4B4B",
  muted: "#8A8A8A",
  bubble: "#EFEFEF",
  purple: "#7442D1",
  accent: "#8351E4",
  green: "#1F9D55",
  red: "#D93025",
  amber: "#B06D00",
} as const;

// The agent avatars' colours, in slot order (apps/web/src/avatar.tsx).
const COLOURS = ["#8b5cf6", "#ef4444", "#ec4899", "#a16207", "#6b7280", "#111827", "#f97316", "#0ea5e9"];
export function agentColour(index: number): string {
  return COLOURS[index - 1] ?? `hsl(${(index * 137.508) % 360}, 60%, 45%)`;
}
