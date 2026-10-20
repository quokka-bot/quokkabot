import { AGENT_COLOURS, AGENT_SHAPES, type AgentColour, type AgentLook, type AgentShape } from "@quokkabot/shared";

// The agent avatars the web and iPhone apps draw: a soft body with two white eyes, in a 64 x 64 box. Each app renders
// these numbers with its own SVG; nothing here touches the DOM.

export interface ShapeGeometry {
  // The body outline, drawn upright.
  body: string;
  // The point between the eyes, and the distance between their centres.
  eyeX: number;
  eyeY: number;
  eyeGap: number;
  // Degrees the whole face leans at rest, around the box centre.
  tilt: number;
}

export const SHAPE_GEOMETRY: Record<AgentShape, ShapeGeometry> = {
  // The original Quokka Bot blob: slot 1 and the product mark look as they always have.
  blob: { body: "M10 30c0-13 10-22 24-22 13 0 22 8 22 19 0 14-11 27-27 27C17 54 10 44 10 30z", eyeX: 33.7, eyeY: 26.2, eyeGap: 11.2, tilt: -12 },
  ghost: { body: "M12 30C12.9 25.2 13.7 18.5 17 15C20.3 11.5 27 9 32 9C37 9 43.7 11.5 47 15C50.3 18.5 51.1 25.2 52 30C52.9 34.8 52.8 40.2 52.3 44C51.8 47.8 50.7 52.1 49 53C47.3 53.9 44 49.3 42 49.5C40 49.7 38.7 53.9 37 54C35.3 54.1 33.7 50 32 50C30.3 50 28.7 54.1 27 54C25.3 53.9 24 49.7 22 49.5C20 49.3 16.7 53.9 15 53C13.3 52.1 12.2 47.8 11.7 44C11.2 40.2 11.1 34.8 12 30Z", eyeX: 32, eyeY: 29, eyeGap: 11, tilt: 0 },
  squircle: { body: "M32 11c16.5 0 21 4.5 21 21s-4.5 22-21 22-21-5.5-21-22 4.5-21 21-21z", eyeX: 32, eyeY: 30, eyeGap: 11, tilt: -6 },
  pebble: { body: "M7.5 35a24.5 17.5 0 1 0 49 0a24.5 17.5 0 1 0-49 0z", eyeX: 32, eyeY: 31, eyeGap: 11, tilt: -4 },
  cloud: { body: "M17 49a8.5 8.5 0 0 1-3.6-16.2A10 10 0 0 1 24 19.6a11 11 0 0 1 19.6 2.6A9.5 9.5 0 0 1 50 38.7 6 6 0 0 1 47 49z", eyeX: 32, eyeY: 34, eyeGap: 11, tilt: 4 },
  scallop: { body: "M38.7 14.7A5 5 0 0 1 48.9 23.3A5 5 0 0 1 51.2 36.4A5 5 0 0 1 44.5 47.9A5 5 0 0 1 32 52.5A5 5 0 0 1 19.5 47.9A5 5 0 0 1 12.8 36.4A5 5 0 0 1 15.1 23.3A5 5 0 0 1 25.3 14.7A5 5 0 0 1 38.7 14.7Z", eyeX: 32, eyeY: 30.5, eyeGap: 11, tilt: -8 },
  egg: { body: "M32 9C36.3 9 41.9 13.7 45 18C48.1 22.3 50.8 29.5 50.5 35C50.3 40.5 46.6 47.5 43.5 51C40.4 54.5 35.8 56 32 56C28.2 56 23.6 54.5 20.5 51C17.4 47.5 13.8 40.5 13.5 35C13.3 29.5 15.9 22.3 19 18C22.1 13.7 27.7 9 32 9Z", eyeX: 32, eyeY: 29, eyeGap: 10, tilt: 7 },
  drop: { body: "M32 9C34.7 9 36.7 15.8 40 20C43.3 24.2 50.7 29.2 52 34C53.3 38.8 51.3 45.3 48 49C44.7 52.7 37.3 56 32 56C26.7 56 19.3 52.7 16 49C12.7 45.3 10.7 38.8 12 34C13.3 29.2 20.7 24.2 24 20C27.3 15.8 29.3 9 32 9Z", eyeX: 32, eyeY: 37, eyeGap: 10, tilt: 10 },
  gumdrop: { body: "M32 11C35.3 11 38.7 15.2 42 20C45.3 24.8 51.3 34.7 52 40C52.7 45.3 49.3 49.7 46 52C42.7 54.3 36.7 54 32 54C27.3 54 21.3 54.3 18 52C14.7 49.7 11.3 45.3 12 40C12.7 34.7 18.7 24.8 22 20C25.3 15.2 28.7 11 32 11Z", eyeX: 32, eyeY: 36, eyeGap: 10.5, tilt: -5 },
  capsule: { body: "M19 23.5a13 13 0 0 1 26 0v17a13 13 0 0 1-26 0z", eyeX: 32, eyeY: 27, eyeGap: 10, tilt: 9 },
};

// Every colour keeps white eyes at 3:1 contrast or more. The first eight are the colours slots 1 to 8 always had
// (orange and sky one step darker for that contrast).
export const COLOUR_HEX: Record<AgentColour, string> = {
  violet: "#8b5cf6", red: "#ef4444", pink: "#ec4899", brown: "#a16207", grey: "#6b7280",
  ink: "#111827", orange: "#ea580c", sky: "#0284c7", green: "#16a34a", teal: "#0d9488",
};

export const EYE_RADIUS = { x: 3.2, y: 5 } as const;

// The sign-in screens' mark. It never moves.
export const PRODUCT_MARK: AgentLook = { shape: "blob", colour: "violet" };

// Slot n gets shape n and a colour that steps one further every ten slots, so slots 1 to 100 all differ.
export function slotLook(index: number): AgentLook {
  if (!Number.isInteger(index) || index < 1) throw new Error(`Agent slot must be a positive integer, got ${index}`);
  const position = index - 1;
  const shape = AGENT_SHAPES[position % AGENT_SHAPES.length];
  const colour = AGENT_COLOURS[(position + Math.floor(position / AGENT_SHAPES.length)) % AGENT_COLOURS.length];
  if (!shape || !colour) throw new Error(`No look for slot ${index}`);
  return { shape, colour };
}

// The owner's pick when there is one, otherwise the slot's look. The name never plays a part, so renaming keeps it.
export function agentLook(agent: { index: number; look: AgentLook | null }): AgentLook {
  return agent.look ?? slotLook(agent.index);
}

export function eyeCentres(geometry: ShapeGeometry): { left: { x: number; y: number }; right: { x: number; y: number } } {
  const half = geometry.eyeGap / 2;
  return { left: { x: geometry.eyeX - half, y: geometry.eyeY }, right: { x: geometry.eyeX + half, y: geometry.eyeY } };
}

// The lopsided smirk under the eyes, rising to the right.
export function smirkPath(geometry: ShapeGeometry): string {
  const { left } = eyeCentres(geometry);
  return `M${left.x + 0.3} ${geometry.eyeY + 10.5}q${geometry.eyeGap / 2} 3 ${geometry.eyeGap + 1.8} -1.8`;
}

// Motion in the iPhone app, matching apps/web/src/style.css ("Agent avatars"). Distances are in the 64-unit box.
export const AVATAR_MOTION = {
  // While working: one slow breath, up and slightly larger, then back.
  breatheMs: 4000,
  breatheLift: 1.2,
  breatheScale: 1.025,
  // While working with motion reduced: the eyes rest looking down at the work.
  workingGaze: { x: -2.4, y: 0.6 },
} as const;
