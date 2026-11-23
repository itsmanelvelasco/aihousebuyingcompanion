import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * Sentences the MCP tools add to a result a person reads. Tool titles, descriptions, the server
 * instructions and the short `content` summary are written for the model and stay in English.
 */
export const toolMessages = defineMessages(
  {
    fiscalScreening:
      'Eligibility is a screening result based on declared facts and the official rules verified in the snapshot.',
    fiscalTaxDates:
      'For tax measures, the measure’s effective dates apply. Call status is unknown because tax claims do not have a grant application window.',
    saySignIn:
      'To use your own ReloCat profile, connect your account first: open ReloCat in the apps or connectors settings of your assistant, choose Connect and sign in. Until then I can keep your answers in this conversation only.',
    sayReconnect:
      'Your ReloCat connection does not allow this yet. Reconnect ReloCat in the apps or connectors settings of your assistant and allow it when you are asked.',
    sayNoAccounts:
      'This ReloCat server has no accounts, so nothing can be saved to a profile here. I can keep your answers in this conversation only.',
    sayNotStored:
      'I am keeping your answers only in this conversation, so they will be gone when it ends. To save them, connect your ReloCat account in the apps or connectors settings of your assistant.',
    sayNotStoredNoAccounts: 'I am keeping your answers only in this conversation, so they will be gone when it ends.',
    habitStoreMissing: 'Habits cannot be saved on this server.',
    habitFuture: 'A habit cannot start in the future: give today or an earlier day.',
    habitLimit: 'You already have the most habits a profile can hold. Pause or replace one first.',
  },
  {
    ca: {
      fiscalScreening:
        'L’elegibilitat és el resultat d’una comprovació basada en els fets declarats i en les regles oficials verificades en el conjunt de dades.',
      fiscalTaxDates:
        'Per a les mesures fiscals s’apliquen les dates de vigència de la mesura. L’estat de la convocatòria és desconegut perquè els beneficis fiscals no tenen un termini de sol·licitud com les subvencions.',
      saySignIn:
        'Per fer servir el teu perfil de ReloCat, primer has de connectar el teu compte: obre ReloCat a la configuració d’aplicacions o connectors del teu assistent, tria Connecta i inicia la sessió. Mentrestant, puc guardar les teves respostes només en aquesta conversa.',
      sayReconnect:
        'La teva connexió amb ReloCat encara no permet fer això. Torna a connectar ReloCat a la configuració d’aplicacions o connectors del teu assistent i dona el permís quan se’t demani.',
      sayNoAccounts:
        'Aquest servidor de ReloCat no té comptes, de manera que aquí no es pot desar res en un perfil. Puc guardar les teves respostes només en aquesta conversa.',
      sayNotStored:
        'Guardo les teves respostes només en aquesta conversa, de manera que es perdran quan s’acabi. Per desar-les, connecta el teu compte de ReloCat a la configuració d’aplicacions o connectors del teu assistent.',
      sayNotStoredNoAccounts:
        'Guardo les teves respostes només en aquesta conversa, de manera que es perdran quan s’acabi.',
      habitStoreMissing: 'En aquest servidor no es poden desar hàbits.',
      habitFuture: 'Un hàbit no pot començar en el futur: indica avui o un dia anterior.',
      habitLimit: 'Ja tens el màxim d’hàbits que admet un perfil. Posa’n un en pausa o substitueix-lo abans.',
    },
    es: {
      fiscalScreening:
        'La elegibilidad es el resultado de una comprobación basada en los hechos declarados y en las reglas oficiales verificadas en el conjunto de datos.',
      fiscalTaxDates:
        'Para las medidas fiscales se aplican las fechas de vigencia de la medida. El estado de la convocatoria es desconocido porque los beneficios fiscales no tienen un plazo de solicitud como las subvenciones.',
      saySignIn:
        'Para usar tu perfil de ReloCat, primero tienes que conectar tu cuenta: abre ReloCat en los ajustes de aplicaciones o conectores de tu asistente, elige Conectar e inicia sesión. Mientras tanto, puedo guardar tus respuestas solo en esta conversación.',
      sayReconnect:
        'Tu conexión con ReloCat todavía no permite hacer esto. Vuelve a conectar ReloCat en los ajustes de aplicaciones o conectores de tu asistente y da el permiso cuando se te pida.',
      sayNoAccounts:
        'Este servidor de ReloCat no tiene cuentas, así que aquí no se puede guardar nada en un perfil. Puedo guardar tus respuestas solo en esta conversación.',
      sayNotStored:
        'Guardo tus respuestas solo en esta conversación, así que se perderán cuando termine. Para guardarlas, conecta tu cuenta de ReloCat en los ajustes de aplicaciones o conectores de tu asistente.',
      sayNotStoredNoAccounts: 'Guardo tus respuestas solo en esta conversación, así que se perderán cuando termine.',
      habitStoreMissing: 'En este servidor no se pueden guardar hábitos.',
      habitFuture: 'Un hábito no puede empezar en el futuro: indica hoy o un día anterior.',
      habitLimit: 'Ya tienes el máximo de hábitos que admite un perfil. Pon uno en pausa o sustitúyelo antes.',
    },
  },
);
