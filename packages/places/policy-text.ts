import type { Policy } from '../contracts/places.ts';
import { defaultLocale, type Locale } from '../i18n/locales.ts';

/**
 * The name and the explanation of each housing measure in Catalan and Spanish, keyed by policy id.
 *
 * English is the text of the policy data itself (`data/incentives.json`) and is never copied here,
 * so this is not a `defineMessages` catalog: a measure without a translation is shown in English.
 * `tests/i18n-domain.test.ts` fails when a policy id of the data has no Catalan or Spanish text, or
 * when its notes do not match the data one for one, so a new or edited measure cannot ship
 * untranslated without anybody noticing.
 *
 * These texts state tax and aid conditions. They are translated sentence for sentence, with the
 * same force ("at most", "may", "is not modelled"), and the official names stay as the
 * administrations write them: ITP/TPO, IRPF, IPREM, Codi tributari de Catalunya, Llei 8/2025,
 * Real Decreto 326/2026, Agència Tributària de Catalunya (ATC), the rate codes (TMR, TEA, TUJ…).
 */
export type PolicyText = {
  title: string;
  /** The `benefit` of the data: what the measure is worth, in one sentence. */
  benefit: string;
  /** One per note of the data, in the same order. */
  notes: string[];
  /** The `effect.reason` of a measure whose amount is not modelled. No final full stop. */
  reason?: string;
};

type PolicyId = Policy['id'];
const tariffUrl = 'https://www.boe.es/eli/es-ct/dlg/2024/03/12/1/con#a6-85';
const generalRateIds = 'itp_young_buyer, itp_large_family, itp_single_parent, itp_disability';

// ------------------------------------------------------------------ Català

const caTariff = `Xifres de l’efecte: la tarifa general de l’ITP/TPO consultada a la pàgina de tipus de l’ATC el 22 de novembre de 2026 (article 641-1 del Codi tributari de Catalunya, ${tariffUrl}) és del 10 % quan el valor total de l’immoble no supera els 600.000 €; per sobre, l’impost és la tarifa mitjana del 10 % fins a 600.000 €, l’11 % sobre els 300.000 € següents, el 12 % sobre els 600.000 € següents i el 13 % per sobre d’1.500.000 €. Aquesta tarifa s’aplica des del 27 de juny de 2025. El tipus reduït és fix sobre tot el valor.`;
const caRuralDifference = `${caTariff} Un comprador que té dret a un dels tipus del 5 % que s’apliquen a tot Catalunya (${generalRateIds}) només estalvia la diferència entre el 5 % i aquest tipus si tria un municipi rural.`;
const caHabitual =
  'L’habitatge ha de ser l’habitatge habitual del comprador: s’hi ha de viure dins dels dotze mesos posteriors a la compra i durant tres anys continuats, amb les excepcions previstes a la llei. El tipus és provisional; si s’incompleix un termini, cal presentar una autoliquidació complementària al tipus general amb interessos de demora en el termini d’un mes. S’aplica a la propietat plena o compartida i als drets de superfície, d’usdefruit i d’ús, no a la nua propietat.';
const caEverywhere = `S’aplica a tots els municipis de Catalunya, de manera que no és un estalvi de cap lloc concret: el planificador d’estalvi el fa servir com a tipus de referència del comprador. La llei no fixa cap data de finalització; 2099-12-31 representa una mesura sense data de fi. ${caTariff}`;
const caOnly36 =
  'Només es comprova el límit de 36.000 €. Una família que el superi encara pot tenir-hi dret pels increments de 14.000 €, de manera que aquest cas s’indica com a pendent de verificació, no com a no elegible.';

const ca: Record<PolicyId, PolicyText> = {
  irpf_move: {
    title: 'Deducció catalana de l’IRPF per trasllat a un municipi rural',
    benefit:
      'Rural: 750 €; atenció especial: 1.000 €. Famílies monoparentals oficials: 1.500 € i 2.000 € respectivament.',
    notes: [
      'Per a l’exercici fiscal 2026, que es declara el 2027. La pàgina catalana de l’ATC i la llei coincideixen en 1.000 € per als trasllats a municipis d’atenció especial; la guia en castellà indicava un import diferent.',
      'Les xifres de l’efecte són els imports ordinaris de l’article 57 de la Llei 8/2025 i de la pàgina de l’ATC; els imports dobles per a famílies monoparentals no són a l’efecte. És una deducció de la quota catalana de l’IRPF, de manera que arriba amb la declaració de la renda de l’any següent, no com a diners en el moment del trasllat.',
    ],
  },
  irpf_buy: {
    title: 'Deducció catalana de l’IRPF per la compra de l’habitatge habitual en un municipi rural',
    benefit: '15 % (rural) o 20 % (atenció especial) sobre una base anual màxima de 6.000 €.',
    notes: [
      'Les regles de 2026 distingeixen les bases imposables calculades individualment dels totals de la tributació conjunta. S’apliquen les regles d’ocupació de l’habitatge, d’inversió i de deduccions transitòries.',
      'Xifres de l’efecte: el 15 % o el 20 % de les quantitats pagades durant l’exercici sobre una base anual màxima de 6.000 €, tal com indica la pàgina de l’ATC (com a màxim 900 € o 1.200 € l’any). Redueix l’impost de l’any següent i no pot superar la quota a pagar.',
    ],
  },
  irpf_rent: {
    title: 'Deducció catalana de l’IRPF pel lloguer de l’habitatge habitual en un municipi rural',
    benefit:
      '15 % (rural) o 20 % (atenció especial) del lloguer pagat durant l’any, com a màxim 600 € l’any, o 1.200 € en declaració conjunta; s’apliquen regles de repartiment en habitatges compartits.',
    notes: [
      'Cal identificar l’arrendador a la declaració de la renda. Aquesta eina només accepta la confirmació del criteri.',
      'Xifres de l’efecte: l’article 61 de la Llei 8/2025 i la pàgina de l’ATC apliquen el percentatge al lloguer pagat durant l’exercici, sense límit sobre aquesta base, i limiten la deducció mateixa a 600 € l’any, o a 1.200 € en declaració conjunta quan un dels declarants compleix la condició d’edat o de fill. Quan diversos contribuents poden deduir pel mateix habitatge, el resultat del percentatge o el límit de 1.200 € es reparteix entre ells; aquest repartiment no està modelitzat. És incompatible amb la deducció general per lloguer de l’article 612-3 del Codi tributari de Catalunya.',
    ],
  },
  irpf_renovate: {
    title: 'Deducció catalana de l’IRPF per la rehabilitació de l’habitatge habitual en un municipi rural',
    benefit:
      '15 % (rural) o 20 % (atenció especial) sobre una base anual màxima de 6.000 €, amb els ajustos per subvencions que corresponguin.',
    notes: [
      'L’habitatge ha de ser anterior a l’1 de gener de 1970. S’apliquen condicions d’obres estructurals, d’ocupació, d’inversió i de compatibilitat.',
      'Xifres de l’efecte: el 15 % o el 20 % de les quantitats pagades durant l’exercici sobre una base anual màxima de 6.000 €, tal com indica la pàgina de l’ATC. Les subvencions públiques de rehabilitació rebudes durant l’any redueixen la deducció; aquest ajust no està modelitzat.',
    ],
  },
  itp_buy: {
    title: 'ITP reduït per la compra de l’habitatge habitual en un municipi rural (TMR / TEA)',
    benefit:
      'Tipus TMR del 4 % (rural) o tipus TEA del 3 % (atenció especial) en les adquisicions subjectes a ITP/TPO que hi donen dret.',
    notes: [
      'Cal confirmar amb l’ATC la base imposable anterior de la llar, el dret d’adquisició i les regles d’escolarització i d’ocupació.',
      caRuralDifference,
    ],
  },
  itp_rehab_buy: {
    title: 'ITP reduït per la compra d’un habitatge rural per rehabilitar-lo com a habitatge habitual (TRR / TRA)',
    benefit:
      'Tipus TRR del 4 % (rural) o tipus TRA del 3 % (atenció especial) en la compra subjecta a ITP/TPO d’un habitatge construït abans de 1970 que el comprador rehabilita com a habitatge habitual.',
    notes: [
      'A diferència del tipus TMR / TEA, no es requereix cap fill en edat escolar. La base imposable del comprador (general més de l’estalvi, menys el mínim personal i familiar) a l’última declaració de l’IRPF anterior a la compra no ha de superar els 36.000 €.',
      'Les obres han de ser de rehabilitació estructural amb un cost superior al 25 % del preu de compra o del valor de mercat sense el sòl, i han d’acabar dins dels dos anys posteriors a la compra. El tipus és provisional: si s’incompleix una condició, cal presentar una autoliquidació complementària al tipus general amb interessos de demora en el termini d’un mes. No s’aplica a la nua propietat.',
      'A Artesa de Segre i Tremp només hi tenen dret els nuclis agregats, no el cap de municipi. Des del 29 de setembre de 2026 els municipis de la Resolució PRE/3375/2026 (règim especial) també compten com a rurals per a aquest tipus.',
      caRuralDifference,
    ],
  },
  itp_young_buyer: {
    title: 'ITP reduït per la compra de l’habitatge habitual per un comprador de 35 anys o menys (TUJ)',
    benefit:
      'Tipus de l’ITP/TPO del 5 %, en lloc de la tarifa general, en la compra de l’habitatge habitual a qualsevol municipi de Catalunya per un comprador de 35 anys o menys amb una base imposable de 36.000 € com a màxim.',
    notes: [
      'Article 641-5 del Codi tributari de Catalunya i pàgina de tipus de l’ATC: el comprador té 35 anys o menys en la data de meritació de l’impost, i la seva base imposable general més la de l’estalvi, menys el mínim personal i familiar, a l’última declaració de l’IRPF anterior a la compra és de 36.000 € com a màxim. El límit de 35 anys s’aplica a les compres fetes a partir del 27 de juny de 2025 (abans era de 32); el límit de 36.000 € és vigent des del 18 de març de 2023.',
      'L’última declaració de l’IRPF és l’última presentada, o que s’hauria pogut presentar, abans de la compra (resolucions 1/2025 i 2/2025 de la DGTJ).',
      caHabitual,
      caEverywhere,
    ],
  },
  itp_large_family: {
    title: 'ITP reduït per la compra de l’habitatge habitual per una família nombrosa (TUF)',
    benefit:
      'Tipus de l’ITP/TPO del 5 %, en lloc de la tarifa general, en la compra de l’habitatge habitual d’una família nombrosa a qualsevol municipi de Catalunya, quan les bases imposables de la família sumen com a màxim 36.000 € més 14.000 € per cada fill per sobre del mínim legal.',
    notes: [
      'Article 641-2 del Codi tributari de Catalunya i pàgina de tipus de l’ATC: el comprador és membre d’una família nombrosa segons la Llei 40/2003, i les bases imposables generals més les de l’estalvi, menys els mínims personals i familiars, dels membres de la família a l’última declaració de l’IRPF sumen com a màxim 36.000 €, incrementats en 14.000 € per cada fill per sobre del nombre mínim que fa que una família sigui legalment nombrosa. Llindars vigents per a les compres fetes a partir del 18 de març de 2023.',
      caOnly36,
      caHabitual,
      caEverywhere,
    ],
  },
  itp_single_parent: {
    title: 'ITP reduït per la compra de l’habitatge habitual per una família monoparental (TMP)',
    benefit:
      'Tipus de l’ITP/TPO del 5 %, en lloc de la tarifa general, en la compra de l’habitatge habitual d’una família monoparental a qualsevol municipi de Catalunya, quan les bases imposables de la família sumen com a màxim 36.000 € més 14.000 € per cada fill per sobre del mínim de la categoria especial.',
    notes: [
      'Article 641-3 del Codi tributari de Catalunya i pàgina de tipus de l’ATC: el comprador és membre d’una família monoparental segons les normes que desenvolupen la Llei 18/2003, i les bases imposables generals més les de l’estalvi, menys els mínims personals i familiars, dels membres de la família a l’última declaració de l’IRPF sumen com a màxim 36.000 €, incrementats en 14.000 € per cada fill per sobre del nombre mínim exigit per a la categoria especial. Llindars vigents per a les compres fetes a partir del 18 de març de 2023.',
      caOnly36,
      caHabitual,
      caEverywhere,
    ],
  },
  itp_disability: {
    title:
      'ITP reduït per la compra de l’habitatge habitual per a una persona amb una discapacitat del 65 % o més (TUM)',
    benefit:
      'Tipus de l’ITP/TPO del 5 %, en lloc de la tarifa general, en la compra a qualsevol municipi de Catalunya de l’habitatge habitual d’un comprador que té, o que té a la seva unitat familiar una persona amb, una discapacitat reconeguda del 65 % o més, quan les bases imposables de la unitat familiar sumen com a màxim 36.000 €.',
    notes: [
      'Article 641-4 del Codi tributari de Catalunya i pàgina de tipus de l’ATC: una discapacitat física, psíquica o sensorial reconeguda del 65 % o més en el comprador o en un membre de la seva unitat familiar (tal com es defineix per a la tributació conjunta de l’IRPF), i unes bases imposables generals més les de l’estalvi, menys els mínims personals i familiars, dels membres de la unitat familiar a l’última declaració de l’IRPF de 36.000 € com a màxim (vigent per a les compres fetes a partir del 18 de març de 2023). L’acreditació del grau de discapacitat es presenta amb l’autoliquidació.',
      caHabitual,
      caEverywhere,
    ],
  },
  renovation_grant_2026: {
    title: 'Subvenció de 2026 per a la rehabilitació d’habitatges en el món rural i de muntanya',
    benefit:
      'El percentatge i el límit de la subvenció depenen del municipi, del beneficiari i de l’ús previst (residència pròpia o lloguer assequible).',
    notes: [
      'Només la via per a llars i propietaris particulars. Consulta la taula oficial de municipis i percentatges a https://agenciahabitatge.gencat.cat/monrural2026. El termini de sol·licitud de 2026 va acabar el 10 de setembre a les 14:00, hora local.',
    ],
    reason:
      'Per a la residència pròpia d’un propietari particular, les bases (Resolució TER/723/2026) paguen del 10 % al 40 % del pressupost aprovat, amb un límit de 10.000 € a 20.000 € per habitatge, segons si el municipi és rural o d’atenció especial i segons el grau de ruralitat de la comarca; la classe de la comarca no està modelitzada, i la convocatòria de 2026 està tancada',
  },
  youth_purchase_small_town: {
    title: 'Ajut estatal a joves per comprar o autopromoure un habitatge en un municipi de 10.000 habitants o menys',
    benefit:
      'Com a màxim 15.000 € per habitatge i com a màxim el 20 % del cost de compra o de construcció, per a compradors de 35 anys o menys, en un habitatge de 300.000 € o menys a Catalunya.',
    notes: [
      'Articles 140 a 145 i annex IV del Real Decreto 326/2026 (Plan Estatal de Vivienda 2026-2030), en vigor des del 24 d’abril de 2026. Hi poden tenir dret els contractes de compra signats a partir de l’1 de gener de 2026. El decret no fixa cap data de finalització per a aquesta línia; 2030-12-31 és el final del període del pla.',
      'Condicions del decret: 35 anys o menys; ingressos anuals de com a màxim 5 vegades l’IPREM (5,5 o 6 vegades amb una discapacitat reconeguda); no ser propietari ni usufructuari d’un altre habitatge a Espanya, amb excepcions; residència habitual i permanent durant almenys cinc anys, ocupada dins dels tres mesos posteriors al lliurament.',
      'El 22 de novembre de 2026 no es va trobar cap convocatòria catalana: la pàgina de la Generalitat sobre ajuts a la compra només recull els préstecs del Fons Públic d’Emancipació. Per tant, l’estat de la convocatòria és desconegut, i les bases catalanes poden afegir condicions a les del decret.',
      'El decret cobreix els municipis o nuclis de població de 10.000 habitants o menys en el moment de la seva entrada en vigor o de la publicació de la convocatòria; un acord bilateral pot ampliar-ho a 20.000. Els municipis indicats són els pobles del pilot amb 10.000 habitants o menys segons les xifres de població de 2025 del conjunt de dades. No s’avaluen els nuclis dins de municipis més grans.',
      'Xifres de l’efecte: l’article 143 del Real Decreto 326/2026 fixa l’ajut en 15.000 € per habitatge o menys, limitat al 20 % del cost de compra o de construcció, de manera que l’efecte és un sostre: el menor de 15.000 € i el 20 % del preu. Un habitatge el poden comprar com a màxim dues persones, que es reparteixen l’ajut. L’ajut només es pot sol·licitar a través d’una convocatòria catalana, i el 22 de novembre de 2026 no se’n va trobar cap a les pàgines d’habitatge de la Generalitat, de manera que l’import no es compta mai.',
    ],
  },
};

// --------------------------------------------------------------- Castellano

const esTariff = `Cifras del efecto: la tarifa general del ITP/TPO consultada en la página de tipos de la ATC el 22 de noviembre de 2026 (artículo 641-1 del Codi tributari de Catalunya, ${tariffUrl}) es del 10 % cuando el valor total del inmueble no supera los 600.000 €; por encima, el impuesto es la tarifa media del 10 % hasta 600.000 €, el 11 % sobre los 300.000 € siguientes, el 12 % sobre los 600.000 € siguientes y el 13 % por encima de 1.500.000 €. Esta tarifa se aplica desde el 27 de junio de 2025. El tipo reducido es fijo sobre todo el valor.`;
const esRuralDifference = `${esTariff} Un comprador que tiene derecho a uno de los tipos del 5 % que se aplican en toda Cataluña (${generalRateIds}) solo ahorra la diferencia entre el 5 % y este tipo si elige un municipio rural.`;
const esHabitual =
  'La vivienda debe ser la vivienda habitual del comprador: hay que vivir en ella dentro de los doce meses siguientes a la compra y durante tres años continuados, con las excepciones previstas en la ley. El tipo es provisional; si se incumple un plazo, hay que presentar una autoliquidación complementaria al tipo general con intereses de demora en el plazo de un mes. Se aplica a la propiedad plena o compartida y a los derechos de superficie, de usufructo y de uso, no a la nuda propiedad.';
const esEverywhere = `Se aplica en todos los municipios de Cataluña, así que no es un ahorro de ningún lugar concreto: el planificador de ahorro lo usa como tipo de referencia del comprador. La ley no fija ninguna fecha de finalización; 2099-12-31 representa una medida sin fecha de fin. ${esTariff}`;
const esOnly36 =
  'Solo se comprueba el límite de 36.000 €. Una familia que lo supere aún puede tener derecho por los incrementos de 14.000 €, así que ese caso se indica como pendiente de verificación, no como no elegible.';

const es: Record<PolicyId, PolicyText> = {
  irpf_move: {
    title: 'Deducción catalana del IRPF por traslado a un municipio rural',
    benefit:
      'Rural: 750 €; atención especial: 1000 €. Familias monoparentales oficiales: 1500 € y 2000 € respectivamente.',
    notes: [
      'Para el ejercicio fiscal 2026, que se declara en 2027. La página catalana de la ATC y la ley coinciden en 1000 € para los traslados a municipios de atención especial; la guía en castellano indicaba un importe distinto.',
      'Las cifras del efecto son los importes ordinarios del artículo 57 de la Llei 8/2025 y de la página de la ATC; los importes dobles para familias monoparentales no están en el efecto. Es una deducción de la cuota catalana del IRPF, así que llega con la declaración de la renta del año siguiente, no como dinero en el momento del traslado.',
    ],
  },
  irpf_buy: {
    title: 'Deducción catalana del IRPF por la compra de la vivienda habitual en un municipio rural',
    benefit: '15 % (rural) o 20 % (atención especial) sobre una base anual máxima de 6000 €.',
    notes: [
      'Las reglas de 2026 distinguen las bases imponibles calculadas individualmente de los totales de la tributación conjunta. Se aplican las reglas de ocupación de la vivienda, de inversión y de deducciones transitorias.',
      'Cifras del efecto: el 15 % o el 20 % de las cantidades pagadas durante el ejercicio sobre una base anual máxima de 6000 €, tal como indica la página de la ATC (como máximo 900 € o 1200 € al año). Reduce el impuesto del año siguiente y no puede superar la cuota a pagar.',
    ],
  },
  irpf_rent: {
    title: 'Deducción catalana del IRPF por el alquiler de la vivienda habitual en un municipio rural',
    benefit:
      '15 % (rural) o 20 % (atención especial) del alquiler pagado durante el año, como máximo 600 € al año, o 1200 € en declaración conjunta; se aplican reglas de reparto en viviendas compartidas.',
    notes: [
      'Hay que identificar al arrendador en la declaración de la renta. Esta herramienta solo acepta la confirmación del criterio.',
      'Cifras del efecto: el artículo 61 de la Llei 8/2025 y la página de la ATC aplican el porcentaje al alquiler pagado durante el ejercicio, sin límite sobre esa base, y limitan la deducción misma a 600 € al año, o a 1200 € en declaración conjunta cuando uno de los declarantes cumple la condición de edad o de hijo. Cuando varios contribuyentes pueden deducir por la misma vivienda, el resultado del porcentaje o el límite de 1200 € se reparte entre ellos; ese reparto no está modelizado. Es incompatible con la deducción general por alquiler del artículo 612-3 del Codi tributari de Catalunya.',
    ],
  },
  irpf_renovate: {
    title: 'Deducción catalana del IRPF por la rehabilitación de la vivienda habitual en un municipio rural',
    benefit:
      '15 % (rural) o 20 % (atención especial) sobre una base anual máxima de 6000 €, con los ajustes por subvenciones que correspondan.',
    notes: [
      'La vivienda debe ser anterior al 1 de enero de 1970. Se aplican condiciones de obras estructurales, de ocupación, de inversión y de compatibilidad.',
      'Cifras del efecto: el 15 % o el 20 % de las cantidades pagadas durante el ejercicio sobre una base anual máxima de 6000 €, tal como indica la página de la ATC. Las subvenciones públicas de rehabilitación recibidas durante el año reducen la deducción; ese ajuste no está modelizado.',
    ],
  },
  itp_buy: {
    title: 'ITP reducido por la compra de la vivienda habitual en un municipio rural (TMR / TEA)',
    benefit:
      'Tipo TMR del 4 % (rural) o tipo TEA del 3 % (atención especial) en las adquisiciones sujetas a ITP/TPO que dan derecho a él.',
    notes: [
      'Hay que confirmar con la ATC la base imponible anterior del hogar, el derecho de adquisición y las reglas de escolarización y de ocupación.',
      esRuralDifference,
    ],
  },
  itp_rehab_buy: {
    title: 'ITP reducido por la compra de una vivienda rural para rehabilitarla como vivienda habitual (TRR / TRA)',
    benefit:
      'Tipo TRR del 4 % (rural) o tipo TRA del 3 % (atención especial) en la compra sujeta a ITP/TPO de una vivienda construida antes de 1970 que el comprador rehabilita como vivienda habitual.',
    notes: [
      'A diferencia del tipo TMR / TEA, no se exige ningún hijo en edad escolar. La base imponible del comprador (general más del ahorro, menos el mínimo personal y familiar) en la última declaración del IRPF anterior a la compra no debe superar los 36.000 €.',
      'Las obras deben ser de rehabilitación estructural con un coste superior al 25 % del precio de compra o del valor de mercado sin el suelo, y deben terminar dentro de los dos años siguientes a la compra. El tipo es provisional: si se incumple una condición, hay que presentar una autoliquidación complementaria al tipo general con intereses de demora en el plazo de un mes. No se aplica a la nuda propiedad.',
      'En Artesa de Segre y Tremp solo tienen derecho los núcleos agregados, no la capital del municipio. Desde el 29 de septiembre de 2026 los municipios de la Resolució PRE/3375/2026 (régimen especial) también cuentan como rurales para este tipo.',
      esRuralDifference,
    ],
  },
  itp_young_buyer: {
    title: 'ITP reducido por la compra de la vivienda habitual por un comprador de 35 años o menos (TUJ)',
    benefit:
      'Tipo del ITP/TPO del 5 %, en lugar de la tarifa general, en la compra de la vivienda habitual en cualquier municipio de Cataluña por un comprador de 35 años o menos con una base imponible de 36.000 € como máximo.',
    notes: [
      'Artículo 641-5 del Codi tributari de Catalunya y página de tipos de la ATC: el comprador tiene 35 años o menos en la fecha de devengo del impuesto, y su base imponible general más la del ahorro, menos el mínimo personal y familiar, en la última declaración del IRPF anterior a la compra es de 36.000 € como máximo. El límite de 35 años se aplica a las compras realizadas a partir del 27 de junio de 2025 (antes era de 32); el límite de 36.000 € está vigente desde el 18 de marzo de 2023.',
      'La última declaración del IRPF es la última presentada, o que se habría podido presentar, antes de la compra (resoluciones 1/2025 y 2/2025 de la DGTJ).',
      esHabitual,
      esEverywhere,
    ],
  },
  itp_large_family: {
    title: 'ITP reducido por la compra de la vivienda habitual por una familia numerosa (TUF)',
    benefit:
      'Tipo del ITP/TPO del 5 %, en lugar de la tarifa general, en la compra de la vivienda habitual de una familia numerosa en cualquier municipio de Cataluña, cuando las bases imponibles de la familia suman como máximo 36.000 € más 14.000 € por cada hijo por encima del mínimo legal.',
    notes: [
      'Artículo 641-2 del Codi tributari de Catalunya y página de tipos de la ATC: el comprador es miembro de una familia numerosa según la Ley 40/2003, y las bases imponibles generales más las del ahorro, menos los mínimos personales y familiares, de los miembros de la familia en la última declaración del IRPF suman como máximo 36.000 €, incrementados en 14.000 € por cada hijo por encima del número mínimo que hace que una familia sea legalmente numerosa. Umbrales vigentes para las compras realizadas a partir del 18 de marzo de 2023.',
      esOnly36,
      esHabitual,
      esEverywhere,
    ],
  },
  itp_single_parent: {
    title: 'ITP reducido por la compra de la vivienda habitual por una familia monoparental (TMP)',
    benefit:
      'Tipo del ITP/TPO del 5 %, en lugar de la tarifa general, en la compra de la vivienda habitual de una familia monoparental en cualquier municipio de Cataluña, cuando las bases imponibles de la familia suman como máximo 36.000 € más 14.000 € por cada hijo por encima del mínimo de la categoría especial.',
    notes: [
      'Artículo 641-3 del Codi tributari de Catalunya y página de tipos de la ATC: el comprador es miembro de una familia monoparental según las normas que desarrollan la Llei 18/2003, y las bases imponibles generales más las del ahorro, menos los mínimos personales y familiares, de los miembros de la familia en la última declaración del IRPF suman como máximo 36.000 €, incrementados en 14.000 € por cada hijo por encima del número mínimo exigido para la categoría especial. Umbrales vigentes para las compras realizadas a partir del 18 de marzo de 2023.',
      esOnly36,
      esHabitual,
      esEverywhere,
    ],
  },
  itp_disability: {
    title:
      'ITP reducido por la compra de la vivienda habitual para una persona con una discapacidad del 65 % o más (TUM)',
    benefit:
      'Tipo del ITP/TPO del 5 %, en lugar de la tarifa general, en la compra en cualquier municipio de Cataluña de la vivienda habitual de un comprador que tiene, o en cuya unidad familiar hay una persona con, una discapacidad reconocida del 65 % o más, cuando las bases imponibles de la unidad familiar suman como máximo 36.000 €.',
    notes: [
      'Artículo 641-4 del Codi tributari de Catalunya y página de tipos de la ATC: una discapacidad física, psíquica o sensorial reconocida del 65 % o más en el comprador o en un miembro de su unidad familiar (tal como se define para la tributación conjunta del IRPF), y unas bases imponibles generales más las del ahorro, menos los mínimos personales y familiares, de los miembros de la unidad familiar en la última declaración del IRPF de 36.000 € como máximo (vigente para las compras realizadas a partir del 18 de marzo de 2023). La acreditación del grado de discapacidad se presenta con la autoliquidación.',
      esHabitual,
      esEverywhere,
    ],
  },
  renovation_grant_2026: {
    title: 'Subvención de 2026 para la rehabilitación de viviendas en el mundo rural y de montaña',
    benefit:
      'El porcentaje y el límite de la subvención dependen del municipio, del beneficiario y del uso previsto (residencia propia o alquiler asequible).',
    notes: [
      'Solo la vía para hogares y propietarios particulares. Consulta la tabla oficial de municipios y porcentajes en https://agenciahabitatge.gencat.cat/monrural2026. El plazo de solicitud de 2026 terminó el 10 de septiembre a las 14:00, hora local.',
    ],
    reason:
      'Para la residencia propia de un propietario particular, las bases (Resolució TER/723/2026) pagan del 10 % al 40 % del presupuesto aprobado, con un límite de 10.000 € a 20.000 € por vivienda, según si el municipio es rural o de atención especial y según el grado de ruralidad de la comarca; la clase de la comarca no está modelizada, y la convocatoria de 2026 está cerrada',
  },
  youth_purchase_small_town: {
    title:
      'Ayuda estatal a jóvenes para comprar o autopromover una vivienda en un municipio de 10.000 habitantes o menos',
    benefit:
      'Como máximo 15.000 € por vivienda y como máximo el 20 % del coste de compra o de construcción, para compradores de 35 años o menos, en una vivienda de 300.000 € o menos en Cataluña.',
    notes: [
      'Artículos 140 a 145 y anexo IV del Real Decreto 326/2026 (Plan Estatal de Vivienda 2026-2030), en vigor desde el 24 de abril de 2026. Pueden tener derecho los contratos de compra firmados a partir del 1 de enero de 2026. El decreto no fija ninguna fecha de finalización para esta línea; 2030-12-31 es el final del periodo del plan.',
      'Condiciones del decreto: 35 años o menos; ingresos anuales de como máximo 5 veces el IPREM (5,5 o 6 veces con una discapacidad reconocida); no ser propietario ni usufructuario de otra vivienda en España, con excepciones; residencia habitual y permanente durante al menos cinco años, ocupada dentro de los tres meses siguientes a la entrega.',
      'El 22 de noviembre de 2026 no se encontró ninguna convocatoria catalana: la página de la Generalitat sobre ayudas a la compra solo recoge los préstamos del Fons Públic d’Emancipació. Por tanto, el estado de la convocatoria es desconocido, y las bases catalanas pueden añadir condiciones a las del decreto.',
      'El decreto cubre los municipios o núcleos de población de 10.000 habitantes o menos en el momento de su entrada en vigor o de la publicación de la convocatoria; un acuerdo bilateral puede ampliarlo a 20.000. Los municipios indicados son los pueblos del piloto con 10.000 habitantes o menos según las cifras de población de 2025 del conjunto de datos. No se evalúan los núcleos dentro de municipios más grandes.',
      'Cifras del efecto: el artículo 143 del Real Decreto 326/2026 fija la ayuda en 15.000 € por vivienda o menos, limitada al 20 % del coste de compra o de construcción, así que el efecto es un techo: el menor de 15.000 € y el 20 % del precio. Una vivienda la pueden comprar como máximo dos personas, que se reparten la ayuda. La ayuda solo puede solicitarse a través de una convocatoria catalana, y el 22 de noviembre de 2026 no se encontró ninguna en las páginas de vivienda de la Generalitat, así que el importe no se cuenta nunca.',
    ],
  },
};

/** Catalan and Spanish text by policy id. A policy id of the data that is missing here falls back to English. */
export const policyText: Record<Exclude<Locale, 'en'>, Partial<Record<string, PolicyText>>> = { ca, es };

const localized = new WeakMap<object, Map<Locale, unknown>>();

/**
 * The same policy with its name and explanation in `locale`. English, and a policy without a
 * translation, come back untouched. Notes are replaced only when the translation has one per note
 * of the data, so an edited policy is never shown with notes that belong to an older text. Dates,
 * amounts, the authority, ids and URLs are those of the data in every language.
 */
export function localizePolicy<Value extends Pick<Policy, 'id' | 'title' | 'benefit' | 'notes' | 'effect'>>(
  policy: Value,
  locale: Locale = defaultLocale,
): Value {
  if (locale === 'en') return policy;
  const text = policyText[locale]?.[policy.id];
  if (!text) return policy;
  const cached = localized.get(policy)?.get(locale);
  if (cached) return cached as Value;
  const result: Value = {
    ...policy,
    title: text.title,
    benefit: text.benefit,
    notes: text.notes.length === policy.notes.length ? text.notes : policy.notes,
    ...(policy.effect?.kind === 'unquantified' && text.reason
      ? { effect: { ...policy.effect, reason: text.reason } }
      : {}),
  };
  if (!localized.has(policy)) localized.set(policy, new Map());
  localized.get(policy)?.set(locale, result);
  return result;
}
