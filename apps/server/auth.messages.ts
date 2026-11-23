import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * The page frame, sign-up, sign-in and sign-out. The words shared with every surface ("Sign in",
 * "Sign out", "Create account", "Cancel") come from `packages/i18n/common.ts`.
 *
 * `{link}` and `{endLink}` are the opening and closing tag of a link, filled in by the page.
 */
export const authMessages = defineMessages(
  {
    navLabel: 'Account',
    navAccount: 'Account',
    backToRelocat: 'Back to ReloCat',
    signUpHeading: 'Create your account',
    signUpClosed: 'New accounts are closed on this server.',
    signUpLede:
      'An account keeps your own answers and plans private to you, and lets ChatGPT or another assistant read and save them only when you allow it.',
    email: 'Email',
    password: 'Password',
    signUpPasswordHint:
      'At least {min} characters. There is no password reset yet: this server sends no email, so keep the password somewhere safe.',
    signUpHaveOne: 'Already have one? {link}Sign in{endLink}.',
    loginLede: 'Sign in to see and save your own plan.',
    loginNewHere:
      'New here? {link}Create an account{endLink}.\nThere is no password reset yet, because this server sends no email.',
    logoutQuestion:
      'Sign out of ReloCat in this browser? Assistants you connected keep their access until you remove them on the account page.',
  },
  {
    ca: {
      navLabel: 'Compte',
      navAccount: 'Compte',
      backToRelocat: 'Torna a ReloCat',
      signUpHeading: 'Crea el teu compte',
      signUpClosed: 'En aquest servidor no es poden crear comptes nous.',
      signUpLede:
        'Un compte manté les teves respostes i els teus plans privats, només per a tu, i permet que ChatGPT o un altre assistent els llegeixi i els desi només quan tu ho permets.',
      email: 'Correu electrònic',
      password: 'Contrasenya',
      signUpPasswordHint:
        'Com a mínim {min} caràcters. Encara no es pot restablir la contrasenya: aquest servidor no envia correus, així que desa-la en un lloc segur.',
      signUpHaveOne: 'Ja en tens un? {link}Inicia la sessió{endLink}.',
      loginLede: 'Inicia la sessió per veure i desar el teu pla.',
      loginNewHere:
        'És la primera vegada? {link}Crea un compte{endLink}.\nEncara no es pot restablir la contrasenya, perquè aquest servidor no envia correus.',
      logoutQuestion:
        'Vols tancar la sessió de ReloCat en aquest navegador? Els assistents que has connectat mantenen l’accés fins que els el treguis a la pàgina del compte.',
    },
    es: {
      navLabel: 'Cuenta',
      navAccount: 'Cuenta',
      backToRelocat: 'Vuelve a ReloCat',
      signUpHeading: 'Crea tu cuenta',
      signUpClosed: 'En este servidor no se pueden crear cuentas nuevas.',
      signUpLede:
        'Una cuenta mantiene tus respuestas y tus planes privados, solo para ti, y permite que ChatGPT u otro asistente los lea y los guarde solo cuando tú lo permites.',
      email: 'Correo electrónico',
      password: 'Contraseña',
      signUpPasswordHint:
        'Al menos {min} caracteres. Todavía no se puede restablecer la contraseña: este servidor no envía correos, así que guárdala en un lugar seguro.',
      signUpHaveOne: '¿Ya tienes una? {link}Inicia sesión{endLink}.',
      loginLede: 'Inicia sesión para ver y guardar tu plan.',
      loginNewHere:
        '¿Es tu primera vez? {link}Crea una cuenta{endLink}.\nTodavía no se puede restablecer la contraseña, porque este servidor no envía correos.',
      logoutQuestion:
        '¿Quieres cerrar la sesión de ReloCat en este navegador? Los asistentes que has conectado mantienen su acceso hasta que se lo quites en la página de la cuenta.',
    },
  },
);
