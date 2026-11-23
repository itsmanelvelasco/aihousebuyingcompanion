import { defineMessages } from '../../packages/i18n/messages.ts';

/** The account page: what is stored, connected assistants, the password and the deletion. */
export const accountMessages = defineMessages(
  {
    title: 'Your account',
    lede: 'Everything ReloCat stores about you, and who else may use it.',
    storedTitle: 'What is stored about you',
    created: 'Account created',
    lastSignIn: 'Last sign-in',
    recordId: 'Your record id',
    never: 'never',
    countInputs: 'Saved answer records',
    countBankAccounts: 'Bank accounts',
    countBankMovements: 'Bank movements',
    countBankConnections: 'Bank connections',
    countBankImports: 'Imported statements',
    countHabitGoals: 'Habit goals',
    countHabitCheckins: 'Habit check-ins',
    savedAnswers: 'Your saved answers ({count})',
    noAnswers: 'You have not saved any answers yet.',
    storageNote: 'Your password is stored only as a salted hash. Money is stored in whole cents.',
    openWorkspace: 'Open your workspace',
    download: 'Download everything as JSON',
    downloadNote:
      'The download holds every row stored about you, table by table. Hashes of your password and of tokens, and sealed bank credentials, are left out and named in the file.',
    clientsTitle: 'Connected assistants',
    clientConnected: 'Connected {date} · {scopes}',
    removeAccess: 'Remove access',
    removeAccessOf: 'Remove access of {client}',
    noClients:
      'No assistant or application is connected. Add ReloCat to ChatGPT or another MCP client and it will ask you here.',
    passwordTitle: 'Change your password',
    currentPassword: 'Current password',
    newPassword: 'New password',
    newPasswordHint:
      'At least {min} characters. Changing it signs you out of every other browser and disconnects every assistant; you stay signed in here.',
    changePassword: 'Change password',
    deleteTitle: 'Delete your account',
    deleteWarning:
      'This permanently deletes your account, your answers, your bank connections with their stored credentials, your movements and imported statements, habits and every connected assistant. It cannot be undone.',
    deleteConfirm: 'I understand that all my data will be deleted.',
    deleteButton: 'Delete my account and data',
  },
  {
    ca: {
      title: 'El teu compte',
      lede: 'Tot el que ReloCat desa sobre tu, i qui més ho pot fer servir.',
      storedTitle: 'Què es desa sobre tu',
      created: 'Compte creat',
      lastSignIn: 'Darrer inici de sessió',
      recordId: 'L’identificador del teu registre',
      never: 'mai',
      countInputs: 'Registres de respostes desades',
      countBankAccounts: 'Comptes bancaris',
      countBankMovements: 'Moviments bancaris',
      countBankConnections: 'Connexions bancàries',
      countBankImports: 'Extractes importats',
      countHabitGoals: 'Objectius d’hàbits',
      countHabitCheckins: 'Registres de seguiment d’hàbits',
      savedAnswers: 'Les teves respostes desades ({count})',
      noAnswers: 'Encara no has desat cap resposta.',
      storageNote: 'La teva contrasenya només es desa com a hash amb sal. Els diners es desen en cèntims enters.',
      openWorkspace: 'Obre el teu espai de treball',
      download: 'Baixa-ho tot en JSON',
      downloadNote:
        'La baixada conté totes les files desades sobre tu, taula per taula. Els hashs de la teva contrasenya i dels tokens, i les credencials bancàries xifrades, es deixen fora i el fitxer els anomena.',
      clientsTitle: 'Assistents connectats',
      clientConnected: 'Connectat el {date} · {scopes}',
      removeAccess: 'Treu l’accés',
      removeAccessOf: 'Treu l’accés de {client}',
      noClients:
        'No hi ha cap assistent ni cap aplicació connectats. Afegeix ReloCat a ChatGPT o a un altre client MCP i t’ho demanarà aquí.',
      passwordTitle: 'Canvia la teva contrasenya',
      currentPassword: 'Contrasenya actual',
      newPassword: 'Contrasenya nova',
      newPasswordHint:
        'Com a mínim {min} caràcters. Si la canvies, es tanca la sessió a tots els altres navegadors i es desconnecten tots els assistents; aquí continues amb la sessió iniciada.',
      changePassword: 'Canvia la contrasenya',
      deleteTitle: 'Esborra el teu compte',
      deleteWarning:
        'Això esborra per sempre el teu compte, les teves respostes, les teves connexions bancàries amb les credencials desades, els teus moviments i extractes importats, els hàbits i tots els assistents connectats. No es pot desfer.',
      deleteConfirm: 'Entenc que s’esborraran totes les meves dades.',
      deleteButton: 'Esborra el meu compte i les meves dades',
    },
    es: {
      title: 'Tu cuenta',
      lede: 'Todo lo que ReloCat guarda sobre ti, y quién más puede usarlo.',
      storedTitle: 'Qué se guarda sobre ti',
      created: 'Cuenta creada',
      lastSignIn: 'Último inicio de sesión',
      recordId: 'El identificador de tu registro',
      never: 'nunca',
      countInputs: 'Registros de respuestas guardadas',
      countBankAccounts: 'Cuentas bancarias',
      countBankMovements: 'Movimientos bancarios',
      countBankConnections: 'Conexiones bancarias',
      countBankImports: 'Extractos importados',
      countHabitGoals: 'Objetivos de hábitos',
      countHabitCheckins: 'Registros de seguimiento de hábitos',
      savedAnswers: 'Tus respuestas guardadas ({count})',
      noAnswers: 'Todavía no has guardado ninguna respuesta.',
      storageNote: 'Tu contraseña solo se guarda como hash con sal. El dinero se guarda en céntimos enteros.',
      openWorkspace: 'Abre tu espacio de trabajo',
      download: 'Descárgalo todo en JSON',
      downloadNote:
        'La descarga contiene todas las filas guardadas sobre ti, tabla por tabla. Los hashes de tu contraseña y de los tokens, y las credenciales bancarias cifradas, se dejan fuera y el archivo los nombra.',
      clientsTitle: 'Asistentes conectados',
      clientConnected: 'Conectado el {date} · {scopes}',
      removeAccess: 'Quita el acceso',
      removeAccessOf: 'Quita el acceso de {client}',
      noClients:
        'No hay ningún asistente ni ninguna aplicación conectados. Añade ReloCat a ChatGPT o a otro cliente MCP y te lo pedirá aquí.',
      passwordTitle: 'Cambia tu contraseña',
      currentPassword: 'Contraseña actual',
      newPassword: 'Contraseña nueva',
      newPasswordHint:
        'Al menos {min} caracteres. Al cambiarla se cierra la sesión en todos los demás navegadores y se desconectan todos los asistentes; aquí sigues con la sesión iniciada.',
      changePassword: 'Cambia la contraseña',
      deleteTitle: 'Borra tu cuenta',
      deleteWarning:
        'Esto borra para siempre tu cuenta, tus respuestas, tus conexiones bancarias con sus credenciales guardadas, tus movimientos y extractos importados, los hábitos y todos los asistentes conectados. No se puede deshacer.',
      deleteConfirm: 'Entiendo que se borrarán todos mis datos.',
      deleteButton: 'Borra mi cuenta y mis datos',
    },
  },
);

/** What `storedCounts` counts, as the catalog names it. */
export type StoredCountKey =
  | 'countInputs'
  | 'countBankAccounts'
  | 'countBankMovements'
  | 'countBankConnections'
  | 'countBankImports'
  | 'countHabitGoals'
  | 'countHabitCheckins';
