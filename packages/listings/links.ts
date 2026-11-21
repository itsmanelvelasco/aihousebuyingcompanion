import type { HomeSearchInput } from "../contracts/listings.ts";
import type { Snapshot } from "../contracts/places.ts";

// Municipality pages checked on Idealista on 21 November 2026. Some towns
// have no reachable rental page. A verified page is a link, not inventory evidence.
const townPages: Partial<Record<string, { slug: string; rent?: true }>> = {
  "080312": { slug: "calaf-barcelona" },
  "250024": { slug: "ager-lleida" },
  "250122": { slug: "alcoletge-lleida", rent: true },
  "250371": { slug: "les-avellanes-i-santa-linya-lleida" },
  "250404": { slug: "balaguer-lleida", rent: true },
  "250621": { slug: "camarasa-lleida" },
  "251180": { slug: "juncosa-lleida" },
  "251207": { slug: "lleida-lleida", rent: true },
  "251569": { slug: "os-de-balaguer-lleida" },
  "251713": { slug: "la-pobla-de-segur-lleida", rent: true },
  "251902": { slug: "salas-de-pallars-lleida" },
  "252154": { slug: "talarn-lleida" },
  "252206": { slug: "termens-lleida" },
  "252347": { slug: "tremp-lleida", rent: true },
  "252402": { slug: "vallfogona-de-balaguer-lleida" },
  "252542": { slug: "vilanova-de-la-barca-lleida" },
  "259046": { slug: "castell-de-mur-lleida" },
  "431573": { slug: "ulldemolins-tarragona" },
};

export function homeSearchLinks(town: Pick<Snapshot["municipalities"][number], "code" | "name" | "comarca">,
  { operation, maxPriceEur, minBedrooms }: Pick<HomeSearchInput, "operation" | "maxPriceEur" | "minBedrooms">) {
  const buy = operation === "buy";
  const query = [`site:idealista.com/inmueble/ "${town.name}" "${town.comarca}"`,
    buy ? "venta vivienda" : "alquiler vivienda",
    ...(maxPriceEur === undefined ? [] : [`hasta ${maxPriceEur} euros`]),
    ...(minBedrooms === undefined ? [] : [`${minBedrooms} dormitorios`]),
  ].join(" ");
  const page = townPages[town.code];
  return {
    query,
    searchUrl: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
    idealistaSearchUrl: page && (buy || page.rent)
      ? `https://www.idealista.com/${buy ? "venta-viviendas" : "alquiler-viviendas"}/${page.slug}/`
      : null,
  };
}
