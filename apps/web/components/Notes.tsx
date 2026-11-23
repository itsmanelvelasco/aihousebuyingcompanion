import type { PlanResult } from '../../../packages/contracts/planner.ts';
import { formatDate } from '../format.ts';
import { useLocale, useMessages } from '../i18n.tsx';
import { workspaceMessages } from '../messages/workspace.messages.ts';
import { planNotes } from '../view-model.ts';
import { Icon } from './bits.tsx';

/**
 * Limits, assumptions and gaps of the plan. Part of the answer, so it is always open. The
 * sentences are the planner's own, in the language the plan was asked in.
 */
export function Notes({ result }: { result: PlanResult }) {
  const locale = useLocale();
  const t = useMessages(workspaceMessages);
  const notes = planNotes(result);
  return (
    <section className="panel notes" aria-labelledby="notes-title">
      <header className="panel-head">
        <h2 id="notes-title">{t('notesTitle')}</h2>
        <span className="muted">{t('planDated', { date: formatDate(result.asOf, locale) })}</span>
      </header>
      <div className="notes-grid">
        <div>
          <h3>{t('limits')}</h3>
          {notes.limitations.length ? (
            <ul className="plain-list">
              {notes.limitations.map(text => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('noLimits')}</p>
          )}
        </div>
        <div>
          <h3>{t('assumptions')}</h3>
          {notes.assumptions.length ? (
            <ul className="plain-list">
              {notes.assumptions.map(text => (
                <li key={text}>{text}</li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('noAssumptions')}</p>
          )}
        </div>
        <div>
          <h3>{t('missingData')}</h3>
          {notes.dataMissing.length ? (
            <ul className="plain-list gaps">
              {notes.dataMissing.map(group => (
                <li key={group.place}>
                  <Icon name="help" />
                  <span>
                    <strong>{group.place}.</strong> {group.items.join(' ')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{t('nothingMissing')}</p>
          )}
        </div>
      </div>
    </section>
  );
}
