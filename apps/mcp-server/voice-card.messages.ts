import { defineMessages } from '../../packages/i18n/messages.ts';

/** The "Start talking" card. The sentence to say names the product, ReloCat, as ChatGPT lists the plugin. */
export const voiceCard = defineMessages(
  {
    title: 'ReloCat homebuying interview',
    heading: 'Your homebuying interview',
    intro: 'Start with your bank transactions and talk through your home goals.',
    startHere: 'Start the interview here',
    startMessage: 'Start my homebuying interview with ReloCat: ask me the first question.',
    sent: 'Sent. The interview continues in this chat.',
    voiceTip: 'To speak instead of typing, select the Voice icon in ChatGPT.',
    start: 'Start talking',
    opens: 'Opens ReloCat’s own voice page in a new tab.',
    instructions: 'Select the Voice icon in ChatGPT, then say “Use ReloCat to start my homebuying interview.”',
  },
  {
    ca: {
      title: 'Entrevista de compra d’habitatge de ReloCat',
      heading: 'La teva entrevista de compra d’habitatge',
      intro: 'Comença pels teus moviments bancaris i parla dels teus objectius d’habitatge.',
      startHere: 'Comença l’entrevista aquí',
      startMessage: 'Comença la meva entrevista de compra d’habitatge amb ReloCat: fes-me la primera pregunta.',
      sent: 'Enviat. L’entrevista continua en aquest xat.',
      voiceTip: 'Per parlar en lloc d’escriure, selecciona la icona de veu de ChatGPT.',
      start: 'Comença a parlar',
      opens: 'Obre la pàgina de veu pròpia de ReloCat en una pestanya nova.',
      instructions:
        'Selecciona la icona de veu a ChatGPT i digues: «Fes servir ReloCat per començar la meva entrevista de compra d’habitatge.»',
    },
    es: {
      title: 'Entrevista de compra de vivienda de ReloCat',
      heading: 'Tu entrevista de compra de vivienda',
      intro: 'Empieza por tus movimientos bancarios y habla de tus objetivos de vivienda.',
      startHere: 'Empieza la entrevista aquí',
      startMessage: 'Empieza mi entrevista de compra de vivienda con ReloCat: hazme la primera pregunta.',
      sent: 'Enviado. La entrevista sigue en este chat.',
      voiceTip: 'Para hablar en lugar de escribir, selecciona el icono de voz de ChatGPT.',
      start: 'Empieza a hablar',
      opens: 'Abre la página de voz propia de ReloCat en una pestaña nueva.',
      instructions:
        'Selecciona el icono de voz en ChatGPT y di: «Usa ReloCat para empezar mi entrevista de compra de vivienda.»',
    },
  },
);
