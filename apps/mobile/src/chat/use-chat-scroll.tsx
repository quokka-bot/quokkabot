import { useEffect, useLayoutEffect, useRef, useState, type ComponentRef } from "react";
import type { LayoutChangeEvent, NativeScrollEvent, NativeSyntheticEvent, ScrollView } from "react-native";
import { followsEnd } from "@quokkabot/client";

// The chat's scrolling. A view (the latest task, an earlier task, a new task) opens hidden and shows once `ready`,
// already at its latest messages. After that a change in size (a message, streamed text, a card, the keyboard) keeps
// the view at the end while the owner is at the end, without animation. An owner reading older messages stays where
// they are.
export function useChatScroll(view: string, ready: boolean) {
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  // Whether the owner is at the end. Scrolling up away from the end turns it off, scrolling back to the end on.
  const following = useRef(true);
  // Where the last scroll left the view, set again after every scroll the chat makes itself (the end of the content
  // as last measured): a dropped or merged scroll event never turns the owner's scroll up into a scroll down.
  const offset = useRef(0);
  const size = useRef({ content: 0, viewport: 0 });
  const toEnd = () => {
    scroll.current?.scrollToEnd({ animated: false });
    offset.current = Math.max(0, size.current.content - size.current.viewport);
  };
  // The view the owner moves to by sending (a new task): it stays shown instead of opening hidden.
  const kept = useRef<string | null>(null);
  // Every visit to a view opens hidden, a return to one shown before too: its history loads again.
  const [visit, setVisit] = useState({ view, shown: false });
  if (visit.view !== view) setVisit({ view, shown: kept.current === view });
  const opening = visit.view !== view || !visit.shown;
  const current = useRef(view);
  useLayoutEffect(() => { kept.current = null; current.current = view; }, [view]);
  // "Loading…" shows only when opening takes a moment, as in the web app.
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!opening) return;
    const timer = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(timer);
  }, [opening]);
  useEffect(() => {
    if (!opening || !ready) return;
    following.current = true;
    toEnd();
    // The scroll reaches the native view before the chat shows.
    const frame = requestAnimationFrame(() => setVisit({ view, shown: true }));
    return () => cancelAnimationFrame(frame);
  }, [opening, ready, view]);
  return {
    opening, loading: opening && slow,
    scrollProps: {
      ref: scroll, scrollEventThrottle: 16,
      onContentSizeChange: (_width: number, height: number) => { size.current.content = height; if (following.current) toEnd(); },
      onLayout: (event: LayoutChangeEvent) => { size.current.viewport = event.nativeEvent.layout.height; if (following.current) toEnd(); },
      onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => {
        const { contentOffset, layoutMeasurement, contentSize } = event.nativeEvent;
        following.current = followsEnd(following.current, offset.current, { offset: contentOffset.y, viewport: layoutMeasurement.height, content: contentSize.height });
        offset.current = contentOffset.y;
      },
    },
    // The owner's message, sent from view `from`, was accepted: to the end, and keep following it. A send that
    // finishes after the owner moved to another view leaves that view where it is.
    sent: (from: string) => {
      if (from !== current.current) return;
      following.current = true;
      toEnd();
    },
    // Called before moving to `next`, the task the owner just created.
    keepShown: (next: string) => { following.current = true; kept.current = next; },
  };
}
