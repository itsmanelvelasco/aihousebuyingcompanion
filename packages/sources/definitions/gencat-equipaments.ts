import { z } from 'zod';
import { municipalityCode, serviceCount } from '../../contracts/places.ts';
import { socrata, socrataQuery, socrataUpdatedOn, soqlList } from '../http.ts';
import { withServices } from '../overlay.ts';
import { defineSource } from '../source.ts';

const dataset = '8gmd-gz7i';
const pageLimit = 50_000;
type Kind = z.infer<typeof serviceCount>['kind'];

/**
 * Category labels of the Generalitat facilities directory, checked against the live dataset on
 * 2026-11-22. A facility counts once per kind even when it lists several spaces or sub-categories.
 * The directory has no pharmacy category, so that kind is absent; social services have their own source.
 */
const categories: { kind: Kind; label: string }[] = [
  { kind: 'primary_care', label: "Salut|Centres sanitaris|1. Centres d'atenció primària (CAP)" },
  { kind: 'hospital', label: 'Salut|Centres sanitaris|3. Hospitals' },
  { kind: 'library', label: 'Cultura|Biblioteques' },
  { kind: 'sports', label: 'Esports. Lleure|Instal·lacions esportives' },
];
/** Many health centres and most local surgeries are published without a category; their names identify them. */
const uncategorisedPrimaryCare = /^(CAP|Consultori local)\s/i;
/** Sexual and reproductive health units share the building of a CAP that is already counted. */
const unitInsideCentre = /^ASSIR\s/i;

export type FacilityRow = { idequipament?: string; nom?: string; categoria?: string; codi_municipi?: string };

function isKind(row: FacilityRow, kind: Kind, label: string) {
  if (row.categoria)
    return row.categoria.includes(label) && !(kind === 'primary_care' && unitInsideCentre.test(row.nom ?? ''));
  return kind === 'primary_care' && uncategorisedPrimaryCare.test(row.nom ?? '');
}

/** The directory drops the leading zero of Barcelona-province codes ("80312" for "080312"). */
const directoryCode = (code: string) => code.replace(/^0/, '');

/**
 * Counts listed facilities per municipality and kind. A kind with no listed facility is left out:
 * absence from the directory is not evidence that a town has none.
 */
export function countFacilities(rows: FacilityRow[], codes: string[], observedAt: string) {
  const provenance = { observedAt, sourceUrl: `${socrata}/d/${dataset}` };
  return Object.fromEntries(
    codes.map(code => {
      const local = rows.filter(row => row.idequipament && row.codi_municipi?.padStart(6, '0') === code);
      const counts = categories.map(({ kind, label }) => ({
        ...provenance,
        kind,
        count: new Set(local.filter(row => isKind(row, kind, label)).map(row => row.idequipament)).size,
      }));
      return [code, counts.filter(entry => entry.count > 0)] as const;
    }),
  );
}

export default defineSource({
  id: 'gencat-equipaments',
  title: 'Equipaments de Catalunya',
  authority: 'Generalitat de Catalunya, Direcció General de Serveis Digitals i Experiència Ciutadana',
  homepage: `${socrata}/d/${dataset}`,
  ttlMs: 24 * 60 * 60 * 1000,
  schema: z.record(municipalityCode, z.array(serviceCount)),
  async fetch(context) {
    const codes = context.municipalities.map(town => town.code);
    const [rows, observedAt] = await Promise.all([
      socrataQuery<FacilityRow[]>(context, dataset, {
        $select: 'idequipament,nom,categoria,codi_municipi',
        $where: `codi_municipi in (${soqlList([...new Set(codes.flatMap(code => [code, directoryCode(code)]))])})`,
        $order: 'idequipament',
        $limit: String(pageLimit),
      }),
      socrataUpdatedOn(context, dataset),
    ]);
    if (!Array.isArray(rows) || !rows.length || rows.length === pageLimit) {
      throw new Error('Incomplete facilities directory download');
    }
    return countFacilities(rows, codes, observedAt);
  },
  overlay: withServices,
});
