import { useEffect, useId, useState } from 'react';
import type { PlaceBenefit, PlacePlan } from '../../../packages/contracts/planner.ts';
import type { IconName } from '../../../packages/ui/icons.ts';
import type { Municipality, ToolClient } from '../client.ts';
import { ToolError } from '../client.ts';
import { formatEuros, formatMonthly } from '../format.ts';
import type { PlanState } from '../hooks.ts';
import type { TimelineStep } from '../view-model.ts';
import {
  benefitSummary,
  benefitView,
  indicatorViews,
  longestTimeline,
  planHeadline,
  ruralLabel,
  serviceLabel,
  timelineSteps,
} from '../view-model.ts';
import { Badge, ErrorNote, Icon, Skeleton, Source, Switch } from './bits.tsx';

const MAX_PLACES = 8;

const serviceIcons: Record<PlacePlan['place']['services'][number]['kind'], IconName> = {
  primary_care: 'health',
  hospital: 'hospital',
  pharmacy: 'pharmacy',
  school: 'school',
  library: 'library',
  rail_station: 'train',
  retail: 'shop',
  sports: 'sports',
  social_services: 'household',
};

type Props = {
  client: ToolClient;
  userId: string | null;
  codes: string[];
  plan: PlanState;
  includeUnverified: boolean;
  onIncludeUnverified: (on: boolean) => void;
  onAdd: (code: string) => void;
  onRemove: (code: string) => void;
  onRetry: () => void;
};

export function PlacesPanel(props: Props) {
  const { plan, codes } = props;
  const plans = plan.result?.plans ?? [];
  const scale = longestTimeline(plans);
  const shown = new Set(plans.map(item => item.place.municipalityCode));
  const pending = plan.refreshing ? codes.filter(code => !shown.has(code)) : [];
  const missing = !plan.refreshing && plan.result ? codes.filter(code => !shown.has(code)) : [];

  return (
    <section className="panel places" aria-labelledby="places-title" aria-busy={plan.refreshing}>
      <header className="panel-head">
        <h2 id="places-title">
          <Icon name="compare" />
          Places compared
        </h2>
        <span className="muted" role="status">
          {plan.refreshing && plan.result
            ? 'Updating the plan…'
            : plans.length
              ? `${plans.length} ${plans.length === 1 ? 'place' : 'places'}, shortest timeline first`
              : ''}
        </span>
      </header>

      {plans.length > 0 ? (
        <div className="legend" aria-hidden="true">
          <span className="key key-baseline">Baseline</span>
          <span className="key key-habits">With habits</span>
          <span className="key key-place">With this place's benefits</span>
        </div>
      ) : null}

      {plan.error && plan.result ? (
        <ErrorNote title="The plan could not be updated" error={plan.error} onRetry={props.onRetry} compact />
      ) : null}

      {!props.userId ? (
        <p className="rc-note">Choose who is planning to compare places.</p>
      ) : codes.length === 0 ? (
        <div className="rc-empty">
          <div className="rc-art empty-art" aria-hidden="true" />
          <p>
            <strong>No places to compare yet.</strong> Add a municipality below, or ask ReloCat in the chat for towns
            that fit and open them here.
          </p>
        </div>
      ) : plan.phase === 'error' && plan.error ? (
        <ErrorNote title="Could not load the plan" error={plan.error} onRetry={props.onRetry} />
      ) : plan.phase === 'loading' ? (
        <>
          <p className="rc-sr-only" role="status">
            Loading the plan…
          </p>
          <ol className="place-list">
            {codes.map(code => (
              <li key={code} className="place">
                <Skeleton lines={4} />
              </li>
            ))}
          </ol>
        </>
      ) : plans.length === 0 && pending.length === 0 ? (
        <p className="rc-note">
          <strong>The plan returned no places.</strong> The codes sent ({codes.join(', ')}) may be outside the pilot
          data. Remove them or add another municipality.
        </p>
      ) : (
        <ol className={plan.refreshing ? 'place-list is-refreshing' : 'place-list'}>
          {plans.map((item, index) => (
            <PlaceCard
              key={item.place.municipalityCode}
              plan={item}
              rank={index + 1}
              scale={scale}
              onRemove={() => props.onRemove(item.place.municipalityCode)}
            />
          ))}
          {pending.map(code => (
            <li key={code} className="place">
              <Skeleton lines={4} />
            </li>
          ))}
        </ol>
      )}

      {missing.length > 0 && plans.length > 0 ? (
        <p className="rc-note rc-note--warn">
          No plan came back for {missing.join(', ')}.{' '}
          {missing.map(code => (
            <button
              key={code}
              type="button"
              className="rc-btn rc-btn--quiet rc-btn--sm"
              onClick={() => props.onRemove(code)}
            >
              Remove {code}
            </button>
          ))}
        </p>
      ) : null}

      {props.userId ? (
        <div className="places-foot">
          <AddPlace client={props.client} codes={codes} onAdd={props.onAdd} />
          <Switch checked={props.includeUnverified} onChange={props.onIncludeUnverified}>
            Count benefits that still need verification
          </Switch>
          {props.includeUnverified ? (
            <p className="hint hint-warn">
              Unverified benefits are now counted. These timelines assume aid that has not been confirmed.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PlaceCard(props: { plan: PlacePlan; rank: number; scale: number; onRemove: () => void }) {
  const { plan } = props;
  const { place } = plan;
  const headline = planHeadline(plan);
  const steps = timelineSteps(plan, props.scale);
  const rural = ruralLabel(place.rural);
  const gaps = new Set([...plan.dataMissing, ...place.dataMissing]);
  const titleId = useId();

  return (
    <li className="place">
      <div className="place-head">
        <span className="rank" aria-hidden="true">
          {props.rank}
        </span>
        <div className="place-title">
          <h3 id={titleId}>{place.name}</h3>
          <p className="muted">
            {place.comarca}
            {rural ? ` · ${rural}` : ''} · code {place.municipalityCode}
          </p>
        </div>
        <p className={`headline headline-${headline.tone}`}>{headline.headline}</p>
      </div>
      <p className="price">{headline.priceText}.</p>

      <ol className="steps" aria-labelledby={titleId}>
        {steps.map(step => (
          <StepRow key={step.key} step={step} />
        ))}
      </ol>

      {headline.tone === 'ok' || headline.tone === 'reached' ? (
        <dl className="saved">
          <div className="saved-habits">
            <dt>Habits</dt>
            <dd>{headline.savedByHabitsText}</dd>
          </div>
          <div className="saved-place">
            <dt>This place</dt>
            <dd>{headline.savedByPlaceText}</dd>
          </div>
          <div>
            <dt>Against baseline</dt>
            <dd>{headline.savedTotalText}</dd>
          </div>
        </dl>
      ) : (
        <p className="rc-note rc-note--warn">
          {headline.tone === 'none'
            ? 'At the current rate nothing is saved each month, so the upfront cash is never reached. This is not zero months: there is no end date to show.'
            : 'The planner could not estimate this place. See the missing data below.'}
        </p>
      )}

      <details className="place-details">
        <summary>
          <span>Indicators, services and benefits</span>
          <span className="summary-meta">
            {benefitSummary(plan.benefits)}
            {gaps.size ? ` · ${gaps.size} data ${gaps.size === 1 ? 'gap' : 'gaps'}` : ''}
          </span>
        </summary>

        <h4>Indicators</h4>
        <dl className="indicators">
          {indicatorViews(place).map(item => (
            <div key={item.key}>
              <dt>{item.label}</dt>
              <dd className={item.known ? undefined : 'unknown'}>{item.value}</dd>
              {item.sourceUrl ? (
                <Source url={item.sourceUrl} observedAt={item.observedAt} geography={item.geography} />
              ) : (
                <small className="source">No figure in the data</small>
              )}
            </div>
          ))}
        </dl>

        <h4>Services in the municipality</h4>
        {place.services.length === 0 ? (
          <p className="muted">No service counts in the data. That is unknown, not zero.</p>
        ) : (
          <ul className="services">
            {place.services.map(item => (
              <li key={item.kind}>
                <Icon name={serviceIcons[item.kind]} />
                <span className="service-count">{item.count}</span>
                <span>
                  {serviceLabel(item.kind)}
                  <Source url={item.sourceUrl} observedAt={item.observedAt} label="source" />
                </span>
              </li>
            ))}
          </ul>
        )}
        {place.services.length > 0 ? <p className="hint">A kind that is not listed is unknown, not zero.</p> : null}

        <h4>Benefits</h4>
        {plan.benefits.length === 0 ? (
          <p className="muted">No benefits are listed for this place in the data.</p>
        ) : (
          <ul className="benefits">
            {plan.benefits.map(benefit => (
              <BenefitRow key={benefit.policyId} benefit={benefit} />
            ))}
          </ul>
        )}

        {plan.assumptions.length > 0 ? (
          <>
            <h4>Assumed for this place</h4>
            <ul className="plain-list">
              {plan.assumptions.map(text => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </>
        ) : null}
        {gaps.size > 0 ? (
          <>
            <h4>Missing data</h4>
            <ul className="plain-list gaps">
              {[...gaps].map(text => (
                <li key={text}>
                  <Icon name="help" />
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        <button type="button" className="rc-btn rc-btn--quiet rc-btn--sm remove" onClick={props.onRemove}>
          <Icon name="close" />
          Remove {place.name} from the comparison
        </button>
      </details>
    </li>
  );
}

function StepRow({ step }: { step: TimelineStep }) {
  const hasBar = step.barPercent !== null;
  return (
    <li className={`step step-${step.key} step-${step.state}`}>
      <div className="step-head">
        <span className="step-label">{step.label}</span>
        <span className="step-value">{step.text}</span>
      </div>
      <div className={hasBar ? 'track' : 'track track-empty'} aria-hidden="true">
        {hasBar ? <span className="fill" style={{ width: `${step.barPercent}%` }} /> : null}
      </div>
      <p className="step-foot">
        {step.state === 'not_estimated' ? (
          'No estimate for this step'
        ) : (
          <>
            {formatEuros(step.upfrontCashCents)} upfront ·{' '}
            {step.monthlySavingsCents !== null && step.monthlySavingsCents < 0
              ? `${formatMonthly(-step.monthlySavingsCents)} short`
              : `${formatMonthly(step.monthlySavingsCents)} saved`}
          </>
        )}
        {step.savedText ? <span className="step-saved"> · {step.savedText}</span> : null}
      </p>
    </li>
  );
}

const benefitBadge = {
  counted: 'ok',
  counted_unverified: 'warn',
  unverified: 'warn',
  ineligible: 'off',
  not_counted: 'muted',
} as const;

function BenefitRow({ benefit }: { benefit: PlaceBenefit }) {
  const view = benefitView(benefit);
  return (
    <li className={`benefit benefit-${view.tone}`}>
      <div className="benefit-head">
        <strong>{benefit.title}</strong>
        <span className="benefit-amount">{view.amountLabel}</span>
      </div>
      <p className="benefit-tags">
        <Badge
          tone={benefitBadge[view.tone]}
          icon={view.tone === 'counted' ? 'tick' : view.counted ? 'warning' : 'remove'}
        >
          {view.countedLabel}
        </Badge>
        <Badge
          tone={view.confirmed ? 'ok' : benefit.eligibilityStatus === 'ineligible' ? 'off' : 'warn'}
          icon={!view.confirmed && benefit.eligibilityStatus === 'needs_verification' ? 'help' : undefined}
        >
          {view.eligibilityLabel}
        </Badge>
        <Badge tone={benefit.callStatus === 'open' ? 'ok' : benefit.callStatus === 'closed' ? 'off' : 'muted'}>
          {view.callLabel}
        </Badge>
      </p>
      <p className="benefit-text">
        {view.kindLabel}. {benefit.explanation}
      </p>
      <Source url={benefit.sourceUrl} label="Official source" />
    </li>
  );
}

type Towns = { phase: 'closed' | 'loading' | 'ready' | 'error'; list: Municipality[]; error: ToolError | null };

function AddPlace(props: { client: ToolClient; codes: string[]; onAdd: (code: string) => void }) {
  const [towns, setTowns] = useState<Towns>({ phase: 'closed', list: [], error: null });
  const [choice, setChoice] = useState('');
  const selectId = useId();
  const full = props.codes.length >= MAX_PLACES;
  const options = towns.list.filter(town => !props.codes.includes(town.code));

  const open = () => {
    setTowns(previous => ({ ...previous, phase: 'loading', error: null }));
    props.client.municipalities().then(
      list =>
        setTowns({ phase: 'ready', list: [...list].sort((a, b) => a.name.localeCompare(b.name, 'ca')), error: null }),
      error =>
        setTowns({
          phase: 'error',
          list: [],
          error:
            error instanceof ToolError
              ? error
              : new ToolError('list_catalonia_municipalities', 'failed', 'The list of municipalities did not load.'),
        }),
    );
  };

  useEffect(() => {
    if (choice && !options.some(town => town.code === choice)) setChoice('');
  }, [choice, options]);

  if (full) return <p className="hint">Eight places is the most the plan compares at once.</p>;
  if (towns.phase === 'closed')
    return (
      <button type="button" className="rc-btn" onClick={open}>
        <Icon name="add" />
        Add a place
      </button>
    );
  if (towns.phase === 'loading')
    return (
      <p className="hint" role="status">
        Loading municipalities…
      </p>
    );
  if (towns.phase === 'error' && towns.error)
    return <ErrorNote title="Could not list municipalities" error={towns.error} onRetry={open} compact />;
  if (options.length === 0) return <p className="hint">Every municipality in the pilot is already compared.</p>;
  return (
    <form
      className="add-place rc-field"
      onSubmit={event => {
        event.preventDefault();
        if (!choice) return;
        props.onAdd(choice);
        setChoice('');
      }}
    >
      <label htmlFor={selectId}>Add a place</label>
      <select id={selectId} value={choice} onChange={event => setChoice(event.currentTarget.value)}>
        <option value="">Choose a municipality</option>
        {options.map(town => (
          <option key={town.code} value={town.code}>
            {town.name} · {town.comarca}
          </option>
        ))}
      </select>
      <button type="submit" className="rc-btn rc-btn--primary" disabled={!choice}>
        Add
      </button>
    </form>
  );
}
