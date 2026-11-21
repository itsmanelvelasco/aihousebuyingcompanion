export const socrata = "https://analisi.transparenciacatalunya.cat";

export const urls = {
  emexNodes: "https://api.idescat.cat/emex/v1/nodes.json?lang=ca",
  emexProfile: (code: string) => `https://api.idescat.cat/emex/v1/geo/${code}.json?lang=ca`,
  geography: `${socrata}/d/wpyq-we8x`,
  rural: `${socrata}/d/7gqm-722r`,
  ruralResolution: "https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1037694",
  additionsResolution: "https://dogc.gencat.cat/ca/document-del-dogc/?documentId=1055370",
  school: `${socrata}/d/kvmv-ahh4`,
  retail: `${socrata}/d/2dhj-q3r8`,
  gtfs: "https://www.fgc.cat/google/google_transit.zip",
  sales: (scope: "municipis" | "ambits", year: number) =>
    `https://habitatge.gencat.cat/web/.content/home/dades/estadistiques/01_Estadistiques_de_construccio_i_mercat_immobiliari/02_Compravenda_i_preu_de_venda/02_Compravendes_d_habitatges_registrades_i_el_preu_de_venda/${year}/Trimestrals_per_${scope}_${year}.xlsx`,
};

// The study area follows the RL1/RL2 corridor. Lleida is a destination, not a village candidate.
export const recommendableCodes = [
  "250024", "250122", "250371", "250404", "250621", "251569", "251713",
  "251902", "252154", "252206", "252347", "252402", "252542", "259046",
];
export const lleidaCode = "251207";

export const railMunicipalities: Record<string, string> = {
  LE1: lleidaCode, LE2: lleidaCode, PG1: lleidaCode, AT1: "250122", VB1: "252542", RM1: "252206",
  VF1: "252402", BG1: "250404", BG2: "250404", GB1: "251569", SM1: "250621",
  LS1: "250371", SN1: "250371", AR1: "250024", LL1: "259046", GT1: "259046",
  PT1: "252347", TP1: "252347", SD1: "251902", PS1: "251713",
};
