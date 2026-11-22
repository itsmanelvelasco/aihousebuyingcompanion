import { z } from 'zod';
import { municipalityCode, serviceCount } from '../../contracts/places.ts';
import { socrata, socrataQuery, socrataUpdatedOn } from '../http.ts';
import { matchTownsByName } from '../names.ts';
import { withServices } from '../overlay.ts';
import type { SourceTown } from '../source.ts';
import { defineSource } from '../source.ts';

const dataset = 'ivft-vegh';
const pageLimit = 50_000;

export type SocialServiceRow = { registre?: string; municipi?: string; comarca?: string };

/**
 * Counts registered social services and establishments per municipality. The register names the
 * municipality and comarca but has no official code, so towns are joined by name and comarca and
 * only clean matches are counted. A town with no clean match is left out: unknown, never zero.
 */
export function countSocialServices(rows: SocialServiceRow[], towns: SourceTown[], observedAt: string) {
  const matched = matchTownsByName(towns, rows);
  return Object.fromEntries(
    towns.map(town => {
      const count = new Set((matched.get(town.code) ?? []).map(row => row.registre).filter(Boolean)).size;
      const entry = { kind: 'social_services' as const, count, observedAt, sourceUrl: `${socrata}/d/${dataset}` };
      return [town.code, count > 0 ? [entry] : []] as const;
    }),
  );
}

export default defineSource({
  id: 'gencat-serveis-socials',
  title: "Registre d'entitats, serveis i establiments socials",
  authority: 'Generalitat de Catalunya, Departament de Drets Socials i Inclusió',
  homepage: `${socrata}/d/${dataset}`,
  ttlMs: 24 * 60 * 60 * 1000,
  schema: z.record(municipalityCode, z.array(serviceCount)),
  async fetch(context) {
    const [rows, observedAt] = await Promise.all([
      socrataQuery<SocialServiceRow[]>(context, dataset, {
        $select: 'registre,municipi,comarca',
        $order: 'registre',
        $limit: String(pageLimit),
      }),
      socrataUpdatedOn(context, dataset),
    ]);
    if (!Array.isArray(rows) || rows.length < 1000 || rows.length === pageLimit) {
      throw new Error('Incomplete social services register download');
    }
    return countSocialServices(rows, context.municipalities, observedAt);
  },
  overlay: withServices,
});
