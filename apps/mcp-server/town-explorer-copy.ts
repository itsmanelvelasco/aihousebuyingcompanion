import type { BilingualText } from "../../packages/site/language.ts";

export const explorerCopy = {
  pageTitle: ["relo.cat · Explora municipis", "Relocat Town Explorer"],
  title: ["Troba el teu municipi", "Find your town"],
  intro: ["Compara llocs on viure a Catalunya.", "Compare places to live in Catalonia."],
  explore: ["Explora Catalunya", "Explore Catalonia"],
  views: ["Municipis per mostrar", "Towns to display"],
  results: ["Resultats", "Results"],
  allTowns: ["Tots els municipis", "All towns"],
  mapLabel: ["Mapa dels municipis de la prova pilot", "Map of the Catalonia pilot"],
  mapPins: ["Marcadors dels municipis", "Town map pins"],
  controls: ["Controls del mapa", "Map controls"],
  zoomOut: ["Allunya el mapa", "Zoom out"],
  zoomIn: ["Apropa el mapa", "Zoom in"],
  fit: ["Centra els municipis", "Fit towns"],
  mapAttribution: ["Límits adaptats de l’", "Boundaries adapted from "],
  chooser: ["Ves a un municipi", "Jump to a municipality"],
  selectTown: ["Tria un municipi", "Choose a town"],
  loading: ["Carregant municipis…", "Loading towns…"],
  retry: ["Torna-ho a provar", "Retry"],
  cards: ["Fitxes dels municipis", "Town cards"],
  comparison: ["El recompte inclou les mesures vigents del catàleg pilot. Comprova si s’apliquen al lloc i a la teva llar.", "Measures count active programmes in the pilot catalogue. Check local and household eligibility."],
  profile: ["Detalls del municipi seleccionat", "Selected town details"],
  noScript: ["Cal activar JavaScript per consultar les fitxes dels municipis.", "JavaScript is required to browse the town profiles."],
  home: ["Inici", "Home"],
  homeHref: ["/connect", "/connect?lang=en"],
  localeLabel: ["English", "Català"],
  localeHref: ["/preview?lang=en", "/preview"],
  otherLanguage: ["en", "ca"],
  navLabel: ["Navegació del mapa", "Town Explorer navigation"],
  catalonia: ["Catalunya", "Catalonia"],
} satisfies BilingualText;

export const catalanMeasures: Record<string, string> = {
  irpf_move: "Deducció de l’IRPF per trasllat a un municipi rural",
  irpf_buy: "Deducció de l’IRPF per comprar l’habitatge habitual en un municipi rural",
  irpf_rent: "Deducció de l’IRPF per llogar l’habitatge habitual en un municipi rural",
  irpf_renovate: "Deducció de l’IRPF per rehabilitar l’habitatge habitual en un municipi rural",
  itp_buy: "Tipus reduït de l’ITP per comprar l’habitatge habitual en un municipi rural",
  renovation_grant_2026: "Ajut del 2026 per rehabilitar habitatges en entorns rurals i de muntanya",
};

export const catalanMatchEvidence: Record<string, string> = {
  "Requested school stages are covered by estimated walks.": "Hi ha centres amb les etapes escolars demanades accessibles a peu, segons l’estimació.",
  "Rural tax benefits depend on the exact attached settlement.": "Els beneficis fiscals rurals depenen del nucli concret on sigui l’habitatge.",
  "Verify school admissions, walkability and the return journey.": "Comprova l’admissió escolar, el recorregut a peu i el trajecte de tornada.",
};

export const catalanDestinations = {
  lleida: "Lleida-Pirineus / estació d’autobusos",
  barcelona: "Barcelona Sants",
  bcn_t1: "Aeroport de Barcelona (T1)",
  bcn_t2: "Aeroport de Barcelona (T2)",
  girona: "Estació de tren de Girona",
  girona_airport: "Aeroport de Girona-Costa Brava",
};
