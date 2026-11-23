import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * What the homepage's script says: copy feedback, the endpoint notes, the example questions and
 * the connection instructions of each agent. `connect-page.ts` writes the language of the request
 * into the page as one JSON object; the script reads `<agent id>Kind`, `<agent id>Intro` and every
 * `<agent id>Step<n>` in the order written here.
 *
 * Names of controls in another product ("Add custom MCP server", "Customize → Connectors") stay as
 * that product's English interface writes them: what its other languages call them is not verified.
 */
export const connectScript = defineMessages(
  {
    copied: 'Copied.',
    clipboardUnavailable: 'Clipboard access is unavailable. Copy the selected text manually.',
    endpointInvalid: 'Enter a valid HTTP or HTTPS URL without credentials.',
    endpointLocal:
      'This address works for local agents. ChatGPT and Claude need an HTTPS URL they can reach or a supported tunnel.',
    endpointRemote:
      'Paste this address into your agent. Personal tools ask you to sign in to ReloCat with OAuth; town tools need no sign-in.',
    copyConfiguration: 'Copy configuration',
    copyQuestion: 'Copy question',
    copyQuestionLabel: 'Copy question: {question}',
    prompt1:
      'Use ReloCat to find towns where I could rent for €700 a month and reach a primary school without a car. Explain the trade-offs.',
    prompt2:
      'Compare Calaf, Juncosa and Ulldemolins. Show sources, research dates and anything that still needs checking.',
    prompt3: 'Look for Idealista examples in Calaf. Separate search results from verified available homes.',

    chatgptKind: 'Cloud connection',
    chatgptIntro: 'Add ReloCat as a custom MCP plugin to use its tools in your conversations.',
    chatgptStep1: 'Open ChatGPT’s Plugins page. Select the plus button, then “Add custom MCP server”.',
    chatgptStep2:
      'Name it ReloCat. Choose a public URL connection and paste the MCP server URL shown above. A configured Secure MCP Tunnel is another option.',
    chatgptStep3:
      'For authentication choose OAuth if you want your own saved household and finances; ChatGPT then opens ReloCat’s sign-in and consent page. Without authentication the town tools and the public demo still work. Review the tools and create the plugin.',
    chatgptStep4: 'Install it, start a new chat, and type @ to select ReloCat. Try one of the prompts below.',

    claudeKind: 'Cloud connection',
    claudeIntro:
      'Add a custom connector in Claude. Remote connectors connect from Claude’s cloud, including in Claude Desktop.',
    claudeStep1: 'Open Customize → Connectors. Choose “+ Add”, then “Add custom connector”.',
    claudeStep2: 'Name the connector ReloCat and paste the MCP server URL shown above.',
    claudeStep3:
      'ReloCat announces OAuth sign-in. When Claude asks you to connect, sign in to your ReloCat account and approve the access it lists; town tools work without it. Team or Enterprise users may need an administrator to add the connector first.',
    claudeStep4: 'Enable ReloCat from the chat’s + menu → Connectors, then ask about a town.',

    hermesKind: 'Local or remote',
    hermesIntro:
      'Add ReloCat to the MCP servers in your active Hermes profile. Localhost works when Hermes and ReloCat run on the same machine.',
    hermesStep1:
      'Merge this entry into mcp_servers in your active profile’s config.yaml (default: ~/.hermes/config.yaml). Preserve your existing servers.',
    hermesStep2: 'Start a fresh Hermes session and ask it to use ReloCat’s town tools. They need no sign-in.',
    hermesStep3:
      'Personal tools answer with an OAuth sign-in challenge. If your Hermes version supports OAuth for MCP servers, follow its prompt to sign in to ReloCat; otherwise use the town tools and the public demo.',

    openclawKind: 'Local or remote',
    openclawIntro: 'Register ReloCat as a Streamable HTTP MCP server in OpenClaw.',
    openclawStep1: 'Run the command below in the environment where OpenClaw runs.',
    openclawStep2:
      'Probe the connection, then ask your agent to use ReloCat. A remote OpenClaw installation cannot reach your laptop’s localhost.',
    openclawStep3:
      'Town tools need no sign-in. Personal tools answer with an OAuth sign-in challenge; complete the sign-in if your OpenClaw version offers it for MCP servers.',

    codexKind: 'Local or remote',
    codexIntro: 'Add ReloCat to Codex’s MCP configuration using the CLI.',
    codexStep1: 'Run the command below on the machine where Codex runs.',
    codexStep2:
      'Start a new session, check that ReloCat’s tools are available, and ask a town question. Town tools need no sign-in.',
    codexStep3:
      'For your own saved household and finances, sign in with OAuth when Codex offers it for this server (see Codex’s MCP guide for the login command of your version); the browser opens ReloCat’s sign-in and consent page.',

    cursorKind: 'Local or remote',
    cursorIntro: 'Give Cursor Agent access to ReloCat’s tools through an MCP server entry.',
    cursorStep1:
      'Merge this entry into .cursor/mcp.json for this project, or ~/.cursor/mcp.json for your account. Preserve other servers.',
    cursorStep2: 'Enable ReloCat in Cursor’s MCP settings, then use it from Agent. Town tools need no sign-in.',
    cursorStep3:
      'When Cursor shows that the server needs a login, sign in to your ReloCat account in the browser and approve the access. The server operator must allow Cursor’s return address (the cursor scheme in OAUTH_REDIRECT_SCHEMES).',

    geminiKind: 'Local or remote',
    geminiIntro:
      'Connect the Gemini terminal agent using a Streamable HTTP endpoint. These instructions are for Gemini CLI.',
    geminiStep1: 'Merge this into your Gemini CLI settings.json under mcpServers. Keep any existing servers.',
    geminiStep2: 'Start a new CLI session and use /mcp to inspect the available tools. Town tools need no sign-in.',
    geminiStep3:
      'Personal tools need an OAuth sign-in: follow Gemini CLI’s MCP authentication prompt if your version shows one, then sign in to ReloCat in the browser and approve the access.',

    museKind: 'Meta · setup unverified',
    museIntro: 'Meta’s personal agent. A custom MCP connection path for the consumer Muse app is not verified.',
    museStep1:
      'Meta documents connections to apps and services, but we have not verified an official way to add an arbitrary MCP server to the personal agent.',
    museStep2: 'Try the town demo or choose another agent for documented MCP setup.',

    otherName: 'Another agent',
    otherKind: 'Streamable HTTP',
    otherIntro: 'Use any MCP client that supports Streamable HTTP and can reach your ReloCat server.',
    otherStep1: 'Add a server named ReloCat in your agent’s MCP settings.',
    otherStep2:
      'Select Streamable HTTP and enter the MCP server URL shown above. Choose OAuth where the client offers it: ReloCat supports discovery, dynamic client registration and PKCE, and its personal tools answer 401 with a sign-in challenge until you have signed in. No authentication is enough for the town tools and the public demo.',
    otherStep3:
      'Connect, list the available tools, and try get_town_profile or recommend_towns. Client configuration formats differ; follow your client’s documentation.',
  },
  {
    ca: {
      copied: 'Copiat.',
      clipboardUnavailable: 'No es pot accedir al porta-retalls. Copia manualment el text seleccionat.',
      endpointInvalid: 'Introdueix un URL HTTP o HTTPS vàlid sense credencials.',
      endpointLocal:
        'Aquesta adreça funciona per a agents locals. ChatGPT i Claude necessiten un URL HTTPS al qual puguin arribar o un túnel compatible.',
      endpointRemote:
        'Enganxa aquesta adreça al teu agent. Les eines personals et demanen que iniciïs la sessió a ReloCat amb OAuth; les eines de pobles no demanen iniciar la sessió.',
      copyConfiguration: 'Copia la configuració',
      copyQuestion: 'Copia la pregunta',
      copyQuestionLabel: 'Copia la pregunta: {question}',
      prompt1:
        'Fes servir ReloCat per trobar pobles on pugui llogar per 700 € al mes i arribar a una escola de primària sense cotxe. Explica’m els pros i els contres.',
      prompt2:
        'Compara Calaf, Juncosa i Ulldemolins. Mostra’m les fonts, les dates de la recerca i tot el que encara calgui comprovar.',
      prompt3:
        'Busca exemples d’Idealista a Calaf. Separa els resultats de cerca dels habitatges disponibles verificats.',

      chatgptKind: 'Connexió al núvol',
      chatgptIntro:
        'Afegeix ReloCat com a plugin MCP personalitzat per fer servir les seves eines a les teves converses.',
      chatgptStep1: 'Obre la pàgina Plugins de ChatGPT. Prem el botó del signe més i després «Add custom MCP server».',
      chatgptStep2:
        'Posa-li el nom ReloCat. Tria una connexió per URL públic i enganxa l’URL del servidor MCP que es mostra més amunt. Un Secure MCP Tunnel configurat és una altra opció.',
      chatgptStep3:
        'Per a l’autenticació, tria OAuth si vols la teva llar i les teves finances desades; ChatGPT obre llavors la pàgina d’inici de sessió i consentiment de ReloCat. Sense autenticació, les eines de pobles i la demostració pública continuen funcionant. Revisa les eines i crea el plugin.',
      chatgptStep4:
        'Instal·la’l, comença un xat nou i escriu @ per seleccionar ReloCat. Prova una de les preguntes de més avall.',

      claudeKind: 'Connexió al núvol',
      claudeIntro:
        'Afegeix un connector personalitzat a Claude. Els connectors remots es connecten des del núvol de Claude, també a Claude Desktop.',
      claudeStep1: 'Obre Customize → Connectors. Tria «+ Add» i després «Add custom connector».',
      claudeStep2: 'Posa al connector el nom ReloCat i enganxa l’URL del servidor MCP que es mostra més amunt.',
      claudeStep3:
        'ReloCat anuncia l’inici de sessió amb OAuth. Quan Claude et demani que et connectis, inicia la sessió al teu compte de ReloCat i aprova l’accés que s’hi indica; les eines de pobles funcionen sense fer-ho. Als plans Team o Enterprise pot caldre que un administrador afegeixi abans el connector.',
      claudeStep4: 'Activa ReloCat des del menú + del xat → Connectors i després pregunta per un poble.',

      hermesKind: 'Local o remot',
      hermesIntro:
        'Afegeix ReloCat als servidors MCP del teu perfil actiu de Hermes. Localhost funciona quan Hermes i ReloCat s’executen a la mateixa màquina.',
      hermesStep1:
        'Fusiona aquesta entrada a mcp_servers, al config.yaml del teu perfil actiu (per defecte: ~/.hermes/config.yaml). Conserva els servidors que ja tens.',
      hermesStep2:
        'Comença una sessió nova de Hermes i demana-li que faci servir les eines de pobles de ReloCat. No demanen iniciar la sessió.',
      hermesStep3:
        'Les eines personals responen amb una petició d’inici de sessió amb OAuth. Si la teva versió de Hermes admet OAuth per a servidors MCP, segueix les seves indicacions per iniciar la sessió a ReloCat; si no, fes servir les eines de pobles i la demostració pública.',

      openclawKind: 'Local o remot',
      openclawIntro: 'Registra ReloCat com a servidor MCP Streamable HTTP a OpenClaw.',
      openclawStep1: 'Executa l’ordre de més avall a l’entorn on s’executa OpenClaw.',
      openclawStep2:
        'Comprova la connexió i després demana al teu agent que faci servir ReloCat. Una instal·lació remota d’OpenClaw no pot arribar al localhost del teu portàtil.',
      openclawStep3:
        'Les eines de pobles no demanen iniciar la sessió. Les eines personals responen amb una petició d’inici de sessió amb OAuth; completa l’inici de sessió si la teva versió d’OpenClaw l’ofereix per a servidors MCP.',

      codexKind: 'Local o remot',
      codexIntro: 'Afegeix ReloCat a la configuració MCP de Codex amb la CLI.',
      codexStep1: 'Executa l’ordre de més avall a la màquina on s’executa Codex.',
      codexStep2:
        'Comença una sessió nova, comprova que les eines de ReloCat estan disponibles i fes una pregunta sobre un poble. Les eines de pobles no demanen iniciar la sessió.',
      codexStep3:
        'Per a la teva llar i les teves finances desades, inicia la sessió amb OAuth quan Codex l’ofereixi per a aquest servidor (consulta la guia MCP de Codex per saber l’ordre d’inici de sessió de la teva versió); el navegador obre la pàgina d’inici de sessió i consentiment de ReloCat.',

      cursorKind: 'Local o remot',
      cursorIntro: 'Dona a Cursor Agent accés a les eines de ReloCat amb una entrada de servidor MCP.',
      cursorStep1:
        'Fusiona aquesta entrada a .cursor/mcp.json per a aquest projecte, o a ~/.cursor/mcp.json per al teu compte. Conserva els altres servidors.',
      cursorStep2:
        'Activa ReloCat a la configuració MCP de Cursor i després fes-lo servir des d’Agent. Les eines de pobles no demanen iniciar la sessió.',
      cursorStep3:
        'Quan Cursor indiqui que el servidor necessita un inici de sessió, inicia la sessió al teu compte de ReloCat al navegador i aprova l’accés. Qui administra el servidor ha de permetre l’adreça de retorn de Cursor (l’esquema cursor a OAUTH_REDIRECT_SCHEMES).',

      geminiKind: 'Local o remot',
      geminiIntro:
        'Connecta l’agent de terminal de Gemini amb una adreça Streamable HTTP. Aquestes instruccions són per a Gemini CLI.',
      geminiStep1:
        'Fusiona això al settings.json de Gemini CLI, dins de mcpServers. Conserva els servidors que ja hi hagi.',
      geminiStep2:
        'Comença una sessió nova de la CLI i fes servir /mcp per veure les eines disponibles. Les eines de pobles no demanen iniciar la sessió.',
      geminiStep3:
        'Les eines personals necessiten un inici de sessió amb OAuth: segueix la indicació d’autenticació MCP de Gemini CLI si la teva versió en mostra una, i després inicia la sessió a ReloCat al navegador i aprova l’accés.',

      museKind: 'Meta · configuració no verificada',
      museIntro:
        'L’agent personal de Meta. No s’ha verificat cap via de connexió MCP personalitzada per a l’aplicació Muse de consum.',
      museStep1:
        'Meta documenta connexions amb aplicacions i serveis, però no hem verificat cap manera oficial d’afegir un servidor MCP qualsevol a l’agent personal.',
      museStep2: 'Prova la demo de pobles o tria un altre agent amb una configuració MCP documentada.',

      otherName: 'Un altre agent',
      otherKind: 'Streamable HTTP',
      otherIntro:
        'Fes servir qualsevol client MCP que admeti Streamable HTTP i pugui arribar al teu servidor de ReloCat.',
      otherStep1: 'Afegeix un servidor anomenat ReloCat a la configuració MCP del teu agent.',
      otherStep2:
        'Selecciona Streamable HTTP i introdueix l’URL del servidor MCP que es mostra més amunt. Tria OAuth si el client l’ofereix: ReloCat admet descobriment, registre dinàmic de clients i PKCE, i les seves eines personals responen 401 amb una petició d’inici de sessió fins que hagis iniciat la sessió. Per a les eines de pobles i la demostració pública n’hi ha prou sense autenticació.',
      otherStep3:
        'Connecta’t, llista les eines disponibles i prova get_town_profile o recommend_towns. Els formats de configuració varien segons el client; segueix la documentació del teu.',
    },
    es: {
      copied: 'Copiado.',
      clipboardUnavailable: 'No se puede acceder al portapapeles. Copia manualmente el texto seleccionado.',
      endpointInvalid: 'Introduce una URL HTTP o HTTPS válida sin credenciales.',
      endpointLocal:
        'Esta dirección funciona para agentes locales. ChatGPT y Claude necesitan una URL HTTPS a la que puedan llegar o un túnel compatible.',
      endpointRemote:
        'Pega esta dirección en tu agente. Las herramientas personales te piden que inicies sesión en ReloCat con OAuth; las herramientas de pueblos no piden iniciar sesión.',
      copyConfiguration: 'Copia la configuración',
      copyQuestion: 'Copia la pregunta',
      copyQuestionLabel: 'Copia la pregunta: {question}',
      prompt1:
        'Usa ReloCat para encontrar pueblos donde pueda alquilar por 700 € al mes y llegar a un colegio de primaria sin coche. Explícame las ventajas y los inconvenientes.',
      prompt2:
        'Compara Calaf, Juncosa y Ulldemolins. Muéstrame las fuentes, las fechas de la investigación y todo lo que aún haya que comprobar.',
      prompt3:
        'Busca ejemplos de Idealista en Calaf. Separa los resultados de búsqueda de las viviendas disponibles verificadas.',

      chatgptKind: 'Conexión en la nube',
      chatgptIntro: 'Añade ReloCat como plugin MCP personalizado para usar sus herramientas en tus conversaciones.',
      chatgptStep1:
        'Abre la página Plugins de ChatGPT. Pulsa el botón del signo más y después «Add custom MCP server».',
      chatgptStep2:
        'Ponle el nombre ReloCat. Elige una conexión por URL pública y pega la URL del servidor MCP que se muestra arriba. Un Secure MCP Tunnel configurado es otra opción.',
      chatgptStep3:
        'Para la autenticación, elige OAuth si quieres tu hogar y tus finanzas guardados; ChatGPT abre entonces la página de inicio de sesión y consentimiento de ReloCat. Sin autenticación, las herramientas de pueblos y la demostración pública siguen funcionando. Revisa las herramientas y crea el plugin.',
      chatgptStep4:
        'Instálalo, empieza un chat nuevo y escribe @ para seleccionar ReloCat. Prueba una de las preguntas de más abajo.',

      claudeKind: 'Conexión en la nube',
      claudeIntro:
        'Añade un conector personalizado en Claude. Los conectores remotos se conectan desde la nube de Claude, también en Claude Desktop.',
      claudeStep1: 'Abre Customize → Connectors. Elige «+ Add» y después «Add custom connector».',
      claudeStep2: 'Ponle al conector el nombre ReloCat y pega la URL del servidor MCP que se muestra arriba.',
      claudeStep3:
        'ReloCat anuncia el inicio de sesión con OAuth. Cuando Claude te pida que te conectes, inicia sesión en tu cuenta de ReloCat y aprueba el acceso que se indica; las herramientas de pueblos funcionan sin hacerlo. En los planes Team o Enterprise puede hacer falta que un administrador añada antes el conector.',
      claudeStep4: 'Activa ReloCat desde el menú + del chat → Connectors y después pregunta por un pueblo.',

      hermesKind: 'Local o remoto',
      hermesIntro:
        'Añade ReloCat a los servidores MCP de tu perfil activo de Hermes. Localhost funciona cuando Hermes y ReloCat se ejecutan en la misma máquina.',
      hermesStep1:
        'Fusiona esta entrada en mcp_servers, en el config.yaml de tu perfil activo (por defecto: ~/.hermes/config.yaml). Conserva los servidores que ya tienes.',
      hermesStep2:
        'Empieza una sesión nueva de Hermes y pídele que use las herramientas de pueblos de ReloCat. No piden iniciar sesión.',
      hermesStep3:
        'Las herramientas personales responden con una petición de inicio de sesión con OAuth. Si tu versión de Hermes admite OAuth para servidores MCP, sigue sus indicaciones para iniciar sesión en ReloCat; si no, usa las herramientas de pueblos y la demostración pública.',

      openclawKind: 'Local o remoto',
      openclawIntro: 'Registra ReloCat como servidor MCP Streamable HTTP en OpenClaw.',
      openclawStep1: 'Ejecuta el comando de más abajo en el entorno donde se ejecuta OpenClaw.',
      openclawStep2:
        'Comprueba la conexión y después pide a tu agente que use ReloCat. Una instalación remota de OpenClaw no puede llegar al localhost de tu portátil.',
      openclawStep3:
        'Las herramientas de pueblos no piden iniciar sesión. Las herramientas personales responden con una petición de inicio de sesión con OAuth; completa el inicio de sesión si tu versión de OpenClaw lo ofrece para servidores MCP.',

      codexKind: 'Local o remoto',
      codexIntro: 'Añade ReloCat a la configuración MCP de Codex con la CLI.',
      codexStep1: 'Ejecuta el comando de más abajo en la máquina donde se ejecuta Codex.',
      codexStep2:
        'Empieza una sesión nueva, comprueba que las herramientas de ReloCat están disponibles y haz una pregunta sobre un pueblo. Las herramientas de pueblos no piden iniciar sesión.',
      codexStep3:
        'Para tu hogar y tus finanzas guardados, inicia sesión con OAuth cuando Codex lo ofrezca para este servidor (consulta la guía MCP de Codex para saber el comando de inicio de sesión de tu versión); el navegador abre la página de inicio de sesión y consentimiento de ReloCat.',

      cursorKind: 'Local o remoto',
      cursorIntro: 'Da a Cursor Agent acceso a las herramientas de ReloCat con una entrada de servidor MCP.',
      cursorStep1:
        'Fusiona esta entrada en .cursor/mcp.json para este proyecto, o en ~/.cursor/mcp.json para tu cuenta. Conserva los demás servidores.',
      cursorStep2:
        'Activa ReloCat en la configuración MCP de Cursor y después úsalo desde Agent. Las herramientas de pueblos no piden iniciar sesión.',
      cursorStep3:
        'Cuando Cursor indique que el servidor necesita un inicio de sesión, inicia sesión en tu cuenta de ReloCat en el navegador y aprueba el acceso. Quien administra el servidor debe permitir la dirección de retorno de Cursor (el esquema cursor en OAUTH_REDIRECT_SCHEMES).',

      geminiKind: 'Local o remoto',
      geminiIntro:
        'Conecta el agente de terminal de Gemini con una dirección Streamable HTTP. Estas instrucciones son para Gemini CLI.',
      geminiStep1:
        'Fusiona esto en el settings.json de Gemini CLI, dentro de mcpServers. Conserva los servidores que ya haya.',
      geminiStep2:
        'Empieza una sesión nueva de la CLI y usa /mcp para ver las herramientas disponibles. Las herramientas de pueblos no piden iniciar sesión.',
      geminiStep3:
        'Las herramientas personales necesitan un inicio de sesión con OAuth: sigue la indicación de autenticación MCP de Gemini CLI si tu versión muestra una, y después inicia sesión en ReloCat en el navegador y aprueba el acceso.',

      museKind: 'Meta · configuración no verificada',
      museIntro:
        'El agente personal de Meta. No se ha verificado ninguna vía de conexión MCP personalizada para la aplicación Muse de consumo.',
      museStep1:
        'Meta documenta conexiones con aplicaciones y servicios, pero no hemos verificado ninguna manera oficial de añadir un servidor MCP cualquiera al agente personal.',
      museStep2: 'Prueba la demo de pueblos o elige otro agente con una configuración MCP documentada.',

      otherName: 'Otro agente',
      otherKind: 'Streamable HTTP',
      otherIntro: 'Usa cualquier cliente MCP que admita Streamable HTTP y pueda llegar a tu servidor de ReloCat.',
      otherStep1: 'Añade un servidor llamado ReloCat en la configuración MCP de tu agente.',
      otherStep2:
        'Selecciona Streamable HTTP e introduce la URL del servidor MCP que se muestra arriba. Elige OAuth si el cliente lo ofrece: ReloCat admite descubrimiento, registro dinámico de clientes y PKCE, y sus herramientas personales responden 401 con una petición de inicio de sesión hasta que hayas iniciado sesión. Para las herramientas de pueblos y la demostración pública basta con no usar autenticación.',
      otherStep3:
        'Conéctate, lista las herramientas disponibles y prueba get_town_profile o recommend_towns. Los formatos de configuración varían según el cliente; sigue la documentación del tuyo.',
    },
  },
);
