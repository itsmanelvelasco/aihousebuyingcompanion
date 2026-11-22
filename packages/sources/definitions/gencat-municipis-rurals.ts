import { z } from 'zod';
import type { Municipality } from '../../contracts/places.ts';
import { municipality, municipalityCode } from '../../contracts/places.ts';
import { socrata, socrataQuery, socrataUpdatedOn } from '../http.ts';
import type { LiveData } from '../source.ts';
import { defineSource } from '../source.ts';

const dataset = '7gqm-722r';
const pageLimit = 2000;
export const ruralUrl = `${socrata}/d/${dataset}`;
/** The resolution listing the rural municipalities, in force from 2026-02-24. */
export const ruralResolutionUrl = 'https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1037694';
/** Resolució PRE/3375/2026: municipalities added to the special regime, in force from 2026-09-29. */
export const ruralAdditionsUrl = 'https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1055370';

type Rural = Municipality['rural'];
export type RuralRow = { codi?: string; classificacio?: string };

/**
 * Maps the dataset's classification label to a category. The labels were checked against the live
 * dataset on 2026-11-22; an unknown label throws, so a renamed class can never pass silently.
 * A municipality that the list does not name is `not_listed`.
 */
export function ruralStatus(label: string | undefined, observedAt: string): Rural {
  const provenance = { observedAt, sourceUrl: ruralUrl };
  switch (label) {
    case "Municipi rural d'atenció especial":
      return {
        ...provenance,
        category: 'special_attention',
        effectiveFrom: '2026-02-24',
        legalUrl: ruralResolutionUrl,
      };
    case 'Municipi rural':
      return { ...provenance, category: 'rural', effectiveFrom: '2026-02-24', legalUrl: ruralResolutionUrl };
    case 'Municipi amb aplicació de les mesures del règim especial':
      // The dataset does not date each entry. The later date never grants a benefit too early.
      return { ...provenance, category: 'rural', effectiveFrom: '2026-09-29', legalUrl: ruralAdditionsUrl };
    case 'Municipi amb aplicació parcial de les mesures del règim especial':
      return { ...provenance, category: 'partial', effectiveFrom: '2026-02-24', legalUrl: ruralResolutionUrl };
    case undefined:
      return { ...provenance, category: 'not_listed', effectiveFrom: null };
    default:
      throw new Error(`Unrecognized rural classification: ${label}`);
  }
}

/** The rural status of each given municipality, from the rows of the whole published list. */
export function ruralStatuses(rows: RuralRow[], codes: string[], observedAt: string) {
  const listed = new Map(rows.map(row => [row.codi, row.classificacio]));
  return Object.fromEntries(
    codes.map(code => {
      if (listed.has(code) && !listed.get(code)) throw new Error(`Listed without a classification: ${code}`);
      return [code, ruralStatus(listed.get(code), observedAt)] as const;
    }),
  );
}

/** Replaces the rural status of the municipalities the value covers. Names and codes are untouched. */
function withRural(data: LiveData, value: Record<string, Rural>): LiveData {
  const [first, ...rest] = data.snapshot.municipalities.map(town =>
    value[town.code] ? { ...town, rural: value[town.code] } : town,
  );
  return { ...data, snapshot: { ...data.snapshot, municipalities: [first, ...rest] } };
}

export default defineSource({
  id: 'gencat-municipis-rurals',
  title: 'Municipis rurals',
  authority: "Generalitat de Catalunya, Direcció General d'Administració Local",
  homepage: ruralUrl,
  ttlMs: 24 * 60 * 60 * 1000,
  schema: z.record(municipalityCode, municipality.shape.rural),
  async fetch(context) {
    const [rows, observedAt] = await Promise.all([
      socrataQuery<RuralRow[]>(context, dataset, { $select: 'codi,classificacio', $limit: String(pageLimit) }),
      socrataUpdatedOn(context, dataset),
    ]);
    // The list names about 600 of Catalonia's 947 municipalities; far fewer means a broken download.
    if (!Array.isArray(rows) || rows.length < 500 || rows.length === pageLimit) {
      throw new Error('Incomplete rural classification download');
    }
    return ruralStatuses(
      rows,
      context.municipalities.map(town => town.code),
      observedAt,
    );
  },
  overlay: withRural,
});
