import type { Journey as JourneyModel, JourneyStepState } from '../journey.ts';
import { Icon } from './bits.tsx';

const stateWord: Record<JourneyStepState, string> = {
  done: 'Reached',
  current: 'Next',
  ahead: 'Ahead',
  unknown: 'Not known yet',
};

/**
 * The trail: seven checkpoints from "about you" to "ready to buy", each with its illustration.
 * The checkpoint to work on is shown large with what it still needs; the rest are a strip below.
 * Every state is said in words; colour and the faded art only repeat it.
 */
export function Journey({ journey }: { journey: JourneyModel }) {
  const { steps, reached, total, current } = journey;
  const focus = current ?? (reached === total ? steps[steps.length - 1] : steps[0]);
  const position = steps.indexOf(focus) + 1;
  return (
    <section className="panel journey" aria-labelledby="journey-title">
      <div className="journey-focus">
        <div className={`rc-art journey-art art-${focus.id}`} aria-hidden="true" />
        <div className="journey-copy">
          <p className="rc-label">
            Checkpoint {position} of {total}
          </p>
          <h2 id="journey-title">{reached === total ? 'Trail complete' : focus.title}</h2>
          <p>{focus.detail}</p>
          <div className="journey-progress">
            <progress max={total} value={reached} aria-label="Checkpoints reached" />
            <span>
              {reached} of {total} reached
            </span>
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
              {stateWord[step.state]}
            </span>
            <span className="rc-sr-only">{step.detail}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
