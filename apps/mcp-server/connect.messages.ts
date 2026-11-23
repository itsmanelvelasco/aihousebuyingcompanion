import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * The homepage at /connect: everything written in `connect.html` as `{{t:key}}`. The three keys
 * that carry their own markup (`heroTitle` and the self-hosting paragraphs) are written with
 * `{{t-html:key}}`. What the page's script says lives in `connect-agents.messages.ts`.
 */
export const connect = defineMessages(
  {
    title: 'ReloCat · Find your place in Catalonia',
    metaDescription:
      'Discover places to live in Catalonia. Compare towns, schools, transport and housing support with ReloCat.',
    skip: 'Skip to content',
    homeLabel: 'ReloCat home',
    mainNav: 'Main navigation',
    footerNav: 'Footer navigation',
    townDemo: 'Town demo',
    connectAnAgent: 'Connect an agent',
    heroTitle: 'Find your place <span>in Catalonia</span>',
    heroIntro: 'Compare towns, school journeys and housing support before you decide where to move.',
    exploreTowns: 'Explore towns',
    connectYourAgent: 'Connect your agent',
    discoverTitle: 'Get a feel for everyday life',
    discoverIntro: 'Start with any of the 947 municipalities of Catalonia.',
    fitTitle: 'Find towns that fit',
    fitText:
      'Compare towns against your budget, school needs and transport constraints. See which requirements each town meets and what still needs checking.',
    schoolTitle: 'Compare the school run and commute',
    schoolText:
      'Check nearby schools and dated travel estimates. Sources and sample dates help you decide which journeys to verify.',
    supportTitle: 'Explore housing support and homes',
    supportText:
      'Check published incentives and their application status. When live listing search is enabled, follow example links to confirm the price, bedrooms and availability.',
    dataSources: 'See the data sources',
    setupTitle: 'Bring ReloCat into your chat',
    setupIntro: 'Choose your AI agent for step-by-step connection instructions.',
    chooseAgent: 'Choose an agent',
    endpointLabel: 'ReloCat MCP server URL',
    copyUrl: 'Copy URL',
    officialGuide: 'Official setup guide',
    settingsNote: 'Available settings depend on your agent version and workspace permissions.',
    noscript: 'Enable JavaScript to choose an agent and generate its configuration.',
    questionsTitle: 'What would you ask?',
    questionsIntro: 'Copy a question into your agent after connecting ReloCat.',
    aboutDataTitle: 'About the data',
    aboutDataText:
      'Sources include official municipal statistics and dated relocation research for three pilot towns. Housing averages describe the local market. Check listing availability, school admissions and walkability separately. Incentives show application status and household eligibility separately.',
    selfHostTitle: 'Running ReloCat yourself?',
    selfHostText:
      'Agents connect to <code>/mcp</code>. Town, school, transport and incentive tools need no sign-in. Tools that read or save a person’s own household, finances, bank summary or habits ask the agent to sign in with OAuth: the person signs in to their ReloCat account and approves the connection. Where the public demo is on, four fictional households can be read without an account; nothing in the demo is saved.',
    localSetupSummary: 'Local server and live listing setup',
    localSetupText:
      'The local MCP endpoint is <code>http://127.0.0.1:8787/mcp</code>. Cloud agents need an HTTPS URL: deploy behind HTTPS with <code>PUBLIC_ORIGIN</code> set to that origin, which also becomes the OAuth issuer and the address this page offers. Accounts are created at <code>/signup</code>; <code>/account</code> lists connected agents and removes them.',
    listingSetupText:
      'Set <code>TREG_TOKEN</code> in the server environment to enable live example links. The provider may charge for searches. Town research runs without the key.',
  },
  {
    ca: {
      title: 'ReloCat · Troba el teu lloc a Catalunya',
      metaDescription:
        'Descobreix llocs per viure a Catalunya. Compara pobles, escoles, transport i ajuts a l’habitatge amb ReloCat.',
      skip: 'Ves al contingut',
      homeLabel: 'Inici de ReloCat',
      mainNav: 'Navegació principal',
      footerNav: 'Navegació del peu de pàgina',
      townDemo: 'Demo de pobles',
      connectAnAgent: 'Connecta un agent',
      heroTitle: 'Troba el <br>teu lloc <span>a Catalunya</span>',
      heroIntro: 'Compara pobles, trajectes a l’escola i ajuts a l’habitatge abans de decidir on vols anar a viure.',
      exploreTowns: 'Explora pobles',
      connectYourAgent: 'Connecta el teu agent',
      discoverTitle: 'Fes-te una idea del dia a dia',
      discoverIntro: 'Comença amb qualsevol dels 947 municipis de Catalunya.',
      fitTitle: 'Troba pobles que t’encaixin',
      fitText:
        'Compara pobles segons el teu pressupost, les necessitats escolars i les limitacions de transport. Mira quins requisits compleix cada poble i què cal comprovar encara.',
      schoolTitle: 'Compara el trajecte a l’escola i el desplaçament a la feina',
      schoolText:
        'Consulta les escoles properes i estimacions de trajecte amb data. Les fonts i les dates de mostra t’ajuden a decidir quins trajectes cal verificar.',
      supportTitle: 'Explora ajuts a l’habitatge i habitatges',
      supportText:
        'Consulta els incentius publicats i l’estat de les convocatòries. Quan la cerca d’anuncis en directe està activada, segueix els enllaços d’exemple per confirmar el preu, les habitacions i la disponibilitat.',
      dataSources: 'Consulta les fonts de les dades',
      setupTitle: 'Porta ReloCat al teu xat',
      setupIntro: 'Tria el teu agent d’IA per veure les instruccions de connexió pas a pas.',
      chooseAgent: 'Tria un agent',
      endpointLabel: 'URL del servidor MCP de ReloCat',
      copyUrl: 'Copia l’URL',
      officialGuide: 'Guia oficial de configuració',
      settingsNote: 'Les opcions disponibles depenen de la versió del teu agent i dels permisos de l’espai de treball.',
      noscript: 'Activa JavaScript per triar un agent i generar-ne la configuració.',
      questionsTitle: 'Què preguntaries?',
      questionsIntro: 'Copia una pregunta al teu agent després de connectar ReloCat.',
      aboutDataTitle: 'Sobre les dades',
      aboutDataText:
        'Les fonts inclouen estadístiques municipals oficials i recerca amb data sobre com instal·lar-se en tres pobles pilot. Les mitjanes d’habitatge descriuen el mercat local. Comprova a part la disponibilitat dels anuncis, les admissions escolars i si s’hi pot anar a peu. Els incentius mostren per separat l’estat de la convocatòria i l’elegibilitat de la llar.',
      selfHostTitle: 'Executes ReloCat pel teu compte?',
      selfHostText:
        'Els agents es connecten a <code>/mcp</code>. Les eines de pobles, escoles, transport i incentius no demanen iniciar la sessió. Les eines que llegeixen o desen la llar, les finances, el resum bancari o els hàbits d’una persona demanen a l’agent que iniciï la sessió amb OAuth: la persona inicia la sessió al seu compte de ReloCat i aprova la connexió. On la demostració pública està activada, es poden consultar quatre llars fictícies sense compte; a la demostració no es desa res.',
      localSetupSummary: 'Servidor local i configuració dels anuncis en directe',
      localSetupText:
        'L’adreça MCP local és <code>http://127.0.0.1:8787/mcp</code>. Els agents al núvol necessiten un URL HTTPS: desplega darrere d’HTTPS amb <code>PUBLIC_ORIGIN</code> definit amb aquest origen, que també passa a ser l’emissor d’OAuth i l’adreça que ofereix aquesta pàgina. Els comptes es creen a <code>/signup</code>; <code>/account</code> mostra els agents connectats i permet treure’ls.',
      listingSetupText:
        'Defineix <code>TREG_TOKEN</code> a l’entorn del servidor per activar els enllaços d’exemple en directe. El proveïdor pot cobrar per les cerques. La recerca de pobles funciona sense la clau.',
    },
    es: {
      title: 'ReloCat · Encuentra tu lugar en Cataluña',
      metaDescription:
        'Descubre lugares para vivir en Cataluña. Compara pueblos, escuelas, transporte y ayudas a la vivienda con ReloCat.',
      skip: 'Ir al contenido',
      homeLabel: 'Inicio de ReloCat',
      mainNav: 'Navegación principal',
      footerNav: 'Navegación del pie de página',
      townDemo: 'Demo de pueblos',
      connectAnAgent: 'Conecta un agente',
      heroTitle: 'Encuentra <br>tu lugar <span>en Cataluña</span>',
      heroIntro: 'Compara pueblos, trayectos a la escuela y ayudas a la vivienda antes de decidir adónde te mudas.',
      exploreTowns: 'Explora pueblos',
      connectYourAgent: 'Conecta tu agente',
      discoverTitle: 'Hazte una idea del día a día',
      discoverIntro: 'Empieza con cualquiera de los 947 municipios de Cataluña.',
      fitTitle: 'Encuentra pueblos que encajen contigo',
      fitText:
        'Compara pueblos según tu presupuesto, las necesidades escolares y las limitaciones de transporte. Mira qué requisitos cumple cada pueblo y qué falta por comprobar.',
      schoolTitle: 'Compara el trayecto a la escuela y el desplazamiento al trabajo',
      schoolText:
        'Consulta las escuelas cercanas y estimaciones de trayecto con fecha. Las fuentes y las fechas de muestra te ayudan a decidir qué trayectos hay que verificar.',
      supportTitle: 'Explora ayudas a la vivienda y viviendas',
      supportText:
        'Consulta los incentivos publicados y el estado de las convocatorias. Cuando la búsqueda de anuncios en directo está activada, sigue los enlaces de ejemplo para confirmar el precio, las habitaciones y la disponibilidad.',
      dataSources: 'Consulta las fuentes de los datos',
      setupTitle: 'Lleva ReloCat a tu chat',
      setupIntro: 'Elige tu agente de IA para ver las instrucciones de conexión paso a paso.',
      chooseAgent: 'Elige un agente',
      endpointLabel: 'URL del servidor MCP de ReloCat',
      copyUrl: 'Copia la URL',
      officialGuide: 'Guía oficial de configuración',
      settingsNote:
        'Las opciones disponibles dependen de la versión de tu agente y de los permisos del espacio de trabajo.',
      noscript: 'Activa JavaScript para elegir un agente y generar su configuración.',
      questionsTitle: '¿Qué preguntarías?',
      questionsIntro: 'Copia una pregunta en tu agente después de conectar ReloCat.',
      aboutDataTitle: 'Sobre los datos',
      aboutDataText:
        'Las fuentes incluyen estadísticas municipales oficiales e investigación con fecha sobre cómo instalarse en tres pueblos piloto. Las medias de vivienda describen el mercado local. Comprueba aparte la disponibilidad de los anuncios, las admisiones escolares y si se puede ir a pie. Los incentivos muestran por separado el estado de la convocatoria y la elegibilidad del hogar.',
      selfHostTitle: '¿Ejecutas ReloCat por tu cuenta?',
      selfHostText:
        'Los agentes se conectan a <code>/mcp</code>. Las herramientas de pueblos, escuelas, transporte e incentivos no piden iniciar sesión. Las herramientas que leen o guardan el hogar, las finanzas, el resumen bancario o los hábitos de una persona piden al agente que inicie sesión con OAuth: la persona inicia sesión en su cuenta de ReloCat y aprueba la conexión. Donde la demostración pública está activada, se pueden consultar cuatro hogares ficticios sin cuenta; en la demostración no se guarda nada.',
      localSetupSummary: 'Servidor local y configuración de los anuncios en directo',
      localSetupText:
        'La dirección MCP local es <code>http://127.0.0.1:8787/mcp</code>. Los agentes en la nube necesitan una URL HTTPS: despliega detrás de HTTPS con <code>PUBLIC_ORIGIN</code> definido con ese origen, que pasa a ser también el emisor de OAuth y la dirección que ofrece esta página. Las cuentas se crean en <code>/signup</code>; <code>/account</code> muestra los agentes conectados y permite quitarlos.',
      listingSetupText:
        'Define <code>TREG_TOKEN</code> en el entorno del servidor para activar los enlaces de ejemplo en directo. El proveedor puede cobrar por las búsquedas. La investigación de pueblos funciona sin la clave.',
    },
  },
);
