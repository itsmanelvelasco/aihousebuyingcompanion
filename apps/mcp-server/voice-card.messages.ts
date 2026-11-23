import { defineMessages } from '../../packages/i18n/messages.ts';

/** The "Start talking" card. The sentence to say names the plugin, ReloCat Team, as ChatGPT lists it. */
export const voiceCard = defineMessages(
  {
    title: 'ReloCat homebuying interview',
    heading: 'Your homebuying interview',
    intro: 'Start with your bank transactions and talk through your home goals.',
    start: 'Start talking',
    opens: 'Opens the ReloCat voice interviewer.',
    instructions: 'Select the Voice icon in ChatGPT, then say “Use ReloCat Team to start my homebuying interview.”',
  },
  {
    ca: {
      title: 'Entrevista de compra d’habitatge de ReloCat',
      heading: 'La teva entrevista de compra d’habitatge',
      intro: 'Comença pels teus moviments bancaris i parla dels teus objectius d’habitatge.',
      start: 'Comença a parlar',
      opens: 'Obre l’entrevistador de veu de ReloCat.',
      instructions:
        'Selecciona la icona de veu a ChatGPT i digues: «Fes servir ReloCat Team per començar la meva entrevista de compra d’habitatge.»',
    },
    es: {
      title: 'Entrevista de compra de vivienda de ReloCat',
      heading: 'Tu entrevista de compra de vivienda',
      intro: 'Empieza por tus movimientos bancarios y habla de tus objetivos de vivienda.',
      start: 'Empieza a hablar',
      opens: 'Abre el entrevistador de voz de ReloCat.',
      instructions:
        'Selecciona el icono de voz en ChatGPT y di: «Usa ReloCat Team para empezar mi entrevista de compra de vivienda.»',
    },
  },
);
