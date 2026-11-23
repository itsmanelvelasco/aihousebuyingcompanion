import { useEffect, useId, useState } from 'react';
import type { Person, PlaceBenefit, PlacePlan, PlanResult } from '../../../packages/contracts/planner.ts';
import type { IconName } from '../../../packages/ui/icons.ts';
import type { Municipality, ToolClient } from '../client.ts';
import { ToolError } from '../client.ts';
import { formatCount, formatDuration, formatEuros, formatMonthly } from '../format.ts';
import type { PlanState } from '../hooks.ts';
import { bold, rich, useLocale, useMessages } from '../i18n.tsx';
import { errorMessages } from '../messages/errors.messages.ts';
import { formatMessages } from '../messages/format.messages.ts';
import { placesMessages } from '../messages/places.messages.ts';
import { suggestMessages } from '../messages/suggest.messages.ts';
import { reveal } from '../reveal.ts';
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
import { SUGGEST_ID, SuggestPlaces } from './SuggestPlaces.tsx';

export const MAX_PLACES = 8;

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
  /** The person on screen, for what the suggestions can use; null when there is none. */
  person: Person | null;
  codes: string[];
  plan: PlanState;
  includeUnverified: boolean;
  onIncludeUnverified: (on: boolean) => void;
  onAdd: (code: string) => void;
  /** Add several places at once, in the order given. */
  onAddMany: (codes: string[]) => void;
  onRemove: (code: string) => void;
  onRetry: () => void;
};

/**
 * No place is chosen: say what to do next, and show what the plan already knows without a place
 * when the server sent it (the wait anywhere in Catalonia, at the baseline and with the habits).
 */
function NoPlaces({ result }: { result: PlanResult | null }) {
  const locale = useLocale();
  const t = useMessages(placesMessages);
  const suggest = useMessages(suggestMessages);
  const anywhere = result?.withoutPlace;
  return (
    <div className="rc-empty no-places">
      <div className="rc-art empty-art" aria-hidden="true" />
      <p>{rich(t('empty'), { b: bold })}</p>
      {result?.placeQuestion ? <p className="muted">{result.placeQuestion.why}</p> : null}
      {anywhere ? (
        <dl className="saved anywhere">
          <div>
            <dt>{t('anywhereBaseline')}</dt>
            <dd>{formatDuration(anywhere.baseline?.months, locale)}</dd>
          </div>
          <div className="saved-habits">
            <dt>{t('anywhereHabits')}</dt>
            <dd>{formatDuration(anywhere.withHabits?.months, locale)}</dd>
          </div>
        </dl>
      ) : null}
      {anywhere ? <p className="hint">{t('anywhereNote')}</p> : null}
      <button type="button" className="rc-btn rc-btn--primary" onClick={() => reveal(SUGGEST_ID)}>
        <Icon name="compare" />
        {suggest('summary')}
      </button>
    </div>
  );
}

export function PlacesPanel(props: Props) {
  const { plan, codes } = props;
  const t = useMessages(placesMessages);
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
          {t('title')}
        </h2>
        <span className="muted" role="status">
          {plan.refreshing && plan.result
            ? t('updating')
            : plans.length
              ? t('countShortestFirst', { count: plans.length })
              : ''}
        </span>
      </header>

      {plans.length > 0 ? (
        <div className="legend" aria-hidden="true">
          <span className="key key-baseline">{t('legendBaseline')}</span>
          <span className="key key-habits">{t('legendHabits')}</span>
          <span className="key key-place">{t('legendPlace')}</span>
        </div>
      ) : null}

      {plan.error && plan.result ? (
        <ErrorNote title={t('updateFailed')} error={plan.error} onRetry={props.onRetry} compact />
      ) : null}

      {!props.userId ? (
        <p className="rc-note">{t('chooseWho')}</p>
      ) : codes.length === 0 ? (
        <NoPlaces result={plan.result} />
      ) : plan.phase === 'error' && plan.error ? (
        <ErrorNote title={t('loadFailed')} error={plan.error} onRetry={props.onRetry} />
      ) : plan.phase === 'loading' ? (
        <>
          <p className="rc-sr-only" role="status">
            {t('loading')}
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
        <p className="rc-note">{rich(t('noPlacesReturned', { codes: codes.join(', ') }), { b: bold })}</p>
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
          {t('noPlanFor', { codes: missing.join(', ') })}{' '}
          {missing.map(code => (
            <button
              key={code}
              type="button"
              className="rc-btn rc-btn--quiet rc-btn--sm"
              onClick={() => props.onRemove(code)}
            >
              {t('removeCode', { code })}
            </button>
          ))}
        </p>
      ) : null}

      <div className="places-foot">
        <SuggestPlaces
          client={props.client}
          person={props.person}
          codes={codes}
          maxPlaces={MAX_PLACES}
          onAdd={props.onAddMany}
        />
        {props.userId ? (
          <>
            <AddPlace client={props.client} codes={codes} onAdd={props.onAdd} />
            <Switch checked={props.includeUnverified} onChange={props.onIncludeUnverified}>
              {t('countUnverified')}
            </Switch>
            {props.includeUnverified ? <p className="hint hint-warn">{t('unverifiedCounted')}</p> : null}
          </>
        ) : null}
      </div>
    </section>
  );
}

function PlaceCard(props: { plan: PlacePlan; rank: number; scale: number; onRemove: () => void }) {
  const { plan } = props;
  const { place } = plan;
  const locale = useLocale();
  const t = useMessages(placesMessages);
  const words = useMessages(formatMessages);
  const headline = planHeadline(plan, locale);
  const steps = timelineSteps(plan, props.scale, locale);
  const rural = ruralLabel(place.rural, locale);
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
            {rural ? ` · ${rural}` : ''} · {t('code', { code: place.municipalityCode })}
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
            <dt>{t('savedHabits')}</dt>
            <dd>{headline.savedByHabitsText}</dd>
          </div>
          <div className="saved-place">
            <dt>{t('savedPlace')}</dt>
            <dd>{headline.savedByPlaceText}</dd>
          </div>
          <div>
            <dt>{t('savedBaseline')}</dt>
            <dd>{headline.savedTotalText}</dd>
          </div>
        </dl>
      ) : (
        <p className="rc-note rc-note--warn">{headline.tone === 'none' ? t('neverReached') : t('notEstimable')}</p>
      )}

      <details className="place-details">
        <summary>
          <span>{t('detailsSummary')}</span>
          <span className="summary-meta">
            {benefitSummary(plan.benefits, locale)}
            {gaps.size ? ` · ${t('dataGaps', { count: gaps.size })}` : ''}
          </span>
        </summary>

        <h4>{t('indicators')}</h4>
        <dl className="indicators">
          {indicatorViews(place, locale).map(item => (
            <div key={item.key}>
              <dt>{item.label}</dt>
              <dd className={item.known ? undefined : 'unknown'}>{item.value}</dd>
              {item.sourceUrl ? (
                <Source url={item.sourceUrl} observedAt={item.observedAt} geography={item.geography} />
              ) : (
                <small className="source">{t('noFigure')}</small>
              )}
            </div>
          ))}
        </dl>

        <h4>{t('services')}</h4>
        {place.services.length === 0 ? (
          <p className="muted">{t('noServices')}</p>
        ) : (
          <ul className="services">
            {place.services.map(item => (
              <li key={item.kind}>
                <Icon name={serviceIcons[item.kind]} />
                <span className="service-count">{formatCount(item.count, locale)}</span>
                <span>
                  {serviceLabel(item.kind, locale)}
                  <Source url={item.sourceUrl} observedAt={item.observedAt} label={words('source')} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {place.services.length > 0 ? <p className="hint">{t('unlistedUnknown')}</p> : null}

        <h4>{t('benefits')}</h4>
        {plan.benefits.length === 0 ? (
          <p className="muted">{t('noBenefits')}</p>
        ) : (
          <ul className="benefits">
            {plan.benefits.map(benefit => (
              <BenefitRow key={benefit.policyId} benefit={benefit} />
            ))}
          </ul>
        )}

        {plan.assumptions.length > 0 ? (
          <>
            <h4>{t('assumed')}</h4>
            <ul className="plain-list">
              {plan.assumptions.map(text => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          </>
        ) : null}
        {gaps.size > 0 ? (
          <>
            <h4>{t('missingData')}</h4>
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
          {t('removeFromComparison', { place: place.name })}
        </button>
      </details>
    </li>
  );
}

function StepRow({ step }: { step: TimelineStep }) {
  const hasBar = step.barPercent !== null;
  const locale = useLocale();
  const t = useMessages(placesMessages);
  const upfront = formatEuros(step.upfrontCashCents, locale);
  return (
    <li className={`step step-${step.key} step-${step.state}`}>
      <div className="step-head">
        <span className="step-label">{step.label}</span>
        <span className="step-value">{step.text}</span>
      </div>
      <div className={hasBar ? 'track' : 'track track-empty'} aria-hidden="true">
        {hasBar ? <span className="fill" style={{ transform: `scaleX(${(step.barPercent ?? 0) / 100})` }} /> : null}
      </div>
      <p className="step-foot">
        {step.state === 'not_estimated'
          ? t('noEstimateStep')
          : step.monthlySavingsCents !== null && step.monthlySavingsCents < 0
            ? t('stepUpfrontShort', { upfront, monthly: formatMonthly(-step.monthlySavingsCents, locale) })
            : t('stepUpfrontSaved', { upfront, monthly: formatMonthly(step.monthlySavingsCents, locale) })}
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
  const locale = useLocale();
  const t = useMessages(placesMessages);
  const view = benefitView(benefit, locale);
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
      <Source url={benefit.sourceUrl} label={t('officialSource')} />
    </li>
  );
}

type Towns = { phase: 'closed' | 'loading' | 'ready' | 'error'; list: Municipality[]; error: ToolError | null };

function AddPlace(props: { client: ToolClient; codes: string[]; onAdd: (code: string) => void }) {
  const [towns, setTowns] = useState<Towns>({ phase: 'closed', list: [], error: null });
  const [choice, setChoice] = useState('');
  const selectId = useId();
  const t = useMessages(placesMessages);
  const errors = useMessages(errorMessages);
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
              : new ToolError('list_catalonia_municipalities', 'failed', errors('municipalitiesFailed')),
        }),
    );
  };

  useEffect(() => {
    if (choice && !options.some(town => town.code === choice)) setChoice('');
  }, [choice, options]);

  if (full) return <p className="hint">{t('maxPlaces')}</p>;
  if (towns.phase === 'closed')
    return (
      <button type="button" className="rc-btn" onClick={open}>
        <Icon name="add" />
        {t('addAPlace')}
      </button>
    );
  if (towns.phase === 'loading')
    return (
      <p className="hint" role="status">
        {t('loadingMunicipalities')}
      </p>
    );
  if (towns.phase === 'error' && towns.error)
    return <ErrorNote title={t('listFailed')} error={towns.error} onRetry={open} compact />;
  if (options.length === 0) return <p className="hint">{t('allCompared')}</p>;
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
      <label htmlFor={selectId}>{t('addAPlace')}</label>
      <select id={selectId} value={choice} onChange={event => setChoice(event.currentTarget.value)}>
        <option value="">{t('chooseMunicipality')}</option>
        {options.map(town => (
          <option key={town.code} value={town.code}>
            {town.name} · {town.comarca}
          </option>
        ))}
      </select>
      <button type="submit" className="rc-btn rc-btn--primary" disabled={!choice}>
        {t('addPlace')}
      </button>
    </form>
  );
}
