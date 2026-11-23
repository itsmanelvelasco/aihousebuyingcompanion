import { defineMessages } from '../i18n/messages.ts';

/**
 * What the town recommendation says: why a town matches, what it costs in compromises, why a town
 * was excluded, and what the result cannot tell. Place and comarca names and rail line names are
 * passed in as they are.
 */
export const recommendMessages = defineMessages(
  {
    schoolEstimatedWalks: 'estimated walks',
    schoolRailAndWalks: 'scheduled rail with estimated walks',
    schoolNearbyListed: 'nearby listed schools',
    schoolCovered: 'Requested school stages are covered by {options}.',

    appliedStages: 'Screened the requested school stages.',
    appliedStageRange: 'Compared the range of education stages listed within each municipality.',
    askStages: 'Which school stages should we require?',
    verifyWorkTravel: 'Check travel to the workplace from the shortlisted towns.',
    appliedRural: 'Preferred towns with an official municipality-wide rural classification.',
    appliedLargerTown: 'Preferred towns with a larger published population.',
    verifyDog: 'Check pet permission for the specific home and suitable dog-walking areas nearby.',
    verifyBroadband: 'Check broadband availability and speed at the specific address.',
    askSetting: 'Would you prefer a rural municipality or a larger town?',

    outsideComarca: 'Outside the requested comarca.',
    ruralNotEvidenced: 'The requested municipality-wide rural classification is not evidenced.',
    ruralSpecialAttention: 'Official rural classification: special attention.',
    ruralRural: 'Official rural classification: rural.',
    ruralPartial: 'Rural tax benefits depend on the exact attached settlement.',
    population: 'Published population of {population} ({observedAt}) informs the larger-town preference.',
    housingInsufficient: 'Published housing data is insufficient to screen the budget.',
    housingOverBudget: 'The housing estimate exceeds the requested budget.',
    housingWithinMunicipality: 'The municipality housing estimate of {amount} is within the stated budget.',
    housingWithinComarca: 'The comarca housing estimate of {amount} is within the stated budget.',
    comarcaAverage:
      'Purchase estimate uses the {comarca} comarca average because the municipal resale price is unavailable.',
    historicalAverages:
      'Housing budget is screened using historical averages. Check actual homes and transaction costs.',
    noSchoolOption: 'No evidenced {stage} school option meets the requested journey constraints.',
    verifySchools: 'Verify school admissions, walkability and the return journey.',
    inTownSchools: 'In-town schools are listed for {count} education stage(s).',
    confirmStages: 'Confirm the stages you need and check school admissions and travel.',
    noListedSchool: 'The snapshot has no listed school in this municipality. Check nearby schools.',
    noCommute: 'No evidenced direct rail commute meets the stated destination, time limit and departure window.',
    commute:
      'Direct {line} connection in approximately {minutes} minutes, including estimated walks from and to the municipal centres.',
    railTimes: 'Rail journey times come from the cached timetable and exclude delays.',

    limitCoverage:
      'Recommendations cover the selected Catalan municipalities in the pilot. Scheduled rail coverage is limited to the FGC Lleida–La Pobla corridor.',
    limitScores:
      'Scores rank only known preference signals. The dated snapshot provides estimates and scheduled access.',
    limitTravelDate: 'The requested travel date is outside the cached FGC timetable.',

    'stage.nursery': 'nursery',
    'stage.infantil': 'infantil',
    'stage.primary': 'primary',
    'stage.eso': 'eso',
    'stage.batxillerat': 'batxillerat',
    'stage.fp': 'fp',
  },
  {
    ca: {
      schoolEstimatedWalks: 'trajectes a peu estimats',
      schoolRailAndWalks: 'tren amb horari i trams a peu estimats',
      schoolNearbyListed: 'escoles properes del directori',
      schoolCovered: 'Les etapes escolars demanades queden cobertes amb: {options}.',

      appliedStages: 'S’han filtrat les etapes escolars demanades.',
      appliedStageRange: 'S’ha comparat el ventall d’etapes educatives que consten a cada municipi.',
      askStages: 'Quines etapes escolars hem d’exigir?',
      verifyWorkTravel: 'Comprova el desplaçament a la feina des dels pobles preseleccionats.',
      appliedRural: 'S’han prioritzat els pobles amb classificació rural oficial per a tot el municipi.',
      appliedLargerTown: 'S’han prioritzat els pobles amb més població publicada.',
      verifyDog:
        'Comprova si s’admeten animals a l’habitatge concret i si hi ha zones adequades per passejar el gos a prop.',
      verifyBroadband: 'Comprova la disponibilitat i la velocitat de la banda ampla a l’adreça concreta.',
      askSetting: 'Prefereixes un municipi rural o un poble més gran?',

      outsideComarca: 'Fora de la comarca demanada.',
      ruralNotEvidenced: 'No hi ha constància de la classificació rural per a tot el municipi que s’ha demanat.',
      ruralSpecialAttention: 'Classificació rural oficial: atenció especial.',
      ruralRural: 'Classificació rural oficial: rural.',
      ruralPartial: 'Els beneficis fiscals rurals depenen del nucli agregat exacte.',
      population:
        'La població publicada, de {population} habitants ({observedAt}), es té en compte per a la preferència per un poble més gran.',
      housingInsufficient: 'Les dades d’habitatge publicades no són suficients per filtrar el pressupost.',
      housingOverBudget: 'L’estimació del cost de l’habitatge supera el pressupost demanat.',
      housingWithinMunicipality:
        'L’estimació del cost de l’habitatge al municipi, de {amount}, és dins del pressupost indicat.',
      housingWithinComarca:
        'L’estimació del cost de l’habitatge a la comarca, de {amount}, és dins del pressupost indicat.',
      comarcaAverage:
        'L’estimació de compra fa servir la mitjana de la comarca ({comarca}) perquè el preu municipal de segona mà no està disponible.',
      historicalAverages:
        'El pressupost per a l’habitatge es filtra amb mitjanes històriques. Comprova habitatges reals i les despeses de la compravenda.',
      noSchoolOption:
        'No hi ha constància de cap opció escolar per a l’etapa demanada ({stage}) que compleixi les condicions de trajecte indicades.',
      verifySchools: 'Verifica l’admissió a les escoles, si s’hi pot anar a peu i el trajecte de tornada.',
      inTownSchools:
        '{count, plural, one {Consten escoles al mateix poble per a # etapa educativa.} other {Consten escoles al mateix poble per a # etapes educatives.}}',
      confirmStages: 'Confirma les etapes que necessites i comprova l’admissió a les escoles i els trajectes.',
      noListedSchool: 'El conjunt de dades no recull cap escola en aquest municipi. Comprova les escoles properes.',
      noCommute:
        'No hi ha constància de cap trajecte directe en tren que compleixi la destinació, el límit de temps i la franja de sortida indicats.',
      commute:
        'Connexió directa amb la línia {line} en uns {minutes} minuts, comptant-hi els trams a peu estimats des del centre d’un municipi i fins al de l’altre.',
      railTimes: 'Els temps de viatge en tren provenen de l’horari desat i no inclouen retards.',

      limitCoverage:
        'Les recomanacions cobreixen els municipis catalans seleccionats per al pilot. La cobertura de tren amb horari es limita al corredor d’FGC Lleida–La Pobla.',
      limitScores:
        'Les puntuacions només ordenen els senyals de preferència coneguts. El conjunt de dades, amb la seva data, aporta estimacions i accessos amb horari.',
      limitTravelDate: 'La data de viatge demanada queda fora de l’horari d’FGC desat.',

      'stage.nursery': 'llar d’infants',
      'stage.infantil': 'educació infantil',
      'stage.primary': 'primària',
      'stage.eso': 'ESO',
      'stage.batxillerat': 'batxillerat',
      'stage.fp': 'formació professional',
    },
    es: {
      schoolEstimatedWalks: 'trayectos a pie estimados',
      schoolRailAndWalks: 'tren con horario y tramos a pie estimados',
      schoolNearbyListed: 'escuelas cercanas del directorio',
      schoolCovered: 'Las etapas escolares pedidas quedan cubiertas con: {options}.',

      appliedStages: 'Se han filtrado las etapas escolares pedidas.',
      appliedStageRange: 'Se ha comparado el abanico de etapas educativas que constan en cada municipio.',
      askStages: '¿Qué etapas escolares debemos exigir?',
      verifyWorkTravel: 'Comprueba el desplazamiento al trabajo desde los pueblos preseleccionados.',
      appliedRural: 'Se han priorizado los pueblos con clasificación rural oficial para todo el municipio.',
      appliedLargerTown: 'Se han priorizado los pueblos con más población publicada.',
      verifyDog:
        'Comprueba si se admiten animales en la vivienda concreta y si hay zonas adecuadas para pasear al perro cerca.',
      verifyBroadband: 'Comprueba la disponibilidad y la velocidad de la banda ancha en la dirección concreta.',
      askSetting: '¿Prefieres un municipio rural o un pueblo más grande?',

      outsideComarca: 'Fuera de la comarca pedida.',
      ruralNotEvidenced: 'No hay constancia de la clasificación rural para todo el municipio que se ha pedido.',
      ruralSpecialAttention: 'Clasificación rural oficial: atención especial.',
      ruralRural: 'Clasificación rural oficial: rural.',
      ruralPartial: 'Los beneficios fiscales rurales dependen del núcleo agregado exacto.',
      population:
        'La población publicada, de {population} habitantes ({observedAt}), se tiene en cuenta para la preferencia por un pueblo más grande.',
      housingInsufficient: 'Los datos de vivienda publicados no bastan para filtrar el presupuesto.',
      housingOverBudget: 'La estimación del coste de la vivienda supera el presupuesto pedido.',
      housingWithinMunicipality:
        'La estimación del coste de la vivienda en el municipio, de {amount}, está dentro del presupuesto indicado.',
      housingWithinComarca:
        'La estimación del coste de la vivienda en la comarca, de {amount}, está dentro del presupuesto indicado.',
      comarcaAverage:
        'La estimación de compra usa la media de la comarca ({comarca}) porque el precio municipal de segunda mano no está disponible.',
      historicalAverages:
        'El presupuesto para la vivienda se filtra con medias históricas. Comprueba viviendas reales y los gastos de la compraventa.',
      noSchoolOption:
        'No hay constancia de ninguna opción escolar para la etapa pedida ({stage}) que cumpla las condiciones de trayecto indicadas.',
      verifySchools: 'Verifica la admisión en las escuelas, si se puede ir a pie y el trayecto de vuelta.',
      inTownSchools:
        '{count, plural, one {Constan escuelas en el mismo pueblo para # etapa educativa.} other {Constan escuelas en el mismo pueblo para # etapas educativas.}}',
      confirmStages: 'Confirma las etapas que necesitas y comprueba la admisión en las escuelas y los trayectos.',
      noListedSchool:
        'El conjunto de datos no recoge ninguna escuela en este municipio. Comprueba las escuelas cercanas.',
      noCommute:
        'No hay constancia de ningún trayecto directo en tren que cumpla el destino, el límite de tiempo y la franja de salida indicados.',
      commute:
        'Conexión directa con la línea {line} en unos {minutes} minutos, incluidos los tramos a pie estimados desde el centro de un municipio y hasta el del otro.',
      railTimes: 'Los tiempos de viaje en tren proceden del horario guardado y no incluyen retrasos.',

      limitCoverage:
        'Las recomendaciones cubren los municipios catalanes seleccionados para el piloto. La cobertura de tren con horario se limita al corredor de FGC Lleida–La Pobla.',
      limitScores:
        'Las puntuaciones solo ordenan las señales de preferencia conocidas. El conjunto de datos, con su fecha, aporta estimaciones y accesos con horario.',
      limitTravelDate: 'La fecha de viaje pedida queda fuera del horario de FGC guardado.',

      'stage.nursery': 'escuela infantil de primer ciclo',
      'stage.infantil': 'educación infantil',
      'stage.primary': 'primaria',
      'stage.eso': 'ESO',
      'stage.batxillerat': 'bachillerato',
      'stage.fp': 'formación profesional',
    },
  },
);

/** The limits of the school, rail and relocation-research answers, and of a place node. */
export const accessMessages = defineMessages(
  {
    railDirectOnly:
      'Direct FGC RL1/RL2 timetabled services only. Check the operator for disruption, walking access and request stops.',
    railCoverage: 'Cached schedules cover {from} through {through}.',
    schoolDirectory:
      'The directory records authorized stages. Check admissions, catchment, school start times and school-bus eligibility separately.',
    schoolRail:
      'Rail options depart from 06:30 and reach the school by {arriveBy} local time. Walking legs are estimates from town centres; verify paths and return journeys.',
    schoolRadius:
      'The pilot includes local schools and neighbouring schools within 15 km where covered by the snapshot.',
    schoolDateOutside: 'This date is outside the cached FGC timetable.',

    researchStatus:
      'Research status describes sources at the check date, not live availability or household eligibility. Confirm current terms with the source.',
    researchSeparate:
      'Opportunity rents and business fees are separate from municipal market averages. Research does not affect town budget screening or ranking.',
    researchHistorical:
      'Historical leads and the bundled public-data snapshot are not used as current municipal evidence.',
    researchNone:
      'No detailed relocation research is loaded for this municipality. This does not mean no opportunities exist.',

    comarcaFigureShown: '{field} (municipal figure not published; comarca figure shown)',
  },
  {
    ca: {
      railDirectOnly:
        'Només serveis directes amb horari d’FGC RL1/RL2. Consulta amb l’operador les incidències, l’accés a peu i les parades facultatives.',
      railCoverage: 'Els horaris desats cobreixen del {from} al {through}.',
      schoolDirectory:
        'El directori recull les etapes autoritzades. Comprova a part l’admissió, la zona d’influència, l’horari d’entrada i el dret al transport escolar.',
      schoolRail:
        'Les opcions en tren surten a partir de les 06:30 i arriben a l’escola abans de les {arriveBy}, hora local. Els trams a peu són estimacions des del centre dels pobles; verifica els camins i els trajectes de tornada.',
      schoolRadius:
        'El pilot inclou les escoles locals i les de pobles veïns a menys de 15 km, quan el conjunt de dades les cobreix.',
      schoolDateOutside: 'Aquesta data queda fora de l’horari d’FGC desat.',

      researchStatus:
        'L’estat de la recerca descriu les fonts en la data de comprovació, no la disponibilitat actual ni l’elegibilitat de la llar. Confirma les condicions vigents amb la font.',
      researchSeparate:
        'Els lloguers i les quotes de negoci de les oportunitats són independents de les mitjanes del mercat municipal. La recerca no afecta el filtre de pressupost ni l’ordre dels pobles.',
      researchHistorical:
        'Les pistes històriques i el conjunt de dades públiques inclòs no es fan servir com a evidència municipal actual.',
      researchNone:
        'No hi ha cap recerca detallada de reubicació carregada per a aquest municipi. Això no vol dir que no hi hagi oportunitats.',

      comarcaFigureShown: '{field} (xifra municipal no publicada; es mostra la de la comarca)',
    },
    es: {
      railDirectOnly:
        'Solo servicios directos con horario de FGC RL1/RL2. Consulta con el operador las incidencias, el acceso a pie y las paradas facultativas.',
      railCoverage: 'Los horarios guardados cubren del {from} al {through}.',
      schoolDirectory:
        'El directorio recoge las etapas autorizadas. Comprueba aparte la admisión, la zona de influencia, el horario de entrada y el derecho al transporte escolar.',
      schoolRail:
        'Las opciones en tren salen a partir de las 06:30 y llegan a la escuela antes de las {arriveBy}, hora local. Los tramos a pie son estimaciones desde el centro de los pueblos; verifica los caminos y los trayectos de vuelta.',
      schoolRadius:
        'El piloto incluye las escuelas locales y las de pueblos vecinos a menos de 15 km, cuando el conjunto de datos las cubre.',
      schoolDateOutside: 'Esta fecha queda fuera del horario de FGC guardado.',

      researchStatus:
        'El estado de la investigación describe las fuentes en la fecha de comprobación, no la disponibilidad actual ni la elegibilidad del hogar. Confirma las condiciones vigentes con la fuente.',
      researchSeparate:
        'Los alquileres y las cuotas de negocio de las oportunidades son independientes de las medias del mercado municipal. La investigación no afecta al filtro de presupuesto ni al orden de los pueblos.',
      researchHistorical:
        'Las pistas históricas y el conjunto de datos públicos incluido no se usan como evidencia municipal actual.',
      researchNone:
        'No hay ninguna investigación detallada de reubicación cargada para este municipio. Eso no significa que no haya oportunidades.',

      comarcaFigureShown: '{field} (cifra municipal no publicada; se muestra la de la comarca)',
    },
  },
);
