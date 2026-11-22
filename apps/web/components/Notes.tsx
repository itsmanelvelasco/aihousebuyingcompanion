import type { PlanResult } from '../../../packages/contracts/planner.ts';
import { formatDate } from '../format.ts';
import { planNotes } from '../view-model.ts';

/** Limits, assumptions and gaps of the plan. Part of the answer, so it is always open. */
export function Notes({ result }: { result: PlanResult }) {
  const notes = planNotes(result);
  return (
    <section className="panel notes" aria-labelledby="notes-title">
      <header className="panel-head">
        <h2 id="notes-title">Read this with the numbers</h2>
        <span className="muted">Plan dated {formatDate(result.asOf)}</span>
      </header>
      <div className="notes-grid">
        <div>
          <h3>Limits</h3>
          {notes.limitations.length ? (
            <ul className="plain-list">
              {notes.limitations.map(text => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">The planner listed no limitations.</p>
          )}
        </div>
        <div>
          <h3>Assumptions</h3>
          {notes.assumptions.length ? (
            <ul className="plain-list">
              {notes.assumptions.map(text => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">The planner listed no assumptions.</p>
          )}
        </div>
        <div>
          <h3>Missing data</h3>
          {notes.dataMissing.length ? (
            <ul className="plain-list gaps">
              {notes.dataMissing.map(group => (
                <li key={group.place}>
                  <strong>{group.place}.</strong> {group.items.join(' ')}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing is flagged as missing for these places.</p>
          )}
        </div>
      </div>
    </section>
  );
}
