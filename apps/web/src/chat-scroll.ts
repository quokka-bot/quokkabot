import { useLayoutEffect, useRef, useState } from "react";
import { followsEnd } from "@quokkabot/client";

// The chat's scrolling. A view (the latest task, an earlier task, a new task) opens hidden and shows once `ready`,
// already at its latest messages. After that every change in size (a message, streamed text, a card, an image, the
// window, the composer) keeps the view at the end while the owner is at the end. An owner reading older messages
// stays where they are. Both happen before the browser paints, so nothing moves on screen.
export function useChatScroll(view: string, ready: boolean) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Whether the owner is at the end. Scrolling up away from the end turns it off, scrolling back to the end on.
  const following = useRef(true);
  // Where the last scroll left the view, set again after every scroll the chat makes itself: a scroll event the
  // browser merges with the owner's own scroll up still reads as up.
  const offset = useRef(0);
  const toEnd = (element: HTMLDivElement) => {
    element.scrollTop = element.scrollHeight;
    offset.current = element.scrollTop;
  };
  // The view the owner moves to by sending (a new task): it stays shown instead of opening hidden.
  const kept = useRef<string | null>(null);
  // Every visit to a view opens hidden, a return to one shown before too: its history loads again.
  const [visit, setVisit] = useState({ view, shown: false });
  if (visit.view !== view) setVisit({ view, shown: kept.current === view });
  const opening = visit.view !== view || !visit.shown;
  const current = useRef(view);
  useLayoutEffect(() => { kept.current = null; current.current = view; }, [view]);
  useLayoutEffect(() => {
    if (!opening || !ready) return;
    const element = scroller.current;
    if (!element) throw new Error("The chat scroller is not mounted");
    following.current = true;
    toEnd(element);
    setVisit({ view, shown: true });
  }, [opening, ready, view]);
  useLayoutEffect(() => {
    const element = scroller.current;
    const column = content.current;
    if (!element || !column) throw new Error("The chat scroller is not mounted");
    offset.current = element.scrollTop;
    const onScroll = () => {
      following.current = followsEnd(following.current, offset.current, { offset: element.scrollTop, viewport: element.clientHeight, content: element.scrollHeight });
      offset.current = element.scrollTop;
    };
    const resized = new ResizeObserver(() => { if (following.current) toEnd(element); });
    resized.observe(element);
    resized.observe(column);
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => { resized.disconnect(); element.removeEventListener("scroll", onScroll); };
  }, []);
  return {
    scroller, content, opening,
    // The owner's message, sent from view `from`, was accepted: to the end, and keep following it. A send that
    // finishes after the owner moved to another view leaves that view where it is.
    sent: (from: string) => {
      if (from !== current.current || !scroller.current) return;
      following.current = true;
      toEnd(scroller.current);
    },
    // Called before moving to `next`, the task the owner just created.
    keepShown: (next: string) => { following.current = true; kept.current = next; },
  };
}
