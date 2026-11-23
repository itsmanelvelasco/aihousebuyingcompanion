import { formatClock, formatDate, formatEuros } from '../format.ts';
import type { BankFeedState } from '../hooks.ts';
import { rich, useLocale, useMessages } from '../i18n.tsx';
import { bankMessages } from '../messages/bank.messages.ts';
import { Ago, Badge, ErrorNote, Icon, Monthly } from './bits.tsx';

type Props = {
  userId: string | null;
  feed: BankFeedState;
  onRetry: () => void;
  /** Whether the person is fictional; unknown until the plan has loaded. The bank data is labelled separately. */
  personSynthetic?: boolean | null;
};

const stateLabels = { live: 'stateLive', error: 'stateError', waiting: 'stateWaiting' } as const;
const dataStatus = { observed: 'statusObserved', partial: 'statusPartial', unknown: 'statusUnknown' } as const;

/** Recent bank activity for the person, labelled synthetic or real from the records themselves. */
export function BankStrip({ userId, feed, onRetry, personSynthetic }: Props) {
  const locale = useLocale();
  const t = useMessages(bankMessages);
  // The runtime describes only the built-in simulator. Movements also arrive from connected banks,
  // so being "live" means this view is following the ledger, whichever source feeds it.
  const simulatorOn = feed.runtime?.enabled === true;
  const state = feed.phase === 'live' ? 'live' : feed.phase === 'error' ? 'error' : 'waiting';
  // Unknown until a summary arrives; never call data real or synthetic on a guess.
  const synthetic = feed.summary?.synthetic;
  const when = (value: string) => t('dateTime', { date: formatDate(value, locale), time: formatClock(value, locale) });

  return (
    <section className="panel bank" aria-labelledby="bank-title">
      <div className="bank-line">
        <span className={`live live-${state}`}>
          <Icon name={state === 'error' ? 'warning' : 'pulse'} />
          {userId ? t(stateLabels[state]) : t('noFeed')}
        </span>
        <h2 id="bank-title">
          <Icon name="bank" />
          {t('title')}
        </h2>
        {synthetic === true && personSynthetic === false ? (
          // A real person connected to a fictional bank: the movements are synthetic, the profile is not.
          <Badge tone="violet" title={t('syntheticBankTitle')}>
            {t('syntheticBankBadge')}
          </Badge>
        ) : synthetic === true ? (
          <Badge tone="violet" title={t('syntheticTitle')}>
            {t('syntheticBadge')}
          </Badge>
        ) : synthetic === false ? (
          <Badge tone="ok" title={t('realTitle')}>
            {t('realBadge')}
          </Badge>
        ) : null}
        <span className="bank-status" role="status">
          {!userId ? (
            t('noPerson')
          ) : feed.phase === 'connecting' || feed.phase === 'idle' ? (
            t('connecting')
          ) : feed.phase === 'error' ? (
            t('notFollowed')
          ) : (
            <>
              {feed.checkedAt ? rich(t('checked'), { ago: <Ago since={feed.checkedAt} /> }) : t('checkedJustNow')}
              {' · '}
              {feed.changedAt ? (
                <strong>
                  {rich(
                    feed.newTransactions === null
                      ? t('newActivityRefreshed')
                      : feed.newTransactions === 0
                        ? t('ledgerChangedRefreshed')
                        : t('newTransactionsRefreshed', { count: feed.newTransactions }),
                    { ago: <Ago since={feed.changedAt} /> },
                  )}
                </strong>
              ) : feed.events[0] ? (
                t('lastChange', {
                  date: formatDate(feed.events[0].occurredAt, locale),
                  time: formatClock(feed.events[0].occurredAt, locale),
                })
              ) : (
                t('noActivity')
              )}
            </>
          )}
        </span>
      </div>

      {feed.phase === 'error' && feed.error ? (
        <ErrorNote title={t('feedUnavailable')} error={feed.error} onRetry={onRetry} compact />
      ) : null}

      {userId && feed.phase === 'live' ? (
        <details className="bank-details">
          <summary>{t('detailsSummary')}</summary>
          <div className="bank-grid">
            <div>
              <h3>{t('latestChanges')}</h3>
              {feed.events.length === 0 ? (
                <p className="muted">{t('noChanges')}</p>
              ) : (
                <ul className="events">
                  {feed.events.map(event => (
                    <li key={event.sequence}>
                      <time dateTime={event.occurredAt}>{when(event.occurredAt)}</time>
                      {/* The count is the size of the ledger after the change, not what the change added. */}
                      <span>{t('ledgerAt', { movements: event.transactionCount, accounts: event.accountCount })}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="hint">
                {simulatorOn && feed.runtime
                  ? t('simulatorEvery', { seconds: Math.round(feed.runtime.intervalMs / 1000) })
                  : t('whenReported')}{' '}
                {t('checkedEvery', { seconds: Math.round(feed.pollMs / 1000) })}
              </p>
            </div>
            <div>
              <h3>{t('lastThreeMonths')}</h3>
              {feed.summary ? (
                <>
                  <dl className="figures figures-compact">
                    <div>
                      <dt>{t('income')}</dt>
                      <dd>{formatEuros(feed.summary.incomeCents, locale)}</dd>
                    </div>
                    <div>
                      <dt>{t('spending')}</dt>
                      <dd>{formatEuros(feed.summary.expenseCents, locale)}</dd>
                    </div>
                    <div className="figure-key">
                      <dt>{t('averageKept')}</dt>
                      <dd className={feed.summary.averageMonthlySavingsCents === null ? 'unknown' : undefined}>
                        <Monthly cents={feed.summary.averageMonthlySavingsCents} />
                      </dd>
                    </div>
                  </dl>
                  <p className="hint">
                    {[
                      t('period', {
                        from: formatDate(feed.summary.from, locale),
                        to: formatDate(feed.summary.to, locale),
                      }),
                      t('bookedMovements', { count: feed.summary.transactionCount }),
                      t(dataStatus[feed.summary.dataStatus]),
                      t('leftOut', {
                        pending: feed.summary.excludedPendingCount,
                        transfers: feed.summary.excludedInternalTransferCount,
                      }),
                    ].join(' · ')}
                  </p>
                </>
              ) : feed.summaryError ? (
                <p className="muted">{rich(t('summaryUnavailable'), { reason: feed.summaryError })}</p>
              ) : (
                <p className="muted">{t('loadingSummary')}</p>
              )}
            </div>
          </div>
        </details>
      ) : null}
    </section>
  );
}
