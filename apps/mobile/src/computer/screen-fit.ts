import { SCREEN_MIN_WIDTH, ScreenSize } from "@quokkabot/shared";

// The computer's screen for a live view of this size, in points. One screen pixel per point where the view is wide
// enough, so the agent's browser lays pages out at the phone's own width and text shows at the phone's own size. A
// portrait phone is narrower than the narrowest screen Chrome fits on (504), so its screen keeps the view's shape at
// that width and shows a little smaller (0.78 on a 393-point phone, against 0.31 for the 1280 desktop). Widths round
// up to whole 8-pixel cells and heights to even pixels. Null when the view is outside the sizes the server accepts.
export function screenFor(view: { width: number; height: number }): ScreenSize | null {
  if (!(view.width > 0 && view.height > 0)) return null;
  const scale = Math.max(1, SCREEN_MIN_WIDTH / view.width);
  const size = { width: Math.ceil((view.width * scale) / 8) * 8, height: Math.round((view.height * scale) / 2) * 2 };
  return ScreenSize.safeParse(size).success ? size : null;
}

// Whether the screen needs fitting again. Only a new width counts (the phone turned): the height changes whenever the
// keyboard or the password field opens, and a resize reloads the live view under the owner's finger.
export function needsRefit(fitted: ScreenSize | null, next: ScreenSize | null): next is ScreenSize {
  if (next === null) return false;
  return fitted === null || fitted.width !== next.width;
}
