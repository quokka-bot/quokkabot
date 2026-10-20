import { useEffect, useRef, useSyncExternalStore } from "react";
import { AccessibilityInfo, Animated, Easing } from "react-native";
import Svg, { Ellipse, G, Path } from "react-native-svg";
import { agentLook, AVATAR_MOTION, COLOUR_HEX, EYE_RADIUS, eyeCentres, PRODUCT_MARK, SHAPE_GEOMETRY } from "@quokkabot/client";
import type { AgentLook, AgentSummary } from "@quokkabot/shared";

// The web app's agent avatars (apps/web/src/avatar.tsx), from the same shapes and colours. Still at rest. While the agent
// works: a slow breath on the native thread and eyes looking down at the work. Reduce Motion keeps only the eyes.

// Reduce Motion, read once for the whole app. Until iOS answers, nothing moves.
let reduceMotion = true;
let watching = false;
const listeners = new Set<() => void>();
function setReduceMotion(value: boolean) {
  reduceMotion = value;
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void): () => void {
  if (!watching) {
    watching = true;
    AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion);
  }
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function useReduceMotion(): boolean {
  return useSyncExternalStore(subscribe, () => reduceMotion);
}

export function AvatarFace({ look, size, working }: { look: AgentLook; size: number; working: boolean }) {
  const reduce = useReduceMotion();
  const breath = useRef(new Animated.Value(0)).current;
  const moving = working && !reduce;
  useEffect(() => {
    if (!moving) { breath.setValue(0); return; }
    const half = AVATAR_MOTION.breatheMs / 2;
    const leg = (toValue: number) => Animated.timing(breath, { toValue, duration: half, easing: Easing.inOut(Easing.sin), useNativeDriver: true, isInteraction: false });
    const loop = Animated.loop(Animated.sequence([leg(1), leg(0)]));
    loop.start();
    return () => { loop.stop(); breath.setValue(0); };
  }, [moving, breath]);
  const geometry = SHAPE_GEOMETRY[look.shape];
  const eyes = eyeCentres(geometry);
  const gaze = working ? AVATAR_MOTION.workingGaze : { x: 0, y: 0 };
  const lift = breath.interpolate({ inputRange: [0, 1], outputRange: [0, -AVATAR_MOTION.breatheLift * size / 64] });
  const scale = breath.interpolate({ inputRange: [0, 1], outputRange: [1, AVATAR_MOTION.breatheScale] });
  return <Animated.View accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: size, height: size, transform: [{ translateY: lift }, { scale }] }}>
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <G transform={`rotate(${geometry.tilt} 32 32)`}>
        <Path d={geometry.body} fill={COLOUR_HEX[look.colour]} />
        <G transform={`translate(${gaze.x} ${gaze.y})`}>
          <Ellipse cx={eyes.left.x} cy={eyes.left.y} rx={EYE_RADIUS.x} ry={EYE_RADIUS.y} fill="#fff" />
          <Ellipse cx={eyes.right.x} cy={eyes.right.y} rx={EYE_RADIUS.x} ry={EYE_RADIUS.y} fill="#fff" />
        </G>
      </G>
    </Svg>
  </Animated.View>;
}

export function AgentAvatar({ agent, size, working }: { agent: Pick<AgentSummary, "index" | "look">; size: number; working: boolean }) {
  return <AvatarFace look={agentLook(agent)} size={size} working={working} />;
}

export function ProductMark({ size }: { size: number }) {
  return <AvatarFace look={PRODUCT_MARK} size={size} working={false} />;
}
