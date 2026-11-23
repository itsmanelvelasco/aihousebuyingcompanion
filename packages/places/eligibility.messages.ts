import { defineMessages } from '../i18n/messages.ts';

/**
 * The conditions a measure is screened against, as a person reads them, and the next step.
 *
 * These sentences state tax and aid conditions: each translation says exactly what the English
 * says, no more and no less. Official terms stay as the administrations write them (ITP/TPO, IRPF,
 * IPREM, base imposable / base imponible, habitatge habitual / vivienda habitual).
 */
export const eligibilityMessages = defineMessages(
  {
    residence: 'The property is or will be the habitual residence.',
    irpfIndividualBase: 'The claimant’s individually computed IRPF tax base is at most €36,000.',
    irpfChild:
      'At least one dependent child is aged up to 16 and meets IRPF schooling rules. Children up to 3 are exempt from schooling.',
    irpfAgeOrChild18: 'Claimant is 18–35, or the household has a qualifying child under the schooling rule.',
    irpfAgeOrChild35: 'Claimant is 35 or younger, or the household has a qualifying child under the schooling rule.',
    irpfFilingBase: 'The applicable current-year IRPF tax base is at most €30,000 individually or €45,000 jointly.',
    itpTransaction: 'A qualifying acquisition right is subject to ITP/TPO.',
    itpOccupancyGeneral:
      'The home is occupied within twelve months and kept as the habitual residence for three years, or an official exception applies.',
    familyBaseWithIncreases:
      'The family’s combined net tax bases on the last IRPF return total at most €36,000, plus €14,000 for each child above the legal minimum for the family category.',
    firstRuralMove: 'This is the claimant’s first rural relocation.',
    purchaseDeductionRules: 'The occupancy, investment, patrimony and other purchase-deduction rules are satisfied.',
    qualifyingRent: 'Qualifying rent was paid and the landlord can be identified on the return.',
    rentCompatibility: 'The claimant meets the deduction compatibility rules.',
    pre1970: 'The home was built before 1 January 1970.',
    rehabilitationRules: 'The official structural works, occupancy, investment and rehabilitation rules are satisfied.',
    itpSchoolChild:
      'At least one child up to age 16 meets the ITP schooling rules. Children up to 3 are exempt from schooling.',
    itpFamilyBase: 'The family’s combined net tax bases on the last applicable IRPF return total at most €36,000.',
    itpOccupancyRural:
      'The reduced rate’s acquisition and habitual-residence deadlines or an official exception are satisfied.',
    itpBuyerBase: 'The buyer’s own net tax base on the last IRPF return before the purchase is at most €36,000.',
    itpRehabilitationRules:
      'The works are structural rehabilitation above 25% of the price or market value, end within two years of the purchase, and the occupancy deadlines are met.',
    buyerAge35: 'The buyer is 35 or younger on the date the transfer tax accrues.',
    largeFamily: 'The buyer is a member of an officially recognised large family.',
    singleParent: 'The buyer is a member of an officially recognised single-parent family.',
    disability65: 'The buyer or a member of the buyer’s family unit has a recognised disability of 65% or more.',
    familyUnitBase:
      'The family unit’s combined net tax bases on the last IRPF return before the purchase total at most €36,000.',
    vacantHomeOwner: 'The applicant is a private owner of a qualifying vacant dwelling.',
    grantVerify:
      'Verify the technical project, residential use commitment, expense conditions and documentation with the housing agency.',
    applicantAge35:
      'The applicant is 35 or younger when applying, or when signing a purchase contract that predates the call.',
    priceCap: 'The purchase price, or the self-build cost excluding land, is at most €300,000 in Catalonia.',
    noOtherHome:
      'The applicant does not own or hold a usufruct over another home in Spain, unless an official exception applies.',
    incomeIprem: 'Annual income is at most 5 times IPREM (5.5 or 6 times with a recognised disability).',

    geoSmallTown: 'The municipality has 10,000 residents or fewer.',
    geoSmallNucleusConfirm: 'Confirm that the population nucleus has 10,000 residents or fewer under the call.',
    geoSmallTownRequired: 'The municipality or population nucleus must have 10,000 residents or fewer.',
    geoCatalonia: 'The measure applies in every municipality of Catalonia.',
    geoGrantList: 'Municipality must be listed in the specific 2026 grant call.',
    geoHistorical: 'The historical rural classification for the event date needs official verification.',
    geoRuralRequired: 'The municipality must be covered by the rural classification on the event date.',
    geoInScope: 'Municipality is within the measure’s geographic scope.',
    geoCapitalOutside: 'The municipal capital is outside this measure’s geographic scope.',
    geoNucleusConfirm: 'Confirm the dwelling is in a covered attached nucleus using the official municipality list.',

    eventDate: 'Provide the actual or planned qualifying event date.',
    contractDate: 'The purchase contract is signed on or after 1 January 2026.',
    noCall: 'No Catalan call for this aid could be verified; its bases will set the final amount and conditions.',
    confirmMeasure: 'Confirm whether the measure applies for the stated event date.',

    nextFutureCall: 'Check the housing agency’s official page for a future call.',
    nextGrant: 'Review the application and supporting documents on Tràmits Gencat.',
    nextTax: 'Confirm the dated facts and claiming procedure with the Catalan Tax Agency.',
  },
  {
    ca: {
      residence: 'L’immoble és o serà l’habitatge habitual.',
      irpfIndividualBase:
        'La base imposable de l’IRPF del sol·licitant, calculada individualment, és com a màxim de 36.000 €.',
      irpfChild:
        'Almenys un fill a càrrec té fins a 16 anys i compleix les regles d’escolarització de l’IRPF. Els fills de fins a 3 anys estan exempts d’escolarització.',
      irpfAgeOrChild18:
        'El sol·licitant té entre 18 i 35 anys, o la llar té un fill que compleix la regla d’escolarització.',
      irpfAgeOrChild35:
        'El sol·licitant té 35 anys o menys, o la llar té un fill que compleix la regla d’escolarització.',
      irpfFilingBase:
        'La base imposable de l’IRPF aplicable de l’exercici en curs és com a màxim de 30.000 € en tributació individual o de 45.000 € en tributació conjunta.',
      itpTransaction: 'Un dret d’adquisició que hi dona dret està subjecte a ITP/TPO.',
      itpOccupancyGeneral:
        'L’habitatge s’ocupa en el termini de dotze mesos i es manté com a habitatge habitual durant tres anys, o s’aplica una excepció oficial.',
      familyBaseWithIncreases:
        'Les bases imposables netes de la família a l’última declaració de l’IRPF sumen com a màxim 36.000 €, més 14.000 € per cada fill per sobre del mínim legal de la categoria de família.',
      firstRuralMove: 'És el primer trasllat del sol·licitant a un municipi rural.',
      purchaseDeductionRules:
        'Es compleixen les regles d’ocupació, d’inversió, de patrimoni i la resta de regles de la deducció per compra.',
      qualifyingRent: 'S’ha pagat un lloguer que hi dona dret i l’arrendador es pot identificar a la declaració.',
      rentCompatibility: 'El sol·licitant compleix les regles de compatibilitat de la deducció.',
      pre1970: 'L’habitatge es va construir abans de l’1 de gener de 1970.',
      rehabilitationRules:
        'Es compleixen les regles oficials d’obres estructurals, d’ocupació, d’inversió i de rehabilitació.',
      itpSchoolChild:
        'Almenys un fill de fins a 16 anys compleix les regles d’escolarització de l’ITP. Els fills de fins a 3 anys estan exempts d’escolarització.',
      itpFamilyBase:
        'Les bases imposables netes de la família a l’última declaració de l’IRPF aplicable sumen com a màxim 36.000 €.',
      itpOccupancyRural:
        'Es compleixen els terminis d’adquisició i d’habitatge habitual del tipus reduït, o una excepció oficial.',
      itpBuyerBase:
        'La base imposable neta del comprador a l’última declaració de l’IRPF anterior a la compra és com a màxim de 36.000 €.',
      itpRehabilitationRules:
        'Les obres són de rehabilitació estructural per sobre del 25 % del preu o del valor de mercat, acaben dins dels dos anys posteriors a la compra, i es compleixen els terminis d’ocupació.',
      buyerAge35: 'El comprador té 35 anys o menys en la data en què es merita l’impost de transmissions patrimonials.',
      largeFamily: 'El comprador és membre d’una família nombrosa reconeguda oficialment.',
      singleParent: 'El comprador és membre d’una família monoparental reconeguda oficialment.',
      disability65:
        'El comprador o un membre de la seva unitat familiar té una discapacitat reconeguda del 65 % o més.',
      familyUnitBase:
        'Les bases imposables netes de la unitat familiar a l’última declaració de l’IRPF anterior a la compra sumen com a màxim 36.000 €.',
      vacantHomeOwner: 'El sol·licitant és propietari particular d’un habitatge buit que hi dona dret.',
      grantVerify:
        'Cal verificar amb l’Agència de l’Habitatge el projecte tècnic, el compromís d’ús residencial, les condicions de despesa i la documentació.',
      applicantAge35:
        'El sol·licitant té 35 anys o menys en el moment de sol·licitar l’ajut, o en signar un contracte de compra anterior a la convocatòria.',
      priceCap: 'El preu de compra, o el cost d’autopromoció sense el sòl, és com a màxim de 300.000 € a Catalunya.',
      noOtherHome:
        'El sol·licitant no és propietari ni usufructuari d’un altre habitatge a Espanya, tret que s’apliqui una excepció oficial.',
      incomeIprem:
        'Els ingressos anuals són com a màxim 5 vegades l’IPREM (5,5 o 6 vegades amb una discapacitat reconeguda).',

      geoSmallTown: 'El municipi té 10.000 habitants o menys.',
      geoSmallNucleusConfirm:
        'Cal confirmar que el nucli de població té 10.000 habitants o menys segons la convocatòria.',
      geoSmallTownRequired: 'El municipi o el nucli de població ha de tenir 10.000 habitants o menys.',
      geoCatalonia: 'La mesura s’aplica a tots els municipis de Catalunya.',
      geoGrantList: 'El municipi ha de constar a la convocatòria específica de subvencions de 2026.',
      geoHistorical: 'La classificació rural històrica per a la data del fet s’ha de verificar oficialment.',
      geoRuralRequired: 'El municipi ha d’estar inclòs a la classificació rural en la data del fet.',
      geoInScope: 'El municipi és dins l’àmbit geogràfic de la mesura.',
      geoCapitalOutside: 'El cap de municipi queda fora de l’àmbit geogràfic d’aquesta mesura.',
      geoNucleusConfirm:
        'Cal confirmar amb la llista oficial de municipis que l’habitatge és en un nucli agregat inclòs.',

      eventDate: 'Indica la data real o prevista del fet que hi dona dret.',
      contractDate: 'El contracte de compra se signa l’1 de gener de 2026 o després.',
      noCall:
        'No s’ha pogut verificar cap convocatòria catalana d’aquest ajut; les seves bases fixaran l’import i les condicions definitius.',
      confirmMeasure: 'Cal confirmar si la mesura s’aplica per a la data del fet indicada.',

      nextFutureCall: 'Consulta la pàgina oficial de l’Agència de l’Habitatge per si hi ha una convocatòria futura.',
      nextGrant: 'Revisa la sol·licitud i la documentació acreditativa a Tràmits Gencat.',
      nextTax:
        'Confirma els fets amb les seves dates i el procediment per aplicar-la amb l’Agència Tributària de Catalunya.',
    },
    es: {
      residence: 'El inmueble es o será la vivienda habitual.',
      irpfIndividualBase:
        'La base imponible del IRPF del solicitante, calculada individualmente, es como máximo de 36.000 €.',
      irpfChild:
        'Al menos un hijo a cargo tiene hasta 16 años y cumple las reglas de escolarización del IRPF. Los hijos de hasta 3 años están exentos de escolarización.',
      irpfAgeOrChild18:
        'El solicitante tiene entre 18 y 35 años, o el hogar tiene un hijo que cumple la regla de escolarización.',
      irpfAgeOrChild35:
        'El solicitante tiene 35 años o menos, o el hogar tiene un hijo que cumple la regla de escolarización.',
      irpfFilingBase:
        'La base imponible del IRPF aplicable del ejercicio en curso es como máximo de 30.000 € en tributación individual o de 45.000 € en tributación conjunta.',
      itpTransaction: 'Un derecho de adquisición que da derecho a la medida está sujeto a ITP/TPO.',
      itpOccupancyGeneral:
        'La vivienda se ocupa en el plazo de doce meses y se mantiene como vivienda habitual durante tres años, o se aplica una excepción oficial.',
      familyBaseWithIncreases:
        'Las bases imponibles netas de la familia en la última declaración del IRPF suman como máximo 36.000 €, más 14.000 € por cada hijo por encima del mínimo legal de la categoría de familia.',
      firstRuralMove: 'Es el primer traslado del solicitante a un municipio rural.',
      purchaseDeductionRules:
        'Se cumplen las reglas de ocupación, de inversión, de patrimonio y las demás reglas de la deducción por compra.',
      qualifyingRent:
        'Se ha pagado un alquiler que da derecho a la deducción y el arrendador puede identificarse en la declaración.',
      rentCompatibility: 'El solicitante cumple las reglas de compatibilidad de la deducción.',
      pre1970: 'La vivienda se construyó antes del 1 de enero de 1970.',
      rehabilitationRules:
        'Se cumplen las reglas oficiales de obras estructurales, de ocupación, de inversión y de rehabilitación.',
      itpSchoolChild:
        'Al menos un hijo de hasta 16 años cumple las reglas de escolarización del ITP. Los hijos de hasta 3 años están exentos de escolarización.',
      itpFamilyBase:
        'Las bases imponibles netas de la familia en la última declaración del IRPF aplicable suman como máximo 36.000 €.',
      itpOccupancyRural:
        'Se cumplen los plazos de adquisición y de vivienda habitual del tipo reducido, o una excepción oficial.',
      itpBuyerBase:
        'La base imponible neta del comprador en la última declaración del IRPF anterior a la compra es como máximo de 36.000 €.',
      itpRehabilitationRules:
        'Las obras son de rehabilitación estructural por encima del 25 % del precio o del valor de mercado, terminan dentro de los dos años posteriores a la compra, y se cumplen los plazos de ocupación.',
      buyerAge35:
        'El comprador tiene 35 años o menos en la fecha en que se devenga el impuesto de transmisiones patrimoniales.',
      largeFamily: 'El comprador es miembro de una familia numerosa reconocida oficialmente.',
      singleParent: 'El comprador es miembro de una familia monoparental reconocida oficialmente.',
      disability65: 'El comprador o un miembro de su unidad familiar tiene una discapacidad reconocida del 65 % o más.',
      familyUnitBase:
        'Las bases imponibles netas de la unidad familiar en la última declaración del IRPF anterior a la compra suman como máximo 36.000 €.',
      vacantHomeOwner: 'El solicitante es propietario particular de una vivienda vacía que da derecho a la ayuda.',
      grantVerify:
        'Hay que verificar con la Agència de l’Habitatge el proyecto técnico, el compromiso de uso residencial, las condiciones de gasto y la documentación.',
      applicantAge35:
        'El solicitante tiene 35 años o menos al solicitar la ayuda, o al firmar un contrato de compra anterior a la convocatoria.',
      priceCap:
        'El precio de compra, o el coste de autopromoción sin el suelo, es como máximo de 300.000 € en Cataluña.',
      noOtherHome:
        'El solicitante no es propietario ni usufructuario de otra vivienda en España, salvo que se aplique una excepción oficial.',
      incomeIprem:
        'Los ingresos anuales son como máximo 5 veces el IPREM (5,5 o 6 veces con una discapacidad reconocida).',

      geoSmallTown: 'El municipio tiene 10.000 habitantes o menos.',
      geoSmallNucleusConfirm:
        'Hay que confirmar que el núcleo de población tiene 10.000 habitantes o menos según la convocatoria.',
      geoSmallTownRequired: 'El municipio o el núcleo de población debe tener 10.000 habitantes o menos.',
      geoCatalonia: 'La medida se aplica en todos los municipios de Cataluña.',
      geoGrantList: 'El municipio debe figurar en la convocatoria específica de subvenciones de 2026.',
      geoHistorical: 'La clasificación rural histórica para la fecha del hecho debe verificarse oficialmente.',
      geoRuralRequired: 'El municipio debe estar incluido en la clasificación rural en la fecha del hecho.',
      geoInScope: 'El municipio está dentro del ámbito geográfico de la medida.',
      geoCapitalOutside: 'La capital del municipio queda fuera del ámbito geográfico de esta medida.',
      geoNucleusConfirm:
        'Hay que confirmar con la lista oficial de municipios que la vivienda está en un núcleo agregado incluido.',

      eventDate: 'Indica la fecha real o prevista del hecho que da derecho a la medida.',
      contractDate: 'El contrato de compra se firma el 1 de enero de 2026 o después.',
      noCall:
        'No se ha podido verificar ninguna convocatoria catalana de esta ayuda; sus bases fijarán el importe y las condiciones definitivos.',
      confirmMeasure: 'Hay que confirmar si la medida se aplica para la fecha del hecho indicada.',

      nextFutureCall: 'Consulta la página oficial de la Agència de l’Habitatge por si hay una convocatoria futura.',
      nextGrant: 'Revisa la solicitud y la documentación acreditativa en Tràmits Gencat.',
      nextTax:
        'Confirma los hechos con sus fechas y el procedimiento para aplicarla con la Agència Tributària de Catalunya.',
    },
  },
);
