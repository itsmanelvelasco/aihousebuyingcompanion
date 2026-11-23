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

/** Comarques that publishers name in two ways. The snapshot keeps Idescat's spelling. */
const comarcaAliases: Record<string, string> = { "val d'aran": 'aran' };

/** A comparable comarca name: `normaliseName` plus the known alternative spellings. */
export function normaliseComarca(name: string | undefined) {
  const text = normaliseName(name);
  return comarcaAliases[text] ?? text;
}

/** Every spelling of a comarca that a publisher may filter by. */
export function comarcaSpellings(name: string) {
  return name === 'Aran' ? ['Aran', "Val d'Aran"] : [name];
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
  const sameName = new Map<string, number>();
  for (const town of towns) {
    const name = normaliseName(town.name);
    sameName.set(name, (sameName.get(name) ?? 0) + 1);
  }
  const matched = new Map<string, Row[]>();
  for (const town of towns) {
    const name = normaliseName(town.name);
    const candidates = byName.get(name);
    if (!candidates?.length || (sameName.get(name) ?? 0) > 1) continue;
    const comarca = normaliseComarca(town.comarca);
    if (candidates.every(row => normaliseComarca(row.comarca) === comarca)) matched.set(town.code, candidates);
  }
  return matched;
}
