import { formatClock, formatDate, formatEuros, formatMonthly } from '../format.ts';
import type { BankFeedState } from '../hooks.ts';
import { Ago, Badge, ErrorNote } from './bits.tsx';

type Props = { userId: string | null; feed: BankFeedState; onRetry: () => void };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Recent bank activity for the person. The data is fictional and says so on every state. */
export function BankStrip({ userId, feed, onRetry }: Props) {
  const feedOff = feed.runtime !== null && !feed.runtime.enabled;
  const state = feed.phase === 'live' ? (feedOff ? 'paused' : 'live') : feed.phase === 'error' ? 'error' : 'waiting';
  const stateLabel = { live: 'Live', paused: 'Feed off', error: 'Unavailable', waiting: 'Connecting' }[state];

  return (
    <section className="panel bank" aria-labelledby="bank-title">
      <div className="bank-line">
        <span className={`live live-${state}`}>
          <span className="dot" aria-hidden="true" />
          {userId ? stateLabel : 'No feed'}
        </span>
        <h2 id="bank-title">Bank activity</h2>
        <Badge tone="violet" title="Fictional transactions generated for the demo. No real bank is connected.">
          Synthetic data
        </Badge>
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
                    {plural(feed.newTransactions, 'new transaction')}, figures refreshed <Ago since={feed.changedAt} />
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
                      <span>
                        {plural(event.transactionCount, 'transaction')} on {plural(event.accountCount, 'account')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint">
                {feed.runtime === null
                  ? 'Feed status unknown.'
                  : feedOff
                    ? 'The synthetic feed is switched off; this is the last stored activity.'
                    : `The synthetic feed adds movements about every ${Math.round(feed.runtime.intervalMs / 1000)} s.`}{' '}
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
                    <div>
                      <dt>Average kept</dt>
                      <dd className={feed.summary.averageMonthlySavingsCents === null ? 'unknown' : undefined}>
                        {formatMonthly(feed.summary.averageMonthlySavingsCents)}
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
