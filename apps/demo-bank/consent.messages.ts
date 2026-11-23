import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * Banc Demo's consent page. The bank is a fictional brand of its own, and every language says so
 * as plainly as the English: "fictional", "invented" and "no real account" stay.
 */
export const consentPageMessages = defineMessages(
  {
    title: 'Banc Demo · allow access',
    fictionalBank: 'Fictional bank',
    question: 'Allow ReloCat to read the accounts of a customer?',
    asks: 'The application at <strong>{host}</strong> asks to read the accounts, balances and movements of the customer you choose. It cannot move money: Banc Demo has no payments at all.',
    youAre: 'You are',
    fictionalNote:
      'A real bank would ask you to sign in and confirm with a second factor here. Banc Demo is fictional: it has no logins, its customers are invented and so is every movement. Nothing on this page concerns a real account.',
    allow: 'Allow for {days} days',
    deny: 'Deny access',
    after: 'After you choose, you return to {host}.',
  },
  {
    ca: {
      title: 'Banc Demo · permet l’accés',
      fictionalBank: 'Banc fictici',
      question: 'Vols permetre que ReloCat llegeixi els comptes d’un client?',
      asks: 'L’aplicació de <strong>{host}</strong> demana llegir els comptes, els saldos i els moviments del client que triïs. No pot moure diners: Banc Demo no té cap mena de pagaments.',
      youAre: 'Ets',
      fictionalNote:
        'Un banc real et demanaria aquí que iniciessis la sessió i ho confirmessis amb un segon factor. Banc Demo és fictici: no té inicis de sessió, els seus clients són inventats i tots els moviments també. Res d’aquesta pàgina afecta cap compte real.',
      allow: 'Permet durant {days, plural, one {# dia} other {# dies}}',
      deny: 'Denega l’accés',
      after: 'Després de triar, tornes a {host}.',
    },
    es: {
      title: 'Banc Demo · permite el acceso',
      fictionalBank: 'Banco ficticio',
      question: '¿Quieres permitir que ReloCat lea las cuentas de un cliente?',
      asks: 'La aplicación de <strong>{host}</strong> pide leer las cuentas, los saldos y los movimientos del cliente que elijas. No puede mover dinero: Banc Demo no tiene ningún tipo de pagos.',
      youAre: 'Eres',
      fictionalNote:
        'Un banco real te pediría aquí que iniciaras sesión y lo confirmaras con un segundo factor. Banc Demo es ficticio: no tiene inicios de sesión, sus clientes son inventados y todos los movimientos también. Nada de esta página afecta a ninguna cuenta real.',
      allow: 'Permite durante {days, plural, one {# día} other {# días}}',
      deny: 'Deniega el acceso',
      after: 'Después de elegir, vuelves a {host}.',
    },
  },
);
