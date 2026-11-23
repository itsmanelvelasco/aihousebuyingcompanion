import { defineMessages } from './messages.ts';

/**
 * Words every surface shares: units, the unknown state, the language switcher and the product's
 * standing disclaimers. Anything said on one surface only belongs in that surface's own catalog.
 */
export const common = defineMessages(
  {
    unknown: 'Unknown',
    perMonth: '{amount}/month',
    months: '{count, plural, one {# month} other {# months}}',
    years: '{count, plural, one {# year} other {# years}}',
    yearsAndMonths: '{years} {months}',
    monthsShort: '{count} mo',
    yearsShort: '{count} y',
    noFiniteTimeline: 'No finite timeline',
    alreadyReached: 'Already reached',
    noTimeline: 'No timeline',
    reached: 'Reached',
    language: 'Language',
    signIn: 'Sign in',
    signOut: 'Sign out',
    createAccount: 'Create account',
    tryAgain: 'Try again',
    cancel: 'Cancel',
    syntheticData: 'Synthetic data',
    fictionalDemo: 'Fictional demo data',
    upfrontCashOnly:
      'ReloCat estimates upfront cash only. It does not assess a mortgage, and aid is never guaranteed until the administration confirms it.',
  },
  {
    ca: {
      unknown: 'Desconegut',
      perMonth: '{amount}/mes',
      months: '{count, plural, one {# mes} other {# mesos}}',
      years: '{count, plural, one {# any} other {# anys}}',
      yearsAndMonths: '{years} i {months}',
      monthsShort: '{count} m',
      yearsShort: '{count} a',
      noFiniteTimeline: 'Sense termini finit',
      alreadyReached: 'Ja assolit',
      noTimeline: 'Sense termini',
      reached: 'Assolit',
      language: 'Idioma',
      signIn: 'Inicia la sessió',
      signOut: 'Tanca la sessió',
      createAccount: 'Crea un compte',
      tryAgain: 'Torna-ho a provar',
      cancel: 'Cancel·la',
      syntheticData: 'Dades sintètiques',
      fictionalDemo: 'Dades de demostració fictícies',
      upfrontCashOnly:
        'ReloCat només estima els diners inicials. No avalua cap hipoteca, i cap ajut està garantit fins que l’administració el confirma.',
    },
    es: {
      unknown: 'Desconocido',
      perMonth: '{amount}/mes',
      months: '{count, plural, one {# mes} other {# meses}}',
      years: '{count, plural, one {# año} other {# años}}',
      yearsAndMonths: '{years} y {months}',
      monthsShort: '{count} m',
      yearsShort: '{count} a',
      noFiniteTimeline: 'Sin plazo finito',
      alreadyReached: 'Ya alcanzado',
      noTimeline: 'Sin plazo',
      reached: 'Alcanzado',
      language: 'Idioma',
      signIn: 'Iniciar sesión',
      signOut: 'Cerrar sesión',
      createAccount: 'Crear cuenta',
      tryAgain: 'Reintentar',
      cancel: 'Cancelar',
      syntheticData: 'Datos sintéticos',
      fictionalDemo: 'Datos de demostración ficticios',
      upfrontCashOnly:
        'ReloCat solo estima el dinero inicial. No evalúa ninguna hipoteca, y ninguna ayuda está garantizada hasta que la administración la confirma.',
    },
  },
);
