import { type FormEvent, useId, useState } from 'react';
import type { HabitDraft, ToolClient } from '../client.ts';
import { ToolError } from '../client.ts';
import type { HabitFormError } from '../habit-form.ts';
import { habitCategories, readHabitForm } from '../habit-form.ts';
import { bold, rich, useMessages } from '../i18n.tsx';
import type { Subject } from '../launch.ts';
import { habitFormMessages } from '../messages/habit-form.messages.ts';

/** The element the journey trail opens and scrolls to. */
export const ADD_HABIT_ID = 'add-habit';

const categoryLabels = {
  housing: 'categoryHousing',
  food: 'categoryFood',
  transport: 'categoryTransport',
  utilities: 'categoryUtilities',
  subscriptions: 'categorySubscriptions',
  healthcare: 'categoryHealthcare',
  education: 'categoryEducation',
  debt: 'categoryDebt',
  other: 'categoryOther',
} as const satisfies Record<(typeof habitCategories)[number], string>;

type Props = {
  client: ToolClient;
  subject: Subject;
  /** The signed-in person saved a habit: re-read the person and the plan. */
  onSaved: () => void;
  /** Plan with this habit as a what-if; nothing is stored. */
  onWhatIf: (habit: HabitDraft) => void;
};

type Outcome =
  | { kind: 'invalid'; error: HabitFormError }
  | { kind: 'done'; message: 'saved' | 'addedWhatIf' }
  /** The server's own reason when it gave one; the form's words otherwise. */
  | { kind: 'failed'; message: 'couldNotSave' | 'notAvailable' | 'signIn'; reason?: string };

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A small form for one habit. The signed-in person saves it to their own profile through
 * `save_my_habit`; for a demo persona or a what-if person it only joins the estimate on screen, and
 * says so before and after. A server that cannot save yet answers with an error, shown as one.
 */
export function AddHabit({ client, subject, onSaved, onWhatIf }: Props) {
  const t = useMessages(habitFormMessages);
  const stored = subject.kind === 'me';
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [formKey, setFormKey] = useState(0);
  const ids = { title: useId(), category: useId(), saving: useId(), status: useId(), start: useId(), note: useId() };
  const savingHint = useId();
  const startHint = useId();
  const invalid = outcome?.kind === 'invalid' ? outcome.error : null;
  const fieldOf = (error: HabitFormError | null) =>
    error === null ? null : error.startsWith('title') ? 'title' : error === 'savingInvalid' ? 'saving' : 'start';
  const wrong = fieldOf(invalid);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '');
    const read = readHabitForm(
      {
        title: text('title'),
        category: text('category'),
        monthlySaving: text('saving'),
        status: text('status'),
        startedOn: text('startedOn'),
      },
      today(),
    );
    if (!read.ok) return setOutcome({ kind: 'invalid', error: read.error });
    if (!stored) {
      onWhatIf(read.habit);
      setFormKey(value => value + 1);
      return setOutcome({ kind: 'done', message: 'addedWhatIf' });
    }
    setBusy(true);
    setOutcome(null);
    try {
      await client.saveHabit(read.habit);
      setFormKey(value => value + 1);
      setOutcome({ kind: 'done', message: 'saved' });
      onSaved();
    } catch (error) {
      const kind = error instanceof ToolError ? error.kind : 'failed';
      setOutcome(
        kind === 'unavailable'
          ? { kind: 'failed', message: 'notAvailable' }
          : kind === 'signin'
            ? { kind: 'failed', message: 'signIn' }
            : {
                kind: 'failed',
                message: 'couldNotSave',
                ...(error instanceof ToolError && kind === 'failed' && error.message ? { reason: error.message } : {}),
              },
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="add-habit" id={ADD_HABIT_ID}>
      <summary>{t('summary')}</summary>
      <p className={stored ? 'hint' : 'rc-note rc-note--warn note-compact'}>
        {stored ? t('introSaved') : rich(t(subject.kind === 'demo' ? 'introDemo' : 'introWhatIf'), { b: bold })}
      </p>
      <form key={formKey} className="habit-form" onSubmit={event => void onSubmit(event)} noValidate>
        <div className="rc-field habit-form-wide">
          <label htmlFor={ids.title}>{t('title')}</label>
          <input
            id={ids.title}
            name="title"
            maxLength={80}
            autoComplete="off"
            placeholder={t('titlePlaceholder')}
            aria-invalid={wrong === 'title' || undefined}
            aria-describedby={wrong === 'title' ? ids.note : undefined}
          />
        </div>
        <div className="rc-field">
          <label htmlFor={ids.category}>{t('category')}</label>
          <select id={ids.category} name="category" defaultValue="other">
            {habitCategories.map(category => (
              <option key={category} value={category}>
                {t(categoryLabels[category])}
              </option>
            ))}
          </select>
        </div>
        <div className="rc-field">
          <label htmlFor={ids.saving}>{t('saving')}</label>
          <input
            id={ids.saving}
            name="saving"
            inputMode="decimal"
            autoComplete="off"
            aria-invalid={wrong === 'saving' || undefined}
            aria-describedby={wrong === 'saving' ? `${savingHint} ${ids.note}` : savingHint}
          />
          <p id={savingHint} className="hint">
            {t('savingHint')}
          </p>
        </div>
        <div className="rc-field">
          <label htmlFor={ids.status}>{t('status')}</label>
          <select id={ids.status} name="status" defaultValue="active">
            <option value="active">{t('statusActive')}</option>
            <option value="paused">{t('statusPaused')}</option>
          </select>
        </div>
        <div className="rc-field">
          <label htmlFor={ids.start}>{t('startedOn')}</label>
          <input
            id={ids.start}
            name="startedOn"
            type="date"
            defaultValue={today()}
            aria-invalid={wrong === 'start' || undefined}
            aria-describedby={wrong === 'start' ? `${startHint} ${ids.note}` : startHint}
          />
          <p id={startHint} className="hint">
            {t('startedOnHint')}
          </p>
        </div>
        <button
          type="submit"
          className="rc-btn rc-btn--primary rc-btn--sm habit-form-wide"
          disabled={busy}
          aria-busy={busy || undefined}
        >
          {stored ? t('save') : t('addWhatIf')}
        </button>
      </form>
      {outcome ? (
        <p
          id={ids.note}
          className={outcome.kind === 'done' ? 'hint' : outcome.kind === 'invalid' ? 'field-error' : 'hint hint-warn'}
          role={outcome.kind === 'done' ? 'status' : 'alert'}
        >
          {outcome.kind === 'invalid'
            ? t(outcome.error)
            : outcome.kind === 'failed' && outcome.reason
              ? `${t('couldNotSave')} ${outcome.reason}`
              : t(outcome.message)}
        </p>
      ) : null}
    </details>
  );
}
