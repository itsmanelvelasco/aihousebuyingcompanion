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
  },
  {
    ca: {
      fiscalScreening:
        'L’elegibilitat és el resultat d’una comprovació basada en els fets declarats i en les regles oficials verificades en el conjunt de dades.',
      fiscalTaxDates:
        'Per a les mesures fiscals s’apliquen les dates de vigència de la mesura. L’estat de la convocatòria és desconegut perquè els beneficis fiscals no tenen un termini de sol·licitud com les subvencions.',
    },
    es: {
      fiscalScreening:
        'La elegibilidad es el resultado de una comprobación basada en los hechos declarados y en las reglas oficiales verificadas en el conjunto de datos.',
      fiscalTaxDates:
        'Para las medidas fiscales se aplican las fechas de vigencia de la medida. El estado de la convocatoria es desconocido porque los beneficios fiscales no tienen un plazo de solicitud como las subvenciones.',
    },
  },
);
