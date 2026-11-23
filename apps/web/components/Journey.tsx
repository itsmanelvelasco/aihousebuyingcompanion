import { useMessages } from '../i18n.tsx';
import type { Journey as JourneyModel, JourneyStepState, JourneyTarget } from '../journey.ts';
import { journeyMessages } from '../messages/journey.messages.ts';
import { reveal } from '../reveal.ts';
import { ADD_HABIT_ID } from './AddHabit.tsx';
import { Icon } from './bits.tsx';
import { SUGGEST_ID } from './SuggestPlaces.tsx';

/**
 * The part of the workspace behind each action, then where to go when that part is not on screen
 * (the bank strip and the habit form exist only once a person is shown).
 */
const targets: Record<JourneyTarget, string[]> = {
  person: ['person-title'],
  questions: ['details-title', 'person-title'],
  bank: ['bank-title', 'person-title'],
  'suggest-places': [SUGGEST_ID, 'places-title'],
  'add-habit': [ADD_HABIT_ID, 'person-title'],
  places: ['places-title'],
};

const stateWord = {
  done: 'stateDone',
  current: 'stateCurrent',
  ahead: 'stateAhead',
  unknown: 'stateUnknown',
} as const satisfies Record<JourneyStepState, string>;

/**
 * The trail: seven checkpoints from "about you" to "ready to buy", each with its illustration.
 * The checkpoint to work on is shown large with what it still needs; the rest are a strip below.
 * Every state is said in words; colour and the faded art only repeat it. The checkpoint in focus
 * carries its action as a button that opens the part of the workspace where it is done.
 */
export function Journey({ journey }: { journey: JourneyModel }) {
  const t = useMessages(journeyMessages);
  const { steps, reached, total, current } = journey;
  const focus = current ?? (reached === total ? steps[steps.length - 1] : steps[0]);
  const position = steps.indexOf(focus) + 1;
  return (
    <section className="panel journey" aria-labelledby="journey-title">
      <div className="journey-focus">
        <div className={`rc-art journey-art art-${focus.id}`} aria-hidden="true" />
        <div className="journey-copy">
          <p className="rc-label">{t('checkpointOf', { position, total })}</p>
          <h2 id="journey-title">{reached === total ? t('trailComplete') : focus.title}</h2>
          <p>{focus.detail}</p>
          {reached === total ? null : (
            <p className="journey-action">
              <button
                type="button"
                className="rc-btn rc-btn--primary rc-btn--sm"
                onClick={() => reveal(...targets[focus.action.target])}
              >
                {focus.action.label}
                <Icon name="next" />
              </button>
            </p>
          )}
          <div className="journey-progress">
            <progress max={total} value={reached} aria-label={t('checkpointsReached')} />
            <span>{t('reachedOf', { reached, total })}</span>
          </div>
        </div>
      </div>
      <ol className="journey-steps">
        {steps.map(step => (
          <li
            key={step.id}
            className={`journey-step is-${step.state}`}
            aria-current={step === current ? 'step' : undefined}
          >
            <span className={`rc-art journey-thumb art-${step.id}`} aria-hidden="true" />
            <strong>{step.title}</strong>
            <span className="journey-state">
              {step.state === 'done' ? <Icon name="check" /> : null}
              {t(stateWord[step.state])}
            </span>
            <span className="rc-sr-only">{step.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
