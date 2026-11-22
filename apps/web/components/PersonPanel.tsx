import { useId } from 'react';
import type { Habit, Person, PlanResult } from '../../../packages/contracts/planner.ts';
import { formatDate, formatEuros, formatMonthly, formatShare } from '../format.ts';
import type { PlanState } from '../hooks.ts';
import type { HabitOverrides } from '../view-model.ts';
import {
  baselineMonthlySavingsCents,
  basisLabel,
  habitCounted,
  habitMonthlyEffectCents,
  habitStatusLabel,
} from '../view-model.ts';
import { Badge, ErrorNote, Skeleton, Switch } from './bits.tsx';

const demoProfiles = ['user-001', 'user-002', 'user-003', 'user-004'];

type Props = {
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
  onChooseUser: (userId: string) => void;
  onRetry: () => void;
};

export function PersonPanel(props: Props) {
  const { plan, person } = props;
  return (
    <section className="panel person" aria-labelledby="person-title" aria-busy={plan.refreshing}>
      <header className="panel-head">
        <h2 id="person-title">Who is planning</h2>
        {person?.synthetic ? (
          <Badge tone="violet" title="A fictional profile created for the demo.">
            Synthetic profile
          </Badge>
        ) : null}
      </header>
      {!props.userId ? (
        <div className="note">
          <p>
            <strong>No person selected.</strong> Ask ReloCat in the chat to open the workspace for a profile, or pick
            one of the synthetic demo profiles.
          </p>
          <div className="choices">
            {demoProfiles.map(id => (
              <button key={id} type="button" className="button" onClick={() => props.onChooseUser(id)}>
                {id}
              </button>
            ))}
          </div>
        </div>
      ) : !person && plan.phase === 'error' && plan.error ? (
        <ErrorNote title="Could not load this person" error={plan.error} onRetry={props.onRetry} />
      ) : !person && !props.hasPlaces ? (
        <p className="note">
          Profile <strong>{props.userId}</strong>. The figures load with the plan: add a place to compare first.
        </p>
      ) : !person ? (
        <>
          <p className="visually-hidden" role="status">
            Loading the person's figures…
          </p>
          <Skeleton lines={6} />
        </>
      ) : (
        <PersonDetails {...props} person={person} result={plan.result} />
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
          <p className="note">No habits recorded yet. Savings habits agreed in the chat appear here.</p>
        ) : (
          <ul className="habit-list">
            {person.habits.map(habit => {
              const on = habitCounted(habit, includeProposed, overrides);
              const changed = overrides[habit.id] !== undefined && on !== habitCounted(habit, includeProposed);
              return (
                <li key={habit.id} className={on ? 'habit habit-on' : 'habit'}>
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
                      {changed ? (
                        <Badge tone="violet">{on ? 'Counted in what-if' : 'Left out in what-if'}</Badge>
                      ) : null}
                    </span>
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
            <button type="button" className="link-button" onClick={props.onReset}>
              Reset to stored habits
            </button>
          ) : null}
        </div>
        <p id={noteId} className="hint">
          Switches re-run the plan as a what-if. Nothing is saved to the profile.
        </p>
      </div>
    </div>
  );
}
