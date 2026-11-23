import { useCallback, useEffect, useRef, useState } from 'react';
import type { Habit, Person, PlanResult } from '../../packages/contracts/planner.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import type { BankEvent, BankRuntime, BankSummary, PlanAssumptionsInput, ToolClient } from './client.ts';
import { isNoPlaceRefusal, ToolError } from './client.ts';
import { withWhatIfHabits } from './habit-form.ts';
import type { Subject } from './launch.ts';
import { subjectKey } from './launch.ts';
import { errorMessages } from './messages/errors.messages.ts';
import type { HabitOverrides } from './view-model.ts';
import { addedTransactions, applyHabitOverrides, effectiveOverrides, lastCompleteMonths } from './view-model.ts';

const asToolError = (error: unknown, tool: string, locale: Locale) =>
  error instanceof ToolError
    ? error
    : new ToolError(tool, 'failed', translator(errorMessages, locale)('toolUnreachable', { tool }));

// --------------------------------------------------------------------- plan

export type PlanState = {
  /** `idle`: nothing to plan yet. `loading`: first load. `ready`: a result is on screen. */
  phase: 'idle' | 'loading' | 'ready' | 'error';
  result: PlanResult | null;
  /** The last failure. With `phase: 'ready'` the previous result stays on screen next to it. */
  error: ToolError | null;
  /** A newer plan is being fetched while the previous one stays visible. */
  refreshing: boolean;
  loadedAt: number | null;
};

const idlePlan: PlanState = { phase: 'idle', result: null, error: null, refreshing: false, loadedAt: null };

const noHabits: Habit[] = [];

/**
 * Loads the plan and re-runs it when places, switches or habit toggles change. A stored person is
 * named by the subject (the signed-in person or a demo persona, never a user id); a what-if with
 * toggled or added habits, or a person typed into the page, is sent inline.
 *
 * With no place chosen the plan is still asked for: a server that plans without a place answers
 * with the person, their questions and a baseline anywhere in Catalonia (`plans` is empty). A
 * server that refuses an empty list leaves the workspace as it was before that existed: nothing to
 * plan yet (`idle`), and no error, because the person did nothing wrong.
 */
export function usePlan(
  client: ToolClient,
  subject: Subject,
  municipalityCodes: string[],
  assumptions: PlanAssumptionsInput,
  overrides: HabitOverrides,
  /** Habits added as a what-if: planned with, stored nowhere. */
  extraHabits: Habit[] = noHabits,
) {
  const [state, setState] = useState<PlanState>(idlePlan);
  /** The person as stored, before any what-if toggles. */
  const [storedPerson, setStoredPerson] = useState<Person | null>(null);
  const stored = useRef<{ key: string; person: Person } | null>(null);
  const key = subjectKey(subject);
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  const run = useRef(0);
  const codesKey = municipalityCodes.join(',');
  const { includeProposedHabits, includeUnverifiedBenefits } = assumptions;

  const load = useCallback(
    async (rereadPerson: boolean) => {
      const current = ++run.current;
      const codes = codesKey ? codesKey.split(',') : [];
      const subject = subjectRef.current;
      if (stored.current && stored.current.key !== key) {
        stored.current = null;
        setStoredPerson(null);
      }
      if (subject.kind === 'none') {
        setState(idlePlan);
        return;
      }
      // A person typed into the page is its own source: there is nothing stored to read first.
      if (subject.kind === 'inline' && !stored.current) {
        stored.current = { key, person: subject.person };
        setStoredPerson(subject.person);
      }
      const planAssumptions = { includeProposedHabits, includeUnverifiedBenefits };
      setState(previous => ({
        ...previous,
        phase: previous.result ? 'ready' : 'loading',
        refreshing: true,
      }));
      try {
        let result: PlanResult | null = null;
        if (!stored.current || rereadPerson) {
          result = await client.plan({ subject, municipalityCodes: codes, assumptions: planAssumptions });
          if (current !== run.current) return;
          stored.current = { key, person: result.person };
          setStoredPerson(result.person);
        }
        const person = stored.current.person;
        const edits = effectiveOverrides(person, overrides, includeProposedHabits);
        if (Object.keys(edits).length > 0 || extraHabits.length > 0) {
          result = await client.plan({
            person: withWhatIfHabits(applyHabitOverrides(person, edits), extraHabits),
            municipalityCodes: codes,
            assumptions: planAssumptions,
          });
        } else if (!result) {
          result = await client.plan({ subject, municipalityCodes: codes, assumptions: planAssumptions });
        }
        if (current !== run.current) return;
        setState({ phase: 'ready', result, error: null, refreshing: false, loadedAt: Date.now() });
      } catch (error) {
        if (current !== run.current) return;
        const failure = asToolError(error, 'plan_home_savings', client.locale);
        // No place chosen and the server will not plan without one: there is nothing to plan yet.
        if (isNoPlaceRefusal(codes, failure)) {
          setState(idlePlan);
          return;
        }
        setState(previous => ({
          ...previous,
          phase: previous.result ? 'ready' : 'error',
          error: failure,
          refreshing: false,
        }));
      }
    },
    [client, key, codesKey, includeProposedHabits, includeUnverifiedBenefits, overrides, extraHabits],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return { state, storedPerson, reload: load };
}

// --------------------------------------------------------------------- bank

export type BankFeedState = {
  phase: 'idle' | 'connecting' | 'live' | 'error';
  /** Newest first, at most five. */
  events: BankEvent[];
  runtime: BankRuntime | null;
  summary: BankSummary | null;
  summaryError: string | null;
  /** When the feed last answered. */
  checkedAt: number | null;
  /** When a poll last brought new activity while the workspace was open. */
  changedAt: number | null;
  /**
   * Movements added to the ledger while the workspace was open, or null when that cannot be told
   * (the size of the ledger before the first change is not known).
   */
  newTransactions: number | null;
  error: ToolError | null;
  /** How often the feed is asked. While `transport` is `stream` this is only the safety net. */
  pollMs: number;
  /**
   * How news of a change arrives: `stream` while the server's event stream is open (the standalone
   * page of a signed-in person), `polling` otherwise.
   */
  transport: 'polling' | 'stream';
};

const idleFeed: BankFeedState = {
  phase: 'idle',
  events: [],
  runtime: null,
  summary: null,
  summaryError: null,
  checkedAt: null,
  changedAt: null,
  newTransactions: 0,
  error: null,
  pollMs: 10_000,
  transport: 'polling',
};

const clampPoll = (intervalMs: number | undefined) => Math.min(60_000, Math.max(5_000, intervalMs ?? 10_000));

/** While the event stream is open the feed is still asked this often, in case the stream is silently stuck. */
const streamSafetyPollMs = 60_000;

/** The part of the browser's `EventSource` the feed uses, so a test can stand in for it. */
export type EventSourceLike = {
  readonly readyState: number;
  addEventListener(type: string, listener: (event: { lastEventId?: string }) => void): void;
  close(): void;
};

/** Where the signed-in person's event stream is, and how to open it. */
export type BankStream = {
  /** The stream's address for events after a cursor. Same origin; the session cookie authorises it. */
  url: (after: number) => string;
  open: (url: string) => EventSourceLike;
  /** How long to wait for the stream's first `ready` before giving up on it. Default 10 s. */
  readyTimeoutMs?: number;
};

/**
 * The stream of the page this code runs in, or null when there is none to use:
 *
 * - inside a chat host the widget's content security policy allows no connection, so it polls;
 * - the fixture preview has no server;
 * - only the standalone `/workspace` page is on ReloCat's own origin with the session cookie.
 *
 * The address names no user: `/api/me/…` is the caller's own stream, decided by the server.
 */
export function pageBankStream(): BankStream | null {
  if (typeof window === 'undefined' || typeof EventSource === 'undefined') return null;
  let framed = true;
  try {
    framed = window.parent !== window;
  } catch {
    // A frame that cannot look at its parent is a frame.
  }
  if (framed || !/^\/workspace(\/|$)/.test(window.location.pathname)) return null;
  if (new URLSearchParams(window.location.search).has('fixture')) return null;
  return {
    url: after => `/api/me/bank/events/stream?after=${after}`,
    open: url => new EventSource(url),
  };
}

/**
 * Listens to the event stream and reports three things: it is `up` (the server said `ready`; again
 * after every reconnection), an `update` with a sequence not seen before, and `down`. A stream
 * that is down for a moment reconnects by itself and the browser sends the last event ID it saw
 * (`Last-Event-ID`), so the server continues from there. `down(true)` is final: the server refused
 * the stream, or it never became ready (a proxy that buffers event streams), and it was closed.
 */
export function followBankStream(
  stream: BankStream,
  after: number,
  on: { up: (reconnected: boolean) => void; update: (sequence: number) => void; down: (final: boolean) => void },
) {
  let closed = false;
  let seen = after;
  let wasUp = false;
  const source = stream.open(stream.url(after));
  const giveUp = () => {
    if (closed) return;
    closed = true;
    clearTimeout(waiting);
    source.close();
    on.down(true);
  };
  let waiting: ReturnType<typeof setTimeout> | undefined = setTimeout(giveUp, stream.readyTimeoutMs ?? 10_000);
  source.addEventListener('ready', () => {
    if (closed) return;
    clearTimeout(waiting);
    on.up(wasUp);
    wasUp = true;
  });
  source.addEventListener('bank.updated', event => {
    const sequence = Number(event.lastEventId);
    // A replayed event (the same sequence again after a reconnection) is not news.
    if (closed || !Number.isSafeInteger(sequence) || sequence <= seen) return;
    seen = sequence;
    on.update(sequence);
  });
  source.addEventListener('error', () => {
    if (closed) return;
    // 2 is CLOSED: the browser will not try again (the server answered with an error).
    if (source.readyState === 2) return giveUp();
    clearTimeout(waiting);
    // Reconnecting: if it does not come back in time it is given up, and polling carries on alone.
    waiting = setTimeout(giveUp, stream.readyTimeoutMs ?? 10_000);
    on.down(false);
  });
  return {
    close() {
      closed = true;
      clearTimeout(waiting);
      source.close();
    },
  };
}

/**
 * Follows the bank feed of the subject. New activity calls `onActivity` so the plan re-reads the
 * person's figures. Only a stored subject has a feed: the signed-in person or a demo persona.
 *
 * The events themselves are always read by cursor through the bank-updates tool, so nothing is
 * counted twice. What differs is what triggers a read:
 *
 * - On the standalone page of a signed-in person, the server's event stream
 *   (`/api/me/bank/events/stream`): an event triggers one read at once, and a slow poll remains as
 *   a safety net. `stream` overrides where that stream is; `null` turns it off.
 * - Everywhere else (inside a chat host, a demo persona, a stream that is refused or never becomes
 *   ready), a poll on the feed's own interval. Polling pauses while the tab is hidden.
 */
export function useBankFeed(client: ToolClient, subject: Subject, onActivity: () => void, stream?: BankStream | null) {
  const [state, setState] = useState<BankFeedState>(idleFeed);
  const [attempt, setAttempt] = useState(0);
  const notify = useRef(onActivity);
  notify.current = onActivity;
  // A change of language makes a new client; the feed keeps its cursor and goes on with the new one.
  const clientRef = useRef(client);
  clientRef.current = client;

  const key = subjectKey(subject);
  const subjectRef = useRef(subject);
  subjectRef.current = subject;
  const streamRef = useRef(stream);
  streamRef.current = stream;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for the subject; `attempt` restarts the feed on retry.
  useEffect(() => {
    const subject = subjectRef.current;
    if (subject.kind === 'none' || subject.kind === 'inline') {
      setState(idleFeed);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let first = true;
    /** Movements in the ledger at the last event seen; null until that is known. */
    let ledgerSize: number | null = null;
    let pollMs = idleFeed.pollMs;
    /** A read is in flight; `again` asks for one more as soon as it ends. */
    let reading = false;
    let again = false;
    /** The event stream is open and has said `ready`. */
    let streaming = false;
    let following: { close(): void } | undefined;
    // Only the signed-in person has a stream: the public demo is read-only through the tools.
    const source =
      subject.kind === 'me' ? (streamRef.current === undefined ? pageBankStream() : streamRef.current) : null;
    setState({ ...idleFeed, phase: 'connecting' });

    const loadSummary = async () => {
      try {
        const period = lastCompleteMonths(new Date().toISOString().slice(0, 10), 3);
        const summary = await clientRef.current.bankSummary(subject, period);
        if (!cancelled) setState(previous => ({ ...previous, summary, summaryError: null }));
      } catch (error) {
        if (!cancelled)
          setState(previous => ({
            ...previous,
            summaryError: asToolError(error, 'get_bank_summary', clientRef.current.locale).message,
          }));
      }
    };
    const loadRuntime = async () => {
      try {
        const runtime = await clientRef.current.bankRuntime(subject);
        if (cancelled) return;
        pollMs = clampPoll(runtime.intervalMs);
        setState(previous => ({ ...previous, runtime, pollMs }));
      } catch {
        // The feed status is optional context; the strip says it is unknown.
      }
    };
    const cadence = () => (streaming ? Math.max(pollMs, streamSafetyPollMs) : pollMs);
    const showTransport = () =>
      setState(previous => ({ ...previous, transport: streaming ? 'stream' : 'polling', pollMs: cadence() }));
    /** Read now: at once when idle, right after the read in flight otherwise. Never two at a time. */
    const wake = () => {
      if (cancelled) return;
      if (reading) {
        again = true;
        return;
      }
      clearTimeout(timer);
      void poll();
    };
    const follow = () => {
      if (!source || following || cancelled) return;
      try {
        following = followBankStream(source, cursor, {
          up: reconnected => {
            streaming = true;
            showTransport();
            // Whatever happened while the stream was away is read once, by cursor.
            if (reconnected) wake();
          },
          update: sequence => {
            if (sequence > cursor) wake();
          },
          down: () => {
            if (!streaming) return;
            streaming = false;
            showTransport();
            wake();
          },
        });
      } catch {
        // No stream here after all: polling carries on.
      }
    };
    const poll = async () => {
      if (cancelled || reading) return;
      if (typeof document !== 'undefined' && document.hidden && !first) {
        timer = setTimeout(poll, cadence());
        return;
      }
      reading = true;
      again = false;
      let nextDelay = pollMs;
      try {
        const received: BankEvent[] = [];
        let requiresRefresh = false;
        if (first) {
          // Start near the end of the log: the five newest events are enough for the list.
          const head = await clientRef.current.bankUpdates(subject, 0, 1);
          cursor = Math.max(0, head.latestRevision - 5);
          // An empty log on an untouched ledger means the ledger holds nothing yet.
          if (head.latestRevision === 0) ledgerSize = 0;
        }
        for (let page = 0; page < 5; page += 1) {
          const updates = await clientRef.current.bankUpdates(subject, cursor, 100);
          cursor = updates.nextCursor;
          received.push(...updates.events);
          requiresRefresh ||= updates.requiresRefresh;
          if (!updates.hasMore) break;
        }
        if (cancelled) return;
        const changed = !first && (received.length > 0 || requiresRefresh);
        // `transactionCount` is the size of the ledger after each change, not a per-event delta.
        const added = first ? 0 : addedTransactions(ledgerSize, received);
        ledgerSize = received.at(-1)?.transactionCount ?? ledgerSize;
        const now = Date.now();
        setState(previous => ({
          ...previous,
          phase: 'live',
          error: null,
          checkedAt: now,
          events: [...received.reverse(), ...previous.events].slice(0, 5),
          changedAt: changed ? now : previous.changedAt,
          newTransactions:
            !changed || received.length === 0
              ? previous.newTransactions
              : added === null || previous.newTransactions === null
                ? null
                : previous.newTransactions + added,
        }));
        if (first) {
          first = false;
          void loadSummary();
          follow();
        } else if (changed) {
          notify.current();
          void loadSummary();
        }
        nextDelay = cadence();
      } catch (error) {
        if (cancelled) return;
        nextDelay = 30_000;
        again = false;
        setState(previous => ({
          ...previous,
          phase: 'error',
          error: asToolError(error, 'get_bank_updates', clientRef.current.locale),
        }));
      } finally {
        reading = false;
      }
      if (cancelled) return;
      if (again) return void poll();
      timer = setTimeout(poll, nextDelay);
    };
    // Back in view: what the stream said meanwhile was not read while hidden.
    const onVisible = () => {
      if (!document.hidden && streaming) wake();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    void loadRuntime().then(poll);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      following?.close();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, attempt]);

  return { state, retry: useCallback(() => setAttempt(value => value + 1), []) };
}

/** The current time, refreshed on an interval, for "updated … ago" labels. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
