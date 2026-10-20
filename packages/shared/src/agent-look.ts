import { z } from "zod";

// An agent's look: a body shape and a colour, each from a closed set. The owner may pick one in Agent settings; without
// a pick, the apps derive it from the agent's slot (packages/client/src/avatar.ts). The order of both lists is part of
// that derivation: append new entries, never reorder or remove one, or existing agents change their look.
export const AGENT_SHAPES = ["blob", "ghost", "squircle", "pebble", "cloud", "scallop", "egg", "drop", "gumdrop", "capsule"] as const;
export const AGENT_COLOURS = ["violet", "red", "pink", "brown", "grey", "ink", "orange", "sky", "green", "teal"] as const;

export const AgentShape = z.enum(AGENT_SHAPES);
export type AgentShape = z.infer<typeof AgentShape>;
export const AgentColour = z.enum(AGENT_COLOURS);
export type AgentColour = z.infer<typeof AgentColour>;
export const AgentLook = z.object({ shape: AgentShape, colour: AgentColour }).strict();
export type AgentLook = z.infer<typeof AgentLook>;
