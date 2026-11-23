import type { AuthErrorCode } from '../../packages/auth/accounts.ts';
import { defaultLocale, type Locale } from '../../packages/i18n/locales.ts';
import { defineMessages, formatMessage } from '../../packages/i18n/messages.ts';

/** What the account page says after a redirect back to it, by the `done` code of the redirect. */
export const noticeMessages = defineMessages(
  {
    disconnected: 'Access removed.',
    password: 'Your password was changed. Every other browser was signed out and every assistant was disconnected.',
    'bank-connected': 'Your bank is connected.',
    'bank-renewed': 'Your consent at the bank was renewed.',
    'bank-denied': 'You did not allow access at the bank. Nothing was connected.',
    'bank-disconnected': 'The bank was disconnected and its stored credential deleted. Movements already fetched stay.',
    synced: 'Your bank data is up to date.',
    imported: 'The statement was imported.',
    discarded: 'The statement was discarded. Nothing was saved.',
    'import-deleted': 'The statement and the movements only it brought were deleted.',
    category: 'The category was saved.',
    'movement-deleted': 'The movement was deleted.',
  },
  {
    ca: {
      disconnected: 'S’ha tret l’accés.',
      password:
        'S’ha canviat la teva contrasenya. S’ha tancat la sessió a tots els altres navegadors i s’han desconnectat tots els assistents.',
      'bank-connected': 'El teu banc està connectat.',
      'bank-renewed': 'S’ha renovat el teu consentiment al banc.',
      'bank-denied': 'No has permès l’accés al banc. No s’ha connectat res.',
      'bank-disconnected':
        'S’ha desconnectat el banc i s’ha esborrat la seva credencial desada. Els moviments ja obtinguts es mantenen.',
      synced: 'Les teves dades bancàries estan al dia.',
      imported: 'S’ha importat l’extracte.',
      discarded: 'S’ha descartat l’extracte. No s’ha desat res.',
      'import-deleted': 'S’han esborrat l’extracte i els moviments que només ell havia portat.',
      category: 'S’ha desat la categoria.',
      'movement-deleted': 'S’ha esborrat el moviment.',
    },
    es: {
      disconnected: 'Se ha quitado el acceso.',
      password:
        'Se ha cambiado tu contraseña. Se ha cerrado la sesión en todos los demás navegadores y se han desconectado todos los asistentes.',
      'bank-connected': 'Tu banco está conectado.',
      'bank-renewed': 'Se ha renovado tu consentimiento en el banco.',
      'bank-denied': 'No has permitido el acceso en el banco. No se ha conectado nada.',
      'bank-disconnected':
        'Se ha desconectado el banco y se ha borrado su credencial guardada. Los movimientos ya obtenidos se mantienen.',
      synced: 'Tus datos bancarios están al día.',
      imported: 'Se ha importado el extracto.',
      discarded: 'Se ha descartado el extracto. No se ha guardado nada.',
      'import-deleted': 'Se han borrado el extracto y los movimientos que solo él había traído.',
      category: 'Se ha guardado la categoría.',
      'movement-deleted': 'Se ha borrado el movimiento.',
    },
  },
);

/** Titles and refusals worded by the account routes themselves. */
export const routeMessages = defineMessages(
  {
    proxyHost:
      'This server is behind a proxy that does not pass the original Host header, so it cannot check where this form came from. The operator must configure the proxy to preserve Host.',
    otherSite: 'This form was sent from another site.',
    formExpired: 'This form expired. Go back, reload the page and try again.',
    methodNotAllowed: 'Method not allowed',
    notFound: 'Not found',
    bankNotConnectedTitle: 'Your bank was not connected',
    bankCannotConnect: 'This bank cannot be connected here.',
    bankFetchFailed: 'The bank could not be fetched: {error}',
    statementTooLarge: 'The statement is larger than 256 KiB.',
    chooseCsv: 'Choose a CSV file first.',
    didNotWork: 'That did not work. Check what you entered and try again.',
    cannotContinueTitle: 'This connection cannot continue',
    signUpsClosed: 'New accounts are closed on this server.',
    somethingWrong: 'Something went wrong. Try again.',
    tickToConfirm: 'Tick the box to confirm the deletion.',
    accountNotDeleted: 'The account could not be deleted.',
    deletedTitle: 'Your account was deleted',
    deletedMessage: 'Your account, your answers and every connection were removed from ReloCat.',
    didNotWorkTitle: 'That did not work',
    wrongTitle: 'Something went wrong',
    tryInAMoment: 'Try again in a moment.',
    busyTitle: 'ReloCat is busy',
    busyMessage: 'Nothing was changed. Wait a moment and try again.',
  },
  {
    ca: {
      proxyHost:
        'Aquest servidor és darrere d’un servidor intermediari que no transmet la capçalera Host original, i per això no pot comprovar d’on ve aquest formulari. L’operador ha de configurar el servidor intermediari perquè conservi Host.',
      otherSite: 'Aquest formulari s’ha enviat des d’un altre lloc web.',
      formExpired: 'Aquest formulari ha caducat. Torna enrere, recarrega la pàgina i torna-ho a provar.',
      methodNotAllowed: 'Mètode no permès',
      notFound: 'No s’ha trobat',
      bankNotConnectedTitle: 'El teu banc no s’ha connectat',
      bankCannotConnect: 'Aquest banc no es pot connectar aquí.',
      bankFetchFailed: 'No s’han pogut obtenir les dades del banc: {error}',
      statementTooLarge: 'L’extracte fa més de 256 KiB.',
      chooseCsv: 'Primer tria un fitxer CSV.',
      didNotWork: 'No ha funcionat. Revisa el que has introduït i torna-ho a provar.',
      cannotContinueTitle: 'Aquesta connexió no pot continuar',
      signUpsClosed: 'En aquest servidor no es poden crear comptes nous.',
      somethingWrong: 'Alguna cosa ha anat malament. Torna-ho a provar.',
      tickToConfirm: 'Marca la casella per confirmar l’esborrament.',
      accountNotDeleted: 'No s’ha pogut esborrar el compte.',
      deletedTitle: 'El teu compte s’ha esborrat',
      deletedMessage: 'El teu compte, les teves respostes i totes les connexions s’han eliminat de ReloCat.',
      didNotWorkTitle: 'No ha funcionat',
      wrongTitle: 'Alguna cosa ha anat malament',
      tryInAMoment: 'Torna-ho a provar d’aquí a un moment.',
      busyTitle: 'ReloCat està ocupat',
      busyMessage: 'No s’ha canviat res. Espera un moment i torna-ho a provar.',
    },
    es: {
      proxyHost:
        'Este servidor está detrás de un proxy que no transmite la cabecera Host original, y por eso no puede comprobar de dónde viene este formulario. El operador tiene que configurar el proxy para que conserve Host.',
      otherSite: 'Este formulario se ha enviado desde otro sitio web.',
      formExpired: 'Este formulario ha caducado. Vuelve atrás, recarga la página e inténtalo de nuevo.',
      methodNotAllowed: 'Método no permitido',
      notFound: 'No se ha encontrado',
      bankNotConnectedTitle: 'Tu banco no se ha conectado',
      bankCannotConnect: 'Este banco no se puede conectar aquí.',
      bankFetchFailed: 'No se han podido obtener los datos del banco: {error}',
      statementTooLarge: 'El extracto ocupa más de 256 KiB.',
      chooseCsv: 'Primero elige un archivo CSV.',
      didNotWork: 'No ha funcionado. Revisa lo que has introducido e inténtalo de nuevo.',
      cannotContinueTitle: 'Esta conexión no puede continuar',
      signUpsClosed: 'En este servidor no se pueden crear cuentas nuevas.',
      somethingWrong: 'Algo ha ido mal. Inténtalo de nuevo.',
      tickToConfirm: 'Marca la casilla para confirmar el borrado.',
      accountNotDeleted: 'No se ha podido borrar la cuenta.',
      deletedTitle: 'Tu cuenta se ha borrado',
      deletedMessage: 'Tu cuenta, tus respuestas y todas las conexiones se han eliminado de ReloCat.',
      didNotWorkTitle: 'No ha funcionado',
      wrongTitle: 'Algo ha ido mal',
      tryInAMoment: 'Inténtalo de nuevo en un momento.',
      busyTitle: 'ReloCat está ocupado',
      busyMessage: 'No se ha cambiado nada. Espera un momento e inténtalo de nuevo.',
    },
  },
);

/**
 * Refusals worded elsewhere (`packages/auth`, `packages/banks`, `packages/finance`,
 * `packages/http` and the profile API) that reach a person on an account page. The English text
 * here is the text those layers throw, with `{name}` where they insert a value: `localizeRefusal`
 * recognises a refusal by it. `tests/auth.test.ts` checks that every English text still exists in
 * the source it comes from. A refusal that is not listed is shown as it was thrown, in English.
 */
export const refusalMessages = defineMessages(
  {
    invalidEmail: 'Enter a valid email address.',
    passwordLength: 'Choose a password of {min} to {max} characters.',
    passwordIsEmail: 'The password must differ from the email.',
    emailTaken: 'An account with this email already exists. Sign in instead.',
    wrongLogin: 'The email or the password is not right.',
    wrongCurrentPassword: 'The current password is not right. Nothing was changed.',
    newPasswordLength: 'Choose a new password of {min} to {max} characters.',
    samePassword: 'The new password must differ from the current one.',
    wrongDeletePassword: 'The password is not right. Nothing was deleted.',
    throttled: 'Too many attempts. Wait a little and try again.',
    clientNotRegistered: 'This application is not registered with ReloCat.',
    returnAddressNotRegistered: 'The return address of this request is not registered for the application.',
    connectionNotFound: 'Bank connection not found',
    connectionLimit: 'Connection limit reached',
    syncShuttingDown: 'Bank sync is shutting down',
    connectedAtBank: 'This bank is connected by authorising access at the bank itself',
    operatorOnly: 'This bank can only be connected by the operator',
    notThroughConsent: 'This bank is not connected through a consent at the bank',
    noEncryptionKey: 'Bank connections are unavailable: the server has no data encryption key',
    authorisationNotStarted: 'The bank did not start the authorisation',
    authorisationInvalid: 'This bank authorisation is no longer valid. Start again from your account page.',
    authorisationSomebodyElse: 'This bank authorisation was started by somebody else or in another browser session.',
    connectionsUnavailable: 'Bank connections are unavailable right now',
    authorisationNotConfirmed: 'The bank did not confirm the authorisation',
    consentAlreadyExpired: 'The bank returned a consent that has already expired',
    bankLoginTaken: 'This bank login is already connected to a ReloCat account',
    unknownProvider: 'Unknown bank provider: {provider}',
    movementNotFound: 'Movement not found',
    categoryForMoneyIn: 'Money that came in can be income, other or a transfer between your own accounts',
    categoryForMoneyOut:
      'Money that went out cannot be income; choose a spending category, other or a transfer between your own accounts',
    onlyImportedDeleted:
      'Only movements you imported yourself can be deleted. A bank movement would come back with the next sync; change its category instead.',
    importLimit: 'Import limit reached: delete a statement you no longer need (maximum {max})',
    accountLimit: 'Account limit reached',
    importNotFound: 'Import not found',
    statementEmpty: 'The statement is empty',
    statementTooLarge: 'The statement is larger than {size} KiB',
    statementUnreadable: 'The statement could not be read',
    statementTooManyRows: 'The statement has more than {rows} rows; split it by period',
    statementNoAmount: 'The statement has no row with an amount',
    noPreviewWaiting:
      'There is no statement waiting under this preview hash. Preview the statement again, review the summary, then confirm.',
    previewMismatch: 'The preview does not match',
    csvUnfinishedQuote: 'The CSV has an unfinished quoted field.',
    csvColumns: 'Use a CSV with date, description, and amount columns and at least one transaction.',
    csvInvalidRow: 'Invalid transaction on data row {row}. Use YYYY-MM-DD dates and signed amounts.',
    formBodyExpected: 'Expected a form body',
    fileFormExpected: 'Expected a form with a file',
    malformedForm: 'Malformed form body',
    bodyTooLarge: 'Request body is too large',
    tooManyFields: 'Too many form fields',
  },
  {
    ca: {
      invalidEmail: 'Introdueix una adreça de correu electrònic vàlida.',
      passwordLength: 'Tria una contrasenya d’entre {min} i {max} caràcters.',
      passwordIsEmail: 'La contrasenya ha de ser diferent del correu electrònic.',
      emailTaken: 'Ja hi ha un compte amb aquest correu electrònic. Inicia la sessió.',
      wrongLogin: 'El correu electrònic o la contrasenya no són correctes.',
      wrongCurrentPassword: 'La contrasenya actual no és correcta. No s’ha canviat res.',
      newPasswordLength: 'Tria una contrasenya nova d’entre {min} i {max} caràcters.',
      samePassword: 'La contrasenya nova ha de ser diferent de l’actual.',
      wrongDeletePassword: 'La contrasenya no és correcta. No s’ha esborrat res.',
      throttled: 'Massa intents. Espera una mica i torna-ho a provar.',
      clientNotRegistered: 'Aquesta aplicació no està registrada a ReloCat.',
      returnAddressNotRegistered: 'L’adreça de retorn d’aquesta sol·licitud no està registrada per a l’aplicació.',
      connectionNotFound: 'No s’ha trobat la connexió bancària',
      connectionLimit: 'S’ha arribat al límit de connexions',
      syncShuttingDown: 'La sincronització bancària s’està aturant',
      connectedAtBank: 'Aquest banc es connecta autoritzant l’accés al mateix banc',
      operatorOnly: 'Aquest banc només el pot connectar l’operador',
      notThroughConsent: 'Aquest banc no es connecta amb un consentiment al banc',
      noEncryptionKey: 'Les connexions bancàries no estan disponibles: el servidor no té clau de xifratge de dades',
      authorisationNotStarted: 'El banc no ha iniciat l’autorització',
      authorisationInvalid:
        'Aquesta autorització bancària ja no és vàlida. Torna a començar des de la pàgina del teu compte.',
      authorisationSomebodyElse:
        'Aquesta autorització bancària la va iniciar una altra persona o es va iniciar en una altra sessió del navegador.',
      connectionsUnavailable: 'Les connexions bancàries no estan disponibles ara mateix',
      authorisationNotConfirmed: 'El banc no ha confirmat l’autorització',
      consentAlreadyExpired: 'El banc ha retornat un consentiment que ja ha caducat',
      bankLoginTaken: 'Aquest accés bancari ja està connectat a un compte de ReloCat',
      unknownProvider: 'Proveïdor bancari desconegut: {provider}',
      movementNotFound: 'No s’ha trobat el moviment',
      categoryForMoneyIn:
        'Els diners que han entrat poden ser ingressos, altres o una transferència entre els teus propis comptes',
      categoryForMoneyOut:
        'Els diners que han sortit no poden ser ingressos; tria una categoria de despesa, altres o una transferència entre els teus propis comptes',
      onlyImportedDeleted:
        'Només es poden esborrar els moviments que has importat tu. Un moviment del banc tornaria amb la propera sincronització; canvia’n la categoria.',
      importLimit: 'S’ha arribat al límit d’importacions: esborra un extracte que ja no necessitis (màxim {max})',
      accountLimit: 'S’ha arribat al límit de comptes',
      importNotFound: 'No s’ha trobat la importació',
      statementEmpty: 'L’extracte és buit',
      statementTooLarge: 'L’extracte fa més de {size} KiB',
      statementUnreadable: 'No s’ha pogut llegir l’extracte',
      statementTooManyRows: 'L’extracte té més de {rows} files; divideix-lo per períodes',
      statementNoAmount: 'L’extracte no té cap fila amb import',
      noPreviewWaiting:
        'No hi ha cap extracte pendent amb aquest codi de previsualització. Torna a previsualitzar l’extracte, revisa’n el resum i després confirma.',
      previewMismatch: 'La previsualització no coincideix',
      csvUnfinishedQuote: 'El CSV té un camp entre cometes sense tancar.',
      csvColumns: 'Fes servir un CSV amb les columnes date, description i amount i almenys un moviment.',
      csvInvalidRow: 'Moviment no vàlid a la fila de dades {row}. Fes servir dates AAAA-MM-DD i imports amb signe.',
      formBodyExpected: 'S’esperava el cos d’un formulari',
      fileFormExpected: 'S’esperava un formulari amb un fitxer',
      malformedForm: 'El cos del formulari no és vàlid',
      bodyTooLarge: 'El cos de la sol·licitud és massa gran',
      tooManyFields: 'El formulari té massa camps',
    },
    es: {
      invalidEmail: 'Introduce una dirección de correo electrónico válida.',
      passwordLength: 'Elige una contraseña de entre {min} y {max} caracteres.',
      passwordIsEmail: 'La contraseña tiene que ser distinta del correo electrónico.',
      emailTaken: 'Ya existe una cuenta con este correo electrónico. Inicia sesión.',
      wrongLogin: 'El correo electrónico o la contraseña no son correctos.',
      wrongCurrentPassword: 'La contraseña actual no es correcta. No se ha cambiado nada.',
      newPasswordLength: 'Elige una contraseña nueva de entre {min} y {max} caracteres.',
      samePassword: 'La contraseña nueva tiene que ser distinta de la actual.',
      wrongDeletePassword: 'La contraseña no es correcta. No se ha borrado nada.',
      throttled: 'Demasiados intentos. Espera un poco e inténtalo de nuevo.',
      clientNotRegistered: 'Esta aplicación no está registrada en ReloCat.',
      returnAddressNotRegistered: 'La dirección de retorno de esta solicitud no está registrada para la aplicación.',
      connectionNotFound: 'No se ha encontrado la conexión bancaria',
      connectionLimit: 'Se ha alcanzado el límite de conexiones',
      syncShuttingDown: 'La sincronización bancaria se está deteniendo',
      connectedAtBank: 'Este banco se conecta autorizando el acceso en el propio banco',
      operatorOnly: 'Este banco solo lo puede conectar el operador',
      notThroughConsent: 'Este banco no se conecta con un consentimiento en el banco',
      noEncryptionKey: 'Las conexiones bancarias no están disponibles: el servidor no tiene clave de cifrado de datos',
      authorisationNotStarted: 'El banco no ha iniciado la autorización',
      authorisationInvalid:
        'Esta autorización bancaria ya no es válida. Vuelve a empezar desde la página de tu cuenta.',
      authorisationSomebodyElse:
        'Esta autorización bancaria la inició otra persona o se inició en otra sesión del navegador.',
      connectionsUnavailable: 'Las conexiones bancarias no están disponibles ahora mismo',
      authorisationNotConfirmed: 'El banco no ha confirmado la autorización',
      consentAlreadyExpired: 'El banco ha devuelto un consentimiento que ya ha caducado',
      bankLoginTaken: 'Este acceso bancario ya está conectado a una cuenta de ReloCat',
      unknownProvider: 'Proveedor bancario desconocido: {provider}',
      movementNotFound: 'No se ha encontrado el movimiento',
      categoryForMoneyIn:
        'El dinero que ha entrado puede ser ingresos, otros o una transferencia entre tus propias cuentas',
      categoryForMoneyOut:
        'El dinero que ha salido no puede ser ingresos; elige una categoría de gasto, otros o una transferencia entre tus propias cuentas',
      onlyImportedDeleted:
        'Solo se pueden borrar los movimientos que has importado tú. Un movimiento del banco volvería con la siguiente sincronización; cambia su categoría.',
      importLimit: 'Se ha alcanzado el límite de importaciones: borra un extracto que ya no necesites (máximo {max})',
      accountLimit: 'Se ha alcanzado el límite de cuentas',
      importNotFound: 'No se ha encontrado la importación',
      statementEmpty: 'El extracto está vacío',
      statementTooLarge: 'El extracto ocupa más de {size} KiB',
      statementUnreadable: 'No se ha podido leer el extracto',
      statementTooManyRows: 'El extracto tiene más de {rows} filas; divídelo por periodos',
      statementNoAmount: 'El extracto no tiene ninguna fila con importe',
      noPreviewWaiting:
        'No hay ningún extracto pendiente con este código de vista previa. Vuelve a previsualizar el extracto, revisa su resumen y después confirma.',
      previewMismatch: 'La vista previa no coincide',
      csvUnfinishedQuote: 'El CSV tiene un campo entre comillas sin cerrar.',
      csvColumns: 'Usa un CSV con las columnas date, description y amount y al menos un movimiento.',
      csvInvalidRow: 'Movimiento no válido en la fila de datos {row}. Usa fechas AAAA-MM-DD e importes con signo.',
      formBodyExpected: 'Se esperaba el cuerpo de un formulario',
      fileFormExpected: 'Se esperaba un formulario con un archivo',
      malformedForm: 'El cuerpo del formulario no es válido',
      bodyTooLarge: 'El cuerpo de la solicitud es demasiado grande',
      tooManyFields: 'El formulario tiene demasiados campos',
    },
  },
);

type RefusalKey = keyof typeof refusalMessages.en;

/** What an account refusal says when its exact wording is not listed: one message per error code. */
const refusalOfCode: Partial<Record<AuthErrorCode, RefusalKey>> = {
  invalid_email: 'invalidEmail',
  email_taken: 'emailTaken',
  throttled: 'throttled',
};

/** Each English refusal as a pattern: its text with a capture where a value goes. */
const refusalPatterns = (Object.entries(refusalMessages.en) as [RefusalKey, string][]).map(([key, english]) => {
  const names: string[] = [];
  const source = english
    .split(/\{(\w+)\}/)
    .map((part, index) => {
      if (index % 2 === 0) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(part);
      return '(.{1,200}?)';
    })
    .join('');
  return { key, names, pattern: new RegExp(`^${source}$`, 's') };
});

/**
 * A refusal in the person's language. English is returned untouched, and so is a refusal this
 * catalog does not know: the text is then what the layer that refused wrote. `code` is the
 * `AuthError` code, used when the wording itself is not recognised.
 */
export function localizeRefusal(message: string, locale: Locale, code?: AuthErrorCode): string {
  if (locale === defaultLocale) return message;
  for (const { key, names, pattern } of refusalPatterns) {
    const match = pattern.exec(message);
    if (!match) continue;
    const values = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
    return formatMessage(refusalMessages[locale][key], values, locale);
  }
  const byCode = code ? refusalOfCode[code] : undefined;
  return byCode ? formatMessage(refusalMessages[locale][byCode], {}, locale) : message;
}
