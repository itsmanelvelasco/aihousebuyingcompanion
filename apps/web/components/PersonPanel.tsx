import { type FormEvent, useId, useState } from 'react';
import type { Habit, Person, PlanResult } from '../../../packages/contracts/planner.ts';
import { common } from '../../../packages/i18n/common.ts';
import { blankPerson } from '../../../packages/model/questions.ts';
import type { ToolClient } from '../client.ts';
import { formatDate, formatEuros, formatMonthly, formatShare } from '../format.ts';
import type { PlanState } from '../hooks.ts';
import { bold, rich, useLocale, useMessages } from '../i18n.tsx';
import type { Subject, WorkspaceLaunch } from '../launch.ts';
import { personMessages } from '../messages/person.messages.ts';
import type { HabitOverrides } from '../view-model.ts';
import {
  baselineMonthlySavingsCents,
  basisLabel,
  eurosToCents,
  habitMonthlyEffectCents,
  habitPlanView,
  habitStatusLabel,
  habitSwitchedOn,
} from '../view-model.ts';
import { Badge, ErrorNote, Icon, Monthly, Skeleton, Switch } from './bits.tsx';

type Props = {
  client: ToolClient;
  subject: Subject;
  launch: WorkspaceLaunch;
  mode: 'host' | 'standalone' | 'fixture';
  /** A label for whose figures these are, or null when nobody is selected. */
  userId: string | null;
  plan: PlanState;
  /** The person as stored; habit rows show these statuses, not the what-if ones. */
  person: Person | null;
  hasPlaces: boolean;
  overrides: HabitOverrides;
  includeProposed: boolean;
  onToggleHabit: (habit: Habit, on: boolean) => void;
  onIncludeProposed: (on: boolean) => void;
  onReset: () => void;
  onSubject: (subject: Subject) => void;
  /** Plan for a person typed into the page; nothing is stored. */
  onInline: (person: Person) => void;
  /** The signed-in person saved a detail: re-read the plan. */
  onSaved: () => void;
  onRetry: () => void;
};

const euroFields = [
  { name: 'income', label: 'fieldIncome' },
  { name: 'expenses', label: 'fieldExpenses' },
  { name: 'savings', label: 'fieldSavings' },
  { name: 'budget', label: 'fieldBudget' },
] as const;

/** The id `blankPerson` gives a person typed into the page: its name is the workspace's own words. */
const WHAT_IF_ID = 'what-if';

/** Four money fields in whole euros. The values go to the server as integer cents; no sum is made here. */
function FiguresForm(props: {
  submit: string;
  /** Whether this form's button is the main action of its panel; a panel shows one primary button. */
  primary?: boolean;
  busy?: boolean;
  onSubmit: (cents: Record<string, number | undefined>) => void;
}) {
  const t = useMessages(personMessages);
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    props.onSubmit(
      Object.fromEntries(euroFields.map(({ name }) => [name, eurosToCents(String(form.get(name) ?? ''))])),
    );
  };
  return (
    <form className="figures-form" onSubmit={onSubmit}>
      {euroFields.map(field => (
        <label key={field.name} className="rc-field">
          {t(field.label)}
          <input name={field.name} inputMode="decimal" autoComplete="off" />
        </label>
      ))}
      <button
        type="submit"
        className={props.primary ? 'rc-btn rc-btn--primary rc-btn--sm' : 'rc-btn rc-btn--sm'}
        disabled={props.busy}
        aria-busy={props.busy || undefined}
      >
        {props.submit}
      </button>
    </form>
  );
}

/** Nobody is selected: say what signing in gives, offer the demo personas and a what-if that stores nothing. */
function NoPerson(props: Props) {
  const { launch, mode } = props;
  const t = useMessages(personMessages);
  const whatIf = (cents: Record<string, number | undefined>) =>
    props.onInline({
      id: WHAT_IF_ID,
      displayName: t('whatIfName'),
      synthetic: false,
      householdSize: null,
      currentMunicipalityCode: null,
      finances: {
        monthlyIncomeCents: cents.income ?? null,
        monthlyExpensesCents: cents.expenses ?? null,
        currentSavingsCents: cents.savings ?? null,
        emergencyReserveCents: 0,
        basis: 'declared',
        asOf: null,
      },
      home: { floorAreaM2: null, budgetCents: cents.budget ?? null, depositRate: 0.2 },
      habits: [],
    });
  return (
    <div className="rc-note no-person">
      <p>
        {mode === 'host'
          ? rich(t('notSignedInHost'), { b: bold })
          : rich(t('notSignedInPages'), {
              b: bold,
              a: children => <a href="/login?next=%2Fworkspace">{children}</a>,
              a2: children => <a href="/signup?next=%2Fworkspace">{children}</a>,
            })}
      </p>
      {launch.demoIds.length ? (
        <>
          <p>{t('demoOffer')}</p>
          <div className="choices">
            {launch.demoIds.map(id => (
              <button
                key={id}
                type="button"
                className="rc-btn rc-btn--sm"
                onClick={() => props.onSubject({ kind: 'demo', demoId: id })}
              >
                {id}
              </button>
            ))}
          </div>
        </>
      ) : null}
      <p>{t('answerYourself')}</p>
      <div className="choices">
        <button
          type="button"
          className="rc-btn rc-btn--primary rc-btn--sm"
          onClick={() => props.onInline({ ...blankPerson(WHAT_IF_ID), displayName: t('whatIfName') })}
        >
          {t('startEstimate')}
        </button>
      </div>
      <details>
        <summary>{t('fourFigures')}</summary>
        <FiguresForm submit={t('showEstimate')} onSubmit={whatIf} />
      </details>
    </div>
  );
}

/** What the last save did. A failure the server explained is kept as received; the rest are the panel's own words. */
type SaveState = {
  busy: boolean;
  failed: boolean;
  message: 'enterOne' | 'savedToProfile' | 'couldNotSave' | null;
  reason?: string;
};

/** The signed-in person can add details to their own profile; a demo persona and a what-if cannot be saved. */
function SaveDetails(props: Props) {
  const t = useMessages(personMessages);
  const [state, setState] = useState<SaveState>({ busy: false, message: null, failed: false });
  const save = async (cents: Record<string, number | undefined>) => {
    const finance = {
      ...(cents.income === undefined ? {} : { monthlyIncomeCents: cents.income }),
      ...(cents.expenses === undefined ? {} : { monthlyExpensesCents: cents.expenses }),
      ...(cents.savings === undefined ? {} : { currentSavingsCents: cents.savings }),
    };
    const data = {
      ...(Object.keys(finance).length ? { finance } : {}),
      ...(cents.budget ? { housing: { tenure: 'buy', budgetCents: cents.budget } } : {}),
    };
    if (!Object.keys(data).length) return setState({ busy: false, message: 'enterOne', failed: true });
    setState({ busy: true, message: null, failed: false });
    try {
      await props.client.saveInputs(data, true);
      setState({ busy: false, message: 'savedToProfile', failed: false });
      props.onSaved();
    } catch (error) {
      setState({
        busy: false,
        message: 'couldNotSave',
        failed: true,
        ...(error instanceof Error && error.message ? { reason: error.message } : {}),
      });
    }
  };
  return (
    <details className="save-details">
      <summary>{t('addOrCorrect')}</summary>
      <p className="hint">{t('savedAsConfirmed')}</p>
      <FiguresForm submit={t('saveFigures')} primary busy={state.busy} onSubmit={cents => void save(cents)} />
      {state.message ? (
        <p className={state.failed ? 'hint hint-warn' : 'hint'} role="status">
          {state.reason ?? t(state.message)}
        </p>
      ) : null}
    </details>
  );
}

export function PersonPanel(props: Props) {
  const { plan, person } = props;
  const t = useMessages(personMessages);
  const shared = useMessages(common);
  return (
    <section className="panel person" aria-labelledby="person-title" aria-busy={plan.refreshing}>
      <header className="panel-head">
        <h2 id="person-title">
          <Icon name="person" />
          {t('title')}
        </h2>
        {person?.synthetic ? (
          <Badge tone="violet" title={t('fictionalTitle')}>
            {t('fictionalBadge')}
          </Badge>
        ) : props.subject.kind === 'me' ? (
          <Badge tone="ok" title={t('yourProfileTitle')}>
            {t('yourProfileBadge')}
          </Badge>
        ) : null}
      </header>
      {props.subject.kind === 'none' ? (
        <NoPerson {...props} />
      ) : !person && plan.phase === 'error' && plan.error?.kind === 'signin' ? (
        <p className="rc-note rc-note--warn">
          <strong>{t('signInOwnPlan')}</strong> {plan.error.message}{' '}
          {props.mode === 'host' ? null : <a href="/login?next=%2Fworkspace">{shared('signIn')}</a>}
        </p>
      ) : !person && plan.phase === 'error' && plan.error ? (
        <ErrorNote title={t('loadPersonFailed')} error={plan.error} onRetry={props.onRetry} />
      ) : !person && !props.hasPlaces ? (
        <>
          <p className="rc-note">{rich(t('showing'), { b: bold, who: props.userId })}</p>
          {props.subject.kind === 'me' ? <SaveDetails {...props} /> : null}
        </>
      ) : !person ? (
        <>
          <p className="rc-sr-only" role="status">
            {t('loadingFigures')}
          </p>
          <Skeleton lines={6} />
        </>
      ) : (
        <>
          <PersonDetails {...props} person={person} result={plan.result} />
          {props.subject.kind === 'me' ? <SaveDetails {...props} /> : null}
        </>
      )}
    </section>
  );
}

function PersonDetails(props: Props & { person: Person; result: PlanResult | null }) {
  const { person, result, overrides, includeProposed } = props;
  const { finances, home } = person;
  const locale = useLocale();
  const t = useMessages(personMessages);
  const noteId = useId();
  const baselineSaving = result ? baselineMonthlySavingsCents(result) : null;
  const habitEffect = result ? habitMonthlyEffectCents(result) : null;
  const edited = Object.keys(overrides).length > 0;
  const hasProposed = person.habits.some(habit => habit.status === 'proposed');
  const currentTown =
    result?.plans.find(plan => plan.place.municipalityCode === person.currentMunicipalityCode)?.place.name ??
    (person.currentMunicipalityCode ? t('municipalityCode', { code: person.currentMunicipalityCode }) : null);
  const deposit = formatShare(home.depositRate, locale);

  return (
    <div className="person-body">
      <div className="person-facts">
        <p className="person-name">
          {person.id === WHAT_IF_ID && !person.synthetic ? t('whatIfName') : (person.displayName ?? person.id)}
        </p>
        <p className="muted">
          <Icon name="household" />{' '}
          {person.householdSize === null ? t('householdUnknown') : t('householdOf', { count: person.householdSize })}
          {' · '}
          {currentTown ? t('livesIn', { town: currentTown }) : t('townUnknown')}
        </p>
        <dl className="figures">
          <div>
            <dt>{t('income')}</dt>
            <dd className={finances.monthlyIncomeCents === null ? 'unknown' : undefined}>
              <Monthly cents={finances.monthlyIncomeCents} />
            </dd>
          </div>
          <div>
            <dt>{t('expenses')}</dt>
            <dd className={finances.monthlyExpensesCents === null ? 'unknown' : undefined}>
              <Monthly cents={finances.monthlyExpensesCents} />
            </dd>
          </div>
          <div>
            <dt>{t('savingsToday')}</dt>
            <dd className={finances.currentSavingsCents === null ? 'unknown' : undefined}>
              {formatEuros(finances.currentSavingsCents, locale)}
            </dd>
          </div>
          <div>
            <dt>{t('emergencyReserve')}</dt>
            <dd>
              {formatEuros(finances.emergencyReserveCents, locale)} <small>{t('keptAside')}</small>
            </dd>
          </div>
          <div className="figure-key">
            <dt>{t('savedEachMonth')}</dt>
            <dd className={baselineSaving === null ? 'unknown' : undefined}>
              {baselineSaving === null ? t('notEstimated') : <Monthly cents={baselineSaving} />}{' '}
              <small>{t('beforeHabits')}</small>
            </dd>
          </div>
        </dl>
        <p className="provenance">
          <strong>{basisLabel(finances.basis, locale)}.</strong>{' '}
          {finances.bankSynthetic === true && !person.synthetic ? `${t('fictionalFeed')} ` : null}
          {finances.asOf ? t('figuresAsOf', { date: formatDate(finances.asOf, locale) }) : t('figuresDateUnknown')}{' '}
          {home.budgetCents !== null
            ? t('homeBudget', { budget: formatEuros(home.budgetCents, locale), deposit })
            : home.floorAreaM2 !== null
              ? t('homeArea', { area: home.floorAreaM2, deposit })
              : t('homeUnknown', { deposit })}
        </p>
      </div>

      <div className="habits">
        <div className="habits-head">
          <h3>{t('habits')}</h3>
          <span className="muted">
            {habitEffect === null
              ? t('effectNotEstimated')
              : t('addingInPlan', { amount: formatMonthly(habitEffect, locale) })}
          </span>
        </div>
        {person.habits.length === 0 ? (
          <p className="rc-note">{t('noHabits')}</p>
        ) : (
          <ul className="habit-list">
            {person.habits.map(habit => {
              const on = habitSwitchedOn(habit, includeProposed, overrides);
              const changed = overrides[habit.id] !== undefined && on !== habitSwitchedOn(habit, includeProposed);
              // What the plan did with it comes from the plan, never from the habit's status.
              const verdict = habitPlanView(habit, result, on, locale);
              return (
                <li key={habit.id} className={verdict.state === 'counted' ? 'habit habit-on' : 'habit'}>
                  <Switch checked={on} onChange={value => props.onToggleHabit(habit, value)} describedBy={noteId}>
                    <span className="habit-title">{habit.title}</span>
                    <span className="habit-meta">
                      <span className={habit.monthlySavingCents === null ? 'habit-saving unknown' : 'habit-saving'}>
                        {habit.monthlySavingCents === null
                          ? t('noSavingAssumed')
                          : formatMonthly(habit.monthlySavingCents, locale)}
                      </span>
                      <Badge tone={habit.status === 'active' ? 'ok' : habit.status === 'proposed' ? 'warn' : 'off'}>
                        {habitStatusLabel(habit.status, locale)}
                      </Badge>
                      {verdict.label ? (
                        <Badge
                          tone={verdict.state === 'counted' ? 'ok' : 'warn'}
                          title={verdict.explanation ?? undefined}
                        >
                          {verdict.label}
                        </Badge>
                      ) : null}
                      {changed ? <Badge tone="violet">{on ? t('switchedOn') : t('switchedOff')}</Badge> : null}
                    </span>
                    {verdict.state === 'withheld' && verdict.explanation ? (
                      <span className="habit-note">{verdict.explanation}</span>
                    ) : null}
                    <span className="adherence">
                      {habit.adherence === null ? (
                        t('noCheckIns')
                      ) : (
                        <>
                          <span className="meter" aria-hidden="true">
                            <span style={{ width: `${Math.round(habit.adherence * 100)}%` }} />
                          </span>
                          {t('checkInsKept', { share: formatShare(habit.adherence, locale) })}
                        </>
                      )}
                    </span>
                  </Switch>
                </li>
              );
            })}
          </ul>
        )}
        <div className="habit-controls">
          <Switch checked={includeProposed} onChange={props.onIncludeProposed} disabled={!hasProposed}>
            {t('includeProposed')}
          </Switch>
          {edited ? (
            <button type="button" className="rc-btn rc-btn--quiet rc-btn--sm" onClick={props.onReset}>
              {t('resetHabits')}
            </button>
          ) : null}
        </div>
        <p id={noteId} className="hint">
          {t('switchesNote')}
        </p>
      </div>
    </div>
  );
}
