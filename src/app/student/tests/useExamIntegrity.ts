"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { recordAttemptClientEventsAction } from "@/services/student-tests.actions";
import { attachExamMonitors, createClientEventReporter } from "@/lib/student-tests/exam-monitor";

function newTabId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Browser activity signals for the open attempt (tab hidden, offline/online,
 * copy/paste in the question area, print, the same attempt in another tab)
 * plus the leave-page warning — only while `active`. Reports are batched,
 * best effort and never affect saving, submitting or the timer.
 * Returns how many other tabs of this attempt are open (for a gentle notice).
 */
export function useExamIntegrity(attemptId: string, active: boolean, areaRef: RefObject<HTMLElement>): { otherTabs: number } {
  const [otherTabs, setOtherTabs] = useState(0);
  // Read in the cleanup: leaving the page mid-attempt sends what is pending; a finished attempt sends nothing.
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    if (!active) return;
    const reporter = createClientEventReporter({
      send: (events) => recordAttemptClientEventsAction(attemptId, events),
      isOnline: () => (typeof navigator === "undefined" ? true : navigator.onLine !== false),
    });
    const detach = attachExamMonitors({
      attemptId,
      tabId: newTabId(),
      reporter,
      win: window,
      doc: document,
      area: areaRef.current,
      channelFactory: typeof BroadcastChannel === "function" ? (name) => new BroadcastChannel(name) : null,
      onOtherTabs: setOtherTabs,
      now: () => performance.now(),
    });
    return () => {
      detach();
      if (activeRef.current) void reporter.flush();
      reporter.stop();
      setOtherTabs(0);
    };
  }, [attemptId, active, areaRef]);

  return { otherTabs };
}
