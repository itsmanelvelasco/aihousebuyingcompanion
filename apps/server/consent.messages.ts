import type { Scope } from '../../packages/auth/oauth.ts';
import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * The OAuth consent screen: a person grants an assistant access here, so every sentence says
 * exactly what the English says, no more and no less. The English scope texts are the ones in
 * `packages/auth/oauth.ts` (`tests/auth.test.ts` checks they stay equal).
 */
export const consentMessages = defineMessages(
  {
    title: 'Connect an application',
    heading: 'Connect {client}?',
    signedInAs: 'Signed in as <strong>{email}</strong>.',
    wants: '<strong>{client}</strong> wants to use ReloCat for you. It will be able to:',
    scopePersonRead: 'Read your household, finances, bank summary and habits',
    scopePersonWrite: 'Save answers and details to your profile',
    scopeBankManage:
      'Manage your bank data for you: start connecting a bank (you still approve at the bank yourself), disconnect one, fetch new movements, import a bank statement after giving you its summary, and delete a statement you imported. It gets totals and states, never your individual movements, and it cannot move money',
    bankNote:
      'About your bank data: this application may start a bank connection, but a bank is only connected after you approve on the bank’s own page yourself. It may import a statement you give it, after telling you what the statement contains. It receives totals, balances and the state of your connections, not your individual movements, and nothing it can do moves money.',
    limits:
      'It cannot see your password, and it cannot reach anybody else’s data. The name above was supplied by the application and is not verified by ReloCat. After you choose, you return to <strong>{host}</strong>.',
    local:
      'This application runs on your own device (a local address). Allow it only if you started this connection yourself.',
    allow: 'Allow access',
    deny: 'Deny access',
    removable: 'You can remove this access at any time on your account page.',
  },
  {
    ca: {
      title: 'Connecta una aplicació',
      heading: 'Vols connectar {client}?',
      signedInAs: 'Has iniciat la sessió com a <strong>{email}</strong>.',
      wants: '<strong>{client}</strong> vol fer servir ReloCat en nom teu. Podrà:',
      scopePersonRead: 'Llegir les dades de la teva llar, les teves finances, el resum bancari i els teus hàbits',
      scopePersonWrite: 'Desar respostes i dades al teu perfil',
      scopeBankManage:
        'Gestionar les teves dades bancàries en nom teu: iniciar la connexió d’un banc (l’has d’aprovar igualment tu mateix al banc), desconnectar-ne un, obtenir moviments nous, importar un extracte bancari després de donar-te’n el resum, i esborrar un extracte que hagis importat. Rep totals i estats, mai els teus moviments individuals, i no pot moure diners',
      bankNote:
        'Sobre les teves dades bancàries: aquesta aplicació pot iniciar la connexió d’un banc, però un banc només queda connectat després que tu mateix ho aprovis a la pàgina del banc. Pot importar un extracte que tu li donis, després de dir-te què conté. Rep totals, saldos i l’estat de les teves connexions, no els teus moviments individuals, i res del que pot fer mou diners.',
      limits:
        'No pot veure la teva contrasenya i no pot accedir a les dades de ningú més. El nom de dalt l’ha facilitat l’aplicació i ReloCat no l’ha verificat. Després de triar, tornes a <strong>{host}</strong>.',
      local:
        'Aquesta aplicació s’executa al teu dispositiu (una adreça local). Permet-la només si has iniciat tu aquesta connexió.',
      allow: 'Permet l’accés',
      deny: 'Denega l’accés',
      removable: 'Pots treure aquest accés en qualsevol moment a la pàgina del teu compte.',
    },
    es: {
      title: 'Conecta una aplicación',
      heading: '¿Quieres conectar {client}?',
      signedInAs: 'Has iniciado sesión como <strong>{email}</strong>.',
      wants: '<strong>{client}</strong> quiere usar ReloCat en tu nombre. Podrá:',
      scopePersonRead: 'Leer los datos de tu hogar, tus finanzas, el resumen bancario y tus hábitos',
      scopePersonWrite: 'Guardar respuestas y datos en tu perfil',
      scopeBankManage:
        'Gestionar tus datos bancarios en tu nombre: iniciar la conexión de un banco (tienes que aprobarla igualmente tú mismo en el banco), desconectar uno, obtener movimientos nuevos, importar un extracto bancario después de darte su resumen, y borrar un extracto que hayas importado. Recibe totales y estados, nunca tus movimientos individuales, y no puede mover dinero',
      bankNote:
        'Sobre tus datos bancarios: esta aplicación puede iniciar la conexión de un banco, pero un banco solo queda conectado después de que tú mismo lo apruebes en la página del banco. Puede importar un extracto que tú le des, después de decirte qué contiene. Recibe totales, saldos y el estado de tus conexiones, no tus movimientos individuales, y nada de lo que puede hacer mueve dinero.',
      limits:
        'No puede ver tu contraseña y no puede acceder a los datos de nadie más. El nombre de arriba lo ha facilitado la aplicación y ReloCat no lo ha verificado. Después de elegir, vuelves a <strong>{host}</strong>.',
      local:
        'Esta aplicación se ejecuta en tu dispositivo (una dirección local). Permítela solo si has iniciado tú esta conexión.',
      allow: 'Permite el acceso',
      deny: 'Deniega el acceso',
      removable: 'Puedes quitar este acceso en cualquier momento en la página de tu cuenta.',
    },
  },
);

/** The message that says what a scope allows. */
export const scopeMessage = {
  'person:read': 'scopePersonRead',
  'person:write': 'scopePersonWrite',
  'bank:manage': 'scopeBankManage',
} as const satisfies Record<Scope, keyof typeof consentMessages.en>;
