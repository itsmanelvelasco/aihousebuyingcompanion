import { createHash } from 'node:crypto';
import {
  deleteExpiredPreviews,
  deletePreview,
  getImport,
  getPreview,
  putPreview,
  trimPreviews,
} from '../../packages/db/bank-person.ts';
import type { Database } from '../../packages/db/database.ts';
import { getTransaction } from '../../packages/db/ledger.ts';
import type { Transaction } from '../../packages/finance/cashflow.ts';
import { cashFlowStatements, parseTransactions, summarizeTransactions } from '../../packages/finance/csv.ts';
import { ApiError } from '../../packages/http/server.ts';
import { createFormat } from '../../packages/i18n/format.ts';
import { requireUser } from '../../packages/profiles/store.ts';
import type { createBankStore, StatementBatch } from './bank.ts';
import { manualAccountId } from './bank.ts';

/**
 * A person imports a bank statement (CSV) into their own ledger, in two steps:
 *
 *   1. `preview` reads the statement, summarises it and keeps it for a short while. Nothing is
 *      written to the ledger. The answer carries `previewHash`.
 *   2. `confirm` takes that hash and writes exactly the statement that was summarised.
 *
 * A write therefore always follows a summary the person (or the assistant speaking for them) was
 * given: there is no call that takes a statement and writes it in one go.
 *
 * The statement is parsed by `packages/finance/csv.ts`, the same reader the interview uses, so the
 * same columns are accepted (`date`, `description`, `amount`) and the same honesty applies to
 * monthly figures: a statement shorter than 28 days gives none (`averageBasis:
 * 'period_too_short'`), and the preview says so instead of scaling a few days to a month.
 */

/** Largest statement accepted, in bytes of UTF-8 text. */
export const maxStatementBytes = 262_144;
/** Most rows one statement may carry. */
export const maxStatementRows = 2000;
/** How long an uploaded statement waits for its confirmation. */
const previewTtlMs = 15 * 60_000;
/** Unconfirmed statements kept per person; uploading another drops the oldest. */
const maxPreviews = 3;

type Category = Transaction['category'];

/** Keyword rules for the ledger's categories; the first match wins. Unmatched spending is `other`. */
const spending: [Category, RegExp][] = [
  ['housing', /\brent\b|alquiler|lloguer|arrendamiento/],
  ['debt', /\bloan\b|pr[eé]stamo|pr[eé]stec|mortgage|hipoteca/],
  ['food', /grocer|supermarket|supermercat|mercadona|lidl|aldi|carrefour|restaurant|cafe|coffee|takeaway|glovo/],
  ['utilities', /electric|water bill|internet|utility|energia|iberdrola|endesa|\bgas\b/],
  ['transport', /metro|train|fuel|uber|transit|renfe|\bbus\b|gasolin/],
  ['subscriptions', /netflix|spotify|subscription|suscripci[oó]n|subscripci[oó]/],
  ['healthcare', /pharmacy|farmacia|farm[aà]cia|medical|dental|clinic/],
  ['education', /school|escola|colegio|tuition|universit|matr[ií]cula/],
];
const ownTransfer = /internal transfer|own account|transferencia propia|transfer[eè]ncia pr[oò]pia/;
const pay = /salary|payroll|n[oó]mina|wages/;

function categorize(label: string, cents: number): Category {
  if (ownTransfer.test(label)) return 'internal_transfer';
  if (cents > 0) return pay.test(label) ? 'income' : 'other';
  return spending.find(([, pattern]) => pattern.test(label))?.[0] ?? 'other';
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Read a statement into ledger rows. The ID of a row is derived from its date, amount, description
 * and its position among identical rows, never from the file: the same row gets the same ID from
 * any statement that contains it, which is what makes importing twice, or importing two statements
 * that overlap, write each movement once.
 */
export function readStatement(csv: string) {
  if (typeof csv !== 'string' || !csv.trim()) throw new ApiError(400, 'The statement is empty');
  if (Buffer.byteLength(csv, 'utf8') > maxStatementBytes)
    throw new ApiError(413, `The statement is larger than ${maxStatementBytes / 1024} KiB`);
  let parsed: ReturnType<typeof parseTransactions>;
  try {
    parsed = parseTransactions(csv);
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : 'The statement could not be read');
  }
  if (parsed.length > maxStatementRows)
    throw new ApiError(400, `The statement has more than ${maxStatementRows} rows; split it by period`);
  const seen = new Map<string, number>();
  const rows: StatementBatch['rows'] = [];
  let skippedZeroAmountRows = 0;
  for (const { date, label, cents } of parsed) {
    if (cents === 0) {
      skippedZeroAmountRows++;
      continue;
    }
    const key = `${date}|${cents}|${label}`;
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    rows.push({
      id: `csv-${digest(`${key}|${occurrence}`).slice(0, 28)}`,
      date,
      description: label.slice(0, 200),
      amountCents: cents,
      category: categorize(label, cents),
    });
  }
  if (!rows.length) throw new ApiError(400, 'The statement has no row with an amount');
  const dates = rows.map(row => row.date).sort();
  // The same movements are the same statement, in whatever order the file lists them.
  const canonical = rows
    .map(row => row.id)
    .sort()
    .join('\n');
  return {
    batch: {
      importId: `imp-${digest(canonical).slice(0, 24)}`,
      coveredFrom: dates[0],
      coveredTo: dates[dates.length - 1],
      rows,
    } satisfies StatementBatch,
    skippedZeroAmountRows,
    summary: summarizeTransactions(parsed),
  };
}

type BankStore = ReturnType<typeof createBankStore>;

export function createStatementImports(db: Database, bank: BankStore, clock: () => Date = () => new Date()) {
  /** What a statement would do to this person's ledger, without doing it. */
  function describe(
    userId: string,
    statement: ReturnType<typeof readStatement>,
    previewHash: string,
    expiresAt: string,
  ) {
    const { batch, summary, skippedZeroAmountRows } = statement;
    const byCategory: Record<string, { count: number; cents: number }> = {};
    let inflowCents = 0;
    let outflowCents = 0;
    let alreadyInLedger = 0;
    for (const row of batch.rows) {
      const entry = (byCategory[row.category] ??= { count: 0, cents: 0 });
      entry.count++;
      entry.cents += row.amountCents;
      if (row.category !== 'internal_transfer') {
        if (row.amountCents > 0) inflowCents += row.amountCents;
        else outflowCents -= row.amountCents;
      }
      if (getTransaction(db, userId, row.id)) alreadyInLedger++;
    }
    const wording = cashFlowStatements(summary, amount => createFormat().money(amount, 'EUR'));
    return {
      previewHash,
      expiresAt,
      importId: batch.importId,
      /** True when this exact statement was imported before: confirming it again writes nothing. */
      alreadyImported: getImport(db, userId, batch.importId) !== undefined,
      /** A statement is the person's own real data, never demo data. */
      synthetic: false,
      accountId: manualAccountId,
      rowCount: batch.rows.length,
      newRows: batch.rows.length - alreadyInLedger,
      alreadyInLedger,
      skippedZeroAmountRows,
      coveredFrom: batch.coveredFrom,
      coveredTo: batch.coveredTo,
      coveredDays: summary.coveredDays,
      /** What came in and went out over the days covered, transfers between own accounts left out. Not monthly. */
      periodTotals: { inflowCents, outflowCents, netCents: inflowCents - outflowCents },
      /** Rows and their signed sum per ledger category, as they would be stored. */
      byCategory,
      /** `complete_months`, `partial_months_only` or `period_too_short`: see `packages/finance/csv.ts`. */
      averageBasis: summary.averageBasis,
      /** False when the statement is too short for any monthly figure; none may then be quoted. */
      monthlyFigures: wording.monthlyFigures,
      averagingNote: summary.averagingNote,
      guidance: wording.guidance,
    };
  }

  const previewHashOf = (userId: string, importId: string) =>
    digest(`statement-preview\n${userId}\n${importId}`).slice(0, 40);

  return {
    /** Step 1: read and summarise. The statement is kept for 15 minutes; the ledger is not touched. */
    async preview(userId: string, csv: unknown) {
      requireUser(db, userId);
      const statement = readStatement(csv as string);
      const now = clock();
      const expiresAt = new Date(now.getTime() + previewTtlMs).toISOString();
      const previewHash = previewHashOf(userId, statement.batch.importId);
      return db.transaction(() => {
        putPreview(db, userId, { previewHash, csv: csv as string, createdAt: now.toISOString(), expiresAt });
        trimPreviews(db, userId, maxPreviews);
        return describe(userId, statement, previewHash, expiresAt);
      });
    },

    /** Step 2: write the statement whose preview carried this hash. Without a live preview nothing is written. */
    async confirm(userId: string, previewHash: unknown) {
      requireUser(db, userId);
      const hash = typeof previewHash === 'string' && /^[0-9a-f]{40}$/.test(previewHash) ? previewHash : '';
      const stored = hash ? getPreview(db, userId, hash) : undefined;
      if (!stored || stored.expiresAt <= clock().toISOString())
        throw new ApiError(
          409,
          'There is no statement waiting under this preview hash. Preview the statement again, review the summary, then confirm.',
        );
      const statement = readStatement(stored.csv);
      // The stored text is what was summarised; a hash that does not match it is not a confirmation of it.
      if (previewHashOf(userId, statement.batch.importId) !== hash)
        throw new ApiError(409, 'The preview does not match');
      const outcome = await bank.importStatement(userId, statement.batch);
      deletePreview(db, userId, hash);
      return {
        ...outcome.result,
        synthetic: false,
        accountId: manualAccountId,
        coveredFrom: statement.batch.coveredFrom,
        coveredTo: statement.batch.coveredTo,
        revision: outcome.ledger.revision,
      };
    },

    /** Drop an uploaded statement that will not be confirmed. */
    async discard(userId: string, previewHash: string) {
      requireUser(db, userId);
      return { discarded: deletePreview(db, userId, previewHash) };
    },

    list: (userId: string) => bank.imports(userId),

    /** Delete an imported statement and the movements only it brought. */
    async remove(userId: string, importId: string) {
      return (await bank.deleteImport(userId, importId)).result;
    },

    /** Remove uploads nobody confirmed in time. */
    housekeeping() {
      return deleteExpiredPreviews(db, clock().toISOString());
    },
  };
}

export type StatementImports = ReturnType<typeof createStatementImports>;
