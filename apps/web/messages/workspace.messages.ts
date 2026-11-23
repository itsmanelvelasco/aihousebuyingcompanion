import { defineMessages } from '../../../packages/i18n/messages.ts';

/**
 * The frame of the workspace: masthead, whose figures are on screen (a fictional demo persona, the
 * person's own plan or a what-if), and the notes to read with the numbers. `<b>…</b>` marks a bold lead-in.
 */
export const workspaceMessages = defineMessages(
  {
    documentTitle: 'ReloCat Workspace',
    heading: 'How soon could you buy?',
    opening: 'Opening the workspace…',
    connectFailed: '<b>Could not connect to the chat.</b> Reopen the ReloCat workspace to try again.',
    ledeMe: 'Time until you have the upfront cash for a home, place by place. Plan dated {date}.',
    ledeDemo: 'Time until {name} has the upfront cash for a home, place by place. Plan dated {date}.',
    ledeGeneric:
      'Time until you have the upfront cash for a home, place by place: at today’s rate, with your habits, and with what each place offers.',
    fixture:
      '<b>Fixture preview.</b> Sample figures written by hand, not planner output. Toggles call the fixture and the timelines do not recalculate.',

    demoBanner:
      '<b>Fictional demo persona, read-only.</b> {name} is an invented household with invented bank movements. Nothing here belongs to a real person and nothing you change is saved.',
    showMyPlan: 'Show my own plan',
    signInOwnFigures: 'Sign in to plan with your own figures',
    connectInChat: 'Connect your ReloCat account in the chat to plan with your own figures.',
    meBanner:
      '<b>Your own plan.</b> These are the figures saved to your account; only you and the assistants you connected can read them.',
    manageAccount: 'Manage your account',
    inlineBanner: '<b>What-if estimate, not saved.</b> These figures were typed into this page and are stored nowhere.',
    signInToKeep: 'Sign in to keep them',
    clearEstimate: 'Clear estimate',
    labelMe: 'your profile',
    labelWhatIf: 'what-if',

    notesTitle: 'Read this with the numbers',
    planDated: 'Plan dated {date}',
    limits: 'Limits',
    noLimits: 'The planner listed no limitations.',
    assumptions: 'Assumptions',
    noAssumptions: 'The planner listed no assumptions.',
    missingData: 'Missing data',
    nothingMissing: 'Nothing is flagged as missing for these places.',
  },
  {
    ca: {
      documentTitle: 'Espai de treball de ReloCat',
      heading: 'Quan podries comprar?',
      opening: 'Obrint l’espai de treball…',
      connectFailed:
        '<b>No s’ha pogut connectar amb el xat.</b> Torna a obrir l’espai de treball de ReloCat per provar-ho de nou.',
      ledeMe: 'Temps fins que tinguis els diners inicials per a un habitatge, lloc per lloc. Pla amb data de {date}.',
      ledeDemo:
        'Temps fins que {name} tingui els diners inicials per a un habitatge, lloc per lloc. Pla amb data de {date}.',
      ledeGeneric:
        'Temps fins que tinguis els diners inicials per a un habitatge, lloc per lloc: al ritme d’avui, amb els teus hàbits i amb el que ofereix cada lloc.',
      fixture:
        '<b>Vista prèvia amb dades de mostra.</b> Xifres de mostra escrites a mà, no són resultats del planificador. Els interruptors criden les dades de mostra i els terminis no es tornen a calcular.',

      demoBanner:
        '<b>Persona de demostració fictícia, només de lectura.</b> {name} és una llar inventada amb moviments bancaris inventats. Res del que hi ha aquí pertany a una persona real i res del que canviïs es desa.',
      showMyPlan: 'Mostra el meu pla',
      signInOwnFigures: 'Inicia la sessió per planificar amb les teves xifres',
      connectInChat: 'Connecta el teu compte de ReloCat al xat per planificar amb les teves xifres.',
      meBanner:
        '<b>El teu propi pla.</b> Aquestes són les xifres desades al teu compte; només les podeu llegir tu i els assistents que has connectat.',
      manageAccount: 'Gestiona el teu compte',
      inlineBanner:
        '<b>Estimació hipotètica, no desada.</b> Aquestes xifres s’han escrit en aquesta pàgina i no es desen enlloc.',
      signInToKeep: 'Inicia la sessió per conservar-les',
      clearEstimate: 'Esborra l’estimació',
      labelMe: 'el teu perfil',
      labelWhatIf: 'estimació hipotètica',

      notesTitle: 'Llegeix això amb les xifres',
      planDated: 'Pla amb data de {date}',
      limits: 'Límits',
      noLimits: 'El planificador no ha indicat cap limitació.',
      assumptions: 'Supòsits',
      noAssumptions: 'El planificador no ha indicat cap supòsit.',
      missingData: 'Dades que falten',
      nothingMissing: 'No s’ha marcat cap dada que falti per a aquests llocs.',
    },
    es: {
      documentTitle: 'Espacio de trabajo de ReloCat',
      heading: '¿Cuándo podrías comprar?',
      opening: 'Abriendo el espacio de trabajo…',
      connectFailed:
        '<b>No se ha podido conectar con el chat.</b> Vuelve a abrir el espacio de trabajo de ReloCat para intentarlo de nuevo.',
      ledeMe: 'Tiempo hasta que tengas el dinero inicial para una vivienda, lugar por lugar. Plan con fecha de {date}.',
      ledeDemo:
        'Tiempo hasta que {name} tenga el dinero inicial para una vivienda, lugar por lugar. Plan con fecha de {date}.',
      ledeGeneric:
        'Tiempo hasta que tengas el dinero inicial para una vivienda, lugar por lugar: al ritmo de hoy, con tus hábitos y con lo que ofrece cada lugar.',
      fixture:
        '<b>Vista previa con datos de muestra.</b> Cifras de muestra escritas a mano, no son resultados del planificador. Los interruptores llaman a los datos de muestra y los plazos no se recalculan.',

      demoBanner:
        '<b>Persona de demostración ficticia, de solo lectura.</b> {name} es un hogar inventado con movimientos bancarios inventados. Nada de lo que hay aquí pertenece a una persona real y nada de lo que cambies se guarda.',
      showMyPlan: 'Muestra mi plan',
      signInOwnFigures: 'Inicia sesión para planificar con tus cifras',
      connectInChat: 'Conecta tu cuenta de ReloCat en el chat para planificar con tus cifras.',
      meBanner:
        '<b>Tu propio plan.</b> Estas son las cifras guardadas en tu cuenta; solo podéis leerlas tú y los asistentes que has conectado.',
      manageAccount: 'Gestiona tu cuenta',
      inlineBanner:
        '<b>Estimación hipotética, no guardada.</b> Estas cifras se han escrito en esta página y no se guardan en ningún sitio.',
      signInToKeep: 'Inicia sesión para conservarlas',
      clearEstimate: 'Borra la estimación',
      labelMe: 'tu perfil',
      labelWhatIf: 'estimación hipotética',

      notesTitle: 'Lee esto con las cifras',
      planDated: 'Plan con fecha de {date}',
      limits: 'Límites',
      noLimits: 'El planificador no ha indicado ninguna limitación.',
      assumptions: 'Supuestos',
      noAssumptions: 'El planificador no ha indicado ningún supuesto.',
      missingData: 'Datos que faltan',
      nothingMissing: 'No se ha marcado ningún dato que falte para estos lugares.',
    },
  },
);
