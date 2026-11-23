import { type FormEvent, useId, useRef, useState } from 'react';
import type { Person } from '../../../packages/contracts/planner.ts';
import type { Recommendation, ToolClient } from '../client.ts';
import { ToolError } from '../client.ts';
import { formatEuros } from '../format.ts';
import { bold, rich, useLocale, useMessages } from '../i18n.tsx';
import { errorMessages } from '../messages/errors.messages.ts';
import { suggestMessages } from '../messages/suggest.messages.ts';
import type { SchoolStage, SuggestChoices } from '../suggest.ts';
import { noChoices, parseFloorArea, schoolStages, suggestionView, suggestRequest } from '../suggest.ts';
import { Badge, ErrorNote, Icon, Switch } from './bits.tsx';

/** The element the journey trail opens and scrolls to. */
export const SUGGEST_ID = 'suggest-places';

const stageLabels = {
  nursery: 'stageNursery',
  infantil: 'stageInfantil',
  primary: 'stagePrimary',
  eso: 'stageEso',
  batxillerat: 'stageBatxillerat',
  fp: 'stageFp',
} as const satisfies Record<SchoolStage, string>;

type Props = {
  client: ToolClient;
  /** The person on screen, for the budget and the floor area already known; null when there is none. */
  person: Person | null;
  codes: string[];
  maxPlaces: number;
  onAdd: (codes: string[]) => void;
};

type State =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'error'; error: ToolError }
  | { phase: 'ready'; result: Recommendation; names: Record<string, string> };

/**
 * "Suggest places for me": asks `recommend_towns` with what is known and shows the ranked answer
 * with the server's own reasons and compromises. What was excluded and why is listed too, never
 * hidden. The person adds one place, or the first few, to the comparison.
 */
export function SuggestPlaces({ client, person, codes, maxPlaces, onAdd }: Props) {
  const locale = useLocale();
  const t = useMessages(suggestMessages);
  const errors = useMessages(errorMessages);
  const [choices, setChoices] = useState<SuggestChoices>(noChoices);
  const [area, setArea] = useState('');
  const [areaInvalid, setAreaInvalid] = useState(false);
  const [state, setState] = useState<State>({ phase: 'idle' });
  const run = useRef(0);
  const areaId = useId();
  const areaError = useId();
  const hintId = useId();

  const typedArea = parseFloorArea(area);
  const { request, budget } = suggestRequest(person, { ...choices, floorAreaM2: typedArea });
  const knownArea = typedArea ?? person?.home.floorAreaM2 ?? null;
  const budgetText = formatEuros(person?.home.budgetCents ?? null, locale);

  const ask = () => {
    if (area.trim() !== '' && typedArea === null) return setAreaInvalid(true);
    setAreaInvalid(false);
    const current = ++run.current;
    setState({ phase: 'loading' });
    // The names of excluded municipalities are a courtesy: without the list their codes are shown.
    const names = client.municipalities().then(
      list => Object.fromEntries(list.map(town => [town.code, town.name])),
      () => ({}) as Record<string, string>,
    );
    Promise.all([client.recommend(request), names]).then(
      ([result, known]) => current === run.current && setState({ phase: 'ready', result, names: known }),
      error =>
        current === run.current &&
        setState({
          phase: 'error',
          error:
            error instanceof ToolError
              ? error
              : new ToolError('recommend_towns', 'failed', errors('toolUnreachable', { tool: 'recommend_towns' })),
        }),
    );
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    ask();
  };
  const toggleStage = (stage: SchoolStage, on: boolean) =>
    setChoices(previous => ({
      ...previous,
      schoolStages: schoolStages.filter(item => (item === stage ? on : previous.schoolStages.includes(item))),
    }));

  const view = state.phase === 'ready' ? suggestionView(state.result, codes, maxPlaces, state.names) : null;
  const full = codes.length >= maxPlaces;

  return (
    <details className="suggest" id={SUGGEST_ID}>
      <summary>
        <Icon name="compare" />
        {t('summary')}
      </summary>
      <p className="hint">{t('intro')}</p>
      <form className="suggest-form" onSubmit={onSubmit} noValidate>
        <p className="hint" id={hintId}>
          {budget === 'used'
            ? t('budgetUsed', { budget: budgetText, area: knownArea ?? '' })
            : budget === 'no_area'
              ? t('budgetNoArea', { budget: budgetText })
              : t('budgetUnknown')}
        </p>
        <div className="rc-field">
          <label htmlFor={areaId}>{t('floorArea')}</label>
          <input
            id={areaId}
            inputMode="decimal"
            autoComplete="off"
            value={area}
            placeholder={person?.home.floorAreaM2 ? String(person.home.floorAreaM2) : undefined}
            aria-invalid={areaInvalid || undefined}
            aria-describedby={areaInvalid ? `${hintId} ${areaError}` : hintId}
            onChange={event => {
              setArea(event.currentTarget.value);
              setAreaInvalid(false);
            }}
          />
          {areaInvalid ? (
            <p id={areaError} className="field-error" role="alert">
              {t('floorAreaInvalid')}
            </p>
          ) : null}
        </div>
        <fieldset className="choice-set">
          <legend>{t('stages')}</legend>
          <div className="choice-row">
            {schoolStages.map(stage => (
              <label key={stage} className="choice">
                <input
                  type="checkbox"
                  checked={choices.schoolStages.includes(stage)}
                  onChange={event => toggleStage(stage, event.currentTarget.checked)}
                />
                <span>{t(stageLabels[stage])}</span>
              </label>
            ))}
          </div>
          <p className="hint">{t('stagesHint')}</p>
        </fieldset>
        <Switch
          checked={choices.ruralOnly}
          onChange={ruralOnly => setChoices(previous => ({ ...previous, ruralOnly }))}
        >
          {t('ruralOnly')}
        </Switch>
        <button
          type="submit"
          className="rc-btn rc-btn--primary"
          disabled={state.phase === 'loading'}
          aria-busy={state.phase === 'loading' || undefined}
        >
          {state.phase === 'ready' || state.phase === 'error' ? t('again') : t('submit')}
        </button>
      </form>

      {state.phase === 'loading' ? (
        <p className="hint" role="status">
          {t('loading')}
        </p>
      ) : null}
      {state.phase === 'error' ? <ErrorNote title={t('failed')} error={state.error} onRetry={ask} compact /> : null}

      {view ? (
        <div className="suggest-results">
          {view.places.length === 0 ? (
            <p className="rc-note rc-note--warn" role="status">
              {rich(t('none'), { b: bold })}
            </p>
          ) : (
            <>
              <div className="suggest-head">
                <h3 role="status">{t('resultsTitle', { count: view.places.length })}</h3>
                {view.addable.length > 1 ? (
                  <button type="button" className="rc-btn rc-btn--sm" onClick={() => onAdd(view.addable)}>
                    <Icon name="add" />
                    {t('addAll', { count: view.addable.length })}
                  </button>
                ) : null}
              </div>
              {full ? <p className="hint hint-warn">{t('full')}</p> : null}
              <ol className="suggest-list">
                {view.places.map(place => (
                  <li key={place.code} className="suggestion">
                    <div className="suggestion-head">
                      <div>
                        <h4>{place.name}</h4>
                        <p className="muted">
                          {place.comarca} ·{' '}
                          {place.score === null ? t('scoreUnknown') : t('score', { score: Math.round(place.score) })}
                        </p>
                      </div>
                      {place.compared ? (
                        <Badge tone="ok" icon="tick">
                          {t('added')}
                        </Badge>
                      ) : (
                        <button
                          type="button"
                          className="rc-btn rc-btn--sm"
                          disabled={full}
                          aria-label={t('addNamed', { place: place.name })}
                          onClick={() => onAdd([place.code])}
                        >
                          <Icon name="add" />
                          {t('add')}
                        </button>
                      )}
                    </div>
                    {place.reasons.length ? (
                      <>
                        <h5>{t('reasons')}</h5>
                        <ul className="plain-list">
                          {place.reasons.map(text => (
                            <li key={text}>{text}</li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <p className="muted">{t('noReasons')}</p>
                    )}
                    {place.compromises.length ? (
                      <>
                        <h5>{t('compromises')}</h5>
                        <ul className="plain-list">
                          {place.compromises.map(text => (
                            <li key={text}>{text}</li>
                          ))}
                        </ul>
                      </>
                    ) : null}
                    {place.dataMissing.length ? (
                      <p className="hint">{t('missing', { items: place.dataMissing.join(', ') })}</p>
                    ) : null}
                  </li>
                ))}
              </ol>
            </>
          )}
          {view.excluded.length ? (
            <details className="suggest-excluded" open={view.places.length === 0}>
              <summary>{t('excluded', { count: view.excluded.length })}</summary>
              <ul className="plain-list">
                {view.excluded.map(item => (
                  <li key={item.code}>
                    <strong>{item.name ?? t('excludedCode', { code: item.code })}.</strong> {item.reasons.join(' ')}
                    {item.dataMissing.length ? ` ${t('missing', { items: item.dataMissing.join(', ') })}` : ''}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {view.limitations.length ? (
            <>
              <h5>{t('limitations')}</h5>
              <ul className="plain-list">
                {view.limitations.map(text => (
                  <li key={text}>{text}</li>
                ))}
              </ul>
            </>
          ) : null}
        </div>
      ) : null}
    </details>
  );
}
