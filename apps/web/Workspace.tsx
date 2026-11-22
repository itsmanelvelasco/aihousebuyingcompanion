import { useCallback, useMemo, useState } from 'react';
import type { Habit, Person } from '../../packages/contracts/planner.ts';
import type { ToolClient } from './client.ts';
import { BankStrip } from './components/BankStrip.tsx';
import { Wordmark } from './components/bits.tsx';
import { DetailsPanel } from './components/DetailsPanel.tsx';
import { Notes } from './components/Notes.tsx';
import { PersonPanel } from './components/PersonPanel.tsx';
import { PlacesPanel } from './components/PlacesPanel.tsx';
import { formatDate } from './format.ts';
import { useBankFeed, usePlan } from './hooks.ts';
import type { Subject, WorkspaceLaunch } from './launch.ts';
import { subjectOf } from './launch.ts';
import type { HabitOverrides } from './view-model.ts';

export type WorkspaceMode = 'host' | 'standalone' | 'fixture';

type Props = {
  client: ToolClient;
  launch: WorkspaceLaunch;
  mode: WorkspaceMode;
};

const noOverrides: HabitOverrides = {};

/**
 * Says plainly whose figures are on screen. There are three honest states: a fictional demo persona
 * (read-only), the signed-in person (their own data, which they can add to), and nobody (what-if only).
 */
function SubjectBanner(props: {
  subject: Subject;
  launch: WorkspaceLaunch;
  mode: WorkspaceMode;
  onSubject: (s: Subject) => void;
}) {
  const { subject, launch, mode } = props;
  // Inside a chat host the page has no address of its own to link to; the host starts the sign-in.
  const pages = mode !== 'host';
  if (subject.kind === 'demo')
    return (
      <p className="rc-note subject-banner">
        <strong>Fictional demo persona, read-only.</strong> {subject.demoId} is an invented household with invented bank
        movements. Nothing here belongs to a real person and nothing you change is saved.{' '}
        {launch.signedIn ? (
          <button type="button" className="rc-btn rc-btn--sm" onClick={() => props.onSubject({ kind: 'me' })}>
            Show my own plan
          </button>
        ) : pages ? (
          <a href="/login?next=%2Fworkspace">Sign in to plan with your own figures</a>
        ) : (
          'Connect your ReloCat account in the chat to plan with your own figures.'
        )}
      </p>
    );
  if (subject.kind === 'me')
    return (
      <p className="rc-note subject-banner">
        <strong>Your own plan.</strong> These are the figures saved to your account; only you and the assistants you
        connected can read them. {pages ? <a href="/account">Manage your account</a> : null}
      </p>
    );
  if (subject.kind === 'inline')
    return (
      <p className="rc-note rc-note--warn subject-banner">
        <strong>What-if estimate, not saved.</strong> These figures were typed into this page and are stored nowhere.{' '}
        {pages && !launch.signedIn ? <a href="/login?next=%2Fworkspace">Sign in to keep them</a> : null}{' '}
        <button
          type="button"
          className="rc-btn rc-btn--sm rc-btn--quiet"
          onClick={() => props.onSubject({ kind: 'none' })}
        >
          Clear
        </button>
      </p>
    );
  return null;
}

export function Workspace({ client, launch, mode }: Props) {
  const [subject, setSubjectState] = useState<Subject>(() => subjectOf(launch));
  const [codes, setCodes] = useState(launch.municipalityCodes);
  const [overrides, setOverrides] = useState<HabitOverrides>(noOverrides);
  const [includeProposed, setIncludeProposed] = useState(false);
  const [includeUnverified, setIncludeUnverified] = useState(false);
  const assumptions = useMemo(
    () => ({ includeProposedHabits: includeProposed, includeUnverifiedBenefits: includeUnverified }),
    [includeProposed, includeUnverified],
  );
  const setSubject = useCallback((next: Subject) => {
    setOverrides(noOverrides);
    setSubjectState(next);
  }, []);
  const { state: plan, storedPerson, reload } = usePlan(client, subject, codes, assumptions, overrides);
  const refreshFromBank = useCallback(() => {
    void reload(true);
  }, [reload]);
  const { state: feed, retry: retryFeed } = useBankFeed(client, subject, refreshFromBank);
  const retryPlan = useCallback(() => {
    void reload(false);
  }, [reload]);
  const person = storedPerson;
  const stored = subject.kind === 'me' || subject.kind === 'demo';
  const label =
    subject.kind === 'demo'
      ? subject.demoId
      : subject.kind === 'me'
        ? 'your profile'
        : subject.kind === 'inline'
          ? 'what-if'
          : null;
  const name = subject.kind === 'me' ? 'you have' : subject.kind === 'demo' ? `${subject.demoId} has` : null;

  return (
    <main>
      <header className="masthead">
        <Wordmark />
        <h1>How soon could you buy?</h1>
        <p className="lede">
          {name && plan.result
            ? `Time until ${name} the upfront cash for a home, place by place. Plan dated ${formatDate(plan.result.asOf)}.`
            : 'Time until you have the upfront cash for a home, place by place: at today’s rate, with your habits, and with what each place offers.'}
        </p>
      </header>

      {mode === 'fixture' ? (
        <p className="rc-note rc-note--warn fixture-banner">
          <strong>Fixture preview.</strong> Sample figures written by hand, not planner output. Toggles call the fixture
          and the timelines do not recalculate.
        </p>
      ) : null}

      <SubjectBanner subject={subject} launch={launch} mode={mode} onSubject={setSubject} />

      {stored ? (
        <BankStrip userId={label} feed={feed} onRetry={retryFeed} personSynthetic={person?.synthetic ?? null} />
      ) : null}

      <DetailsPanel
        client={client}
        subject={subject}
        launch={launch}
        mode={mode}
        plan={plan}
        hasPlaces={codes.length > 0}
        onInline={(inline: Person) => setSubject({ kind: 'inline', person: inline })}
        onSaved={refreshFromBank}
      />

      <div className="layout">
        <PersonPanel
          client={client}
          subject={subject}
          launch={launch}
          mode={mode}
          userId={label}
          plan={plan}
          person={person}
          hasPlaces={codes.length > 0}
          overrides={overrides}
          includeProposed={includeProposed}
          onToggleHabit={(habit: Habit, on: boolean) => setOverrides(previous => ({ ...previous, [habit.id]: on }))}
          onIncludeProposed={setIncludeProposed}
          onReset={() => setOverrides(noOverrides)}
          onSubject={setSubject}
          onInline={(inline: Person) => setSubject({ kind: 'inline', person: inline })}
          onSaved={refreshFromBank}
          onRetry={retryPlan}
        />
        <PlacesPanel
          client={client}
          userId={label}
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
