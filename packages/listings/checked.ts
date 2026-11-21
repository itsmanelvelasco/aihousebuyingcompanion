import type { CheckedListing, HomeSearchInput } from "../contracts/listings.ts";

// Property facts transcribed from the linked Idealista listing pages on 21 November 2026.
// These examples contain no listing photos, contact details or ad copy.
const saleExamples = [
  { municipalityCode: "080312", listingId: "113084097", title: "Flat in Calaf", titleCa: "Pis a Calaf",
    askingPriceEur: 131000, bedrooms: 2, areaM2: 79 },
  { municipalityCode: "251180", listingId: "105621620", title: "Detached house in Juncosa", titleCa: "Casa independent a Juncosa",
    askingPriceEur: 75000, bedrooms: 3, areaM2: 119 },
  { municipalityCode: "251713", listingId: "98649597", title: "Flat in La Pobla de Segur", titleCa: "Pis a la Pobla de Segur",
    askingPriceEur: 75000, bedrooms: 3, areaM2: 94 },
  { municipalityCode: "252347", listingId: "112041223", title: "Village house in Vilamitjana, Tremp", titleCa: "Casa de poble a Vilamitjana, Tremp",
    askingPriceEur: 190000, bedrooms: 4, areaM2: 240 },
  { municipalityCode: "431573", listingId: "111641581", title: "Semi-detached house in Ulldemolins", titleCa: "Casa aparellada a Ulldemolins",
    askingPriceEur: 295000, bedrooms: 3, areaM2: 141 },
];
const examples: CheckedListing[] = saleExamples.map(example => ({
  ...example, provider: "idealista", url: `https://www.idealista.com/inmueble/${example.listingId}/`,
  operation: "buy", checkedOn: "2026-11-21", availability: "unknown",
}));

export function getCheckedListings(municipalityCode: string, input: HomeSearchInput): CheckedListing[] {
  return examples.filter(example => example.municipalityCode === municipalityCode && example.operation === input.operation
    && (input.maxPriceEur === undefined || example.askingPriceEur <= input.maxPriceEur)
    && (input.minBedrooms === undefined || example.bedrooms >= input.minBedrooms)).slice(0, input.limitPerTown);
}
