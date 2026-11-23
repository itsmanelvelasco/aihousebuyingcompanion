import { useMessages } from '../i18n.tsx';
import type { Journey as JourneyModel, JourneyStepState } from '../journey.ts';
import { journeyMessages } from '../messages/journey.messages.ts';
import { Icon } from './bits.tsx';

const stateWord = {
  done: 'stateDone',
  current: 'stateCurrent',
  ahead: 'stateAhead',
  unknown: 'stateUnknown',
} as const satisfies Record<JourneyStepState, string>;

/**
 * The trail: seven checkpoints from "about you" to "ready to buy", each with its illustration.
 * The checkpoint to work on is shown large with what it still needs; the rest are a strip below.
 * Every state is said in words; colour and the faded art only repeat it.
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
