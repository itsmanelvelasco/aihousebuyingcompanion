import { z } from 'zod';
import type { School } from '../../contracts/places.ts';
import { school, source } from '../../contracts/places.ts';
import { distanceKm } from '../../places/geography.ts';
import { socrata, socrataQuery, socrataUpdatedOn, soqlList } from '../http.ts';
import { comarcaSpellings } from '../names.ts';
import { withDerivedServices } from '../overlay.ts';
import type { LiveData, SourceTown } from '../source.ts';
import { defineSource } from '../source.ts';
import { coordinates, latestYear } from '../values.ts';

const dataset = 'kvmv-ahh4';
const pageLimit = 4000;
const maxPages = 5;
/** Schools this close to a pilot town centre are kept, whatever municipality they stand in. */
const nearbyKm = 15;
export const schoolUrl = `${socrata}/d/${dataset}`;

export type SchoolRow = Record<string, string | undefined>;

/**
 * Turns directory rows into schools near the given towns. A school with coordinates is kept when it
 * is within 15 km of a town centre; one without is kept only when it stands in one of the towns.
 * Listing a school says nothing about vacancies.
 */
export function schoolsNear(rows: SchoolRow[], towns: SourceTown[]): School[] {
  const codes = new Set(towns.map(town => town.code));
  const centres = towns.flatMap(town => (town.centre ? [town.centre] : []));
  const schools: School[] = [];
  for (const row of rows) {
    if (!row.codi_centre || !row.denominaci_completa || !row.codi_municipi_6 || !row.curs || !row.codi_naturalesa)
      continue;
    // The published geographic columns are decimal degrees. The separate UTM columns are EPSG:25831.
    const location = coordinates(row.coordenades_geo_y, row.coordenades_geo_x);
    const near = location
      ? centres.some(centre => distanceKm(centre, location) <= nearbyKm)
      : codes.has(row.codi_municipi_6);
    if (!near) continue;
    const stages: School['stages'] = [];
    if (row.einf1c) stages.push('nursery');
    if (row.einf2c) stages.push('infantil');
    if (row.epri) stages.push('primary');
    if (row.eso) stages.push('eso');
    if (row.batx) stages.push('batxillerat');
    if (row.cfpm || row.cfps || row.cfam || row.cfas || row.tegm || row.tegs) stages.push('fp');
    if (!stages.length) continue;
    schools.push({
      id: row.codi_centre,
      name: row.denominaci_completa,
      municipalityCode: row.codi_municipi_6,
      locality: row.nom_localitat?.trim() || null,
      coordinates: location,
      public: row.codi_naturalesa === '1',
      stages,
      observedAt: row.curs,
      sourceUrl: schoolUrl,
    });
  }
  return schools;
}

const value = z.object({ schools: z.array(school).nonempty(), directory: source });

/** Replaces the school list as a whole: a school that left the directory must not linger. */
function withSchools(data: LiveData, fresh: z.infer<typeof value>): LiveData {
  return withDerivedServices({
    ...data,
    snapshot: { ...data.snapshot, schools: fresh.schools, schoolDirectory: fresh.directory },
  });
}

export default defineSource({
  id: 'gencat-centres-docents',
  title: 'Directori de centres docents',
  authority: "Generalitat de Catalunya, Departament d'Educació i Formació Professional",
  homepage: schoolUrl,
  ttlMs: 24 * 60 * 60 * 1000,
  schema: value,
  async fetch(context) {
    const comarques = [...new Set(context.municipalities.flatMap(town => comarcaSpellings(town.comarca)))].sort();
    const year = await latestYear(context, dataset);
    const observedAt = await socrataUpdatedOn(context, dataset);
    // The whole of Catalonia is more than one page; a short page ends the download.
    const rows: SchoolRow[] = [];
    for (let page = 0; page < maxPages; page++) {
      const batch = await socrataQuery<SchoolRow[]>(context, dataset, {
        $where: `any=${year} and nom_comarca in (${soqlList(comarques)})`,
        $order: 'codi_centre',
        $limit: String(pageLimit),
        $offset: String(page * pageLimit),
      });
      if (!Array.isArray(batch)) throw new Error('Incomplete school directory download');
      rows.push(...batch);
      if (batch.length < pageLimit) break;
      if (page === maxPages - 1) throw new Error('Incomplete school directory download');
    }
    if (!rows.length) throw new Error('Incomplete school directory download');
    return { schools: schoolsNear(rows, context.municipalities), directory: { observedAt, sourceUrl: schoolUrl } };
  },
  overlay: withSchools,
});
