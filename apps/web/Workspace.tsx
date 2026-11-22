import { useCallback, useMemo, useState } from 'react';
import type { Habit } from '../../packages/contracts/planner.ts';
import type { ToolClient } from './client.ts';
import { BankStrip } from './components/BankStrip.tsx';
import { Wordmark } from './components/bits.tsx';
import { Notes } from './components/Notes.tsx';
import { PersonPanel } from './components/PersonPanel.tsx';
import { PlacesPanel } from './components/PlacesPanel.tsx';
import { formatDate } from './format.ts';
import { useBankFeed, usePlan } from './hooks.ts';
import type { WorkspaceLaunch } from './launch.ts';
import type { HabitOverrides } from './view-model.ts';

export type WorkspaceMode = 'host' | 'standalone' | 'fixture';

type Props = {
  client: ToolClient;
  launch: WorkspaceLaunch;
  mode: WorkspaceMode;
};

const noOverrides: HabitOverrides = {};

export function Workspace({ client, launch, mode }: Props) {
  const [userId, setUserId] = useState(launch.userId);
  const [codes, setCodes] = useState(launch.municipalityCodes);
  const [overrides, setOverrides] = useState<HabitOverrides>(noOverrides);
  const [includeProposed, setIncludeProposed] = useState(false);
  const [includeUnverified, setIncludeUnverified] = useState(false);
  const assumptions = useMemo(
    () => ({ includeProposedHabits: includeProposed, includeUnverifiedBenefits: includeUnverified }),
    [includeProposed, includeUnverified],
  );
  const { state: plan, storedPerson, reload } = usePlan(client, userId, codes, assumptions, overrides);
  const refreshFromBank = useCallback(() => {
    void reload(true);
  }, [reload]);
  const { state: feed, retry: retryFeed } = useBankFeed(client, userId, refreshFromBank);
  const retryPlan = useCallback(() => {
    void reload(false);
  }, [reload]);
  const person = storedPerson;
  const name = person?.displayName ?? person?.id ?? null;

  return (
    <main>
      <header className="masthead">
        <Wordmark />
        <h1>How soon could you buy?</h1>
        <p className="lede">
          {name && plan.result
            ? `Time until ${name} has the upfront cash for a home, place by place. Plan dated ${formatDate(plan.result.asOf)}.`
            : 'Time until you have the upfront cash for a home, place by place: at today’s rate, with your habits, and with what each place offers.'}
        </p>
      </header>

      {mode === 'fixture' ? (
        <p className="rc-note rc-note--warn fixture-banner">
          <strong>Fixture preview.</strong> Sample figures written by hand, not planner output. Toggles call the fixture
          and the timelines do not recalculate.
        </p>
      ) : null}

      <BankStrip userId={userId} feed={feed} onRetry={retryFeed} />

      <div className="layout">
        <PersonPanel
          userId={userId}
          plan={plan}
          person={person}
          hasPlaces={codes.length > 0}
          overrides={overrides}
          includeProposed={includeProposed}
          onToggleHabit={(habit: Habit, on: boolean) => setOverrides(previous => ({ ...previous, [habit.id]: on }))}
          onIncludeProposed={setIncludeProposed}
          onReset={() => setOverrides(noOverrides)}
          onChooseUser={id => {
            setOverrides(noOverrides);
            setUserId(id);
          }}
          onRetry={retryPlan}
        />
        <PlacesPanel
          client={client}
          userId={userId}
          codes={codes}
          plan={plan}
          includeUnverified={includeUnverified}
          onIncludeUnverified={setIncludeUnverified}
          onAdd={code => setCodes(previous => (previous.includes(code) ? previous : [...previous, code]))}
          onRemove={code => setCodes(previous => previous.filter(item => item !== code))}
          onRetry={retryPlan}
        />
      </div>

      {plan.result ? <Notes result={plan.result} /> : null}

      <footer className="foot">
        ReloCat estimates upfront cash only. It does not assess a mortgage, and aid is never guaranteed until the
        administration confirms it.
      </footer>
    </main>
  );
}
