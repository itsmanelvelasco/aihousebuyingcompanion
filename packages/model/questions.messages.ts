import { defineMessages } from '../i18n/messages.ts';

/**
 * The words of the shared question set: what each question is called, how it is asked, why, where
 * to find the answer, and the note said before a sensitive one. Keys are `<questionId>.<part>`.
 *
 * These sentences state tax and aid conditions. The official terms stay as the administrations
 * write them (ITP, IRPF, IPREM, base imposable / base imponible, família nombrosa / familia numerosa).
 */
export const questionMessages = defineMessages(
  {
    'sensitivity.family':
      'About your family. It is used only to check the measures named here. It is stored only if you are signed in and save it; otherwise it stays in this estimate and is sent nowhere else.',
    'sensitivity.health':
      'About health. It is used only to check this one tax rate, and no detail beyond yes or no is asked. It is stored only if you are signed in and save it; otherwise it stays in this estimate and is sent nowhere else.',
    'sensitivity.tax':
      'From your tax return. It is used only to compare with the limit of the measure. It is stored only if you are signed in and save it; otherwise it stays in this estimate and is sent nowhere else.',
    'help.taxBase':
      'This is not your salary. It is the general tax base plus the savings tax base, less the personal and family minimum. On the 2025 income tax return (Renta 2025, form 100) the Agència Tributària computes it as box 0435 plus box 0460 minus box 0520. Box numbers can change from one year to the next, so check the labels: base imponible general, base imponible del ahorro, mínimo personal y familiar. If you are not sure, choose “I don’t know”.',
    'help.schooling':
      'The Catalan Tax Agency sets the exact conditions. If you have not checked them yet, choose “I don’t know” and confirm with the agency.',

    'monthlyIncome.label': 'Monthly income',
    'monthlyIncome.question': 'How much money comes into your household in a typical month, after tax?',
    'monthlyIncome.why': 'The plan saves what is left of your income after your spending each month.',
    'monthlyExpenses.label': 'Monthly spending',
    'monthlyExpenses.question':
      'How much does your household spend in a typical month, with rent, bills and debt payments included?',
    'monthlyExpenses.why': 'The plan saves what is left of your income after your spending each month.',
    'purchaseSavings.label': 'Savings for the purchase',
    'purchaseSavings.question': 'How much have you already saved that you would spend on buying the home?',
    'purchaseSavings.why':
      'It is the starting point of the timeline. A bank balance is never assumed to be available for the purchase.',
    'homeBudget.label': 'Home budget',
    'homeBudget.question': 'What is the most you would pay for the home?',
    'homeBudget.why': 'The deposit, the transfer tax and the purchase fees are all shares of the price.',
    'homeBudget.help':
      'If you do not have a figure, choose “I don’t know”: the plan can price a home of a given size from each town’s average instead.',
    'floorArea.label': 'Home size',
    'floorArea.question': 'How large a home are you looking for, in square metres?',
    'floorArea.why':
      'Without a budget, the price is this floor area times the average price per square metre of each town.',
    'primaryResidence.label': 'Main home',
    'primaryResidence.question': 'Will the home you buy be the one you live in, your main home?',
    'primaryResidence.why':
      'Every reduced transfer-tax rate, the rural deductions and the aid for young buyers are for the home you live in.',
    'birthDate.label': 'Date of birth',
    'birthDate.question': 'What is your date of birth?',
    'birthDate.why':
      'A buyer aged 35 or younger pays 5% transfer tax instead of the general rate anywhere in Catalonia, and some aids and deductions have the same age limit. Your age is worked out for the day you could buy, so it does not go out of date.',
    'children.label': 'Children',
    'children.question':
      'Do children who depend on you live with you? Give the date of birth of each one, or say there are none.',
    'children.why':
      'The reduced transfer tax of a rural municipality (4% or 3%) and the rural income-tax deductions are for households with a child aged 16 or younger.',
    'itpTransaction.label': 'Purchase subject to transfer tax',
    'itpTransaction.question':
      'Will the purchase pay transfer tax (ITP)? That is the case for most resale homes; a new build sold by its developer pays VAT instead.',
    'itpTransaction.why':
      'The reduced rates are rates of the transfer tax, so none of them applies to a purchase that pays VAT.',
    'itpOccupancy.label': 'Moving in and staying',
    'itpOccupancy.question':
      'Will you move in within twelve months of buying and keep it as your main home for at least three years?',
    'itpOccupancy.why':
      'A reduced transfer-tax rate is provisional: it is kept only if those two deadlines are met, or an exception in the law applies.',
    'childrenItpSchooling.label': 'Schooling for the rural transfer tax',
    'childrenItpSchooling.question':
      'For each child aged 4 to 16: will the child meet the schooling conditions of the rural transfer-tax rate (the place of the school, the timing and staying enrolled)?',
    'childrenItpSchooling.why':
      'The reduced transfer tax of a rural municipality needs a child aged 16 or younger who meets its schooling conditions; children aged 3 or younger are exempt.',
    'largeFamily.label': 'Large family',
    'largeFamily.question': 'Does your family hold the official large-family title (família nombrosa)?',
    'largeFamily.why': 'A recognised large family pays 5% transfer tax on its main home anywhere in Catalonia.',
    'singleParent.label': 'Single-parent family',
    'singleParent.question': 'Does your family hold the official single-parent family title (família monoparental)?',
    'singleParent.why':
      'A recognised single-parent family pays 5% transfer tax on its main home anywhere in Catalonia, and its deduction for moving to a rural municipality is doubled.',
    'disability65.label': 'Disability of 65% or more',
    'disability65.question': 'Do you, or a member of your family unit, have a recognised disability of 65% or more?',
    'disability65.why':
      'A household with a recognised disability of 65% or more pays 5% transfer tax on its main home anywhere in Catalonia.',
    'firstRuralMove.label': 'First move to a rural municipality',
    'firstRuralMove.question': 'Would this be the first time you move your home to a rural municipality?',
    'firstRuralMove.why':
      'The income-tax deduction for moving to a rural municipality (€750, or €1,000 in a special-attention one) is for a first move.',
    'childrenIrpfSchooling.label': 'Schooling for the rural income-tax deductions',
    'childrenIrpfSchooling.question':
      'For each child aged 4 to 16: will the child go to school in the educational zone of the new home, or in the school assigned to it?',
    'childrenIrpfSchooling.why':
      'The rural income-tax deductions count a child aged 16 or younger who meets their schooling rule; children aged 3 or younger are exempt.',
    'ownsHomeInSpain.label': 'Another home in Spain',
    'ownsHomeInSpain.question': 'Do you own another home in Spain, or hold a usufruct over one?',
    'ownsHomeInSpain.why':
      'The state aid for buyers aged 35 or younger in small towns is not for people who already own a home in Spain, unless an official exception applies.',
    'incomeWithinFiveIprem.label': 'Income within five times IPREM',
    'incomeWithinFiveIprem.question':
      'Is your yearly income at most five times the IPREM, the public income index (5.5 or 6 times with a recognised disability)?',
    'incomeWithinFiveIprem.why': 'The state aid for buyers aged 35 or younger in small towns has that income ceiling.',
    'incomeWithinFiveIprem.help':
      'The IPREM is set each year in the State Budget, and the call for the aid states the limit in euros. If you have not compared your income with it, choose “I don’t know”.',
    'filing.label': 'Type of tax return',
    'filing.question': 'Do you file your income tax return on your own, or jointly with your family unit?',
    'filing.why':
      'The rural deductions for moving and for renting have an income limit that depends on it: €30,000 on an individual return, €45,000 on a joint one.',
    'filing.option.individual': 'On my own (individual)',
    'filing.option.joint': 'Jointly',
    'itpBuyerNetTaxBase.label': 'Your own tax base',
    'itpBuyerNetTaxBase.question': 'From your last income tax return: what was your own tax base, in euros?',
    'itpBuyerNetTaxBase.why':
      'The 5% transfer tax for buyers aged 35 or younger applies only if this figure is at most €36,000.',
    'itpFamilyNetTaxBase.label': 'Your family’s tax bases',
    'itpFamilyNetTaxBase.question':
      'From the last income tax returns of your family unit: what do the tax bases of all its members add up to, in euros?',
    'itpFamilyNetTaxBase.why':
      'The rural reduced transfer tax and the 5% rates for large families, single-parent families and disability apply only if this total is at most €36,000 (more for some large and single-parent families).',
    'itpFamilyNetTaxBase.help': 'Add the figure of each member who files a return. {taxBase}',
    'irpfNetTaxBase.label': 'Tax base of your return',
    'irpfNetTaxBase.question':
      'From your last income tax return: what was the tax base, in euros? Use the joint figure if you file jointly.',
    'irpfNetTaxBase.why':
      'The rural deductions for moving and for renting apply only if this figure is at most €30,000 on an individual return or €45,000 on a joint one.',
    'irpfNetTaxBase.help':
      '{taxBase} The deduction looks at the return of the year of the move, so last year’s figure is an indication.',
    'irpfIndividualNetTaxBase.label': 'Your individually computed tax base',
    'irpfIndividualNetTaxBase.question':
      'From your last income tax return: what was your own tax base computed individually, in euros, even if you file jointly?',
    'irpfIndividualNetTaxBase.why':
      'The rural income-tax deduction for buying a main home applies only if this figure is at most €36,000.',
    'depositRate.label': 'Deposit',
    'depositRate.question': 'What share of the price would you pay upfront as a deposit, in percent?',
    'depositRate.why':
      'The deposit is the largest part of the upfront cash. Until you say otherwise the plan assumes 20%.',
    'emergencyReserve.label': 'Emergency reserve',
    'emergencyReserve.question':
      'How much of your savings do you want to keep aside and not spend on the purchase? Zero is a valid answer.',
    'emergencyReserve.why':
      'The plan takes this reserve off your savings before counting them. Until you say otherwise it sets nothing aside.',
  },
  {
    ca: {
      'sensitivity.family':
        'Sobre la teva família. Només es fa servir per comprovar les mesures que s’esmenten aquí. Només es desa si has iniciat la sessió i ho deses; si no, es queda en aquesta estimació i no s’envia enlloc més.',
      'sensitivity.health':
        'Sobre salut. Només es fa servir per comprovar aquest tipus impositiu, i no es demana cap detall més enllà de sí o no. Només es desa si has iniciat la sessió i ho deses; si no, es queda en aquesta estimació i no s’envia enlloc més.',
      'sensitivity.tax':
        'De la teva declaració de la renda. Només es fa servir per comparar-ho amb el límit de la mesura. Només es desa si has iniciat la sessió i ho deses; si no, es queda en aquesta estimació i no s’envia enlloc més.',
      'help.taxBase':
        'No és el teu sou. És la base imposable general més la base imposable de l’estalvi, menys el mínim personal i familiar. A la declaració de la renda de 2025 (Renta 2025, model 100) l’Agència Tributària la calcula com la casella 0435 més la casella 0460 menys la casella 0520. Els números de casella poden canviar d’un any a l’altre, de manera que comprova’n els noms: base imponible general, base imponible del ahorro, mínimo personal y familiar. Si no n’estàs segur, tria «No ho sé».',
      'help.schooling':
        'L’Agència Tributària de Catalunya fixa les condicions exactes. Si encara no les has comprovat, tria «No ho sé» i confirma-ho amb l’agència.',

      'monthlyIncome.label': 'Ingressos mensuals',
      'monthlyIncome.question': 'Quants diners entren a la teva llar en un mes normal, després d’impostos?',
      'monthlyIncome.why': 'El pla estalvia el que queda dels teus ingressos després de les despeses de cada mes.',
      'monthlyExpenses.label': 'Despeses mensuals',
      'monthlyExpenses.question':
        'Quant gasta la teva llar en un mes normal, comptant-hi el lloguer, els rebuts i les quotes de deutes?',
      'monthlyExpenses.why': 'El pla estalvia el que queda dels teus ingressos després de les despeses de cada mes.',
      'purchaseSavings.label': 'Estalvis per a la compra',
      'purchaseSavings.question': 'Quant tens ja estalviat que destinaries a comprar l’habitatge?',
      'purchaseSavings.why':
        'És el punt de partida del termini. Mai no se suposa que un saldo bancari estigui disponible per a la compra.',
      'homeBudget.label': 'Pressupost per a l’habitatge',
      'homeBudget.question': 'Quin és el màxim que pagaries per l’habitatge?',
      'homeBudget.why':
        'L’entrada, l’impost de transmissions patrimonials i les despeses de compra són tots percentatges del preu.',
      'homeBudget.help':
        'Si no tens cap xifra, tria «No ho sé»: el pla pot posar preu a un habitatge d’una superfície determinada a partir de la mitjana de cada poble.',
      'floorArea.label': 'Superfície de l’habitatge',
      'floorArea.question': 'De quina superfície busques l’habitatge, en metres quadrats?',
      'floorArea.why':
        'Sense pressupost, el preu és aquesta superfície multiplicada pel preu mitjà per metre quadrat de cada poble.',
      'primaryResidence.label': 'Habitatge habitual',
      'primaryResidence.question': 'L’habitatge que compris serà on viuràs, el teu habitatge habitual?',
      'primaryResidence.why':
        'Tots els tipus reduïts de l’impost de transmissions patrimonials, les deduccions rurals i l’ajut per a compradors joves són per a l’habitatge on vius.',
      'birthDate.label': 'Data de naixement',
      'birthDate.question': 'Quina és la teva data de naixement?',
      'birthDate.why':
        'Un comprador de 35 anys o menys paga un 5 % d’impost de transmissions patrimonials en lloc del tipus general a tot Catalunya, i alguns ajuts i deduccions tenen el mateix límit d’edat. L’edat es calcula per al dia en què podries comprar, de manera que no queda desfasada.',
      'children.label': 'Fills',
      'children.question':
        'Viuen amb tu fills que depenen de tu? Indica la data de naixement de cadascun, o digues que no n’hi ha.',
      'children.why':
        'L’impost de transmissions patrimonials reduït d’un municipi rural (4 % o 3 %) i les deduccions rurals de l’IRPF són per a llars amb un fill de 16 anys o menys.',
      'itpTransaction.label': 'Compra subjecta a l’impost de transmissions patrimonials',
      'itpTransaction.question':
        'La compra pagarà l’impost de transmissions patrimonials (ITP)? És el cas de la majoria d’habitatges de segona mà; una obra nova venuda pel promotor paga IVA.',
      'itpTransaction.why':
        'Els tipus reduïts són tipus de l’impost de transmissions patrimonials, de manera que cap s’aplica a una compra que paga IVA.',
      'itpOccupancy.label': 'Anar-hi a viure i quedar-s’hi',
      'itpOccupancy.question':
        'Hi aniràs a viure dins dels dotze mesos posteriors a la compra i el mantindràs com a habitatge habitual almenys tres anys?',
      'itpOccupancy.why':
        'Un tipus reduït de l’impost de transmissions patrimonials és provisional: només es manté si es compleixen aquests dos terminis, o si s’aplica una excepció prevista a la llei.',
      'childrenItpSchooling.label': 'Escolarització per a l’ITP rural',
      'childrenItpSchooling.question':
        'Per a cada fill de 4 a 16 anys: complirà les condicions d’escolarització del tipus rural de l’impost de transmissions patrimonials (el lloc de l’escola, el moment i la permanència de la matrícula)?',
      'childrenItpSchooling.why':
        'L’impost de transmissions patrimonials reduït d’un municipi rural requereix un fill de 16 anys o menys que en compleixi les condicions d’escolarització; els fills de 3 anys o menys n’estan exempts.',
      'largeFamily.label': 'Família nombrosa',
      'largeFamily.question': 'La teva família té el títol oficial de família nombrosa?',
      'largeFamily.why':
        'Una família nombrosa reconeguda paga un 5 % d’impost de transmissions patrimonials pel seu habitatge habitual a tot Catalunya.',
      'singleParent.label': 'Família monoparental',
      'singleParent.question': 'La teva família té el títol oficial de família monoparental?',
      'singleParent.why':
        'Una família monoparental reconeguda paga un 5 % d’impost de transmissions patrimonials pel seu habitatge habitual a tot Catalunya, i la seva deducció per traslladar-se a un municipi rural és el doble.',
      'disability65.label': 'Discapacitat del 65 % o més',
      'disability65.question':
        'Tu, o algun membre de la teva unitat familiar, teniu una discapacitat reconeguda del 65 % o més?',
      'disability65.why':
        'Una llar amb una discapacitat reconeguda del 65 % o més paga un 5 % d’impost de transmissions patrimonials pel seu habitatge habitual a tot Catalunya.',
      'firstRuralMove.label': 'Primer trasllat a un municipi rural',
      'firstRuralMove.question': 'Seria la primera vegada que trasllades el teu habitatge a un municipi rural?',
      'firstRuralMove.why':
        'La deducció de l’IRPF per traslladar-se a un municipi rural (750 €, o 1.000 € en un d’atenció especial) és per a un primer trasllat.',
      'childrenIrpfSchooling.label': 'Escolarització per a les deduccions rurals de l’IRPF',
      'childrenIrpfSchooling.question':
        'Per a cada fill de 4 a 16 anys: anirà a escola a la zona educativa del nou habitatge, o al centre que li correspon?',
      'childrenIrpfSchooling.why':
        'Les deduccions rurals de l’IRPF compten un fill de 16 anys o menys que compleixi la seva regla d’escolarització; els fills de 3 anys o menys n’estan exempts.',
      'ownsHomeInSpain.label': 'Un altre habitatge a Espanya',
      'ownsHomeInSpain.question': 'Ets propietari d’un altre habitatge a Espanya, o en tens l’usdefruit?',
      'ownsHomeInSpain.why':
        'L’ajut estatal per a compradors de 35 anys o menys en pobles petits no és per a qui ja té un habitatge en propietat a Espanya, tret que s’apliqui una excepció oficial.',
      'incomeWithinFiveIprem.label': 'Ingressos fins a cinc vegades l’IPREM',
      'incomeWithinFiveIprem.question':
        'Els teus ingressos anuals són com a màxim cinc vegades l’IPREM, l’indicador públic de renda (5,5 o 6 vegades amb una discapacitat reconeguda)?',
      'incomeWithinFiveIprem.why':
        'L’ajut estatal per a compradors de 35 anys o menys en pobles petits té aquest límit d’ingressos.',
      'incomeWithinFiveIprem.help':
        'L’IPREM es fixa cada any als pressupostos generals de l’Estat, i la convocatòria de l’ajut indica el límit en euros. Si no hi has comparat els teus ingressos, tria «No ho sé».',
      'filing.label': 'Tipus de declaració de la renda',
      'filing.question':
        'Presentes la declaració de la renda individualment, o conjuntament amb la teva unitat familiar?',
      'filing.why':
        'Les deduccions rurals per trasllat i per lloguer tenen un límit de renda que en depèn: 30.000 € en declaració individual, 45.000 € en declaració conjunta.',
      'filing.option.individual': 'Individualment',
      'filing.option.joint': 'Conjuntament',
      'itpBuyerNetTaxBase.label': 'La teva base imposable',
      'itpBuyerNetTaxBase.question':
        'De la teva última declaració de la renda: quina va ser la teva pròpia base imposable, en euros?',
      'itpBuyerNetTaxBase.why':
        'L’impost de transmissions patrimonials al 5 % per a compradors de 35 anys o menys només s’aplica si aquesta xifra és com a màxim de 36.000 €.',
      'itpFamilyNetTaxBase.label': 'Les bases imposables de la teva família',
      'itpFamilyNetTaxBase.question':
        'De les últimes declaracions de la renda de la teva unitat familiar: quant sumen les bases imposables de tots els seus membres, en euros?',
      'itpFamilyNetTaxBase.why':
        'L’impost de transmissions patrimonials reduït rural i els tipus del 5 % per a famílies nombroses, famílies monoparentals i discapacitat només s’apliquen si aquest total és com a màxim de 36.000 € (més per a algunes famílies nombroses i monoparentals).',
      'itpFamilyNetTaxBase.help': 'Suma la xifra de cada membre que presenta declaració. {taxBase}',
      'irpfNetTaxBase.label': 'Base imposable de la teva declaració',
      'irpfNetTaxBase.question':
        'De la teva última declaració de la renda: quina va ser la base imposable, en euros? Fes servir la xifra conjunta si presentes declaració conjunta.',
      'irpfNetTaxBase.why':
        'Les deduccions rurals per trasllat i per lloguer només s’apliquen si aquesta xifra és com a màxim de 30.000 € en declaració individual o de 45.000 € en declaració conjunta.',
      'irpfNetTaxBase.help':
        '{taxBase} La deducció té en compte la declaració de l’any del trasllat, de manera que la xifra de l’any passat és orientativa.',
      'irpfIndividualNetTaxBase.label': 'La teva base imposable calculada individualment',
      'irpfIndividualNetTaxBase.question':
        'De la teva última declaració de la renda: quina va ser la teva pròpia base imposable calculada individualment, en euros, encara que presentis declaració conjunta?',
      'irpfIndividualNetTaxBase.why':
        'La deducció rural de l’IRPF per la compra de l’habitatge habitual només s’aplica si aquesta xifra és com a màxim de 36.000 €.',
      'depositRate.label': 'Entrada',
      'depositRate.question': 'Quina part del preu pagaries d’entrada, en percentatge?',
      'depositRate.why':
        'L’entrada és la part més gran dels diners inicials. Mentre no diguis una altra cosa, el pla suposa un 20 %.',
      'emergencyReserve.label': 'Reserva d’emergència',
      'emergencyReserve.question':
        'Quina part dels teus estalvis vols mantenir a part i no gastar en la compra? Zero és una resposta vàlida.',
      'emergencyReserve.why':
        'El pla resta aquesta reserva dels teus estalvis abans de comptar-los. Mentre no diguis una altra cosa, no aparta res.',
    },
    es: {
      'sensitivity.family':
        'Sobre tu familia. Solo se usa para comprobar las medidas que se mencionan aquí. Solo se guarda si has iniciado sesión y lo guardas; si no, se queda en esta estimación y no se envía a ningún otro sitio.',
      'sensitivity.health':
        'Sobre salud. Solo se usa para comprobar este tipo impositivo, y no se pide ningún detalle más allá de sí o no. Solo se guarda si has iniciado sesión y lo guardas; si no, se queda en esta estimación y no se envía a ningún otro sitio.',
      'sensitivity.tax':
        'De tu declaración de la renta. Solo se usa para compararlo con el límite de la medida. Solo se guarda si has iniciado sesión y lo guardas; si no, se queda en esta estimación y no se envía a ningún otro sitio.',
      'help.taxBase':
        'No es tu sueldo. Es la base imponible general más la base imponible del ahorro, menos el mínimo personal y familiar. En la declaración de la renta de 2025 (Renta 2025, modelo 100) la Agencia Tributaria la calcula como la casilla 0435 más la casilla 0460 menos la casilla 0520. Los números de casilla pueden cambiar de un año a otro, así que comprueba los nombres: base imponible general, base imponible del ahorro, mínimo personal y familiar. Si no lo tienes claro, elige «No lo sé».',
      'help.schooling':
        'La Agència Tributària de Catalunya fija las condiciones exactas. Si aún no las has comprobado, elige «No lo sé» y confírmalo con la agencia.',

      'monthlyIncome.label': 'Ingresos mensuales',
      'monthlyIncome.question': '¿Cuánto dinero entra en tu hogar en un mes normal, después de impuestos?',
      'monthlyIncome.why': 'El plan ahorra lo que queda de tus ingresos después de los gastos de cada mes.',
      'monthlyExpenses.label': 'Gastos mensuales',
      'monthlyExpenses.question':
        '¿Cuánto gasta tu hogar en un mes normal, incluidos el alquiler, los recibos y las cuotas de deudas?',
      'monthlyExpenses.why': 'El plan ahorra lo que queda de tus ingresos después de los gastos de cada mes.',
      'purchaseSavings.label': 'Ahorros para la compra',
      'purchaseSavings.question': '¿Cuánto tienes ya ahorrado que destinarías a comprar la vivienda?',
      'purchaseSavings.why':
        'Es el punto de partida del plazo. Nunca se supone que un saldo bancario esté disponible para la compra.',
      'homeBudget.label': 'Presupuesto para la vivienda',
      'homeBudget.question': '¿Cuál es el máximo que pagarías por la vivienda?',
      'homeBudget.why':
        'La entrada, el impuesto de transmisiones patrimoniales y los gastos de compra son todos porcentajes del precio.',
      'homeBudget.help':
        'Si no tienes una cifra, elige «No lo sé»: el plan puede poner precio a una vivienda de una superficie determinada a partir de la media de cada pueblo.',
      'floorArea.label': 'Superficie de la vivienda',
      'floorArea.question': '¿De qué superficie buscas la vivienda, en metros cuadrados?',
      'floorArea.why':
        'Sin presupuesto, el precio es esta superficie multiplicada por el precio medio por metro cuadrado de cada pueblo.',
      'primaryResidence.label': 'Vivienda habitual',
      'primaryResidence.question': '¿La vivienda que compres será donde vivas, tu vivienda habitual?',
      'primaryResidence.why':
        'Todos los tipos reducidos del impuesto de transmisiones patrimoniales, las deducciones rurales y la ayuda para compradores jóvenes son para la vivienda en la que vives.',
      'birthDate.label': 'Fecha de nacimiento',
      'birthDate.question': '¿Cuál es tu fecha de nacimiento?',
      'birthDate.why':
        'Un comprador de 35 años o menos paga un 5 % de impuesto de transmisiones patrimoniales en lugar del tipo general en toda Cataluña, y algunas ayudas y deducciones tienen el mismo límite de edad. La edad se calcula para el día en que podrías comprar, así que no queda desfasada.',
      'children.label': 'Hijos',
      'children.question':
        '¿Viven contigo hijos que dependen de ti? Indica la fecha de nacimiento de cada uno, o di que no hay ninguno.',
      'children.why':
        'El impuesto de transmisiones patrimoniales reducido de un municipio rural (4 % o 3 %) y las deducciones rurales del IRPF son para hogares con un hijo de 16 años o menos.',
      'itpTransaction.label': 'Compra sujeta al impuesto de transmisiones patrimoniales',
      'itpTransaction.question':
        '¿La compra pagará el impuesto de transmisiones patrimoniales (ITP)? Es el caso de la mayoría de viviendas de segunda mano; una obra nueva vendida por el promotor paga IVA.',
      'itpTransaction.why':
        'Los tipos reducidos son tipos del impuesto de transmisiones patrimoniales, así que ninguno se aplica a una compra que paga IVA.',
      'itpOccupancy.label': 'Mudarte y quedarte',
      'itpOccupancy.question':
        '¿Te mudarás en los doce meses siguientes a la compra y la mantendrás como vivienda habitual al menos tres años?',
      'itpOccupancy.why':
        'Un tipo reducido del impuesto de transmisiones patrimoniales es provisional: solo se mantiene si se cumplen esos dos plazos, o si se aplica una excepción prevista en la ley.',
      'childrenItpSchooling.label': 'Escolarización para el ITP rural',
      'childrenItpSchooling.question':
        'Para cada hijo de 4 a 16 años: ¿cumplirá las condiciones de escolarización del tipo rural del impuesto de transmisiones patrimoniales (el lugar del centro, el momento y la permanencia de la matrícula)?',
      'childrenItpSchooling.why':
        'El impuesto de transmisiones patrimoniales reducido de un municipio rural requiere un hijo de 16 años o menos que cumpla sus condiciones de escolarización; los hijos de 3 años o menos están exentos.',
      'largeFamily.label': 'Familia numerosa',
      'largeFamily.question': '¿Tu familia tiene el título oficial de familia numerosa (família nombrosa)?',
      'largeFamily.why':
        'Una familia numerosa reconocida paga un 5 % de impuesto de transmisiones patrimoniales por su vivienda habitual en toda Cataluña.',
      'singleParent.label': 'Familia monoparental',
      'singleParent.question': '¿Tu familia tiene el título oficial de familia monoparental (família monoparental)?',
      'singleParent.why':
        'Una familia monoparental reconocida paga un 5 % de impuesto de transmisiones patrimoniales por su vivienda habitual en toda Cataluña, y su deducción por trasladarse a un municipio rural es el doble.',
      'disability65.label': 'Discapacidad del 65 % o más',
      'disability65.question':
        '¿Tú, o algún miembro de tu unidad familiar, tenéis una discapacidad reconocida del 65 % o más?',
      'disability65.why':
        'Un hogar con una discapacidad reconocida del 65 % o más paga un 5 % de impuesto de transmisiones patrimoniales por su vivienda habitual en toda Cataluña.',
      'firstRuralMove.label': 'Primer traslado a un municipio rural',
      'firstRuralMove.question': '¿Sería la primera vez que trasladas tu vivienda a un municipio rural?',
      'firstRuralMove.why':
        'La deducción del IRPF por trasladarse a un municipio rural (750 €, o 1000 € en uno de atención especial) es para un primer traslado.',
      'childrenIrpfSchooling.label': 'Escolarización para las deducciones rurales del IRPF',
      'childrenIrpfSchooling.question':
        'Para cada hijo de 4 a 16 años: ¿irá al colegio en la zona educativa de la nueva vivienda, o en el centro que le corresponde?',
      'childrenIrpfSchooling.why':
        'Las deducciones rurales del IRPF cuentan un hijo de 16 años o menos que cumpla su regla de escolarización; los hijos de 3 años o menos están exentos.',
      'ownsHomeInSpain.label': 'Otra vivienda en España',
      'ownsHomeInSpain.question': '¿Eres propietario de otra vivienda en España, o tienes su usufructo?',
      'ownsHomeInSpain.why':
        'La ayuda estatal para compradores de 35 años o menos en pueblos pequeños no es para quien ya tiene una vivienda en propiedad en España, salvo que se aplique una excepción oficial.',
      'incomeWithinFiveIprem.label': 'Ingresos de hasta cinco veces el IPREM',
      'incomeWithinFiveIprem.question':
        '¿Tus ingresos anuales son como máximo cinco veces el IPREM, el indicador público de renta (5,5 o 6 veces con una discapacidad reconocida)?',
      'incomeWithinFiveIprem.why':
        'La ayuda estatal para compradores de 35 años o menos en pueblos pequeños tiene ese límite de ingresos.',
      'incomeWithinFiveIprem.help':
        'El IPREM se fija cada año en los presupuestos generales del Estado, y la convocatoria de la ayuda indica el límite en euros. Si no has comparado tus ingresos con él, elige «No lo sé».',
      'filing.label': 'Tipo de declaración de la renta',
      'filing.question':
        '¿Presentas la declaración de la renta individualmente, o conjuntamente con tu unidad familiar?',
      'filing.why':
        'Las deducciones rurales por traslado y por alquiler tienen un límite de renta que depende de ello: 30.000 € en declaración individual, 45.000 € en declaración conjunta.',
      'filing.option.individual': 'Individualmente',
      'filing.option.joint': 'Conjuntamente',
      'itpBuyerNetTaxBase.label': 'Tu base imponible',
      'itpBuyerNetTaxBase.question':
        'De tu última declaración de la renta: ¿cuál fue tu propia base imponible, en euros?',
      'itpBuyerNetTaxBase.why':
        'El impuesto de transmisiones patrimoniales al 5 % para compradores de 35 años o menos solo se aplica si esta cifra es como máximo de 36.000 €.',
      'itpFamilyNetTaxBase.label': 'Las bases imponibles de tu familia',
      'itpFamilyNetTaxBase.question':
        'De las últimas declaraciones de la renta de tu unidad familiar: ¿cuánto suman las bases imponibles de todos sus miembros, en euros?',
      'itpFamilyNetTaxBase.why':
        'El impuesto de transmisiones patrimoniales reducido rural y los tipos del 5 % para familias numerosas, familias monoparentales y discapacidad solo se aplican si este total es como máximo de 36.000 € (más para algunas familias numerosas y monoparentales).',
      'itpFamilyNetTaxBase.help': 'Suma la cifra de cada miembro que presenta declaración. {taxBase}',
      'irpfNetTaxBase.label': 'Base imponible de tu declaración',
      'irpfNetTaxBase.question':
        'De tu última declaración de la renta: ¿cuál fue la base imponible, en euros? Usa la cifra conjunta si presentas declaración conjunta.',
      'irpfNetTaxBase.why':
        'Las deducciones rurales por traslado y por alquiler solo se aplican si esta cifra es como máximo de 30.000 € en declaración individual o de 45.000 € en declaración conjunta.',
      'irpfNetTaxBase.help':
        '{taxBase} La deducción tiene en cuenta la declaración del año del traslado, así que la cifra del año pasado es orientativa.',
      'irpfIndividualNetTaxBase.label': 'Tu base imponible calculada individualmente',
      'irpfIndividualNetTaxBase.question':
        'De tu última declaración de la renta: ¿cuál fue tu propia base imponible calculada individualmente, en euros, aunque presentes declaración conjunta?',
      'irpfIndividualNetTaxBase.why':
        'La deducción rural del IRPF por la compra de la vivienda habitual solo se aplica si esta cifra es como máximo de 36.000 €.',
      'depositRate.label': 'Entrada',
      'depositRate.question': '¿Qué parte del precio pagarías de entrada, en porcentaje?',
      'depositRate.why':
        'La entrada es la parte más grande del dinero inicial. Mientras no digas otra cosa, el plan supone un 20 %.',
      'emergencyReserve.label': 'Reserva de emergencia',
      'emergencyReserve.question':
        '¿Qué parte de tus ahorros quieres mantener aparte y no gastar en la compra? Cero es una respuesta válida.',
      'emergencyReserve.why':
        'El plan resta esta reserva de tus ahorros antes de contarlos. Mientras no digas otra cosa, no aparta nada.',
    },
  },
);

/** What a person is told about an answer: validation next to the field, and an answer in words. */
export const answerMessages = defineMessages(
  {
    whatIf: 'What-if estimate',
    giveAnswer: 'Give an answer first.',
    needsValue: 'This one needs a value: the plan cannot use “I don’t know” here.',
    yesOrNo: 'Choose yes or no.',
    fullDate: 'Enter the full date: day, month and year.',
    dateInFuture: 'The date cannot be in the future.',
    dateTooOld: 'That date is more than 120 years ago.',
    amountDigits: 'Enter an amount in euros, digits only.',
    amountCents: 'Enter an amount in euros and cents.',
    amountNegative: 'The amount cannot be negative.',
    amountAtLeast: 'Enter at least {amount}.',
    amountAtMost: 'Enter at most {amount}.',
    numberOf: 'Enter a number of {unit}.',
    numberBetween: 'Enter between {min} and {max} {unit}.',
    percentBetween: 'Enter a percentage between {min} and {max}.',
    chooseOption: 'Choose one of the options.',
    listChildren: 'List the children, or say there are none.',
    tooManyChildren: 'List at most 12 children.',
    childFullDate: 'Enter the full date of birth of child {number}: day, month and year.',
    childDateInFuture: 'The date of birth of child {number} cannot be in the future.',
    childDateTooOld: 'The date of birth of child {number} is too long ago.',
    perChild: 'Answer yes, no or “I don’t know” for each child.',
    eachChildListed: 'Answer for each child listed.',

    dontKnow: 'I don’t know',
    yes: 'Yes',
    no: 'No',
    ageAsStated: 'Age {age}, as stated',
    bornAgeOn: 'Born {born}: {age} on {day}',
    noChildren: 'No children',
    flagYes: 'yes',
    flagNo: 'no',
    flagUnknown: 'not known',
    childBornOn: 'Child {number} (born {born}, aged {age})',
    childBornIn: 'Child {number} (born in {year}, aged {age})',
    childAged: 'Child {number} (aged {age})',
    childAgeUnknown: 'Child {number} (age unknown)',
    bornOn: 'born {born}, aged {age}',
    bornIn: 'born in {year}, aged {age}',
    aged: 'aged {age}',
    ageUnknown: 'age unknown',
  },
  {
    ca: {
      whatIf: 'Estimació hipotètica',
      giveAnswer: 'Primer dona una resposta.',
      needsValue: 'Aquí cal un valor: el pla no pot fer servir «No ho sé» en aquest cas.',
      yesOrNo: 'Tria sí o no.',
      fullDate: 'Escriu la data completa: dia, mes i any.',
      dateInFuture: 'La data no pot ser futura.',
      dateTooOld: 'Aquesta data és de fa més de 120 anys.',
      amountDigits: 'Escriu un import en euros, només amb xifres.',
      amountCents: 'Escriu un import en euros i cèntims.',
      amountNegative: 'L’import no pot ser negatiu.',
      amountAtLeast: 'Escriu com a mínim {amount}.',
      amountAtMost: 'Escriu com a màxim {amount}.',
      numberOf: 'Escriu un nombre de {unit}.',
      numberBetween: 'Escriu un valor entre {min} i {max} {unit}.',
      percentBetween: 'Escriu un percentatge entre {min} i {max}.',
      chooseOption: 'Tria una de les opcions.',
      listChildren: 'Indica els fills, o digues que no n’hi ha.',
      tooManyChildren: 'Indica com a màxim 12 fills.',
      childFullDate: 'Escriu la data de naixement completa del fill {number}: dia, mes i any.',
      childDateInFuture: 'La data de naixement del fill {number} no pot ser futura.',
      childDateTooOld: 'La data de naixement del fill {number} és massa antiga.',
      perChild: 'Respon sí, no o «No ho sé» per a cada fill.',
      eachChildListed: 'Respon per a cada fill indicat.',

      dontKnow: 'No ho sé',
      yes: 'Sí',
      no: 'No',
      ageAsStated: '{age} anys, segons s’ha indicat',
      bornAgeOn: '{born}: {age} anys el {day}',
      noChildren: 'Sense fills',
      flagYes: 'sí',
      flagNo: 'no',
      flagUnknown: 'no se sap',
      childBornOn: 'Fill {number} (naixement: {born}; {age} anys)',
      childBornIn: 'Fill {number} (nascut el {year}; {age} anys)',
      childAged: 'Fill {number} ({age} anys)',
      childAgeUnknown: 'Fill {number} (edat desconeguda)',
      bornOn: 'naixement: {born}; {age} anys',
      bornIn: 'nascut el {year}; {age} anys',
      aged: '{age} anys',
      ageUnknown: 'edat desconeguda',
    },
    es: {
      whatIf: 'Estimación hipotética',
      giveAnswer: 'Primero da una respuesta.',
      needsValue: 'Aquí hace falta un valor: el plan no puede usar «No lo sé» en este caso.',
      yesOrNo: 'Elige sí o no.',
      fullDate: 'Escribe la fecha completa: día, mes y año.',
      dateInFuture: 'La fecha no puede ser futura.',
      dateTooOld: 'Esa fecha es de hace más de 120 años.',
      amountDigits: 'Escribe un importe en euros, solo con cifras.',
      amountCents: 'Escribe un importe en euros y céntimos.',
      amountNegative: 'El importe no puede ser negativo.',
      amountAtLeast: 'Escribe como mínimo {amount}.',
      amountAtMost: 'Escribe como máximo {amount}.',
      numberOf: 'Escribe un número de {unit}.',
      numberBetween: 'Escribe un valor entre {min} y {max} {unit}.',
      percentBetween: 'Escribe un porcentaje entre {min} y {max}.',
      chooseOption: 'Elige una de las opciones.',
      listChildren: 'Indica los hijos, o di que no hay ninguno.',
      tooManyChildren: 'Indica como máximo 12 hijos.',
      childFullDate: 'Escribe la fecha de nacimiento completa del hijo {number}: día, mes y año.',
      childDateInFuture: 'La fecha de nacimiento del hijo {number} no puede ser futura.',
      childDateTooOld: 'La fecha de nacimiento del hijo {number} es demasiado antigua.',
      perChild: 'Responde sí, no o «No lo sé» para cada hijo.',
      eachChildListed: 'Responde para cada hijo indicado.',

      dontKnow: 'No lo sé',
      yes: 'Sí',
      no: 'No',
      ageAsStated: '{age} años, según se indicó',
      bornAgeOn: '{born}: {age} años el {day}',
      noChildren: 'Sin hijos',
      flagYes: 'sí',
      flagNo: 'no',
      flagUnknown: 'no se sabe',
      childBornOn: 'Hijo {number} (nacimiento: {born}; {age} años)',
      childBornIn: 'Hijo {number} (nacido en {year}; {age} años)',
      childAged: 'Hijo {number} ({age} años)',
      childAgeUnknown: 'Hijo {number} (edad desconocida)',
      bornOn: 'nacimiento: {born}; {age} años',
      bornIn: 'nacido en {year}; {age} años',
      aged: '{age} años',
      ageUnknown: 'edad desconocida',
    },
  },
);
