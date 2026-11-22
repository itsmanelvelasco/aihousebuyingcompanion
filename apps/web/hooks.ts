import { useCallback, useEffect, useRef, useState } from 'react';
import type { Person, PlanResult } from '../../packages/contracts/planner.ts';
import type { BankEvent, BankRuntime, BankSummary, PlanAssumptionsInput, ToolClient } from './client.ts';
import { ToolError } from './client.ts';
import type { HabitOverrides } from './view-model.ts';
import { applyHabitOverrides, effectiveOverrides, lastCompleteMonths } from './view-model.ts';

const asToolError = (error: unknown, tool: string) =>
  error instanceof ToolError ? error : new ToolError(tool, 'failed', `The ${tool} tool could not be reached.`);

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
 * Loads the plan and re-runs it when places, switches or habit toggles change. The stored person is
 * read by `userId`; a what-if with toggled habits sends that person inline with edited statuses.
 */
export function usePlan(
  client: ToolClient,
  userId: string | null,
  municipalityCodes: string[],
  assumptions: PlanAssumptionsInput,
  overrides: HabitOverrides,
) {
  const [state, setState] = useState<PlanState>(idlePlan);
  /** The person as stored, before any what-if toggles. */
  const [storedPerson, setStoredPerson] = useState<Person | null>(null);
  const stored = useRef<{ userId: string; person: Person } | null>(null);
  const run = useRef(0);
  const codesKey = municipalityCodes.join(',');
  const { includeProposedHabits, includeUnverifiedBenefits } = assumptions;

  const load = useCallback(
    async (rereadPerson: boolean) => {
      const current = ++run.current;
      const codes = codesKey ? codesKey.split(',') : [];
      if (!userId || codes.length === 0) {
        setState(idlePlan);
        return;
      }
      if (stored.current && stored.current.userId !== userId) {
        stored.current = null;
        setStoredPerson(null);
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
          result = await client.plan({ userId, municipalityCodes: codes, assumptions: planAssumptions });
          if (current !== run.current) return;
          stored.current = { userId, person: result.person };
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
          result = await client.plan({ userId, municipalityCodes: codes, assumptions: planAssumptions });
        }
        if (current !== run.current) return;
        setState({ phase: 'ready', result, error: null, refreshing: false, loadedAt: Date.now() });
      } catch (error) {
        if (current !== run.current) return;
        setState(previous => ({
          ...previous,
          phase: previous.result ? 'ready' : 'error',
          error: asToolError(error, 'plan_home_savings'),
          refreshing: false,
        }));
      }
    },
    [client, userId, codesKey, includeProposedHabits, includeUnverifiedBenefits, overrides],
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
  /** Transactions that arrived while the workspace was open. */
  newTransactions: number;
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
 * Follows the synthetic bank feed by cursor polling `get_bank_updates`. New activity calls
 * `onActivity` so the plan re-reads the person's figures. Polling pauses while the tab is hidden.
 */
export function useBankFeed(client: ToolClient, userId: string | null, onActivity: () => void) {
  const [state, setState] = useState<BankFeedState>(idleFeed);
  const [attempt, setAttempt] = useState(0);
  const notify = useRef(onActivity);
  notify.current = onActivity;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` restarts the feed on retry.
  useEffect(() => {
    if (!userId) {
      setState(idleFeed);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = 0;
    let first = true;
    let pollMs = idleFeed.pollMs;
    setState({ ...idleFeed, phase: 'connecting' });

    const loadSummary = async () => {
      try {
        const period = lastCompleteMonths(new Date().toISOString().slice(0, 10), 3);
        const summary = await client.bankSummary(userId, period);
        if (!cancelled) setState(previous => ({ ...previous, summary, summaryError: null }));
      } catch (error) {
        if (!cancelled)
          setState(previous => ({ ...previous, summaryError: asToolError(error, 'get_bank_summary').message }));
      }
    };
    const loadRuntime = async () => {
      try {
        const runtime = await client.bankRuntime(userId);
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
        for (let page = 0; page < 5; page += 1) {
          const updates = await client.bankUpdates(userId, cursor, 100);
          cursor = updates.nextCursor;
          received.push(...updates.events);
          requiresRefresh ||= updates.requiresRefresh;
          if (!updates.hasMore) break;
        }
        if (cancelled) return;
        const changed = !first && (received.length > 0 || requiresRefresh);
        const added = received.reduce((total, event) => total + event.transactionCount, 0);
        const now = Date.now();
        setState(previous => ({
          ...previous,
          phase: 'live',
          error: null,
          checkedAt: now,
          events: [...received.reverse(), ...previous.events].slice(0, 5),
          changedAt: changed ? now : previous.changedAt,
          newTransactions: previous.newTransactions + (changed ? added : 0),
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
        setState(previous => ({ ...previous, phase: 'error', error: asToolError(error, 'get_bank_updates') }));
      }
      timer = setTimeout(poll, nextDelay);
    };
    void loadRuntime().then(poll);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, userId, attempt]);

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
