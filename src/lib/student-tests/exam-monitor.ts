/**
 * Browser side of the test-attempt activity signals (no React, so it can
 * be tested without a browser). Best effort by design: reporting never
 * throws, never blocks saving or submitting, and is not a security
 * boundary — the server decides what is stored and the database decides
 * whether the attempt is still in progress.
 */
import {
  MAX_EVENTS_PER_REPORT,
  sanitizeClientEventDetail,
  type ClientEvent,
  type ClientEventDetail,
  type ClientEventKind,
} from "./client-events";

export interface ReportOutcome {
  /** The server says the attempt is no longer open for reports. */
  stop?: boolean;
}

export interface ReporterOptions {
  /** One server call with up to MAX_EVENTS_PER_REPORT events. */
  send: (events: ClientEvent[]) => Promise<ReportOutcome | void>;
  /** Wait before sending, so bursts go out together (ms). */
  delayMs?: number;
  /** Pending events kept at most (oldest dropped). */
  maxQueue?: number;
  /** Send attempts per event before it is dropped (only counted while online). */
  maxTries?: number;
  isOnline?: () => boolean;
}

export interface ClientEventReporter {
  report: (kind: ClientEventKind, detail?: ClientEventDetail) => void;
  /** Send what is pending now (e.g. back online). */
  flush: () => Promise<void>;
  /** The attempt is over: drop everything and never send again. */
  stop: () => void;
  readonly pending: number;
  readonly stopped: boolean;
}

export function createClientEventReporter(options: ReporterOptions): ClientEventReporter {
  const delayMs = options.delayMs ?? 1500;
  const maxQueue = options.maxQueue ?? 20;
  const maxTries = options.maxTries ?? 3;
  const isOnline = options.isOnline ?? (() => true);
  let queue: { event: ClientEvent; tries: number }[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending = false;
  let stopped = false;

  const trim = () => {
    if (queue.length > maxQueue) queue = queue.slice(queue.length - maxQueue);
  };
  const schedule = () => {
    if (stopped || timer || sending || queue.length === 0) return;
    timer = setTimeout(() => {
      timer = null;
      void flush();
    }, delayMs);
  };

  async function flush(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (stopped || sending || queue.length === 0 || !isOnline()) return;
    sending = true;
    const batch = queue.splice(0, MAX_EVENTS_PER_REPORT);
    try {
      const outcome = await Promise.resolve().then(() => options.send(batch.map((b) => b.event)));
      if (outcome && outcome.stop) stop();
    } catch {
      // Network or server failure: keep the batch for a later try, a few times at most.
      const retry = batch.filter((b) => ++b.tries < maxTries);
      queue = [...retry, ...queue];
      trim();
    } finally {
      sending = false;
      schedule();
    }
  }

  function stop() {
    stopped = true;
    queue = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return {
    report(kind, detail) {
      if (stopped) return;
      const clean = sanitizeClientEventDetail(kind, detail);
      queue.push({ event: Object.keys(clean).length ? { kind, detail: clean } : { kind }, tries: 0 });
      trim();
      schedule();
    },
    flush,
    stop,
    get pending() {
      return queue.length;
    },
    get stopped() {
      return stopped;
    },
  };
}

/** The minimal browser surface used below (window, document, the test area, BroadcastChannel). */
interface Listenable {
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}
interface ChannelLike {
  postMessage(message: unknown): void;
  close(): void;
  onmessage: ((event: MessageEvent) => void) | null;
}

export interface MonitorOptions {
  attemptId: string;
  /** A random id for this tab (never sent to the server). */
  tabId: string;
  reporter: Pick<ClientEventReporter, "report" | "flush">;
  win: Listenable;
  doc: Listenable & { visibilityState: string };
  /** The question area: copy/paste are only noted inside it. */
  area: Listenable | null;
  channelFactory?: ((name: string) => ChannelLike) | null;
  /** Other open tabs of this attempt (for a gentle notice). */
  onOtherTabs?: (count: number) => void;
  /** Monotonic clock in ms (performance.now()). Used for durations only. */
  now?: () => number;
}

export const attemptChannelName = (attemptId: string) => `spi-test-attempt:${attemptId}`;

/**
 * Listen for the reported browser signals while the attempt is open and
 * register the leave-page warning. Returns a function that removes all of it.
 */
export function attachExamMonitors(o: MonitorOptions): () => void {
  const now = o.now ?? (() => Date.now());
  const { reporter } = o;
  const off: (() => void)[] = [];
  const on = (target: Listenable | null, type: string, listener: (event: Event) => void) => {
    if (!target) return;
    target.addEventListener(type, listener);
    off.push(() => target.removeEventListener(type, listener));
  };

  let hiddenAt: number | null = null;
  on(o.doc, "visibilitychange", () => {
    if (o.doc.visibilityState === "hidden") {
      if (hiddenAt !== null) return;
      hiddenAt = now();
      reporter.report("client_hidden", { phase: "hidden" });
    } else if (hiddenAt !== null) {
      const seconds = Math.round((now() - hiddenAt) / 1000);
      hiddenAt = null;
      reporter.report("client_hidden", { phase: "visible", hiddenSeconds: seconds });
    }
  });

  on(o.win, "offline", () => reporter.report("client_offline"));
  on(o.win, "online", () => {
    reporter.report("client_online");
    void reporter.flush();
  });

  // Noted only — the copy/paste itself is never blocked or altered, and its content is never read.
  on(o.area, "copy", () => reporter.report("client_copy"));
  on(o.area, "cut", () => reporter.report("client_copy", { cut: true }));
  on(o.area, "paste", () => reporter.report("client_paste"));

  let lastPrint = -Infinity;
  on(o.win, "beforeprint", () => {
    const t = now();
    if (t - lastPrint < 2000) return;
    lastPrint = t;
    reporter.report("client_print");
  });

  // A UX warning only (browsers show their own generic text).
  on(o.win, "beforeunload", (event: Event) => {
    event.preventDefault();
    (event as unknown as { returnValue: string }).returnValue = "";
  });

  // Same attempt open in another tab of this browser: announce, answer, and note it once per tab.
  let channel: ChannelLike | null = null;
  try {
    channel = o.channelFactory ? o.channelFactory(attemptChannelName(o.attemptId)) : null;
  } catch {
    channel = null;
  }
  if (channel) {
    const ch = channel;
    const others = new Set<string>();
    ch.onmessage = (message: MessageEvent) => {
      const data = message.data as { type?: unknown; tabId?: unknown } | null;
      if (!data || typeof data.tabId !== "string" || data.tabId === o.tabId) return;
      if (data.type === "bye") {
        if (others.delete(data.tabId)) o.onOtherTabs?.(others.size);
        return;
      }
      if (data.type !== "hello" && data.type !== "here") return;
      if (data.type === "hello") ch.postMessage({ type: "here", tabId: o.tabId });
      if (!others.has(data.tabId) && others.size < 10) {
        others.add(data.tabId);
        reporter.report("client_multiple_tabs", { otherTabs: others.size });
        o.onOtherTabs?.(others.size);
      }
    };
    ch.postMessage({ type: "hello", tabId: o.tabId });
    off.push(() => {
      ch.onmessage = null;
      try {
        ch.postMessage({ type: "bye", tabId: o.tabId });
      } catch {
        // closing tab: nothing to do
      }
      ch.close();
    });
  }

  return () => {
    while (off.length) off.pop()!();
  };
}
