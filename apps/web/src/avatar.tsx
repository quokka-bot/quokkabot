// Agent avatars: a soft blob with two eyes, one colour per agent. Drawn here; no image files.
const COLOURS = ["#8b5cf6", "#ef4444", "#ec4899", "#a16207", "#6b7280", "#111827", "#f97316", "#0ea5e9"];

export function agentColour(index: number): string {
  return COLOURS[index - 1] ?? `hsl(${(index * 137.508) % 360} 60% 45%)`;
}

export function AgentAvatar({ index, size = 36 }: { index: number; size?: number }) {
  const colour = agentColour(index);
  return <svg className="agent-avatar" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
    <path fill={colour} d="M10 30c0-13 10-22 24-22 13 0 22 8 22 19 0 14-11 27-27 27C17 54 10 44 10 30z" transform="rotate(-12 32 32)" />
    <ellipse cx="27" cy="27" rx="3.2" ry="5" fill="#fff" transform="rotate(-12 27 27)" />
    <ellipse cx="38" cy="25" rx="3.2" ry="5" fill="#fff" transform="rotate(-12 38 25)" />
  </svg>;
}
