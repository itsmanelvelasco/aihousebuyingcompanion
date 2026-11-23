import { defineMessages } from '../../../packages/i18n/messages.ts';

/** Failed tool calls: the reason the workspace gives when the server gave none of its own. */
export const errorMessages = defineMessages(
  {
    toolUnavailable: 'This server does not offer the {tool} tool yet.',
    toolFailed: 'The {tool} tool returned an error.',
    toolInvalid: 'The {tool} tool answered in a shape this workspace cannot read.',
    toolUnreachable: 'The {tool} tool could not be reached.',
    signInToContinue: 'Sign in to continue.',
    httpStatus: 'The MCP endpoint answered with HTTP {status}.',
    notJson: 'The MCP endpoint did not answer with JSON.',
    municipalitiesFailed: 'The list of municipalities did not load.',
    titleUnavailable: 'Not available on this server',
    titleFailed: 'The request failed',
    titleInvalid: 'Unreadable answer',
    titleSignin: 'Sign in needed',
  },
  {
    ca: {
      toolUnavailable: 'Aquest servidor encara no ofereix l’eina {tool}.',
      toolFailed: 'L’eina {tool} ha retornat un error.',
      toolInvalid: 'L’eina {tool} ha respost amb una forma que aquest espai de treball no sap llegir.',
      toolUnreachable: 'No s’ha pogut contactar amb l’eina {tool}.',
      signInToContinue: 'Inicia la sessió per continuar.',
      httpStatus: 'El punt d’accés MCP ha respost amb HTTP {status}.',
      notJson: 'El punt d’accés MCP no ha respost amb JSON.',
      municipalitiesFailed: 'La llista de municipis no s’ha carregat.',
      titleUnavailable: 'No disponible en aquest servidor',
      titleFailed: 'La petició ha fallat',
      titleInvalid: 'Resposta il·legible',
      titleSignin: 'Cal iniciar la sessió',
    },
    es: {
      toolUnavailable: 'Este servidor todavía no ofrece la herramienta {tool}.',
      toolFailed: 'La herramienta {tool} ha devuelto un error.',
      toolInvalid: 'La herramienta {tool} ha respondido con una forma que este espacio de trabajo no sabe leer.',
      toolUnreachable: 'No se ha podido contactar con la herramienta {tool}.',
      signInToContinue: 'Inicia sesión para continuar.',
      httpStatus: 'El punto de acceso MCP ha respondido con HTTP {status}.',
      notJson: 'El punto de acceso MCP no ha respondido con JSON.',
      municipalitiesFailed: 'La lista de municipios no se ha cargado.',
      titleUnavailable: 'No disponible en este servidor',
      titleFailed: 'La petición ha fallado',
      titleInvalid: 'Respuesta ilegible',
      titleSignin: 'Hay que iniciar sesión',
    },
  },
);
