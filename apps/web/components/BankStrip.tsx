import { formatClock, formatDate, formatEuros } from '../format.ts';
import type { BankFeedState } from '../hooks.ts';
import { Ago, Badge, ErrorNote, Icon, Monthly } from './bits.tsx';

type Props = {
  userId: string | null;
  feed: BankFeedState;
  onRetry: () => void;
  /** Whether the person is fictional; unknown until the plan has loaded. The bank data is labelled separately. */
  personSynthetic?: boolean | null;
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Recent bank activity for the person, labelled synthetic or real from the records themselves. */
export function BankStrip({ userId, feed, onRetry, personSynthetic }: Props) {
  // The runtime describes only the built-in simulator. Movements also arrive from connected banks,
  // so being "live" means this view is following the ledger, whichever source feeds it.
  const simulatorOn = feed.runtime?.enabled === true;
  const state = feed.phase === 'live' ? 'live' : feed.phase === 'error' ? 'error' : 'waiting';
  const stateLabel = { live: 'Live', error: 'Unavailable', waiting: 'Connecting' }[state];
  // Unknown until a summary arrives; never call data real or synthetic on a guess.
  const synthetic = feed.summary?.synthetic;

  return (
    <section className="panel bank" aria-labelledby="bank-title">
      <div className="bank-line">
        <span className={`live live-${state}`}>
          <Icon name={state === 'error' ? 'warning' : 'pulse'} />
          {userId ? stateLabel : 'No feed'}
        </span>
        <h2 id="bank-title">
          <Icon name="bank" />
          Bank activity
        </h2>
        {synthetic === true && personSynthetic === false ? (
          // A real person connected to a fictional bank: the movements are synthetic, the profile is not.
          <Badge
            tone="violet"
            title="These movements come from a fictional bank feed, not from a real bank. Your profile is your own."
          >
            Synthetic bank data
          </Badge>
        ) : synthetic === true ? (
          <Badge tone="violet" title="Fictional transactions generated for the demo. No real bank is connected.">
            Synthetic data
          </Badge>
        ) : synthetic === false ? (
          <Badge tone="ok" title="These figures include movements from a connected bank.">
            Bank data
          </Badge>
        ) : null}
        <span className="bank-status" role="status">
          {!userId ? (
            'No person selected, so there is no feed to follow.'
          ) : feed.phase === 'connecting' || feed.phase === 'idle' ? (
            'Connecting to the bank feed…'
          ) : feed.phase === 'error' ? (
            'Bank activity is not being followed.'
          ) : (
            <>
              Checked {feed.checkedAt ? <Ago since={feed.checkedAt} /> : 'just now'}
              {feed.changedAt ? (
                <>
                  {' · '}
                  <strong>
                    {feed.newTransactions === null
                      ? 'New activity'
                      : feed.newTransactions === 0
                        ? 'Ledger changed'
                        : plural(feed.newTransactions, 'new transaction')}
                    , figures refreshed <Ago since={feed.changedAt} />
                  </strong>
                </>
              ) : feed.events[0] ? (
                ` · last change ${formatDate(feed.events[0].occurredAt)}, ${formatClock(feed.events[0].occurredAt)}`
              ) : (
                ' · no activity recorded yet'
              )}
            </>
          )}
        </span>
      </div>

      {feed.phase === 'error' && feed.error ? (
        <ErrorNote title="Bank feed unavailable" error={feed.error} onRetry={onRetry} compact />
      ) : null}

      {userId && feed.phase === 'live' ? (
        <details className="bank-details">
          <summary>Recent activity and cash flow</summary>
          <div className="bank-grid">
            <div>
              <h3>Latest changes</h3>
              {feed.events.length === 0 ? (
                <p className="muted">No bank changes have been recorded for this person.</p>
              ) : (
                <ul className="events">
                  {feed.events.map(event => (
                    <li key={event.sequence}>
                      <time dateTime={event.occurredAt}>
                        {formatDate(event.occurredAt)}, {formatClock(event.occurredAt)}
                      </time>
                      {/* The count is the size of the ledger after the change, not what the change added. */}
                      <span>
                        ledger at {plural(event.transactionCount, 'movement')} on{' '}
                        {plural(event.accountCount, 'account')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint">
                {simulatorOn && feed.runtime
                  ? `The built-in simulator adds movements about every ${Math.round(feed.runtime.intervalMs / 1000)} s.`
                  : 'Movements appear when a connected bank reports them.'}{' '}
                Checked here every {Math.round(feed.pollMs / 1000)} s while this view is visible.
              </p>
            </div>
            <div>
              <h3>Last three complete months</h3>
              {feed.summary ? (
                <>
                  <dl className="figures figures-compact">
                    <div>
                      <dt>Income</dt>
                      <dd>{formatEuros(feed.summary.incomeCents)}</dd>
                    </div>
                    <div>
                      <dt>Spending</dt>
                      <dd>{formatEuros(feed.summary.expenseCents)}</dd>
                    </div>
                    <div className="figure-key">
                      <dt>Average kept</dt>
                      <dd className={feed.summary.averageMonthlySavingsCents === null ? 'unknown' : undefined}>
                        <Monthly cents={feed.summary.averageMonthlySavingsCents} />
                      </dd>
                    </div>
                  </dl>
                  <p className="hint">
                    {formatDate(feed.summary.from)} to {formatDate(feed.summary.to)} ·{' '}
                    {plural(feed.summary.transactionCount, 'booked movement')} ·{' '}
                    {feed.summary.dataStatus === 'observed'
                      ? 'every month has data'
                      : feed.summary.dataStatus === 'partial'
                        ? 'some months have no data'
                        : 'no data for these months'}
                    {' · '}
                    {feed.summary.excludedPendingCount} pending and {feed.summary.excludedInternalTransferCount}{' '}
                    own-account transfers left out.
                  </p>
                </>
              ) : feed.summaryError ? (
                <p className="muted">Cash-flow summary unavailable. {feed.summaryError}</p>
              ) : (
                <p className="muted">Loading the summary…</p>
              )}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}
