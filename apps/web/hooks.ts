import { useCallback, useEffect, useRef, useState } from 'react';
import type { Person, PlanResult } from '../../packages/contracts/planner.ts';
import type { Locale } from '../../packages/i18n/locales.ts';
import { translator } from '../../packages/i18n/messages.ts';
import type { BankEvent, BankRuntime, BankSummary, PlanAssumptionsInput, ToolClient } from './client.ts';
import { ToolError } from './client.ts';
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

/**
 * Loads the plan and re-runs it when places, switches or habit toggles change. A stored person is
 * named by the subject (the signed-in person or a demo persona, never a user id); a what-if with
 * toggled habits, or a person typed into the page, is sent inline.
 */
export function usePlan(
  client: ToolClient,
  subject: Subject,
  municipalityCodes: string[],
  assumptions: PlanAssumptionsInput,
  overrides: HabitOverrides,
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
      if (subject.kind === 'none' || codes.length === 0) {
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
        if (Object.keys(edits).length > 0) {
          result = await client.plan({
            person: applyHabitOverrides(person, edits),
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
        setState(previous => ({
          ...previous,
          phase: previous.result ? 'ready' : 'error',
          error: asToolError(error, 'plan_home_savings', client.locale),
          refreshing: false,
        }));
      }
    },
    [client, key, codesKey, includeProposedHabits, includeUnverifiedBenefits, overrides],
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
  pollMs: number;
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
};

const clampPoll = (intervalMs: number | undefined) => Math.min(60_000, Math.max(5_000, intervalMs ?? 10_000));

/**
 * Follows the bank feed by cursor polling the bank-updates tool of the subject. New activity calls
 * `onActivity` so the plan re-reads the person's figures. Polling pauses while the tab is hidden.
 * Only a stored subject has a feed: the signed-in person or a demo persona.
 */
export function useBankFeed(client: ToolClient, subject: Subject, onActivity: () => void) {
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
    const poll = async () => {
      if (cancelled) return;
      if (typeof document !== 'undefined' && document.hidden && !first) {
        timer = setTimeout(poll, pollMs);
        return;
      }
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
        } else if (changed) {
          notify.current();
          void loadSummary();
        }
      } catch (error) {
        if (cancelled) return;
        nextDelay = 30_000;
        setState(previous => ({
          ...previous,
          phase: 'error',
          error: asToolError(error, 'get_bank_updates', clientRef.current.locale),
        }));
      }
      timer = setTimeout(poll, nextDelay);
    };
    void loadRuntime().then(poll);
    return () => {
      cancelled = true;
      clearTimeout(timer);
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
