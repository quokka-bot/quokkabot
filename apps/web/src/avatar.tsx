import { agentLook, COLOUR_HEX, EYE_RADIUS, eyeCentres, PRODUCT_MARK, SHAPE_GEOMETRY, smirkPath } from "@quokkabot/client";
import { AGENT_COLOURS, AGENT_SHAPES, type AgentColour, type AgentLook, type AgentShape, type AgentSummary } from "@quokkabot/shared";

// Agent avatars: a soft body with two eyes, one shape and colour per agent (packages/client/src/avatar.ts). Drawn here;
// no image files. Still at rest; style.css ("Agent avatars") moves them on hover and while the agent works.

export function AvatarFace({ look, size = 36, working = false }: { look: AgentLook; size?: number; working?: boolean }) {
  const geometry = SHAPE_GEOMETRY[look.shape];
  const eyes = eyeCentres(geometry);
  return <svg className="agent-avatar" data-shape={look.shape} data-colour={look.colour} data-state={working ? "working" : "idle"}
    width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" focusable="false">
    <g className="avatar-breathe">
      <g transform={`rotate(${geometry.tilt} 32 32)`}>
        <g className="avatar-lean">
          <path className="avatar-body" fill={COLOUR_HEX[look.colour]} d={geometry.body} />
          <g className="avatar-gaze">
            <g className="avatar-glance">
              <g className="avatar-eye avatar-eye-left"><ellipse className="avatar-blink" cx={eyes.left.x} cy={eyes.left.y} rx={EYE_RADIUS.x} ry={EYE_RADIUS.y} fill="#fff" /></g>
              <g className="avatar-eye avatar-eye-right"><ellipse className="avatar-blink" cx={eyes.right.x} cy={eyes.right.y} rx={EYE_RADIUS.x} ry={EYE_RADIUS.y} fill="#fff" /></g>
              <path className="avatar-mouth" d={smirkPath(geometry)} fill="none" stroke="#fff" strokeWidth={2.3} strokeLinecap="round" />
            </g>
          </g>
        </g>
      </g>
    </g>
  </svg>;
}

export function AgentAvatar({ agent, size = 36, working }: { agent: Pick<AgentSummary, "index" | "look">; size?: number; working: boolean }) {
  return <AvatarFace look={agentLook(agent)} size={size} working={working} />;
}

export function ProductMark({ size }: { size: number }) {
  return <AvatarFace look={PRODUCT_MARK} size={size} />;
}

const SHAPE_NAMES: Record<AgentShape, string> = {
  blob: "Blob", ghost: "Ghost", squircle: "Squircle", pebble: "Pebble", cloud: "Cloud",
  scallop: "Scallop", egg: "Egg", drop: "Drop", gumdrop: "Gumdrop", capsule: "Capsule",
};
const COLOUR_NAMES: Record<AgentColour, string> = {
  violet: "Violet", red: "Red", pink: "Pink", brown: "Brown", grey: "Grey",
  ink: "Ink", orange: "Orange", sky: "Sky", green: "Green", teal: "Teal",
};

// The owner's choice of shape and colour in Agent settings. Each option shows the face it would give.
export function LookPicker({ look, onChange }: { look: AgentLook; onChange: (look: AgentLook) => void }) {
  return <div className="look-picker">
    <fieldset>
      <legend>Shape</legend>
      <div className="look-options">{AGENT_SHAPES.map(shape => <label key={shape} className="look-option" title={SHAPE_NAMES[shape]}>
        <input type="radio" className="sr-only" name="look-shape" value={shape} checked={look.shape === shape} onChange={() => onChange({ ...look, shape })} />
        <AvatarFace look={{ shape, colour: look.colour }} size={32} /><span className="sr-only">{SHAPE_NAMES[shape]}</span>
      </label>)}</div>
    </fieldset>
    <fieldset>
      <legend>Colour</legend>
      <div className="look-options">{AGENT_COLOURS.map(colour => <label key={colour} className="look-option" title={COLOUR_NAMES[colour]}>
        <input type="radio" className="sr-only" name="look-colour" value={colour} checked={look.colour === colour} onChange={() => onChange({ ...look, colour })} />
        <AvatarFace look={{ shape: look.shape, colour }} size={32} /><span className="sr-only">{COLOUR_NAMES[colour]}</span>
      </label>)}</div>
    </fieldset>
  </div>;
}
