import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * The interview card embedded in a chat (`card.html`, `card.ts`): what only the card says. The
 * labels it shares with the interview page (Start talking, Mute mic, the plan, the trail) come from
 * `messages.ts`, so both surfaces name the same thing with the same words.
 */
export const card = defineMessages(
  {
    title: 'ReloCat homebuying interview',
    heading: 'Your homebuying interview',
    intro: 'Talk it through here, in this card. ReloCat asks one question at a time.',
    ready: 'Ready when you are. Your microphone is asked for when you start.',
    voiceNote: 'Voice uses your microphone and sends what you say to OpenAI.',
    continueInChat: 'Continue in the chat instead',
    startMessage: 'Start my homebuying interview with ReloCat: ask me the first question.',
    sent: 'Sent. The interview continues in this chat.',
    typeIt: 'Type this in the chat: “{message}”',
    typeInstead: 'Answer by typing',
    typing: 'Type your reply below. ReloCat answers aloud and in writing.',
    micRefused:
      'The microphone was not allowed, so ReloCat cannot hear you here. Answer by typing, or continue in the chat.',
    micUnavailable: 'This app gives the card no microphone. Answer by typing, or continue in the chat.',
    voiceUnavailable: 'Voice cannot run in this app. Continue in the chat instead.',
    voiceRefused: 'Voice is not open to this app yet. Continue in the chat instead.',
    voiceBusy: 'Too many voice conversations right now. Try again later, or continue in the chat.',
    voiceOff: 'Voice is not set up on this ReloCat server. Continue in the chat instead.',
    voiceNetwork: 'Voice could not connect. Try again, or continue in the chat.',
    voiceDropped: 'The voice conversation was cut off. Start again, or continue in the chat.',
    ended: 'Conversation ended. Start again whenever you like.',
    notSaved:
      'Your ReloCat account is not connected in this chat, so your answers stay in this card and are not saved. Connect ReloCat in ChatGPT to save them.',
    noTools:
      'This card cannot reach ReloCat’s tools here, so your answers stay in this card and it shows no plan. Continue in the chat to get one.',
    savedToProfile: 'Each answer you confirm is saved to your ReloCat profile.',
    planHeading: 'Your plan so far',
    workspaceMessage: 'Use ReloCat to show my workspace for {towns}.',
    workspaceMessageNoTowns: 'Use ReloCat to show my workspace.',
    workspaceSent: 'Asked in the chat. The workspace appears there.',
  },
  {
    ca: {
      title: 'Entrevista de compra d’habitatge de ReloCat',
      heading: 'La teva entrevista de compra d’habitatge',
      intro: 'Parla-ho aquí mateix, en aquesta targeta. ReloCat fa una pregunta cada vegada.',
      ready: 'Quan vulguis. Se’t demanarà el micròfon en començar.',
      voiceNote: 'La veu fa servir el teu micròfon i envia el que dius a OpenAI.',
      continueInChat: 'Continua al xat',
      startMessage: 'Comença la meva entrevista de compra d’habitatge amb ReloCat: fes-me la primera pregunta.',
      sent: 'Enviat. L’entrevista continua en aquest xat.',
      typeIt: 'Escriu això al xat: «{message}»',
      typeInstead: 'Respon per escrit',
      typing: 'Escriu la teva resposta a sota. ReloCat respon en veu alta i per escrit.',
      micRefused:
        'No s’ha permès el micròfon, de manera que ReloCat no et pot sentir aquí. Respon per escrit o continua al xat.',
      micUnavailable: 'Aquesta aplicació no dona micròfon a la targeta. Respon per escrit o continua al xat.',
      voiceUnavailable: 'La veu no pot funcionar en aquesta aplicació. Continua al xat.',
      voiceRefused: 'La veu encara no està oberta per a aquesta aplicació. Continua al xat.',
      voiceBusy: 'Ara mateix hi ha massa converses de veu. Torna-ho a provar més tard o continua al xat.',
      voiceOff: 'La veu no està configurada en aquest servidor de ReloCat. Continua al xat.',
      voiceNetwork: 'La veu no s’ha pogut connectar. Torna-ho a provar o continua al xat.',
      voiceDropped: 'La conversa de veu s’ha tallat. Torna a començar o continua al xat.',
      ended: 'Conversa acabada. Torna a començar quan vulguis.',
      notSaved:
        'El teu compte de ReloCat no està connectat en aquest xat, de manera que les teves respostes es queden en aquesta targeta i no es desen. Connecta ReloCat a ChatGPT per desar-les.',
      noTools:
        'Aquesta targeta no pot accedir a les eines de ReloCat aquí, de manera que les teves respostes es queden en aquesta targeta i no mostra cap pla. Continua al xat per tenir-ne un.',
      savedToProfile: 'Cada resposta que confirmes es desa al teu perfil de ReloCat.',
      planHeading: 'El teu pla fins ara',
      workspaceMessage: 'Fes servir ReloCat per mostrar el meu espai de treball per a {towns}.',
      workspaceMessageNoTowns: 'Fes servir ReloCat per mostrar el meu espai de treball.',
      workspaceSent: 'Demanat al xat. L’espai de treball apareix allà.',
    },
    es: {
      title: 'Entrevista de compra de vivienda de ReloCat',
      heading: 'Tu entrevista de compra de vivienda',
      intro: 'Háblalo aquí mismo, en esta tarjeta. ReloCat hace una pregunta cada vez.',
      ready: 'Cuando quieras. Se te pedirá el micrófono al empezar.',
      voiceNote: 'La voz usa tu micrófono y envía lo que dices a OpenAI.',
      continueInChat: 'Sigue en el chat',
      startMessage: 'Empieza mi entrevista de compra de vivienda con ReloCat: hazme la primera pregunta.',
      sent: 'Enviado. La entrevista sigue en este chat.',
      typeIt: 'Escribe esto en el chat: «{message}»',
      typeInstead: 'Responde por escrito',
      typing: 'Escribe tu respuesta abajo. ReloCat responde en voz alta y por escrito.',
      micRefused:
        'No se ha permitido el micrófono, así que ReloCat no puede oírte aquí. Responde por escrito o sigue en el chat.',
      micUnavailable: 'Esta aplicación no da micrófono a la tarjeta. Responde por escrito o sigue en el chat.',
      voiceUnavailable: 'La voz no puede funcionar en esta aplicación. Sigue en el chat.',
      voiceRefused: 'La voz todavía no está abierta para esta aplicación. Sigue en el chat.',
      voiceBusy: 'Ahora mismo hay demasiadas conversaciones de voz. Inténtalo de nuevo más tarde o sigue en el chat.',
      voiceOff: 'La voz no está configurada en este servidor de ReloCat. Sigue en el chat.',
      voiceNetwork: 'La voz no se ha podido conectar. Inténtalo de nuevo o sigue en el chat.',
      voiceDropped: 'La conversación de voz se ha cortado. Empieza de nuevo o sigue en el chat.',
      ended: 'Conversación terminada. Empieza de nuevo cuando quieras.',
      notSaved:
        'Tu cuenta de ReloCat no está conectada en este chat, así que tus respuestas se quedan en esta tarjeta y no se guardan. Conecta ReloCat en ChatGPT para guardarlas.',
      noTools:
        'Esta tarjeta no puede acceder a las herramientas de ReloCat aquí, así que tus respuestas se quedan en esta tarjeta y no muestra ningún plan. Sigue en el chat para tener uno.',
      savedToProfile: 'Cada respuesta que confirmas se guarda en tu perfil de ReloCat.',
      planHeading: 'Tu plan hasta ahora',
      workspaceMessage: 'Usa ReloCat para mostrar mi espacio de trabajo para {towns}.',
      workspaceMessageNoTowns: 'Usa ReloCat para mostrar mi espacio de trabajo.',
      workspaceSent: 'Pedido en el chat. El espacio de trabajo aparece allí.',
    },
  },
);
