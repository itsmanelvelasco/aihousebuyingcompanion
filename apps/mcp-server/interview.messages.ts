import { defineMessages } from '../../packages/i18n/messages.ts';

/** What `start_homebuying_interview` gives the assistant to say to the person as it is. */
export const interviewMessages = defineMessages(
  {
    openingQuestion:
      'Would you like to start with a bank CSV, use the fictional demo bank account, or tell me your rough monthly income and spending?',
    voiceSetup:
      'Select the Voice icon in ChatGPT to start Live, then say: Use ReloCat to start my homebuying interview.',
  },
  {
    ca: {
      openingQuestion:
        'Vols començar amb un CSV del banc, fer servir el compte bancari fictici de demostració, o dir-me aproximadament els teus ingressos i despeses mensuals?',
      voiceSetup:
        'Selecciona la icona de veu a ChatGPT per iniciar el mode de veu i digues: «Fes servir ReloCat per començar la meva entrevista de compra d’habitatge.»',
    },
    es: {
      openingQuestion:
        '¿Quieres empezar con un CSV del banco, usar la cuenta bancaria ficticia de demostración, o decirme aproximadamente tus ingresos y gastos mensuales?',
      voiceSetup:
        'Selecciona el icono de voz en ChatGPT para iniciar el modo de voz y di: «Usa ReloCat para empezar mi entrevista de compra de vivienda.»',
    },
  },
);
