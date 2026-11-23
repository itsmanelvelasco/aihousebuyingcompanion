import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import type {
  AnswerSpec,
  FactConflict,
  KnownFact,
  NextQuestion,
  Person,
  PlanResult,
} from '../../../packages/contracts/planner.ts';
import { common } from '../../../packages/i18n/common.ts';
import type { Locale } from '../../../packages/i18n/locales.ts';
import type { AnswerValue, QuestionId } from '../../../packages/model/questions.ts';
import {
  answerSpecFor,
  answerToInput,
  applyAnswer,
  isQuestionId,
  parseTyped,
  questionById,
  validateAnswer,
} from '../../../packages/model/questions.ts';
import type { ToolClient } from '../client.ts';
import { formatDate } from '../format.ts';
import type { PlanState } from '../hooks.ts';
import { bold, rich, srOnly, useLocale, useMessages } from '../i18n.tsx';
import type { Subject, WorkspaceLaunch } from '../launch.ts';
import { detailsMessages } from '../messages/details.messages.ts';
import type { PlanChange } from '../view-model.ts';
import { conflictSources, factSourceLabel, planChanges } from '../view-model.ts';
import { Badge, Icon } from './bits.tsx';

type Props = {
  client: ToolClient;
  subject: Subject;
  launch: WorkspaceLaunch;
  mode: 'host' | 'standalone' | 'fixture';
  plan: PlanState;
  hasPlaces: boolean;
  /** Apply answers as a what-if: plan for this person inline, storing nothing. */
  onInline: (person: Person) => void;
  /** The signed-in person saved an answer: re-read the person and the plan. */
  onSaved: () => void;
};

/** What a form needs to ask one question: a question of the plan, or one of the set opened to change an answer. */
type Asked = Pick<
  NextQuestion,
  'id' | 'label' | 'question' | 'why' | 'help' | 'sensitivity' | 'answer' | 'allowUnknown'
> & { effect: string | null; state: NextQuestion['state'] | 'known' };

type Tri = 'yes' | 'no' | 'unknown' | '';
const triValue = (choice: Tri) => (choice === 'yes' ? true : choice === 'no' ? false : null);

/** Yes, no and, where the question allows it, "I don't know". Nothing is selected until the person chooses. */
function YesNo(props: {
  name: string;
  legend: string;
  value: Tri;
  allowUnknown: boolean;
  invalid: boolean;
  describedBy?: string;
  onChange: (value: Tri) => void;
}) {
  const t = useMessages(detailsMessages);
  const options: [Tri, string][] = [
    ['yes', t('yes')],
    ['no', t('no')],
    ...(props.allowUnknown ? ([['unknown', t('unknownOption')]] as [Tri, string][]) : []),
  ];
  return (
    <fieldset className="choice-set" aria-invalid={props.invalid || undefined} aria-describedby={props.describedBy}>
      <legend>{props.legend}</legend>
      <div className="choice-row">
        {options.map(([value, label]) => (
          <label key={value} className="choice">
            <input
              type="radio"
              name={props.name}
              value={value}
              checked={props.value === value}
              onChange={() => props.onChange(value)}
            />
            <span>{label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * One question with its control, validation and an explicit "I don't know". The typed value comes
 * from the shared question set (`parseTyped`, `validateAnswer`); this component only collects it.
 */
function QuestionForm(props: {
  asked: Asked;
  today: string;
  submitLabel: string;
  busy: boolean;
  /** Move the keyboard focus to this question when it appears: it follows an answer just given. */
  focus: boolean;
  onSubmit: (value: AnswerValue | null) => void;
  onCancel?: () => void;
}) {
  const { asked } = props;
  const spec: AnswerSpec = asked.answer;
  const t = useMessages(detailsMessages);
  const shared = useMessages(common);
  const locale = useLocale();
  const unknownLabel = t('unknownOption');
  const id = useId();
  const [text, setText] = useState('');
  const [tri, setTri] = useState<Tri>('');
  const [choice, setChoice] = useState('');
  const [unknown, setUnknown] = useState(false);
  const [hasChildren, setHasChildren] = useState<'' | 'none' | 'some'>('');
  const [births, setBirths] = useState<string[]>(['']);
  const [flags, setFlags] = useState<Tri[]>(() =>
    spec.type === 'per_child' ? spec.children.map(() => '' as Tri) : [],
  );
  const [error, setError] = useState<string | null>(null);
  /** A message stands until the person changes the answer it was about. */
  const editing =
    <Value,>(set: (value: Value) => void) =>
    (value: Value) => {
      setError(null);
      set(value);
    };
  const form = useRef<HTMLFormElement>(null);
  const { focus } = props;
  useEffect(() => {
    if (focus) form.current?.querySelector<HTMLElement>('input, select, button')?.focus();
  }, [focus]);
  const errorId = `${id}-error`;
  const helpId = `${id}-help`;
  const described = [asked.help ? helpId : null, error ? errorId : null].filter(Boolean).join(' ') || undefined;

  const read = (): { value: AnswerValue | null | undefined; message?: string } => {
    switch (spec.type) {
      case 'boolean':
        return tri === '' ? { value: undefined, message: t('chooseAnswer') } : { value: triValue(tri) };
      case 'choice':
        return choice === ''
          ? { value: undefined, message: t('chooseOption') }
          : { value: choice === 'unknown' ? null : choice };
      case 'children':
        if (hasChildren === '') return { value: undefined, message: t('sayChildren') };
        return { value: hasChildren === 'none' ? [] : births.map(birthDate => ({ birthDate })) };
      case 'per_child':
        return flags.some(flag => flag === '')
          ? { value: undefined, message: t('answerEachChild') }
          : { value: flags.map(triValue) };
      default: {
        if (unknown) return { value: null };
        if (!text.trim()) return { value: undefined, message: t('enterValue') };
        const value = parseTyped(asked.id as QuestionId, text);
        return value === undefined ? { value, message: t('notANumber') } : { value };
      }
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const { value, message } = read();
    const problem =
      message ??
      validateAnswer(
        asked.id as QuestionId,
        value,
        { today: props.today, ...(spec.type === 'per_child' ? { childCount: spec.children.length } : {}) },
        locale,
      );
    setError(problem);
    if (!problem && value !== undefined) props.onSubmit(value);
  };

  const typed = spec.type === 'date' || spec.type === 'money' || spec.type === 'number' || spec.type === 'percent';
  const suffix = spec.type === 'money' ? '€' : spec.type === 'percent' ? '%' : spec.type === 'number' ? spec.unit : '';

  return (
    <form ref={form} className="question-form" onSubmit={submit} noValidate>
      {asked.sensitivity ? (
        <p className="rc-note sensitive-note">
          <Icon name="info" /> <span>{asked.sensitivity}</span>
        </p>
      ) : null}

      {spec.type === 'boolean' ? (
        <YesNo
          name={id}
          legend={asked.question}
          value={tri}
          allowUnknown={asked.allowUnknown}
          invalid={Boolean(error)}
          describedBy={described}
          onChange={editing(setTri)}
        />
      ) : null}

      {spec.type === 'choice' ? (
        <fieldset className="choice-set" aria-invalid={Boolean(error) || undefined} aria-describedby={described}>
          <legend>{asked.question}</legend>
          <div className="choice-row">
            {[...spec.options, ...(asked.allowUnknown ? [{ value: 'unknown', label: unknownLabel }] : [])].map(
              option => (
                <label key={option.value} className="choice">
                  <input
                    type="radio"
                    name={id}
                    value={option.value}
                    checked={choice === option.value}
                    onChange={() => editing(setChoice)(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ),
            )}
          </div>
        </fieldset>
      ) : null}

      {typed ? (
        <div className="typed-answer">
          <label className="rc-field" htmlFor={`${id}-input`}>
            {asked.question}
          </label>
          <div className="typed-row">
            <input
              id={`${id}-input`}
              className="rc-input"
              type={spec.type === 'date' ? 'date' : 'text'}
              inputMode={spec.type === 'date' ? undefined : 'decimal'}
              autoComplete={asked.id === 'birthDate' ? 'bday' : 'off'}
              {...(spec.type === 'date' ? { min: spec.min, max: spec.max } : {})}
              value={text}
              disabled={unknown}
              aria-invalid={Boolean(error) || undefined}
              aria-describedby={described}
              onChange={event => editing(setText)(event.currentTarget.value)}
            />
            {suffix ? <span className="typed-unit">{suffix}</span> : null}
          </div>
          {asked.allowUnknown ? (
            <label className="choice">
              <input
                type="checkbox"
                checked={unknown}
                onChange={event => editing(setUnknown)(event.currentTarget.checked)}
              />
              <span>{unknownLabel}</span>
            </label>
          ) : null}
        </div>
      ) : null}

      {spec.type === 'children' ? (
        <fieldset className="choice-set" aria-invalid={Boolean(error) || undefined} aria-describedby={described}>
          <legend>{asked.question}</legend>
          <div className="choice-row">
            {(
              [
                ['none', t('noChildren')],
                ['some', t('yes')],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="choice">
                <input
                  type="radio"
                  name={id}
                  value={value}
                  checked={hasChildren === value}
                  onChange={() => editing(setHasChildren)(value)}
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
          {hasChildren === 'some' ? (
            <div className="child-rows">
              {births.map((birth, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions; a child has no other identity yet.
                <div key={index} className="child-row">
                  <label className="rc-field">
                    {t('childBirth', { number: index + 1 })}
                    <input
                      type="date"
                      min={`${Number(props.today.slice(0, 4)) - 120}-01-01`}
                      max={props.today}
                      value={birth}
                      onChange={event => {
                        const value = event.currentTarget.value;
                        setError(null);
                        setBirths(previous => previous.map((item, position) => (position === index ? value : item)));
                      }}
                    />
                  </label>
                  {births.length > 1 ? (
                    <button
                      type="button"
                      className="rc-btn rc-btn--quiet rc-btn--sm"
                      onClick={() => setBirths(previous => previous.filter((_, position) => position !== index))}
                    >
                      {rich(t('removeChild', { number: index + 1 }), { sr: srOnly })}
                    </button>
                  ) : null}
                </div>
              ))}
              {births.length < spec.max ? (
                <button
                  type="button"
                  className="rc-btn rc-btn--sm"
                  onClick={() => setBirths(previous => [...previous, ''])}
                >
                  {t('addChild')}
                </button>
              ) : null}
            </div>
          ) : null}
        </fieldset>
      ) : null}

      {spec.type === 'per_child' ? (
        <div className="per-child" aria-describedby={described}>
          <p className="question-text">{asked.question}</p>
          {spec.children.map((child, position) => (
            <YesNo
              key={child.index}
              name={`${id}-${child.index}`}
              legend={child.label}
              value={flags[position] ?? ''}
              allowUnknown={asked.allowUnknown}
              invalid={Boolean(error) && (flags[position] ?? '') === ''}
              onChange={value => {
                setError(null);
                setFlags(previous => previous.map((item, index) => (index === position ? value : item)));
              }}
            />
          ))}
        </div>
      ) : null}

      {error ? (
        <p id={errorId} className="field-error" role="alert">
          <Icon name="warning" /> {error}
        </p>
      ) : null}
      {asked.help ? (
        <p id={helpId} className="hint">
          {asked.help}
        </p>
      ) : null}
      <p className="question-why">{rich(t('whyWeAsk'), { b: bold, why: asked.why })}</p>
      {asked.effect ? (
        <p className="question-effect">
          <Icon name="sparkle" /> {asked.effect}
        </p>
      ) : null}
      <div className="form-actions">
        <button
          type="submit"
          className="rc-btn rc-btn--primary rc-btn--sm"
          disabled={props.busy}
          aria-busy={props.busy}
        >
          {props.submitLabel}
        </button>
        {props.onCancel ? (
          <button type="button" className="rc-btn rc-btn--quiet rc-btn--sm" onClick={props.onCancel}>
            {shared('cancel')}
          </button>
        ) : null}
      </div>
    </form>
  );
}

const stateLabel = {
  missing: null,
  known: null,
  unconfirmed: 'stateUnconfirmed',
  conflict: 'stateConflict',
  said_unknown: 'saidUnknown',
} as const satisfies Record<Asked['state'], string | null>;

/** A question of the set as a form can ask it, for changing an answer the plan already has. */
function askedFromSet(id: string, person: Person, today: string, locale: Locale): Asked | null {
  if (!isQuestionId(id)) return null;
  const question = questionById(id, locale);
  return {
    id,
    label: question.label,
    question: question.question,
    why: question.why,
    help: question.help,
    sensitivity: question.sensitivity,
    answer: answerSpecFor(question, person, today, locale),
    allowUnknown: question.allowUnknown,
    effect: null,
    state: 'known',
  };
}

function ConflictPicker(props: {
  conflict: FactConflict;
  busy: boolean;
  canSave: boolean;
  onPick: (index: number) => void;
}) {
  const { conflict } = props;
  const locale = useLocale();
  const t = useMessages(detailsMessages);
  const id = useId();
  const [picked, setPicked] = useState<number | null>(null);
  return (
    <form
      className="conflict"
      onSubmit={event => {
        event.preventDefault();
        if (picked !== null) props.onPick(picked);
      }}
    >
      <fieldset className="choice-set">
        <legend>{rich(t('conflictLegend'), { b: bold, label: conflict.label })}</legend>
        <div className="choice-column">
          {conflict.candidates.map((candidate, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: candidates have no identity beyond their position.
            <label key={index} className="choice">
              <input type="radio" name={id} checked={picked === index} onChange={() => setPicked(index)} />
              <span>
                {candidate.text}{' '}
                <small className="muted">
                  {t(candidate.confirmed ? 'candidateConfirmed' : 'candidateNotConfirmed', {
                    source: factSourceLabel(candidate.source, locale),
                    date: formatDate(candidate.observedAt, locale),
                  })}
                </small>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {props.canSave ? (
        <button type="submit" className="rc-btn rc-btn--sm" disabled={props.busy || picked === null}>
          {t('keepAnswer')}
        </button>
      ) : (
        <p className="hint">{t('signInToSettle')}</p>
      )}
    </form>
  );
}

function KnownList(props: { facts: KnownFact[]; onChange: (id: string) => void; editable: boolean }) {
  const locale = useLocale();
  const t = useMessages(detailsMessages);
  if (!props.facts.length) return <p className="muted">{t('nothingKnown')}</p>;
  const origin = (fact: KnownFact) => (fact.source ? factSourceLabel(fact.source, locale) : t('statedWithPlan'));
  return (
    <ul className="rc-rows known-list">
      {props.facts.map(fact => (
        <li key={fact.id}>
          <div className="known-main">
            <span className="known-label">{fact.label}</span>
            <span className="known-value">{fact.value}</span>
          </div>
          <div className="known-meta">
            <small className="muted">
              {fact.observedAt
                ? t('sourceDated', { source: origin(fact), date: formatDate(fact.observedAt, locale) })
                : origin(fact)}
            </small>
            {fact.confirmed === true ? <Badge tone="ok">{t('confirmed')}</Badge> : null}
            {fact.confirmed === false ? <Badge tone="warn">{t('notConfirmed')}</Badge> : null}
            {fact.usedByPlan ? null : (
              <Badge tone="off" title={t('notUsedTitle')}>
                {t('notUsedHere')}
              </Badge>
            )}
            {props.editable ? (
              <button
                type="button"
                className="rc-btn rc-btn--quiet rc-btn--sm known-change"
                onClick={() => props.onChange(fact.id)}
              >
                {rich(t('changeAnswer'), { sr: srOnly, label: fact.label })}
              </button>
            ) : null}
          </div>
          {fact.stale ? (
            <p className="hint hint-warn">
              <Icon name="warning" /> {rich(t('possiblyStale'), { reason: fact.stale })}
            </p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * "Your details": what the plan knows about the person and from where, what it does not know, and
 * the next most valuable question, asked inline. Signed in, an answer is saved to the person's own
 * profile as confirmed by them; otherwise it is applied to a what-if and stored nowhere. After each
 * answer the plan is computed again and the panel says what changed, in the planner's own figures.
 */
export function DetailsPanel(props: Props) {
  const { plan, subject } = props;
  const result = plan.result;
  const locale = useLocale();
  const t = useMessages(detailsMessages);
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Why the last answer was not saved: the server's reason, or true when it gave none. */
  const [failure, setFailure] = useState<string | true | null>(null);
  const [changes, setChanges] = useState<{ label: string; lines: PlanChange[]; saved: boolean } | null>(null);
  /** The plan on screen when an answer was given, to say afterwards what the answer changed. */
  const pending = useRef<{ before: PlanResult; label: string; saved: boolean } | null>(null);

  useEffect(() => {
    const waiting = pending.current;
    if (!waiting || !result || result === waiting.before || plan.refreshing) return;
    pending.current = null;
    setBusy(false);
    setChanges({ label: waiting.label, lines: planChanges(waiting.before, result, locale), saved: waiting.saved });
  }, [result, plan.refreshing, locale]);
  useEffect(() => {
    // A failed re-plan must not leave the form disabled.
    if (plan.error && pending.current) {
      pending.current = null;
      setBusy(false);
    }
  }, [plan.error]);

  if (subject.kind === 'none') return null;
  const signedIn = subject.kind === 'me';
  const where = t(signedIn ? 'whereMe' : subject.kind === 'demo' ? 'whereDemo' : 'whereInline');

  const heading = (
    <header className="panel-head">
      <h2 id="details-title">
        <Icon name="household" />
        {t('title')}
      </h2>
      <span className="muted">{where}</span>
    </header>
  );

  if (!result)
    return (
      <section className="panel details" aria-labelledby="details-title">
        {heading}
        <p className="rc-note">{props.hasPlaces ? t('questionsLoad') : t('addPlaceFirst')}</p>
      </section>
    );

  const today = result.asOf;
  const person = result.person;
  const questions: Asked[] = (result.nextQuestions ?? []).map(question => ({
    ...question,
    effect: question.effect.text,
  }));
  // A question whose answers disagree is settled in the conflict picker above, not asked a third time.
  const toAsk = questions.filter(question => question.state !== 'said_unknown' && question.state !== 'conflict');
  const saidUnknown = questions.filter(question => question.state === 'said_unknown');
  const editing =
    openId && !questions.some(question => question.id === openId) ? askedFromSet(openId, person, today, locale) : null;
  const current = editing ?? questions.find(question => question.id === openId) ?? toAsk[0] ?? null;
  const listed = result.nextQuestions !== undefined;
  const currentState = current ? stateLabel[current.state] : null;

  const answer = async (asked: Asked, value: AnswerValue | null) => {
    setFailure(null);
    setChanges(null);
    setBusy(true);
    pending.current = { before: result, label: asked.label, saved: signedIn };
    try {
      if (signedIn) {
        await props.client.saveInputs(answerToInput(asked.id as QuestionId, value, { person, day: today }), true);
        props.onSaved();
      } else {
        props.onInline(applyAnswer(person, asked.id as QuestionId, value, { day: today }));
      }
      setOpenId(null);
    } catch (error) {
      pending.current = null;
      setBusy(false);
      setFailure(error instanceof Error && error.message ? error.message : true);
    }
  };

  const settle = async (conflict: FactConflict, index: number) => {
    const [group, field] = conflict.inputPath.split('.');
    setFailure(null);
    setChanges(null);
    setBusy(true);
    pending.current = { before: result, label: conflict.label, saved: true };
    try {
      // The pick is written under every source that disagreed, so no older answer keeps contradicting it.
      for (const source of conflictSources(conflict))
        await props.client.saveInputs({ [group]: { [field]: conflict.candidates[index].value } }, true, source);
      props.onSaved();
    } catch (error) {
      pending.current = null;
      setBusy(false);
      setFailure(error instanceof Error && error.message ? error.message : true);
    }
  };

  return (
    <section className="panel details" aria-labelledby="details-title" aria-busy={busy || plan.refreshing}>
      {heading}

      {changes ? (
        <div className="rc-note details-note changes" role="status">
          <p>
            {rich(
              t(
                changes.saved
                  ? changes.lines.length
                    ? 'savedChanged'
                    : 'savedUnchanged'
                  : changes.lines.length
                    ? 'appliedChanged'
                    : 'appliedUnchanged',
              ),
              { b: bold, label: changes.label },
            )}
          </p>
          {changes.lines.length ? (
            <ul className="plain-list">
              {changes.lines.map(change => (
                <li key={change.place}>
                  <strong>{change.place}.</strong> {change.lines.join(' ')}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <p className="rc-note rc-note--error details-note" role="alert">
          {rich(t('notSaved'), { b: bold, reason: failure === true ? t('answerNotSaved') : failure })}
        </p>
      ) : null}

      {(result.conflicts ?? []).map(conflict => (
        <ConflictPicker
          key={conflict.inputPath}
          conflict={conflict}
          busy={busy}
          canSave={signedIn}
          onPick={index => void settle(conflict, index)}
        />
      ))}

      <div className="details-grid">
        <div className="ask">
          <h3>{editing ? t('changeAnAnswer') : t('nextQuestion')}</h3>
          {!listed ? (
            <p className="rc-note">{t('noNextQuestions')}</p>
          ) : current ? (
            <div className="question-card">
              {currentState ? <Badge tone="warn">{t(currentState)}</Badge> : null}
              <QuestionForm
                key={current.id}
                asked={current}
                today={today}
                busy={busy}
                focus={openId !== null || changes !== null}
                submitLabel={signedIn ? t('saveToProfile') : t('applyToEstimate')}
                onSubmit={value => void answer(current, value)}
                onCancel={openId ? () => setOpenId(null) : undefined}
              />
            </div>
          ) : (
            <p className="rc-note">{rich(t('nothingMore'), { b: bold })}</p>
          )}

          {toAsk.filter(question => question.id !== current?.id).length ? (
            <>
              <h4>{t('thenInOrder')}</h4>
              <ol className="rc-rows queue">
                {toAsk
                  .filter(question => question.id !== current?.id)
                  .map(question => (
                    <li key={question.id}>
                      <button type="button" className="queue-item" onClick={() => setOpenId(question.id)}>
                        <span className="queue-label">{question.label}</span>
                        <span className="muted">{question.effect}</span>
                      </button>
                    </li>
                  ))}
              </ol>
              <p className="hint">{t('notAsked')}</p>
            </>
          ) : null}

          {saidUnknown.length ? (
            <>
              <h4>{t('saidUnknown')}</h4>
              <ul className="rc-rows queue">
                {saidUnknown.map(question => (
                  <li key={question.id}>
                    <button type="button" className="queue-item" onClick={() => setOpenId(question.id)}>
                      <span className="queue-label">{question.label}</span>
                      <span className="muted">
                        {t('keptUnknown')} {question.effect} {question.help ?? ''}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>

        <div className="known">
          <h3>{t('whatPlanKnows')}</h3>
          <KnownList facts={result.knownFacts ?? []} editable={!busy} onChange={setOpenId} />
        </div>
      </div>
    </section>
  );
}
