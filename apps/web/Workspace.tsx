import { useCallback, useMemo, useState } from 'react';
import type { Habit, Person } from '../../packages/contracts/planner.ts';
import { common } from '../../packages/i18n/common.ts';
import type { ToolClient } from './client.ts';
import { BankStrip } from './components/BankStrip.tsx';
import { Wordmark } from './components/bits.tsx';
import { DetailsPanel } from './components/DetailsPanel.tsx';
import { Journey } from './components/Journey.tsx';
import { Notes } from './components/Notes.tsx';
import { PersonPanel } from './components/PersonPanel.tsx';
import { PlacesPanel } from './components/PlacesPanel.tsx';
import { formatDate } from './format.ts';
import { useBankFeed, usePlan } from './hooks.ts';
import { bold, LanguageSwitcher, rich, useLocale, useMessages } from './i18n.tsx';
import { journey } from './journey.ts';
import type { Subject, WorkspaceLaunch } from './launch.ts';
import { subjectOf } from './launch.ts';
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

      <footer className="foot">{shared('upfrontCashOnly')}</footer>
    </main>
  );
}
