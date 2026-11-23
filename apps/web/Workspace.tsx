import { useCallback, useMemo, useRef, useState } from 'react';
import type { Habit, Person } from '../../packages/contracts/planner.ts';
import { common } from '../../packages/i18n/common.ts';
import type { HabitDraft, ToolClient } from './client.ts';
import { BankStrip } from './components/BankStrip.tsx';
import { Wordmark } from './components/bits.tsx';
import { DetailsPanel } from './components/DetailsPanel.tsx';
import { Journey } from './components/Journey.tsx';
import { Notes } from './components/Notes.tsx';
import { PersonPanel } from './components/PersonPanel.tsx';
import { MAX_PLACES, PlacesPanel } from './components/PlacesPanel.tsx';
import { formatDate } from './format.ts';
import { whatIfHabit } from './habit-form.ts';
import { useBankFeed, usePlan } from './hooks.ts';
import { bold, LanguageSwitcher, rich, useLocale, useMessages } from './i18n.tsx';
import { journey } from './journey.ts';
import type { Subject, WorkspaceLaunch } from './launch.ts';
import { openingPlaces, subjectOf } from './launch.ts';
import { workspaceMessages } from './messages/workspace.messages.ts';
import type { HabitOverrides } from './view-model.ts';

export type WorkspaceMode = 'host' | 'standalone' | 'fixture';

type Props = {
  /** Made for the language on screen: a change of language brings a new client and a new plan. */
  client: ToolClient;
  launch: WorkspaceLaunch;
  mode: WorkspaceMode;
};

const noOverrides: HabitOverrides = {};
const noExtraHabits: Habit[] = [];

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
  const t = useMessages(workspaceMessages);
  // Inside a chat host the page has no address of its own to link to; the host starts the sign-in.
  const pages = mode !== 'host';
  if (subject.kind === 'demo')
    return (
      <p className="rc-note subject-banner">
        {rich(t('demoBanner'), { b: bold, name: subject.demoId })}{' '}
        {launch.signedIn ? (
          <button type="button" className="rc-btn rc-btn--sm" onClick={() => props.onSubject({ kind: 'me' })}>
            {t('showMyPlan')}
          </button>
        ) : pages ? (
          <a href="/login?next=%2Fworkspace">{t('signInOwnFigures')}</a>
        ) : (
          t('connectInChat')
        )}
      </p>
    );
  if (subject.kind === 'me')
    return (
      <p className="rc-note subject-banner">
        {rich(t('meBanner'), { b: bold })} {pages ? <a href="/account">{t('manageAccount')}</a> : null}
      </p>
    );
  if (subject.kind === 'inline')
    return (
      <p className="rc-note rc-note--warn subject-banner">
        {rich(t('inlineBanner'), { b: bold })}{' '}
        {pages && !launch.signedIn ? <a href="/login?next=%2Fworkspace">{t('signInToKeep')}</a> : null}{' '}
        <button
          type="button"
          className="rc-btn rc-btn--sm rc-btn--quiet"
          onClick={() => props.onSubject({ kind: 'none' })}
        >
          {t('clearEstimate')}
        </button>
      </p>
    );
  return null;
}

export function Workspace({ client, launch, mode }: Props) {
  const locale = useLocale();
  const t = useMessages(workspaceMessages);
  const shared = useMessages(common);
  const [subject, setSubjectState] = useState<Subject>(() => subjectOf(launch));
  // A demo persona that came with no places opens on the ones where the difference is visible.
  const [codes, setCodes] = useState(() => openingPlaces(subjectOf(launch), launch.municipalityCodes));
  const [overrides, setOverrides] = useState<HabitOverrides>(noOverrides);
  /** Habits added as a what-if for a demo persona or a typed person: part of the estimate, stored nowhere. */
  const [extraHabits, setExtraHabits] = useState<Habit[]>(noExtraHabits);
  const habitCount = useRef(0);
  const [includeProposed, setIncludeProposed] = useState(false);
  const [includeUnverified, setIncludeUnverified] = useState(false);
  const assumptions = useMemo(
    () => ({ includeProposedHabits: includeProposed, includeUnverifiedBenefits: includeUnverified }),
    [includeProposed, includeUnverified],
  );
  const setSubject = useCallback((next: Subject) => {
    setOverrides(noOverrides);
    setExtraHabits(noExtraHabits);
    setCodes(previous => openingPlaces(next, previous));
    setSubjectState(next);
  }, []);
  const addWhatIfHabit = useCallback((draft: HabitDraft) => {
    habitCount.current += 1;
    const habit = whatIfHabit(draft, habitCount.current);
    setExtraHabits(previous => [...previous, habit]);
  }, []);
  const addPlaces = useCallback((added: string[]) => {
    setCodes(previous => [...new Set([...previous, ...added])].slice(0, MAX_PLACES));
  }, []);
  const { state: plan, storedPerson, reload } = usePlan(client, subject, codes, assumptions, overrides, extraHabits);
  const refreshFromBank = useCallback(() => {
    void reload(true);
  }, [reload]);
  const { state: feed, retry: retryFeed } = useBankFeed(client, subject, refreshFromBank);
  const retryPlan = useCallback(() => {
    void reload(false);
  }, [reload]);
  const person = storedPerson;
  const trail = useMemo(
    () =>
      journey(
        {
          result: plan.result ?? null,
          placeCount: codes.length,
          bankMovements: feed.summary?.transactionCount ?? null,
          bankSynthetic: feed.summary?.synthetic ?? null,
        },
        locale,
      ),
    [plan.result, codes.length, feed.summary, locale],
  );
  const stored = subject.kind === 'me' || subject.kind === 'demo';
  const label =
    subject.kind === 'demo'
      ? subject.demoId
      : subject.kind === 'me'
        ? t('labelMe')
        : subject.kind === 'inline'
          ? t('labelWhatIf')
          : null;
  const dated = plan.result ? formatDate(plan.result.asOf, locale) : null;

  return (
    <main>
      <header className="masthead">
        <div className="masthead-top">
          <Wordmark />
          <LanguageSwitcher />
        </div>
        <h1>{t('heading')}</h1>
        <p className="lede">
          {subject.kind === 'me' && dated
            ? t('ledeMe', { date: dated })
            : subject.kind === 'demo' && dated
              ? t('ledeDemo', { name: subject.demoId, date: dated })
              : t('ledeGeneric')}
        </p>
      </header>

      {mode === 'fixture' ? (
        <p className="rc-note rc-note--warn fixture-banner">{rich(t('fixture'), { b: bold })}</p>
      ) : null}

      <SubjectBanner subject={subject} launch={launch} mode={mode} onSubject={setSubject} />

      <Journey journey={trail} />

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
          extraHabits={extraHabits}
          onAddWhatIfHabit={addWhatIfHabit}
          onRemoveWhatIfHabit={id => setExtraHabits(previous => previous.filter(habit => habit.id !== id))}
          includeProposed={includeProposed}
          onToggleHabit={(habit: Habit, on: boolean) => setOverrides(previous => ({ ...previous, [habit.id]: on }))}
          onIncludeProposed={setIncludeProposed}
          onReset={() => {
            setOverrides(noOverrides);
            setExtraHabits(noExtraHabits);
          }}
          onSubject={setSubject}
          onInline={(inline: Person) => setSubject({ kind: 'inline', person: inline })}
          onSaved={refreshFromBank}
          onRetry={retryPlan}
        />
        <PlacesPanel
          client={client}
          userId={label}
          person={person}
          codes={codes}
          plan={plan}
          includeUnverified={includeUnverified}
          onIncludeUnverified={setIncludeUnverified}
          onAdd={code => addPlaces([code])}
          onAddMany={addPlaces}
          onRemove={code => setCodes(previous => previous.filter(item => item !== code))}
          onRetry={retryPlan}
        />
      </div>

      {plan.result ? <Notes result={plan.result} /> : null}

      <footer className="foot">{shared('upfrontCashOnly')}</footer>
    </main>
  );
}
