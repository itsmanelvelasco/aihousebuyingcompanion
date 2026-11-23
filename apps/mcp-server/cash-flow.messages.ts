import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * The sample cash-flow card. `cash-flow-widget.html` is a static file with no build step, so it
 * carries a copy of this catalog as JSON in its script (`const messages = …`);
 * `tests/i18n-pages.test.ts` fails when the copy and this file differ. After a change here, paste
 * `JSON.stringify(cashFlow)` over that line.
 */
export const cashFlow = defineMessages(
  {
    title: 'Sample cash flow',
    heading: 'Sample monthly cash flow',
    fictional: 'Fictional data',
    loading: 'Loading fictional transaction summary…',
    coverage: '{count, plural, one {# month of fictional transactions} other {# months of fictional transactions}}',
    salary: 'Estimated salary',
    spending: 'Average spending',
    net: 'Net cash flow',
    breakdown: 'Spending by category',
    rent: 'Housing (rent)',
    eatingOut: 'Restaurants and takeout',
    unidentified: 'Unidentified',
    unavailable: 'Cash flow preview is unavailable.',
    language: 'Language',
  },
  {
    ca: {
      title: 'Flux de caixa de mostra',
      heading: 'Flux de caixa mensual de mostra',
      fictional: 'Dades fictícies',
      loading: 'S’està carregant el resum de moviments ficticis…',
      coverage: '{count, plural, one {# mes de moviments ficticis} other {# mesos de moviments ficticis}}',
      salary: 'Sou estimat',
      spending: 'Despesa mitjana',
      net: 'Flux de caixa net',
      breakdown: 'Despeses per categoria',
      rent: 'Habitatge (lloguer)',
      eatingOut: 'Restaurants i menjar per emportar',
      unidentified: 'Sense identificar',
      unavailable: 'La previsualització del flux de caixa no està disponible.',
      language: 'Idioma',
    },
    es: {
      title: 'Flujo de caja de muestra',
      heading: 'Flujo de caja mensual de muestra',
      fictional: 'Datos ficticios',
      loading: 'Cargando el resumen de movimientos ficticios…',
      coverage: '{count, plural, one {# mes de movimientos ficticios} other {# meses de movimientos ficticios}}',
      salary: 'Salario estimado',
      spending: 'Gasto medio',
      net: 'Flujo de caja neto',
      breakdown: 'Gastos por categoría',
      rent: 'Vivienda (alquiler)',
      eatingOut: 'Restaurantes y comida para llevar',
      unidentified: 'Sin identificar',
      unavailable: 'La vista previa del flujo de caja no está disponible.',
      language: 'Idioma',
    },
  },
);
