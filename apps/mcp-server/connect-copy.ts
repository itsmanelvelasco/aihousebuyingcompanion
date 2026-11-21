import type { BilingualText } from "../../packages/site/language.ts";

export const connectCopy = {
  description: ["Troba on viure a Catalunya. Compara municipis, escoles, transport i ajuts a l’habitatge amb relo.cat.", "Discover places to live in Catalonia. Compare towns, schools, transport and housing support with relo.cat."],
  title: ["relo.cat · Troba el teu lloc a Catalunya", "relo.cat · Find your place in Catalonia"],
  skip: ["Salta al contingut", "Skip to content"],
  homeLabel: ["Inici de relo.cat", "relo.cat home"],
  mainNavigation: ["Navegació principal", "Main navigation"],
  townDemo: ["Mapa", "Town demo"],
  connectAgent: ["Connecta", "Connect"],
  heroTitle: ["Troba el teu lloc", "Find your place"],
  heroPlace: ["a Catalunya.", "in Catalonia."],
  heroIntro: ["Compara municipis, trajectes escolars i ajuts a l’habitatge abans de decidir on viure.", "Compare towns, school journeys and housing support before you decide where to move."],
  exploreTowns: ["Explora municipis", "Explore towns"],
  connectYourAgent: ["Connecta el teu assistent", "Connect your agent"],
  trySavings: ["Prova el simulador d’estalvi", "Try the Savings Coach"],
  dailyLife: ["Com seria el teu dia a dia?", "Get a feel for everyday life."],
  pilot: ["Comença amb els 18 municipis de la prova pilot.", "Start with 18 Catalan municipalities in the pilot."],
  townFit: ["Troba municipis que t’encaixin", "Find towns that fit"],
  townFitDetails: ["Compara municipis segons el pressupost, les necessitats escolars i les opcions de transport. Mira quins requisits compleix cadascun i què cal comprovar.", "Compare towns against your budget, school needs and transport constraints. See which requirements each town meets and what still needs checking."],
  journeys: ["Compara els trajectes a l’escola i a la feina", "Compare the school run and commute"],
  journeyDetails: ["Consulta les escoles properes i els temps de trajecte estimats. Les fonts i les dates t’ajuden a saber quins trajectes cal comprovar.", "Check nearby schools and dated travel estimates. Sources and sample dates help you decide which journeys to verify."],
  housingSupport: ["Consulta ajuts i habitatges", "Explore housing support and homes"],
  housingSupportDetails: ["Consulta els incentius publicats i l’estat de les convocatòries. Obre Idealista per veure habitatges i comprovar-ne el preu, les habitacions i la disponibilitat.", "Check published incentives and their application status. Open Idealista to browse homes and check prices, bedrooms and availability."],
  sources: ["Consulta les fonts de les dades", "See the data sources"],
  setupTitle: ["Fes servir relo.cat al teu xat.", "Bring relo.cat into your chat."],
  setupIntro: ["Tria el teu assistent d’IA i segueix els passos per connectar-lo.", "Choose your AI agent for step-by-step connection instructions."],
  chooseAgent: ["Tria un assistent", "Choose an agent"],
  endpointLabel: ["URL del servidor MCP de relo.cat", "relo.cat MCP server URL"],
  copyUrl: ["Copia l’URL", "Copy URL"],
  officialGuide: ["Guia oficial de configuració", "Official setup guide"],
  settings: ["Les opcions depenen de la versió de l’assistent i dels permisos del teu espai de treball.", "Available settings depend on your agent version and workspace permissions."],
  noScript: ["Activa JavaScript per triar un assistent i generar-ne la configuració.", "Enable JavaScript to choose an agent and generate its configuration."],
  questionTitle: ["Què li preguntaries?", "What would you ask?"],
  questionIntro: ["Copia una pregunta al teu assistent després de connectar relo.cat.", "Copy a question into your agent after connecting relo.cat."],
  aboutData: ["Sobre les dades", "About the data"],
  dataDetails: ["Les fonts inclouen estadístiques municipals oficials i informació datada sobre oportunitats per anar a viure a tres municipis del pilot. Les mitjanes d’habitatge descriuen el mercat local. Comprova la disponibilitat dels anuncis, l’admissió escolar i els recorreguts a peu. Distingim l’estat de les convocatòries dels requisits de cada llar.", "Sources include official municipal statistics and dated relocation research for three pilot towns. Housing averages describe the local market. Check listing availability, school admissions and walkability separately. Incentives show application status and household eligibility separately."],
  selfHost: ["Vols executar relo.cat en local?", "Running relo.cat yourself?"],
  selfHostDetails: ["Fes servir perfils ficticis per a la demo local. Afegeix autenticació i controls d’accés abans de publicar un desplegament.", "Use fictional profiles for the local connected demo. Add authentication and access controls before sharing a public deployment."],
  serverSetup: ["Servidor local i cerca d’habitatges", "Local server and live listing setup"],
  localServer: ["L’adreça del servidor MCP local és", "The local MCP endpoint is"],
  cloudServer: ["Els assistents al núvol necessiten una URL HTTPS accessible o un túnel compatible.", "Cloud agents need an HTTPS URL from your server operator or a supported private tunnel."],
  listingKeyStart: ["El mapa ofereix enllaços de cerca sense cap clau. Configura", "Town Explorer offers search links without a key. Set"],
  listingKeyEnd: ["a l’entorn del servidor per activar la cerca opcional d’anuncis indexats. El proveïdor pot cobrar per aquestes cerques.", "in the server environment to enable optional indexed examples. The provider may charge for those searches."],
  footerNavigation: ["Enllaços del peu de pàgina", "Footer navigation"],
  homeHref: ["/connect", "/connect?lang=en"],
  previewHref: ["/preview", "/preview?lang=en"],
  languageName: ["English", "Català"],
  otherLanguage: ["en", "ca"],
  switchHref: ["/connect?lang=en", "/connect"],
} satisfies BilingualText;

export const catalanAgents = {
  "chatgpt": {
    "kind": "Connexió al núvol",
    "intro": "Afegeix relo.cat com a connector MCP personalitzat per fer-ne servir les eines a les converses.",
    "steps": [
      "Obre la pàgina Plugins de ChatGPT. Prem el botó + i selecciona «Add custom MCP server».",
      "Posa-li el nom relo.cat. Tria la connexió per URL pública i enganxa-hi l’URL del servidor MCP. Si ja tens un Secure MCP Tunnel configurat, també el pots fer servir.",
      "Fes servir la configuració d’autenticació que t’hagi indicat la persona que gestiona el servidor. Revisa les eines i crea el connector.",
      "Instal·la’l, obre un xat nou i escriu @ per seleccionar relo.cat. Prova una de les preguntes de més avall."
    ]
  },
  "claude": {
    "kind": "Connexió al núvol",
    "intro": "Afegeix un connector personalitzat a Claude. Els connectors remots es connecten des del núvol de Claude, també a Claude Desktop.",
    "steps": [
      "Obre Customize → Connectors. Tria «+ Add» i després «Add custom connector».",
      "Posa-li el nom relo.cat i enganxa-hi l’URL del servidor MCP.",
      "Revisa l’autenticació detectada i segueix les indicacions de qui gestiona el servidor. Si tens un compte Team o Enterprise, pot ser que l’hagi d’afegir un administrador.",
      "Activa relo.cat des del menú + del xat, a Connectors, i pregunta per un municipi."
    ]
  },
  "hermes": {
    "kind": "Local o remot",
    "intro": "Afegeix relo.cat als servidors MCP del perfil actiu de Hermes. Pots fer servir localhost si Hermes i relo.cat s’executen al mateix ordinador.",
    "steps": [
      "Afegeix aquesta entrada a mcp_servers dins del fitxer config.yaml del perfil actiu (per defecte, ~/.hermes/config.yaml). Conserva els servidors que ja hi tinguis.",
      "Obre una sessió nova de Hermes i demana-li que faci servir les eines de municipis de relo.cat."
    ]
  },
  "openclaw": {
    "kind": "Local o remot",
    "intro": "Registra relo.cat a OpenClaw com a servidor MCP amb transport Streamable HTTP.",
    "steps": [
      "Executa l’ordre següent a l’entorn on s’executa OpenClaw.",
      "Comprova la connexió i demana a l’assistent que faci servir relo.cat. Si OpenClaw s’executa en remot, necessitarà una adreça accessible des del servidor on està instal·lat."
    ]
  },
  "codex": {
    "kind": "Local o remot",
    "intro": "Afegeix relo.cat a la configuració MCP de Codex des de la línia d’ordres.",
    "steps": [
      "Executa l’ordre següent a l’ordinador on s’executa Codex.",
      "Obre una sessió nova, comprova que les eines de relo.cat estiguin disponibles i pregunta per un municipi."
    ]
  },
  "cursor": {
    "kind": "Local o remot",
    "intro": "Dona accés a les eines de relo.cat a Cursor Agent amb una entrada de servidor MCP.",
    "steps": [
      "Afegeix aquesta entrada a .cursor/mcp.json per al projecte o a ~/.cursor/mcp.json per al compte. Conserva la resta de servidors.",
      "Activa relo.cat a la configuració MCP de Cursor i fes-lo servir des d’Agent."
    ]
  },
  "gemini": {
    "kind": "Local o remot",
    "intro": "Connecta l’assistent de terminal Gemini CLI amb una adreça Streamable HTTP.",
    "steps": [
      "Afegeix aquesta entrada a mcpServers, dins del fitxer settings.json de Gemini CLI. Conserva els servidors que ja hi tinguis.",
      "Obre una sessió nova i fes servir /mcp per veure les eines disponibles."
    ]
  },
  "muse": {
    "kind": "Meta · configuració per verificar",
    "intro": "Muse és l’assistent personal de Meta. La connexió a un servidor MCP personalitzat encara està per verificar.",
    "steps": [
      "Meta documenta connexions a aplicacions i serveis. La configuració d’un servidor MCP propi queda pendent de verificar.",
      "Prova el mapa de municipis o tria un assistent amb instruccions de connexió disponibles."
    ]
  },
  "other": {
    "kind": "Streamable HTTP",
    "intro": "Fes servir un client MCP compatible amb Streamable HTTP que pugui accedir al servidor de relo.cat.",
    "steps": [
      "Afegeix un servidor amb el nom relo.cat a la configuració MCP del teu assistent.",
      "Tria Streamable HTTP i enganxa-hi l’URL del servidor MCP. Fes servir l’autenticació que t’hagi indicat qui gestiona el servidor.",
      "Connecta’t, consulta les eines disponibles i prova get_town_profile o recommend_towns. Segueix la documentació del teu client per saber quin format de configuració fa servir."
    ],
    "name": "Un altre assistent"
  }
};
