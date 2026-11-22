import { type FormEvent, useId, useState } from 'react';
import type { Habit, Person, PlanResult } from '../../../packages/contracts/planner.ts';
import type { ToolClient } from '../client.ts';
import { formatDate, formatEuros, formatMonthly, formatShare } from '../format.ts';
import type { PlanState } from '../hooks.ts';
import type { Subject, WorkspaceLaunch } from '../launch.ts';
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
import { Badge, ErrorNote, Icon, Skeleton, Switch } from './bits.tsx';

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
  { name: 'income', label: 'Monthly income, €' },
  { name: 'expenses', label: 'Monthly expenses, €' },
  { name: 'savings', label: 'Savings today, €' },
  { name: 'budget', label: 'Home budget, €' },
] as const;

/** Four money fields in whole euros. The values go to the server as integer cents; no sum is made here. */
function FiguresForm(props: {
  submit: string;
  busy?: boolean;
  onSubmit: (cents: Record<string, number | undefined>) => void;
}) {
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
          {field.label}
          <input name={field.name} inputMode="decimal" autoComplete="off" />
        </label>
      ))}
      <button type="submit" className="rc-btn rc-btn--primary rc-btn--sm" disabled={props.busy}>
        {props.submit}
      </button>
    </form>
  );
}

/** Nobody is selected: say what signing in gives, offer the demo personas and a what-if that stores nothing. */
function NoPerson(props: Props) {
  const { launch, mode } = props;
  const whatIf = (cents: Record<string, number | undefined>) =>
    props.onInline({
      id: 'what-if',
      displayName: 'What-if estimate',
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
        <strong>You are not signed in.</strong> With an account your own answers, bank summary and habits are kept
        privately and this page plans from them; assistants you connect can read and save them only with your
        permission.{' '}
        {mode === 'host' ? (
          'Ask ReloCat in the chat to connect your account.'
        ) : (
          <>
            <a href="/login?next=%2Fworkspace">Sign in</a> or <a href="/signup?next=%2Fworkspace">create an account</a>.
          </>
        )}
      </p>
      {launch.demoIds.length ? (
        <>
          <p>Or look at a fictional demo persona (invented figures, read-only):</p>
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
      <details>
        <summary>Try a what-if with your own numbers (nothing is saved)</summary>
        <FiguresForm submit="Estimate" onSubmit={whatIf} />
      </details>
    </div>
  );
}

/** The signed-in person can add details to their own profile; a demo persona and a what-if cannot be saved. */
function SaveDetails(props: Props) {
  const [state, setState] = useState<{ busy: boolean; message: string | null; failed: boolean }>({
    busy: false,
    message: null,
    failed: false,
  });
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
    if (!Object.keys(data).length)
      return setState({ busy: false, message: 'Enter at least one figure.', failed: true });
    setState({ busy: true, message: null, failed: false });
    try {
      await props.client.saveInputs(data, true);
      setState({ busy: false, message: 'Saved to your profile.', failed: false });
      props.onSaved();
    } catch (error) {
      setState({ busy: false, message: error instanceof Error ? error.message : 'Could not save.', failed: true });
    }
  };
  return (
    <details className="save-details">
      <summary>Add or correct your figures</summary>
      <p className="hint">Saved to your own profile as confirmed by you. Leave a field empty to keep what is stored.</p>
      <FiguresForm submit="Save" busy={state.busy} onSubmit={cents => void save(cents)} />
      {state.message ? (
        <p className={state.failed ? 'hint hint-warn' : 'hint'} role="status">
          {state.message}
        </p>
      ) : null}
    </details>
  );
}

export function PersonPanel(props: Props) {
  const { plan, person } = props;
  return (
    <section className="panel person" aria-labelledby="person-title" aria-busy={plan.refreshing}>
      <header className="panel-head">
        <h2 id="person-title">
          <Icon name="person" />
          Who is planning
        </h2>
        {person?.synthetic ? (
          <Badge tone="violet" title="A fictional profile created for the demo.">
            Fictional demo profile
          </Badge>
        ) : props.subject.kind === 'me' ? (
          <Badge tone="ok" title="Your own profile, kept in your account.">
            Your profile
          </Badge>
        ) : null}
      </header>
      {props.subject.kind === 'none' ? (
        <NoPerson {...props} />
      ) : !person && plan.phase === 'error' && plan.error?.kind === 'signin' ? (
        <p className="rc-note rc-note--warn">
          <strong>Sign in to see your own plan.</strong> {plan.error.message}{' '}
          {props.mode === 'host' ? null : <a href="/login?next=%2Fworkspace">Sign in</a>}
        </p>
      ) : !person && plan.phase === 'error' && plan.error ? (
        <ErrorNote title="Could not load this person" error={plan.error} onRetry={props.onRetry} />
      ) : !person && !props.hasPlaces ? (
        <>
          <p className="rc-note">
            Showing <strong>{props.userId}</strong>. The figures load with the plan: add a place to compare first.
          </p>
          {props.subject.kind === 'me' ? <SaveDetails {...props} /> : null}
        </>
      ) : !person ? (
        <>
          <p className="rc-sr-only" role="status">
            Loading the person's figures…
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
  const noteId = useId();
  const baselineSaving = result ? baselineMonthlySavingsCents(result) : null;
  const habitEffect = result ? habitMonthlyEffectCents(result) : null;
  const edited = Object.keys(overrides).length > 0;
  const hasProposed = person.habits.some(habit => habit.status === 'proposed');
  const currentTown =
    result?.plans.find(plan => plan.place.municipalityCode === person.currentMunicipalityCode)?.place.name ??
    (person.currentMunicipalityCode ? `municipality ${person.currentMunicipalityCode}` : null);

  return (
    <div className="person-body">
      <div className="person-facts">
        <p className="person-name">{person.displayName ?? person.id}</p>
        <p className="muted">
          <Icon name="household" />{' '}
          {person.householdSize === null ? 'Household size unknown' : `Household of ${person.householdSize}`}
          {' · '}
          {currentTown ? `lives in ${currentTown}` : 'current town unknown'}
        </p>
        <dl className="figures">
          <div>
            <dt>Income</dt>
            <dd className={finances.monthlyIncomeCents === null ? 'unknown' : undefined}>
              {formatMonthly(finances.monthlyIncomeCents)}
            </dd>
          </div>
          <div>
            <dt>Expenses</dt>
            <dd className={finances.monthlyExpensesCents === null ? 'unknown' : undefined}>
              {formatMonthly(finances.monthlyExpensesCents)}
            </dd>
          </div>
          <div>
            <dt>Savings today</dt>
            <dd className={finances.currentSavingsCents === null ? 'unknown' : undefined}>
              {formatEuros(finances.currentSavingsCents)}
            </dd>
          </div>
          <div>
            <dt>Emergency reserve</dt>
            <dd>
              {formatEuros(finances.emergencyReserveCents)} <small>kept aside, not spent on the purchase</small>
            </dd>
          </div>
          <div>
            <dt>Saved each month</dt>
            <dd className={baselineSaving === null ? 'unknown' : undefined}>
              {baselineSaving === null ? 'Not estimated' : formatMonthly(baselineSaving)}{' '}
              <small>before habits, as the plan computes it</small>
            </dd>
          </div>
        </dl>
        <p className="provenance">
          <strong>{basisLabel(finances.basis)}.</strong>{' '}
          {finances.bankSynthetic === true && !person.synthetic
            ? 'Those bank movements come from a fictional bank feed, not a real bank. '
            : null}
          {finances.asOf ? `Figures as of ${formatDate(finances.asOf)}.` : 'The date of these figures is unknown.'}{' '}
          {home.budgetCents !== null
            ? `Looking for a home up to ${formatEuros(home.budgetCents)}`
            : home.floorAreaM2 !== null
              ? `Looking for about ${home.floorAreaM2} m², priced from each place's average`
              : 'Home size and budget unknown'}
          {`, with a ${formatShare(home.depositRate)} deposit.`}
        </p>
      </div>

      <div className="habits">
        <div className="habits-head">
          <h3>Habits</h3>
          <span className="muted">
            {habitEffect === null
              ? 'Effect on the plan not estimated'
              : `Adding ${formatMonthly(habitEffect)} in this plan`}
          </span>
        </div>
        {person.habits.length === 0 ? (
          <p className="rc-note">No habits recorded yet. Savings habits agreed in the chat appear here.</p>
        ) : (
          <ul className="habit-list">
            {person.habits.map(habit => {
              const on = habitSwitchedOn(habit, includeProposed, overrides);
              const changed = overrides[habit.id] !== undefined && on !== habitSwitchedOn(habit, includeProposed);
              // What the plan did with it comes from the plan, never from the habit's status.
              const verdict = habitPlanView(habit, result, on);
              return (
                <li key={habit.id} className={verdict.state === 'counted' ? 'habit habit-on' : 'habit'}>
                  <Switch checked={on} onChange={value => props.onToggleHabit(habit, value)} describedBy={noteId}>
                    <span className="habit-title">{habit.title}</span>
                    <span className="habit-meta">
                      <span className={habit.monthlySavingCents === null ? 'habit-saving unknown' : 'habit-saving'}>
                        {habit.monthlySavingCents === null
                          ? 'No saving assumed'
                          : formatMonthly(habit.monthlySavingCents)}
                      </span>
                      <Badge tone={habit.status === 'active' ? 'ok' : habit.status === 'proposed' ? 'warn' : 'off'}>
                        {habitStatusLabel(habit.status)}
                      </Badge>
                      {verdict.label ? (
                        <Badge
                          tone={verdict.state === 'counted' ? 'ok' : 'warn'}
                          title={verdict.explanation ?? undefined}
                        >
                          {verdict.label}
                        </Badge>
                      ) : null}
                      {changed ? (
                        <Badge tone="violet">{on ? 'Switched on in what-if' : 'Switched off in what-if'}</Badge>
                      ) : null}
                    </span>
                    {verdict.state === 'withheld' && verdict.explanation ? (
                      <span className="habit-note">{verdict.explanation}</span>
                    ) : null}
                    <span className="adherence">
                      {habit.adherence === null ? (
                        'No check-ins yet'
                      ) : (
                        <>
                          <span className="meter" aria-hidden="true">
                            <span style={{ width: `${Math.round(habit.adherence * 100)}%` }} />
                          </span>
                          {formatShare(habit.adherence)} of check-ins kept
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
            Include proposed habits
          </Switch>
          {edited ? (
            <button type="button" className="rc-btn rc-btn--quiet rc-btn--sm" onClick={props.onReset}>
              Reset to stored habits
            </button>
          ) : null}
        </div>
        <p id={noteId} className="hint">
          Switches re-run the plan as a what-if. They do not change what is stored.
        </p>
      </div>
    </div>
  );
}
