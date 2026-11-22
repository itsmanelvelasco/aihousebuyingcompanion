import type { SourceTown } from './source.ts';

/**
 * A comparable form of an official Catalan place name. Registers write the article last
 * ("Pobla de Segur, la", "Albi, l'") where the municipal list writes it first; case, accents,
 * apostrophe style and spacing also vary between publishers.
 */
export function normaliseName(name: string | undefined) {
  const text = (name ?? '').replaceAll(/[’`´]/g, "'").trim();
  const inverted = /^(.+),\s*(el|la|els|les|l'|en|na|sa|es|s')$/i.exec(text);
  const ordered = inverted ? `${inverted[2]}${inverted[2].endsWith("'") ? '' : ' '}${inverted[1]}` : text;
  return ordered
    .normalize('NFD')
    .replaceAll(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replaceAll(/'\s+/g, "'")
    .replaceAll(/\s+/g, ' ');
}

export type NamedRow = { municipi?: string; comarca?: string };

/**
 * Joins rows of a dataset that names municipalities but carries no official code. A town gets its
 * rows only when the join is clean: no other town in the list shares its name, and every row with
 * that name also states the town's comarca. A town with no row, or with any doubtful row, is left
 * out of the result, so callers report it as unknown instead of guessing.
 */
export function matchTownsByName<Row extends NamedRow>(towns: SourceTown[], rows: Row[]) {
  const byName = new Map<string, Row[]>();
  for (const row of rows) {
    const name = normaliseName(row.municipi);
    if (!name) continue;
    const group = byName.get(name);
    if (group) group.push(row);
    else byName.set(name, [row]);
  }
  const matched = new Map<string, Row[]>();
  for (const town of towns) {
    const name = normaliseName(town.name);
    const candidates = byName.get(name);
    if (!candidates?.length || towns.some(other => other !== town && normaliseName(other.name) === name)) continue;
    const comarca = normaliseName(town.comarca);
    if (candidates.every(row => normaliseName(row.comarca) === comarca)) matched.set(town.code, candidates);
  }
  return matched;
}
