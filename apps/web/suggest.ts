import type { Person } from '../../packages/contracts/planner.ts';
import type { Recommendation, RecommendationRequest } from './client.ts';

/**
 * "Suggest places for me": what the workspace asks `recommend_towns`, and how it reads the answer.
 * The screening and the ranking are the server's. Nothing here filters, scores or rewords a place:
 * the reasons, compromises and exclusions are shown as they were returned.
 */

export const schoolStages = ['nursery', 'infantil', 'primary', 'eso', 'batxillerat', 'fp'] as const;
export type SchoolStage = (typeof schoolStages)[number];

/** What the person chooses in the form. The budget is theirs already; only the rest is asked. */
export type SuggestChoices = {
  schoolStages: SchoolStage[];
  /** Only municipalities with an official rural or special-attention status. */
  ruralOnly: boolean;
  /** Constructed floor area typed into the form, or null to use the one on record (if any). */
  floorAreaM2: number | null;
};

export const noChoices: SuggestChoices = { schoolStages: [], ruralOnly: false, floorAreaM2: null };

export type SuggestRequest = {
  request: RecommendationRequest;
  /**
   * What happened to the budget: `used` (budget and floor area are both known, so the server screens
   * on price), `no_area` (a budget is known but the server cannot price a home without its floor
   * area, so the budget is left out and the form says so) or `no_budget`.
   */
  budget: 'used' | 'no_area' | 'no_budget';
};

/**
 * The request for what is known. A purchase budget is sent only with a floor area, because the
 * server estimates a price per square metre and refuses a budget alone; an unknown is left out,
 * never replaced by a guess. At most eight places come back, the most the comparison holds.
 */
export function suggestRequest(person: Person | null, choices: SuggestChoices): SuggestRequest {
  const budgetCents = person?.home.budgetCents ?? null;
  const area = choices.floorAreaM2 ?? person?.home.floorAreaM2 ?? null;
  const budget = budgetCents === null ? 'no_budget' : area === null ? 'no_area' : 'used';
  return {
    budget,
    request: {
      ...(budget === 'used' && budgetCents !== null && area !== null
        ? // The planner holds cents and the screening asks for euros: converted at this boundary.
          { housing: { tenure: 'buy' as const, maxBudgetEur: budgetCents / 100, homeSizeM2: area } }
        : {}),
      ...(choices.schoolStages.length ? { schoolStages: choices.schoolStages } : {}),
      ...(choices.ruralOnly ? { ruralOnly: true } : {}),
      limit: 8,
    },
  };
}

/** A floor area typed into the form: a positive number of square metres, or null for anything else. */
export function parseFloorArea(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(value) && value > 0 && value <= 2000 ? value : null;
}

export type SuggestedPlace = {
  code: string;
  name: string;
  comarca: string;
  /** The server's ranking score, 0 to 100, or null when nothing asked for could rank the place. */
  score: number | null;
  reasons: string[];
  compromises: string[];
  dataMissing: string[];
  /** Already in the comparison. */
  compared: boolean;
};

export type SuggestionView = {
  places: SuggestedPlace[];
  /** Suggested places that are not compared yet and still fit under the limit of the comparison, in rank order. */
  addable: string[];
  excluded: { code: string; name: string | null; reasons: string[]; dataMissing: string[] }[];
  /** How many municipalities were excluded in all; `excluded` lists the first ones. */
  excludedCount: number;
  limitations: string[];
};

/**
 * The answer in the server's order, with which places are already compared and which can still be
 * added. `names` resolves the code of an excluded municipality to its name when the list is known.
 */
export function suggestionView(
  result: Recommendation,
  compared: string[],
  maxPlaces: number,
  names: Record<string, string> = {},
): SuggestionView {
  const places = result.towns.map(town => ({
    code: town.municipality.code,
    name: town.municipality.name,
    comarca: town.municipality.comarca,
    score: town.score,
    reasons: town.matchReasons,
    compromises: town.tradeoffs,
    dataMissing: town.dataMissing,
    compared: compared.includes(town.municipality.code),
  }));
  const room = Math.max(0, maxPlaces - compared.length);
  return {
    places,
    addable: places
      .filter(place => !place.compared)
      .slice(0, room)
      .map(place => place.code),
    excluded: result.excluded.map(item => ({
      code: item.municipalityCode,
      name: names[item.municipalityCode] ?? null,
      reasons: item.reasons,
      dataMissing: item.dataMissing,
    })),
    excludedCount: result.excludedCount,
    limitations: result.limitations,
  };
}
