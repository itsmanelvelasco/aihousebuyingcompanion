import { defineMessages } from '../../packages/i18n/messages.ts';

/**
 * The scripted content of the journey board: the four fictional personas, the intake questions,
 * Marc's habit quests, Núria's routes and Jordi's credits. Everything here is invented for the
 * demo and is labelled as such on the board. `scenes.ts` fills the amounts; the server sends the
 * English text to the model and the widget shows the same keys in the person's language.
 */
export const scenes = defineMessages(
  {
    'persona.onboarding': 'Getting started',
    'persona.progress': 'On the trail',
    'persona.shortcuts': 'Faster routes',
    'persona.payoff': 'Debt-free home',

    'group.home': 'Tell me about the home you want',
    'group.finances': 'Give me the financial picture',
    'group.household': 'Home and household',
    'group.commute': 'Commute and schools',
    'group.buffer': 'Debt and cash buffer',

    'field.town': 'Target town',
    'field.bedrooms': 'Bedrooms',
    'field.household': 'Household size',
    'field.employment': 'Employment',
    'field.income': 'Take-home income per month (€)',
    'field.spending': 'Monthly expenses, before debt (€)',
    'field.savings': 'Current savings (€)',
    'field.currentTown': 'Where you live now',
    'field.budget': 'Maximum home price (€)',
    'field.homeSize': 'Minimum floor area (m²)',
    'field.dependants': 'Dependants',
    'field.rural': 'Rural preference',
    'field.commuteTo': 'Work destination',
    'field.commuteTime': 'Maximum commute (minutes)',
    'field.transport': 'Transport preference',
    'field.schoolStages': 'School stages needed',
    'field.debtPayments': 'Debt payments per month (€)',
    'field.reserve': 'Emergency savings to keep (€)',
    'field.cashTarget': 'Custom upfront cash goal (€)',

    'example.employment': 'Full-time employee',
    'example.rural': 'Open to rural towns',
    'example.transport': 'Train, no car',
    'example.schoolStages': 'Primary and ESO',

    'fact.income': 'Monthly income',
    'fact.spending': 'Monthly spending (including debt)',
    'fact.savings': 'Saved',
    'fact.floorArea': 'Floor area (m²)',
    'fact.destinationCode': 'Commute municipality code',
    'fact.maxCommuteMinutes': 'Maximum commute minutes',
    'fact.schoolMode': 'School travel mode',
    'fact.allowComarcaEstimate': 'Allow comarca estimate',
    'fact.upfrontTarget': 'Upfront cash target',
    'fact.emergencyReserve': 'Emergency reserve',

    'bank.insight':
      'At the sample spending rate you have {left} left each month. Two fewer paid outings would free up another estimated {extra}.',

    'note.customGoal': 'Uses your custom upfront goal.',
    'note.budgetShare': 'Models 30% of the purchase budget for deposit and buying costs.',
    'note.sampleGoal': 'Uses the {goal} sample upfront goal.',
    'note.reserve': 'Your emergency reserve stays out of the buying fund.',
    'note.unreportedDebt': 'Monthly saving is before any unreported debt payments.',

    'opportunity.rule.title': 'Compare a lower deposit route',
    'opportunity.rule.detail':
      'A fictional rule change reduces the upfront goal to {goal}. Your {saved} reaches that goal. Sample rent is {rent} and the modeled mortgage payment is {payment}, a {difference} difference before ownership costs.',
    'opportunity.rule.verify': 'Check the actual rule, lender eligibility, fees and total ownership costs.',
    'opportunity.job.title': 'Hybrid job near Sabadell',
    'opportunity.job.detail': 'A sample job would add {extra} per month after estimated commute and childcare.',
    'opportunity.job.verify': 'Confirm the offer, take-home pay and weekly commute.',
    'opportunity.rural.title': 'Explore a lower-rent move to Solsona',
    'opportunity.rural.detail':
      'A fictional relocation program and lower rent could free up {extra} per month after sample travel costs.',
    'opportunity.rural.verify': 'Check official program status, eligibility, schools and transport.',
    'opportunity.listing.title': 'Compare a lower-cost home in Manresa',
    'opportunity.listing.detail':
      'A simulated portal or builder lead lowers the modeled upfront goal to {goal}. This illustrates an Idealista-style or builder alert.',
    'opportunity.listing.verify': 'Check listing availability, fees, accessibility and train schedule.',
    'opportunity.friends.title': 'Try a cheaper weekend plan',
    'opportunity.friends.detail':
      'Swap two paid outings for the sample first-buyer group’s park meetup and free up an estimated {extra} per month.',
    'opportunity.friends.verify': 'See if the habit fits your schedule and budget.',

    'step.rule': 'Review deposit rules',
    'step.listing': 'Move to Manresa',
    'step.job': 'Change jobs',
    'step.rural': 'Move to Solsona',
    'step.friends': 'Try cheaper outings',

    'habit.coffee.title': 'Switch your coffee stop',
    'habit.coffee.badge': 'Coffee Saver',
    'habit.coffee.action':
      'Buy your four coffees at the sample station café for {price} each instead of {usual}. Try the cheaper café on your next coffee run.',
    'habit.takeout.title': 'Cook once instead of ordering in',
    'habit.takeout.badge': 'Home Chef',
    'habit.takeout.action':
      'Replace one {before} delivery meal each month with a {after} grocery basket. Put Friday on your calendar as the first cook-at-home night.',
    'habit.picnic.title': 'Swap a cinema trip for a park picnic',
    'habit.picnic.badge': 'Good Neighbor',
    'habit.picnic.action':
      'Invite another first-time buyer to the free park picnic in place of one {before} cinema ticket this month.',

    'badge.trailblazer': 'Trailblazer',
    'badge.steadySaver': 'Steady Saver',
    'badge.keysInHand': 'Keys in Hand',
    'badge.mortgageFree': 'Mortgage-Free',

    'coach.start.headline': 'Marc, you’re past halfway!',
    'coach.start.milestone':
      'You’ve saved four months in a row. Your next quest could make each month count a little more.',
    'coach.habits.headline': 'You’re building habits that stick.',
    'coach.habits.milestone':
      '{count, plural, one {# quest} other {# quests}} checked off. Keep them up to free up {amount} a month.',
    'leaderboard.you': 'Marc · You',

    'credits.title': 'A place of your own',
    'credits.stat.principal': 'Mortgage principal repaid',
    'credits.stat.journey': 'Repayment journey',
    'credits.stat.remaining': 'Remaining debt',
    'credits.milestone.first.title': 'The first step',
    'credits.milestone.first.detail': 'Jordi set a savings goal and built an upfront fund.',
    'credits.milestone.keys.title': 'Keys in hand',
    'credits.milestone.keys.detail': 'He bought his home and began repaying the mortgage.',
    'credits.milestone.finish.title': 'The finish line',
    'credits.milestone.finish.detail': 'The last installment cleared. He owns the home outright.',
  },
  {
    ca: {
      'persona.onboarding': 'Primers passos',
      'persona.progress': 'En camí',
      'persona.shortcuts': 'Rutes més ràpides',
      'persona.payoff': 'Habitatge sense deutes',

      'group.home': 'Explica’m l’habitatge que vols',
      'group.finances': 'Dona’m la situació financera',
      'group.household': 'Habitatge i llar',
      'group.commute': 'Desplaçaments i escoles',
      'group.buffer': 'Deutes i coixí de diners',

      'field.town': 'Poble on vols comprar',
      'field.bedrooms': 'Habitacions',
      'field.household': 'Persones de la llar',
      'field.employment': 'Situació laboral',
      'field.income': 'Ingressos nets al mes (€)',
      'field.spending': 'Despeses mensuals, sense deutes (€)',
      'field.savings': 'Estalvis actuals (€)',
      'field.currentTown': 'On vius ara',
      'field.budget': 'Preu màxim de l’habitatge (€)',
      'field.homeSize': 'Superfície mínima (m²)',
      'field.dependants': 'Persones a càrrec',
      'field.rural': 'Preferència rural',
      'field.commuteTo': 'Destinació de la feina',
      'field.commuteTime': 'Desplaçament màxim (minuts)',
      'field.transport': 'Preferència de transport',
      'field.schoolStages': 'Etapes escolars que necessites',
      'field.debtPayments': 'Pagaments de deutes al mes (€)',
      'field.reserve': 'Estalvis d’emergència que vols mantenir (€)',
      'field.cashTarget': 'Objectiu propi de diners inicials (€)',

      'example.employment': 'Assalariada a jornada completa',
      'example.rural': 'Oberta a pobles rurals',
      'example.transport': 'Tren, sense cotxe',
      'example.schoolStages': 'Primària i ESO',

      'fact.income': 'Ingressos mensuals',
      'fact.spending': 'Despeses mensuals (deutes inclosos)',
      'fact.savings': 'Estalviat',
      'fact.floorArea': 'Superfície (m²)',
      'fact.destinationCode': 'Codi del municipi de la feina',
      'fact.maxCommuteMinutes': 'Minuts màxims de desplaçament',
      'fact.schoolMode': 'Mitjà de transport a l’escola',
      'fact.allowComarcaEstimate': 'Permet l’estimació comarcal',
      'fact.upfrontTarget': 'Objectiu de diners inicials',
      'fact.emergencyReserve': 'Reserva d’emergència',

      'bank.insight':
        'Amb el ritme de despesa de mostra et queden {left} cada mes. Dues sortides de pagament menys alliberarien uns altres {extra} estimats.',

      'note.customGoal': 'Fa servir el teu objectiu propi de diners inicials.',
      'note.budgetShare': 'Calcula el 30% del pressupost de compra per a l’entrada i les despeses de compra.',
      'note.sampleGoal': 'Fa servir l’objectiu inicial de mostra de {goal}.',
      'note.reserve': 'La teva reserva d’emergència queda fora del fons de compra.',
      'note.unreportedDebt': 'L’estalvi mensual és abans de qualsevol pagament de deutes no declarat.',

      'opportunity.rule.title': 'Compara una ruta amb menys entrada',
      'opportunity.rule.detail':
        'Un canvi de norma fictici redueix l’objectiu inicial a {goal}. Els teus {saved} arriben a aquest objectiu. El lloguer de mostra és de {rent} i la quota d’hipoteca del model és de {payment}, una diferència de {difference} abans de les despeses de propietat.',
      'opportunity.rule.verify':
        'Comprova la norma real, l’elegibilitat amb el banc, les comissions i el cost total de la propietat.',
      'opportunity.job.title': 'Feina híbrida a prop de Sabadell',
      'opportunity.job.detail':
        'Una feina de mostra afegiria {extra} al mes després del desplaçament i la cura dels infants estimats.',
      'opportunity.job.verify': 'Confirma l’oferta, el sou net i el desplaçament setmanal.',
      'opportunity.rural.title': 'Explora un trasllat a Solsona amb un lloguer més baix',
      'opportunity.rural.detail':
        'Un programa de trasllat fictici i un lloguer més baix podrien alliberar {extra} al mes després de les despeses de viatge de mostra.',
      'opportunity.rural.verify': 'Comprova l’estat oficial del programa, l’elegibilitat, les escoles i el transport.',
      'opportunity.listing.title': 'Compara un habitatge més barat a Manresa',
      'opportunity.listing.detail':
        'Un avís simulat d’un portal o d’una promotora abaixa l’objectiu inicial del model a {goal}. Il·lustra una alerta de l’estil d’Idealista o d’una promotora.',
      'opportunity.listing.verify':
        'Comprova la disponibilitat de l’anunci, les comissions, l’accessibilitat i l’horari del tren.',
      'opportunity.friends.title': 'Prova un pla de cap de setmana més barat',
      'opportunity.friends.detail':
        'Canvia dues sortides de pagament per la trobada al parc del grup de mostra de primers compradors i allibera uns {extra} estimats al mes.',
      'opportunity.friends.verify': 'Mira si l’hàbit encaixa amb el teu horari i el teu pressupost.',

      'step.rule': 'Revisa l’entrada',
      'step.listing': 'Trasllat a Manresa',
      'step.job': 'Canvi de feina',
      'step.rural': 'Trasllat a Solsona',
      'step.friends': 'Sortides més barates',

      'habit.coffee.title': 'Canvia de lloc per al cafè',
      'habit.coffee.badge': 'Estalvi de cafè',
      'habit.coffee.action':
        'Compra els teus quatre cafès a la cafeteria de mostra de l’estació per {price} cadascun en lloc de {usual}. Prova la cafeteria més barata la propera vegada que vagis a fer un cafè.',
      'habit.takeout.title': 'Cuina un cop en lloc de demanar a domicili',
      'habit.takeout.badge': 'Xef de casa',
      'habit.takeout.action':
        'Substitueix un àpat a domicili de {before} cada mes per una compra de {after}. Apunta’t el divendres al calendari com la primera nit de cuinar a casa.',
      'habit.picnic.title': 'Canvia una anada al cinema per un pícnic al parc',
      'habit.picnic.badge': 'Bon veïnatge',
      'habit.picnic.action':
        'Convida algú altre que compra per primera vegada al pícnic gratuït al parc en lloc d’una entrada de cinema de {before} aquest mes.',

      'badge.trailblazer': 'Obre camins',
      'badge.steadySaver': 'Estalvi constant',
      'badge.keysInHand': 'Claus a la mà',
      'badge.mortgageFree': 'Sense hipoteca',

      'coach.start.headline': 'Marc, ja has passat la meitat',
      'coach.start.milestone':
        'Has estalviat quatre mesos seguits. La teva propera missió podria fer que cada mes compti una mica més.',
      'coach.habits.headline': 'Estàs creant hàbits que duren.',
      'coach.habits.milestone':
        '{count, plural, one {# missió completada} other {# missions completades}}. Mantén-les per alliberar {amount} al mes.',
      'leaderboard.you': 'Marc · Tu',

      'credits.title': 'Un lloc ben teu',
      'credits.stat.principal': 'Capital de la hipoteca retornat',
      'credits.stat.journey': 'Camí de retorn',
      'credits.stat.remaining': 'Deute restant',
      'credits.milestone.first.title': 'El primer pas',
      'credits.milestone.first.detail':
        'En Jordi es va fixar un objectiu d’estalvi i va reunir un fons de diners inicials.',
      'credits.milestone.keys.title': 'Claus a la mà',
      'credits.milestone.keys.detail': 'Va comprar el seu habitatge i va començar a retornar la hipoteca.',
      'credits.milestone.finish.title': 'La meta',
      'credits.milestone.finish.detail': 'L’última quota s’ha pagat. L’habitatge és del tot seu.',
    },
    es: {
      'persona.onboarding': 'Primeros pasos',
      'persona.progress': 'En camino',
      'persona.shortcuts': 'Rutas más rápidas',
      'persona.payoff': 'Vivienda sin deudas',

      'group.home': 'Cuéntame qué vivienda quieres',
      'group.finances': 'Dame la situación financiera',
      'group.household': 'Vivienda y hogar',
      'group.commute': 'Desplazamientos y escuelas',
      'group.buffer': 'Deudas y colchón de dinero',

      'field.town': 'Pueblo donde quieres comprar',
      'field.bedrooms': 'Habitaciones',
      'field.household': 'Personas del hogar',
      'field.employment': 'Situación laboral',
      'field.income': 'Ingresos netos al mes (€)',
      'field.spending': 'Gastos mensuales, sin deudas (€)',
      'field.savings': 'Ahorros actuales (€)',
      'field.currentTown': 'Dónde vives ahora',
      'field.budget': 'Precio máximo de la vivienda (€)',
      'field.homeSize': 'Superficie mínima (m²)',
      'field.dependants': 'Personas a cargo',
      'field.rural': 'Preferencia rural',
      'field.commuteTo': 'Destino del trabajo',
      'field.commuteTime': 'Desplazamiento máximo (minutos)',
      'field.transport': 'Preferencia de transporte',
      'field.schoolStages': 'Etapas escolares que necesitas',
      'field.debtPayments': 'Pagos de deudas al mes (€)',
      'field.reserve': 'Ahorros de emergencia que quieres mantener (€)',
      'field.cashTarget': 'Objetivo propio de dinero inicial (€)',

      'example.employment': 'Asalariada a jornada completa',
      'example.rural': 'Abierta a pueblos rurales',
      'example.transport': 'Tren, sin coche',
      'example.schoolStages': 'Primaria y ESO',

      'fact.income': 'Ingresos mensuales',
      'fact.spending': 'Gastos mensuales (deudas incluidas)',
      'fact.savings': 'Ahorrado',
      'fact.floorArea': 'Superficie (m²)',
      'fact.destinationCode': 'Código del municipio del trabajo',
      'fact.maxCommuteMinutes': 'Minutos máximos de desplazamiento',
      'fact.schoolMode': 'Medio de transporte a la escuela',
      'fact.allowComarcaEstimate': 'Permitir la estimación comarcal',
      'fact.upfrontTarget': 'Objetivo de dinero inicial',
      'fact.emergencyReserve': 'Reserva de emergencia',

      'bank.insight':
        'Con el ritmo de gasto de muestra te quedan {left} cada mes. Dos salidas de pago menos liberarían otros {extra} estimados.',

      'note.customGoal': 'Usa tu objetivo propio de dinero inicial.',
      'note.budgetShare': 'Calcula el 30% del presupuesto de compra para la entrada y los gastos de compra.',
      'note.sampleGoal': 'Usa el objetivo inicial de muestra de {goal}.',
      'note.reserve': 'Tu reserva de emergencia queda fuera del fondo de compra.',
      'note.unreportedDebt': 'El ahorro mensual es antes de cualquier pago de deudas no declarado.',

      'opportunity.rule.title': 'Compara una ruta con menos entrada',
      'opportunity.rule.detail':
        'Un cambio de norma ficticio reduce el objetivo inicial a {goal}. Tus {saved} alcanzan ese objetivo. El alquiler de muestra es de {rent} y la cuota de hipoteca del modelo es de {payment}, una diferencia de {difference} antes de los gastos de propiedad.',
      'opportunity.rule.verify':
        'Comprueba la norma real, la elegibilidad con el banco, las comisiones y el coste total de la propiedad.',
      'opportunity.job.title': 'Trabajo híbrido cerca de Sabadell',
      'opportunity.job.detail':
        'Un trabajo de muestra añadiría {extra} al mes después del desplazamiento y el cuidado infantil estimados.',
      'opportunity.job.verify': 'Confirma la oferta, el sueldo neto y el desplazamiento semanal.',
      'opportunity.rural.title': 'Explora una mudanza a Solsona con un alquiler más bajo',
      'opportunity.rural.detail':
        'Un programa de traslado ficticio y un alquiler más bajo podrían liberar {extra} al mes después de los gastos de viaje de muestra.',
      'opportunity.rural.verify':
        'Comprueba el estado oficial del programa, la elegibilidad, las escuelas y el transporte.',
      'opportunity.listing.title': 'Compara una vivienda más barata en Manresa',
      'opportunity.listing.detail':
        'Un aviso simulado de un portal o de una promotora baja el objetivo inicial del modelo a {goal}. Ilustra una alerta al estilo de Idealista o de una promotora.',
      'opportunity.listing.verify':
        'Comprueba la disponibilidad del anuncio, las comisiones, la accesibilidad y el horario del tren.',
      'opportunity.friends.title': 'Prueba un plan de fin de semana más barato',
      'opportunity.friends.detail':
        'Cambia dos salidas de pago por el encuentro en el parque del grupo de muestra de primeros compradores y libera unos {extra} estimados al mes.',
      'opportunity.friends.verify': 'Mira si el hábito encaja con tu horario y tu presupuesto.',

      'step.rule': 'Revisa la entrada',
      'step.listing': 'Mudanza a Manresa',
      'step.job': 'Cambio de trabajo',
      'step.rural': 'Mudanza a Solsona',
      'step.friends': 'Salidas más baratas',

      'habit.coffee.title': 'Cambia de sitio para el café',
      'habit.coffee.badge': 'Ahorro en café',
      'habit.coffee.action':
        'Compra tus cuatro cafés en la cafetería de muestra de la estación por {price} cada uno en lugar de {usual}. Prueba la cafetería más barata la próxima vez que vayas a por un café.',
      'habit.takeout.title': 'Cocina una vez en lugar de pedir a domicilio',
      'habit.takeout.badge': 'Chef de casa',
      'habit.takeout.action':
        'Sustituye una comida a domicilio de {before} cada mes por una compra de {after}. Apúntate el viernes en el calendario como la primera noche de cocinar en casa.',
      'habit.picnic.title': 'Cambia una ida al cine por un pícnic en el parque',
      'habit.picnic.badge': 'Buena vecindad',
      'habit.picnic.action':
        'Invita a otra persona que compra por primera vez al pícnic gratuito en el parque en lugar de una entrada de cine de {before} este mes.',

      'badge.trailblazer': 'Abre caminos',
      'badge.steadySaver': 'Ahorro constante',
      'badge.keysInHand': 'Llaves en mano',
      'badge.mortgageFree': 'Sin hipoteca',

      'coach.start.headline': 'Marc, ya has pasado la mitad',
      'coach.start.milestone':
        'Has ahorrado cuatro meses seguidos. Tu próxima misión podría hacer que cada mes cuente un poco más.',
      'coach.habits.headline': 'Estás creando hábitos que duran.',
      'coach.habits.milestone':
        '{count, plural, one {# misión completada} other {# misiones completadas}}. Mantenlas para liberar {amount} al mes.',
      'leaderboard.you': 'Marc · Tú',

      'credits.title': 'Un lugar muy tuyo',
      'credits.stat.principal': 'Capital de la hipoteca devuelto',
      'credits.stat.journey': 'Camino de devolución',
      'credits.stat.remaining': 'Deuda restante',
      'credits.milestone.first.title': 'El primer paso',
      'credits.milestone.first.detail': 'Jordi se fijó un objetivo de ahorro y reunió un fondo de dinero inicial.',
      'credits.milestone.keys.title': 'Llaves en mano',
      'credits.milestone.keys.detail': 'Compró su vivienda y empezó a devolver la hipoteca.',
      'credits.milestone.finish.title': 'La meta',
      'credits.milestone.finish.detail': 'La última cuota se ha pagado. La vivienda es del todo suya.',
    },
  },
);
