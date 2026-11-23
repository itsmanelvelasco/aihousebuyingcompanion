import { defineMessages } from '../i18n/messages.ts';

/**
 * The sentences of a savings plan: assumptions, what is missing, limitations, and why each habit
 * and each benefit was or was not counted.
 *
 * These sentences state tax and aid conditions, so each translation keeps the force of the English:
 * "could", "up to", "not counted", "until verified", "not guaranteed" say the same in the three
 * languages. Amounts, shares and dates arrive already formatted. A `{reason}` is a clause written
 * to follow a colon, and the `label…` messages are noun phrases written to follow a verb: the
 * sentences that take them are built so that no article has to contract with them.
 */
export const planMessages = defineMessages(
  {
    reasonUnsettled:
      'whether it applies depends on the day you could buy, and that day depends on whether it is counted. The two did not settle, so the plan takes the cautious figure and leaves it out.',
    reasonNoDay:
      'no day of purchase can be estimated, so this is the screening on the plan date ({asOf}). It holds on that date, but it would no longer hold by the time the cash could be saved, and without it the upfront cash is beyond what this plan estimates.',
    reasonAnotherRate: 'another reduced transfer-tax rate is already counted, and reduced rates do not add up.',
    reasonAlreadyHaveCash: 'you already have the upfront cash, so money that arrives later does not shorten anything.',
    reasonBuyBefore: 'you could buy in {months} month(s), before this money arrives {delay} months after the move.',

    limitation1:
      'This is an arithmetic estimate from the figures supplied. It is not a mortgage offer, a credit assessment or a promise that a lender will approve a loan.',
    limitation2:
      'No aid, grant or tax benefit is guaranteed. Benefits are screened against the rules in the dated policy snapshot and must be confirmed with the Catalan Tax Agency or the housing agency before relying on them.',
    limitation3:
      'Prices are published municipal or comarca averages per square metre, not actual listings. The timeline assumes constant income, expenses and prices, with no interest or inflation.',
    limitation4:
      'Months are rounded up. Zero, negative or unknown monthly savings give no timeline rather than a misleading number, and neither does a target more than {maxMonths} months away.',
    limitation5:
      'Benefits tied to the purchase are screened on the estimated purchase day, with ages advanced to it. Tax bases, family status and the rules themselves are assumed to stay as they are on the plan date; the rules on the actual purchase day may differ.',

    ageRange: '{low} or {high}',
    agesSelf: 'By then you would be {age}.',
    agesChildren: 'By then your {count, plural, one {child} other {children}} would be {ages}.',
    agesBoth: 'By then you would be {age} and your {count, plural, one {child} other {children}} would be {ages}.',
    birthdaysUnknown: 'Whether an age limit is still met on {date} depends on birthdays this plan does not know.',

    habitPaused: 'Not counted: the habit is paused.',
    habitNoAmount: 'Not counted: no monthly saving is attached to this habit.',
    habitAsProposed: 'Counted as if adopted: {amount} a month.',
    habitNotAdopted: 'Not counted: the habit is only proposed. Switch it on to see its effect.',
    habitCounted: 'Counted: {amount} a month on top of your stated spending.',
    habitStartUnknown:
      'Shown, not counted: your monthly spending comes from bank movements, and the day this habit started is not known, so the plan cannot tell whether its effect is already in that spending.',
    habitStartUnknownUpTo:
      'Shown, not counted: your monthly spending comes from bank movements up to {asOf}, and the day this habit started is not known, so the plan cannot tell whether its effect is already in that spending.',
    habitPeriodEndUnknown:
      'Shown, not counted: your monthly spending comes from bank movements, and the end of that period is not known, so the plan cannot tell whether its effect is already in that spending.',
    habitCountedAfter:
      'Counted: {amount} a month. It started on {startedOn}, after the bank movements your spending comes from (up to {asOf}).',
    habitInside:
      'Shown, not counted: it started on {startedOn}, and your monthly spending comes from bank movements up to {asOf}, which already include its effect.',
    habitScaled: 'Scaled by the {share} of check-ins kept.',

    whatUnquantified: 'Not quantified: {reason}.',
    whatNotModelled: 'Not quantified: the amount is not modelled.',
    whatNucleus: 'A reduced transfer-tax rate may apply, depending on the nucleus where the home is.',
    whatRateAnywhere: 'Transfer tax at {rate} instead of {standard}, in any municipality of Catalonia.',
    whatRate: 'Transfer tax at {rate} instead of {baseline}.',
    whatOneOffRate: 'A single payment of at most the lower of {cap} and {rate} of the price.',
    whatOneOff: 'A single payment or deduction.',
    whatAnnual: 'A yearly amount.',
    whatAnnualYears: 'A yearly amount for at most {years} years.',
    'whatCostShare.purchase_payments':
      'A yearly share of home-purchase payments{limits}. The amount depends on what you actually pay, which this plan does not know.',
    'whatCostShare.rent':
      'A yearly share of rent paid{limits}. The amount depends on what you actually pay, which this plan does not know.',
    'whatCostShare.renovation':
      'A yearly share of renovation costs{limits}. The amount depends on what you actually pay, which this plan does not know.',
    'whatCostRate.purchase_payments':
      '{rate} a year of home-purchase payments{limits}. The amount depends on what you actually pay, which this plan does not know.',
    'whatCostRate.rent':
      '{rate} a year of rent paid{limits}. The amount depends on what you actually pay, which this plan does not know.',
    'whatCostRate.renovation':
      '{rate} a year of renovation costs{limits}. The amount depends on what you actually pay, which this plan does not know.',
    limitBase: ', on at most {base} a year',
    limitCap: ', capped at {individual} a year ({joint} on a joint return)',

    labelGeneralRate: 'the general rate',
    labelGeneralTariff: 'the general tariff ({amount}, an average of {rate} on this price)',
    labelGeneralPercent: 'the general {rate}',
    labelAlreadyQualify: 'the {rate} you already qualify for anywhere in Catalonia ({title})',

    lostMeasureEnds:
      'the measure is in force until {through} and is not confirmed for {date}, the day you could buy ({months} months after the plan date).',
    lostNotOnDay:
      'it applies if you buy on the plan date, but not on {date}, the day you could buy ({months} months after the plan date).',
    lostNotCertain:
      'it applies if you buy on the plan date, but it is not certain on {date}, the day you could buy ({months} months after the plan date).',
    criteriaNotMetByThen: 'Criteria not met by then: {criteria}',
    toVerify: 'To verify: {criteria}',

    notCounted: 'Not counted: {reason}',
    notCountedCriteria: 'Not counted, criteria not met: {criteria}',
    callClosed: 'Not counted: the application call is closed.',
    callUpcoming: 'Not counted: the application call has not opened yet.',
    callNone: 'Not counted: no application call could be verified, so this aid cannot be claimed yet.',
    callClosesBefore:
      'Not counted: the application call is open today but closes before {date}, the day you could buy, and no later call is known.',
    notInForceOn: 'Not counted: the measure is not confirmed to be in force on {date}.',
    notInForceOnPlanDate: 'Not counted: the measure is not confirmed to be in force on the plan date.',
    untilVerifiedGeo: 'Not counted until verified: {criteria}',
    shownUntilVerified: 'Shown but not counted until verified: {criteria}',
    amountUnknown: 'Not counted: the amount cannot be computed from the facts known.',
    noReduction: 'Not counted: it brings no reduction for this place.',
    afterPurchase:
      'Not counted: it is received after the purchase (with a later tax return), so it does not shorten the time needed to gather the upfront cash. It lowers costs afterwards.',
    alreadyLiveHere:
      'Not counted: you already live here, so if you receive it, it is already part of your income and savings.',

    countedAtPurchase: 'Counted: lowers the upfront cash needed by {amount}.',
    countedAnnual:
      'Counted as {amount} of extra monthly savings from month {month}, assuming you move here on the plan date and buy later.',
    countedOneOff:
      'Counted as {amount} received after {months} months, assuming you move here on the plan date and buy later.',
    countedUnverified: 'Counted at your request although eligibility is not verified.',

    appliedBaseline:
      'Applied to your baseline: it lowers the upfront cash by {amount} wherever you buy in Catalonia, so it is not counted as a saving of this place.',
    notApplied: 'Not applied: {reason}',
    notAppliedCriteria: 'Not applied, criteria not met: {criteria}',
    notAppliedNotInForce: 'Not applied: the measure is not confirmed to be in force on {date}.',
    notAppliedUntilVerified: 'Not applied to your baseline until verified: {criteria}',
    ifYouQualify:
      'If you qualify, you pay less transfer tax everywhere, and the transfer-tax saving of this place is smaller than shown.',
    notAppliedAnother: 'Not applied: another reduced rate is already your baseline, and reduced rates do not add up.',
    notAppliedNotLower: 'Not applied: it is not lower than the general transfer tax on this price.',

    assumeBudget: 'The price is your stated budget of {amount}.',
    missingBudgetPositive: 'person.home.budgetCents (must be greater than zero)',
    missingAreaOrBudget: 'person.home.floorAreaM2 or person.home.budgetCents',
    missingResale: 'resale price per m² for {place}',
    missingMunicipalResale: 'municipal resale price per m² for {place} (comarca average used)',
    missingStandardRate: 'standard transfer-tax rate (no policy in the snapshot states it)',
    missingGeneralRates:
      'household facts for the reduced transfer-tax rates that apply anywhere in Catalonia ({ids}): the baseline uses {baseline} and could be as low as {rate}, which would shorten the baseline and shrink the transfer-tax saving of this place',
    assumePriceTown:
      'The price is {area} m² × {perM2}/m² for {place} ({observedAt}) = {price}. It is an average of past sales, not a listing.',
    assumePriceComarca:
      'The price is {area} m² × {perM2}/m² for the {comarca} comarca average ({observedAt}) = {price}. It is an average of past sales, not a listing.',
    assumeUpfront:
      'Upfront cash = {depositRate} deposit ({deposit}) + transfer tax at {baseline} ({tax}) + {feesRate} notary, registry and similar fees ({fees}) = {total}. The rest of the price is assumed to be financed; no lender has assessed it.',
    assumeBaselineApplied:
      'The baseline transfer tax is {rate}, not {standard}, because every condition of "{title}" is confirmed and that rate applies in any municipality of Catalonia. A place is credited only with the difference between that rate and its own.',
    assumeBaselinePossiblyLower:
      'The baseline transfer tax is {standard}. A lower rate that applies anywhere in Catalonia is not assumed, because its conditions are not all confirmed; if you qualify, the baseline is shorter and the transfer-tax saving of a rural place is smaller than shown.',
    assumeBaselineStandard:
      'The baseline transfer tax is {standard}: no reduced rate that applies anywhere in Catalonia is verified for you.',
    assumeSavingsReserve: 'Available savings are {available}: current savings less the {reserve} emergency reserve.',
    assumeSavingsNoReserve:
      'Available savings are {available}. No emergency reserve was declared, so none is set aside.',
    assumeMonthly: 'Monthly savings are income less expenses ({amount}), from {basis} figures.',
    assumeMonthlyAsOf: 'Monthly savings are income less expenses ({amount}), from {basis} figures as of {asOf}.',
    'basis.declared': 'declared',
    'basis.bank_observed': 'bank-observed',
    'basis.mixed': 'mixed',
    'basis.unknown': 'unknown',
    assumeTariff:
      "The price is above {threshold}, so the general transfer tax is not a single rate. It follows the tariff by total value ({steps}): {tax} on this price. The price is taken as the property's total value, and the tax agency rounds the averaged rate, so the bill can differ by a few euros.",
    tariffStep: '{rate} from {amount}',
    assumeHabitsCounted:
      "{count} habit(s) add {amount} a month: each planned saving is scaled by its check-in adherence, or counted in full when there are no check-ins yet. Habit savings are the person's own estimates.",
    assumeHabitsWithheld:
      '{count} active habit(s) are shown but not counted ({titles}): your monthly spending comes from bank movements, which already include the effect of a habit that was running then. A habit is added on top only when it has a start date after that period.',
    assumeHabitsWithheldUpTo:
      '{count} active habit(s) are shown but not counted ({titles}): your monthly spending comes from bank movements up to {asOf}, which already include the effect of a habit that was running then. A habit is added on top only when it has a start date after that period.',
    assumeProposed: 'Habits that are only proposed are counted as if adopted.',
    purchaseDayNone: 'no purchase day can be estimated, so it is screened on the plan date',
    purchaseDayOn: '{date} ({months} months after {asOf})',
    assumeScreening:
      'Benefits tied to the purchase are screened on the day you could buy, with ages advanced to that day, not on the plan date. With the benefits of this place: {place}. The baseline: {baseline}. Tax bases, family status and the rules themselves are assumed to stay as they are on {asOf}.',
    assumeTaxDiffers:
      'The transfer tax anywhere in Catalonia differs between the two days: {baseline} for the baseline and {place} with the benefits of this place, which is the rate this place is compared with.',
    assumeHeld:
      "With your habits the cash would be there before {date}, but on that earlier day the transfer tax the baseline relies on does not apply, and the plan does not look for a day in between. The timeline with habits is therefore the baseline's day, {date}: saving more never makes the purchase later.",
    timelineBaseline: 'baseline',
    timelineHabits: 'with habits',
    timelinePlace: 'with the benefits of this place',
    assumeNoDay:
      'For the timeline {timelines} no day of purchase exists: a benefit that holds on the plan date would no longer hold by the time the cash could be saved, and without it the upfront cash is beyond the horizon. The benefits are listed as screened on the plan date, {asOf}, and none of them is counted.',
    assumeUnsettled:
      'For the timeline {timelines}, the day you could buy did not settle: counting a benefit moved the purchase to a day on which it does not apply. The benefits that depend on that day are left out there, which is the cautious figure.',
    assumeBeyond:
      'No timeline is given: at {amount} a month the upfront cash is more than {months} months ({years} years) away, beyond what this plan estimates.',
    assumeBeyondBaseline:
      'No timeline is given for the baseline: at {amount} a month the upfront cash is more than {months} months ({years} years) away, beyond what this plan estimates.',
    assumeUnverifiedCounted:
      'Benefits whose eligibility is not yet verified are counted at your request; treat the shorter timeline as provisional.',
    assumeOnlyVerified:
      'Only benefits with every eligibility condition confirmed are counted; the others are listed, not counted.',
    assumeTiming:
      'A benefit tied to the purchase lowers the upfront cash. A benefit tied to living or renting in the place counts only on the assumption that you move there on the plan date and buy later, and arrives one tax year late. A benefit received after the purchase is never counted.',
  },
  {
    ca: {
      reasonUnsettled:
        'que s’apliqui depèn del dia en què podries comprar, i aquest dia depèn de si es compta. Les dues coses no s’han estabilitzat, de manera que el pla agafa la xifra prudent i la deixa fora.',
      reasonNoDay:
        'no es pot estimar cap dia de compra, de manera que aquesta és la comprovació feta en la data del pla ({asOf}). Es compleix en aquesta data, però ja no es compliria quan s’haguessin pogut estalviar els diners, i sense això els diners inicials queden més enllà del que aquest pla estima.',
      reasonAnotherRate:
        'ja es compta un altre tipus reduït de l’impost de transmissions patrimonials, i els tipus reduïts no s’acumulen.',
      reasonAlreadyHaveCash:
        'ja tens els diners inicials, de manera que uns diners que arriben més tard no escurcen res.',
      reasonBuyBefore:
        '{months, plural, one {podries comprar d’aquí a # mes} other {podries comprar d’aquí a # mesos}}, abans que aquests diners arribin {delay} mesos després del trasllat.',

      limitation1:
        'Això és una estimació aritmètica a partir de les xifres facilitades. No és una oferta d’hipoteca, ni una avaluació de crèdit, ni cap promesa que una entitat aprovarà un préstec.',
      limitation2:
        'Cap ajut, subvenció o benefici fiscal està garantit. Els beneficis es comproven amb les regles del recull de mesures, que porta data, i s’han de confirmar amb l’Agència Tributària de Catalunya o l’Agència de l’Habitatge abans de comptar-hi.',
      limitation3:
        'Els preus són mitjanes municipals o comarcals publicades per metre quadrat, no anuncis reals. El termini suposa ingressos, despeses i preus constants, sense interessos ni inflació.',
      limitation4:
        'Els mesos s’arrodoneixen a l’alça. Un estalvi mensual zero, negatiu o desconegut no dona cap termini, en lloc d’un nombre enganyós, i tampoc en dona un objectiu a més de {maxMonths} mesos.',
      limitation5:
        'Els beneficis vinculats a la compra es comproven per al dia estimat de compra, amb les edats avançades fins a aquell dia. Se suposa que les bases imposables, la situació familiar i les mateixes regles es mantenen com en la data del pla; les regles del dia real de la compra poden ser diferents.',

      ageRange: '{low} o {high}',
      agesSelf: 'Aleshores tindries {age} anys.',
      agesChildren:
        '{count, plural, one {Aleshores el teu fill tindria {ages} anys.} other {Aleshores els teus fills tindrien {ages} anys.}}',
      agesBoth:
        '{count, plural, one {Aleshores tindries {age} anys i el teu fill en tindria {ages}.} other {Aleshores tindries {age} anys i els teus fills en tindrien {ages}.}}',
      birthdaysUnknown:
        'Que un límit d’edat encara es compleixi el {date} depèn d’aniversaris que aquest pla no coneix.',

      habitPaused: 'No es compta: l’hàbit està en pausa.',
      habitNoAmount: 'No es compta: aquest hàbit no té cap estalvi mensual associat.',
      habitAsProposed: 'Es compta com si s’hagués adoptat: {amount} al mes.',
      habitNotAdopted: 'No es compta: l’hàbit només està proposat. Activa’l per veure’n l’efecte.',
      habitCounted: 'Es compta: {amount} al mes, a més de les despeses que has indicat.',
      habitStartUnknown:
        'Es mostra, però no es compta: les teves despeses mensuals provenen de moviments bancaris, i no se sap el dia en què va començar aquest hàbit, de manera que el pla no pot saber si el seu efecte ja és dins d’aquestes despeses.',
      habitStartUnknownUpTo:
        'Es mostra, però no es compta: les teves despeses mensuals provenen de moviments bancaris fins al {asOf}, i no se sap el dia en què va començar aquest hàbit, de manera que el pla no pot saber si el seu efecte ja és dins d’aquestes despeses.',
      habitPeriodEndUnknown:
        'Es mostra, però no es compta: les teves despeses mensuals provenen de moviments bancaris, i no se sap quan acaba aquest període, de manera que el pla no pot saber si el seu efecte ja és dins d’aquestes despeses.',
      habitCountedAfter:
        'Es compta: {amount} al mes. Va començar el {startedOn}, després dels moviments bancaris dels quals provenen les teves despeses (fins al {asOf}).',
      habitInside:
        'Es mostra, però no es compta: va començar el {startedOn}, i les teves despeses mensuals provenen de moviments bancaris fins al {asOf}, que ja n’inclouen l’efecte.',
      habitScaled: 'S’ajusta segons el {share} de registres de seguiment complerts.',

      whatUnquantified: 'No quantificat: {reason}.',
      whatNotModelled: 'No quantificat: l’import no està modelitzat.',
      whatNucleus:
        'Es pot aplicar un tipus reduït de l’impost de transmissions patrimonials, segons el nucli on sigui l’habitatge.',
      whatRateAnywhere:
        'Impost de transmissions patrimonials al {rate} a qualsevol municipi de Catalunya, en lloc d’aplicar {standard}.',
      whatRate: 'Impost de transmissions patrimonials al {rate}, en lloc d’aplicar {baseline}.',
      whatOneOffRate: 'Un pagament únic de, com a màxim, el menor de {cap} i el {rate} del preu.',
      whatOneOff: 'Un pagament únic o una deducció.',
      whatAnnual: 'Un import anual.',
      whatAnnualYears:
        '{years, plural, one {Un import anual durant # any com a màxim.} other {Un import anual durant # anys com a màxim.}}',
      'whatCostShare.purchase_payments':
        'Un percentatge anual dels pagaments per la compra de l’habitatge{limits}. L’import depèn del que paguis realment, cosa que aquest pla no sap.',
      'whatCostShare.rent':
        'Un percentatge anual del lloguer pagat{limits}. L’import depèn del que paguis realment, cosa que aquest pla no sap.',
      'whatCostShare.renovation':
        'Un percentatge anual de les despeses de rehabilitació{limits}. L’import depèn del que paguis realment, cosa que aquest pla no sap.',
      'whatCostRate.purchase_payments':
        'El {rate} anual dels pagaments per la compra de l’habitatge{limits}. L’import depèn del que paguis realment, cosa que aquest pla no sap.',
      'whatCostRate.rent':
        'El {rate} anual del lloguer pagat{limits}. L’import depèn del que paguis realment, cosa que aquest pla no sap.',
      'whatCostRate.renovation':
        'El {rate} anual de les despeses de rehabilitació{limits}. L’import depèn del que paguis realment, cosa que aquest pla no sap.',
      limitBase: ', sobre una base de {base} l’any com a màxim',
      limitCap: ', amb un límit de {individual} l’any ({joint} en declaració conjunta)',

      labelGeneralRate: 'el tipus general',
      labelGeneralTariff: 'la tarifa general ({amount}, una mitjana del {rate} sobre aquest preu)',
      labelGeneralPercent: 'el {rate} general',
      labelAlreadyQualify: 'el {rate} a què ja tens dret a qualsevol municipi de Catalunya ({title})',

      lostMeasureEnds:
        '{months, plural, one {la mesura és vigent fins al {through} i no està confirmada per al {date}, el dia en què podries comprar (# mes després de la data del pla).} other {la mesura és vigent fins al {through} i no està confirmada per al {date}, el dia en què podries comprar (# mesos després de la data del pla).}}',
      lostNotOnDay:
        '{months, plural, one {s’aplica si compres en la data del pla, però no el {date}, el dia en què podries comprar (# mes després de la data del pla).} other {s’aplica si compres en la data del pla, però no el {date}, el dia en què podries comprar (# mesos després de la data del pla).}}',
      lostNotCertain:
        '{months, plural, one {s’aplica si compres en la data del pla, però no és segur el {date}, el dia en què podries comprar (# mes després de la data del pla).} other {s’aplica si compres en la data del pla, però no és segur el {date}, el dia en què podries comprar (# mesos després de la data del pla).}}',
      criteriaNotMetByThen: 'Criteris que aleshores no es compleixen: {criteria}',
      toVerify: 'Cal verificar: {criteria}',

      notCounted: 'No es compta: {reason}',
      notCountedCriteria: 'No es compta, no es compleixen els criteris: {criteria}',
      callClosed: 'No es compta: la convocatòria està tancada.',
      callUpcoming: 'No es compta: la convocatòria encara no s’ha obert.',
      callNone:
        'No es compta: no s’ha pogut verificar cap convocatòria, de manera que aquest ajut encara no es pot sol·licitar.',
      callClosesBefore:
        'No es compta: la convocatòria és oberta avui però es tanca abans del {date}, el dia en què podries comprar, i no es coneix cap convocatòria posterior.',
      notInForceOn: 'No es compta: no està confirmat que la mesura sigui vigent el {date}.',
      notInForceOnPlanDate: 'No es compta: no està confirmat que la mesura sigui vigent en la data del pla.',
      untilVerifiedGeo: 'No es compta fins que es verifiqui: {criteria}',
      shownUntilVerified: 'Es mostra, però no es compta fins que es verifiqui: {criteria}',
      amountUnknown: 'No es compta: l’import no es pot calcular amb els fets coneguts.',
      noReduction: 'No es compta: no aporta cap reducció en aquest lloc.',
      afterPurchase:
        'No es compta: es rep després de la compra (amb una declaració de la renda posterior), de manera que no escurça el temps necessari per reunir els diners inicials. Redueix costos més endavant.',
      alreadyLiveHere:
        'No es compta: ja vius aquí, de manera que, si el reps, ja forma part dels teus ingressos i estalvis.',

      countedAtPurchase: 'Es compta: redueix els diners inicials necessaris en {amount}.',
      countedAnnual:
        'Es compta com {amount} d’estalvi mensual addicional a partir del mes {month}, suposant que et trasllades aquí en la data del pla i compres més endavant.',
      countedOneOff:
        'Es compta com {amount} rebuts al cap de {months} mesos, suposant que et trasllades aquí en la data del pla i compres més endavant.',
      countedUnverified: 'Es compta perquè ho has demanat, tot i que l’elegibilitat no està verificada.',

      appliedBaseline:
        'S’aplica a la teva referència: redueix els diners inicials en {amount} compris on compris a Catalunya, de manera que no es compta com un estalvi d’aquest lloc.',
      notApplied: 'No s’aplica: {reason}',
      notAppliedCriteria: 'No s’aplica, no es compleixen els criteris: {criteria}',
      notAppliedNotInForce: 'No s’aplica: no està confirmat que la mesura sigui vigent el {date}.',
      notAppliedUntilVerified: 'No s’aplica a la teva referència fins que es verifiqui: {criteria}',
      ifYouQualify:
        'Si hi tens dret, pagues menys impost de transmissions patrimonials a tot arreu, i l’estalvi en aquest impost que ofereix aquest lloc és més petit que el que es mostra.',
      notAppliedAnother:
        'No s’aplica: un altre tipus reduït ja és la teva referència, i els tipus reduïts no s’acumulen.',
      notAppliedNotLower:
        'No s’aplica: no és inferior a l’impost de transmissions patrimonials general per a aquest preu.',

      assumeBudget: 'El preu és el pressupost que has indicat, de {amount}.',
      missingBudgetPositive: 'person.home.budgetCents (ha de ser superior a zero)',
      missingAreaOrBudget: 'person.home.floorAreaM2 o person.home.budgetCents',
      missingResale: 'preu de segona mà per m² a {place}',
      missingMunicipalResale: 'preu municipal de segona mà per m² a {place} (s’ha fet servir la mitjana de la comarca)',
      missingStandardRate: 'tipus general de l’impost de transmissions patrimonials (cap mesura del recull l’indica)',
      missingGeneralRates:
        'fets de la llar per als tipus reduïts de l’impost de transmissions patrimonials que s’apliquen a tot Catalunya ({ids}): la referència fa servir {baseline} i el tipus podria ser tan baix com el {rate}, cosa que escurçaria la referència i reduiria l’estalvi en aquest impost que ofereix aquest lloc',
      assumePriceTown:
        'El preu és {area} m² × {perM2}/m² a {place} ({observedAt}) = {price}. És una mitjana de vendes passades, no un anunci.',
      assumePriceComarca:
        'El preu és {area} m² × {perM2}/m², la mitjana de la comarca ({comarca}, {observedAt}) = {price}. És una mitjana de vendes passades, no un anunci.',
      assumeUpfront:
        'Diners inicials = entrada del {depositRate} ({deposit}) + impost de transmissions patrimonials aplicant {baseline} ({tax}) + {feesRate} de notaria, registre i despeses similars ({fees}) = {total}. Se suposa que la resta del preu es finança; cap entitat ho ha avaluat.',
      assumeBaselineApplied:
        'L’impost de transmissions patrimonials de referència és del {rate}, i no {standard}, perquè totes les condicions de «{title}» estan confirmades i aquest tipus s’aplica a qualsevol municipi de Catalunya. A un lloc només se li atribueix la diferència entre aquest tipus i el seu.',
      assumeBaselinePossiblyLower:
        'L’impost de transmissions patrimonials de referència és {standard}. No se suposa un tipus inferior dels que s’apliquen a tot Catalunya, perquè no totes les seves condicions estan confirmades; si hi tens dret, la referència és més curta i l’estalvi en aquest impost que ofereix un lloc rural és més petit que el que es mostra.',
      assumeBaselineStandard:
        'L’impost de transmissions patrimonials de referència és {standard}: no tens verificat cap tipus reduït dels que s’apliquen a tot Catalunya.',
      assumeSavingsReserve:
        'Els estalvis disponibles són {available}: els estalvis actuals menys la reserva d’emergència de {reserve}.',
      assumeSavingsNoReserve:
        'Els estalvis disponibles són {available}. No s’ha declarat cap reserva d’emergència, de manera que no se n’aparta cap.',
      assumeMonthly: 'L’estalvi mensual són els ingressos menys les despeses ({amount}), a partir de xifres {basis}.',
      assumeMonthlyAsOf:
        'L’estalvi mensual són els ingressos menys les despeses ({amount}), a partir de xifres {basis} a data {asOf}.',
      'basis.declared': 'declarades',
      'basis.bank_observed': 'observades al banc',
      'basis.mixed': 'mixtes',
      'basis.unknown': 'd’origen desconegut',
      assumeTariff:
        'El preu supera {threshold}, de manera que l’impost de transmissions patrimonials general no és un tipus únic. Segueix la tarifa per valor total ({steps}): {tax} per a aquest preu. El preu es pren com el valor total de l’immoble, i l’agència tributària arrodoneix el tipus mitjà, de manera que la quota pot variar uns quants euros.',
      tariffStep: '{rate} a partir de {amount}',
      assumeHabitsCounted:
        '{count, plural, one {# hàbit afegeix {amount} al mes} other {# hàbits afegeixen {amount} al mes}}: cada estalvi previst s’ajusta segons el compliment dels registres de seguiment, o es compta sencer quan encara no n’hi ha cap. Els estalvis dels hàbits són estimacions de la mateixa persona.',
      assumeHabitsWithheld:
        '{count, plural, one {# hàbit actiu es mostra però no es compta} other {# hàbits actius es mostren però no es compten}} ({titles}): les teves despeses mensuals provenen de moviments bancaris, que ja inclouen l’efecte d’un hàbit que aleshores estava en marxa. Un hàbit només s’hi afegeix quan té una data d’inici posterior a aquest període.',
      assumeHabitsWithheldUpTo:
        '{count, plural, one {# hàbit actiu es mostra però no es compta} other {# hàbits actius es mostren però no es compten}} ({titles}): les teves despeses mensuals provenen de moviments bancaris fins al {asOf}, que ja inclouen l’efecte d’un hàbit que aleshores estava en marxa. Un hàbit només s’hi afegeix quan té una data d’inici posterior a aquest període.',
      assumeProposed: 'Els hàbits que només estan proposats es compten com si s’haguessin adoptat.',
      purchaseDayNone: 'no es pot estimar cap dia de compra, de manera que es comprova en la data del pla',
      purchaseDayOn:
        '{months, plural, one {{date} (# mes després del {asOf})} other {{date} (# mesos després del {asOf})}}',
      assumeScreening:
        'Els beneficis vinculats a la compra es comproven per al dia en què podries comprar, amb les edats avançades fins a aquell dia, no en la data del pla. Amb els beneficis d’aquest lloc: {place}. La referència: {baseline}. Se suposa que les bases imposables, la situació familiar i les mateixes regles es mantenen com el {asOf}.',
      assumeTaxDiffers:
        'L’impost de transmissions patrimonials a tot Catalunya és diferent en els dos dies: {baseline} per a la referència i {place} amb els beneficis d’aquest lloc, que és el tipus amb què es compara aquest lloc.',
      assumeHeld:
        'Amb els teus hàbits tindries els diners abans del {date}, però en aquell dia anterior no s’aplica l’impost de transmissions patrimonials en què es basa la referència, i el pla no busca cap dia entremig. Per això el termini amb hàbits és el dia de la referència, el {date}: estalviar més no endarrereix mai la compra.',
      timelineBaseline: 'referència',
      timelineHabits: 'amb hàbits',
      timelinePlace: 'amb els beneficis d’aquest lloc',
      assumeNoDay:
        'No hi ha cap dia de compra per a aquests terminis ({timelines}): un benefici que es compleix en la data del pla ja no es compliria quan s’haguessin pogut estalviar els diners, i sense ell els diners inicials queden més enllà de l’horitzó. Els beneficis es mostren tal com es comproven en la data del pla, el {asOf}, i no se’n compta cap.',
      assumeUnsettled:
        'El dia en què podries comprar no s’ha estabilitzat per a aquests terminis ({timelines}): comptar un benefici traslladava la compra a un dia en què no s’aplica. Els beneficis que depenen d’aquell dia s’hi deixen fora, que és la xifra prudent.',
      assumeBeyond:
        'No es dona cap termini: amb {amount} al mes, els diners inicials queden a més de {months} mesos ({years} anys), més enllà del que aquest pla estima.',
      assumeBeyondBaseline:
        'No es dona cap termini per a la referència: amb {amount} al mes, els diners inicials queden a més de {months} mesos ({years} anys), més enllà del que aquest pla estima.',
      assumeUnverifiedCounted:
        'Els beneficis amb l’elegibilitat encara no verificada es compten perquè ho has demanat; considera provisional el termini més curt.',
      assumeOnlyVerified:
        'Només es compten els beneficis amb totes les condicions d’elegibilitat confirmades; els altres es mostren, però no es compten.',
      assumeTiming:
        'Un benefici vinculat a la compra redueix els diners inicials. Un benefici vinculat a viure o llogar al lloc només compta si se suposa que t’hi trasllades en la data del pla i compres més endavant, i arriba amb un exercici fiscal de retard. Un benefici que es rep després de la compra no es compta mai.',
    },
    es: {
      reasonUnsettled:
        'que se aplique depende del día en que podrías comprar, y ese día depende de si se cuenta. Las dos cosas no se han estabilizado, así que el plan toma la cifra prudente y lo deja fuera.',
      reasonNoDay:
        'no se puede estimar ningún día de compra, así que esta es la comprobación hecha en la fecha del plan ({asOf}). Se cumple en esa fecha, pero ya no se cumpliría cuando se hubiera podido ahorrar el dinero, y sin ello el dinero inicial queda más allá de lo que este plan estima.',
      reasonAnotherRate:
        'ya se cuenta otro tipo reducido del impuesto de transmisiones patrimoniales, y los tipos reducidos no se acumulan.',
      reasonAlreadyHaveCash: 'ya tienes el dinero inicial, así que un dinero que llega más tarde no acorta nada.',
      reasonBuyBefore:
        '{months, plural, one {podrías comprar dentro de # mes} other {podrías comprar dentro de # meses}}, antes de que este dinero llegue {delay} meses después del traslado.',

      limitation1:
        'Esto es una estimación aritmética a partir de las cifras facilitadas. No es una oferta de hipoteca, ni una evaluación de crédito, ni una promesa de que una entidad aprobará un préstamo.',
      limitation2:
        'Ninguna ayuda, subvención o beneficio fiscal está garantizado. Los beneficios se comprueban con las reglas de la recopilación de medidas, que lleva fecha, y deben confirmarse con la Agència Tributària de Catalunya o la Agència de l’Habitatge antes de contar con ellos.',
      limitation3:
        'Los precios son medias municipales o comarcales publicadas por metro cuadrado, no anuncios reales. El plazo supone ingresos, gastos y precios constantes, sin intereses ni inflación.',
      limitation4:
        'Los meses se redondean al alza. Un ahorro mensual cero, negativo o desconocido no da ningún plazo, en lugar de un número engañoso, y tampoco lo da un objetivo a más de {maxMonths} meses.',
      limitation5:
        'Los beneficios vinculados a la compra se comprueban para el día estimado de compra, con las edades avanzadas hasta ese día. Se supone que las bases imponibles, la situación familiar y las propias reglas se mantienen como en la fecha del plan; las reglas del día real de la compra pueden ser distintas.',

      ageRange: '{low} o {high}',
      agesSelf: 'Para entonces tendrías {age} años.',
      agesChildren:
        '{count, plural, one {Para entonces tu hijo tendría {ages} años.} other {Para entonces tus hijos tendrían {ages} años.}}',
      agesBoth:
        '{count, plural, one {Para entonces tendrías {age} años y tu hijo tendría {ages}.} other {Para entonces tendrías {age} años y tus hijos tendrían {ages}.}}',
      birthdaysUnknown:
        'Que un límite de edad se siga cumpliendo el {date} depende de cumpleaños que este plan no conoce.',

      habitPaused: 'No se cuenta: el hábito está en pausa.',
      habitNoAmount: 'No se cuenta: este hábito no tiene ningún ahorro mensual asociado.',
      habitAsProposed: 'Se cuenta como si se hubiera adoptado: {amount} al mes.',
      habitNotAdopted: 'No se cuenta: el hábito solo está propuesto. Actívalo para ver su efecto.',
      habitCounted: 'Se cuenta: {amount} al mes, además de los gastos que has indicado.',
      habitStartUnknown:
        'Se muestra, pero no se cuenta: tus gastos mensuales proceden de movimientos bancarios, y no se sabe el día en que empezó este hábito, así que el plan no puede saber si su efecto ya está dentro de esos gastos.',
      habitStartUnknownUpTo:
        'Se muestra, pero no se cuenta: tus gastos mensuales proceden de movimientos bancarios hasta el {asOf}, y no se sabe el día en que empezó este hábito, así que el plan no puede saber si su efecto ya está dentro de esos gastos.',
      habitPeriodEndUnknown:
        'Se muestra, pero no se cuenta: tus gastos mensuales proceden de movimientos bancarios, y no se sabe cuándo termina ese periodo, así que el plan no puede saber si su efecto ya está dentro de esos gastos.',
      habitCountedAfter:
        'Se cuenta: {amount} al mes. Empezó el {startedOn}, después de los movimientos bancarios de los que proceden tus gastos (hasta el {asOf}).',
      habitInside:
        'Se muestra, pero no se cuenta: empezó el {startedOn}, y tus gastos mensuales proceden de movimientos bancarios hasta el {asOf}, que ya incluyen su efecto.',
      habitScaled: 'Se ajusta según el {share} de registros de seguimiento cumplidos.',

      whatUnquantified: 'No cuantificado: {reason}.',
      whatNotModelled: 'No cuantificado: el importe no está modelizado.',
      whatNucleus:
        'Puede aplicarse un tipo reducido del impuesto de transmisiones patrimoniales, según el núcleo en el que esté la vivienda.',
      whatRateAnywhere:
        'Impuesto de transmisiones patrimoniales al {rate} en cualquier municipio de Cataluña, en lugar de aplicar {standard}.',
      whatRate: 'Impuesto de transmisiones patrimoniales al {rate}, en lugar de aplicar {baseline}.',
      whatOneOffRate: 'Un pago único de, como máximo, el menor de {cap} y el {rate} del precio.',
      whatOneOff: 'Un pago único o una deducción.',
      whatAnnual: 'Un importe anual.',
      whatAnnualYears:
        '{years, plural, one {Un importe anual durante # año como máximo.} other {Un importe anual durante # años como máximo.}}',
      'whatCostShare.purchase_payments':
        'Un porcentaje anual de los pagos por la compra de la vivienda{limits}. El importe depende de lo que pagues realmente, algo que este plan no sabe.',
      'whatCostShare.rent':
        'Un porcentaje anual del alquiler pagado{limits}. El importe depende de lo que pagues realmente, algo que este plan no sabe.',
      'whatCostShare.renovation':
        'Un porcentaje anual de los gastos de rehabilitación{limits}. El importe depende de lo que pagues realmente, algo que este plan no sabe.',
      'whatCostRate.purchase_payments':
        'El {rate} anual de los pagos por la compra de la vivienda{limits}. El importe depende de lo que pagues realmente, algo que este plan no sabe.',
      'whatCostRate.rent':
        'El {rate} anual del alquiler pagado{limits}. El importe depende de lo que pagues realmente, algo que este plan no sabe.',
      'whatCostRate.renovation':
        'El {rate} anual de los gastos de rehabilitación{limits}. El importe depende de lo que pagues realmente, algo que este plan no sabe.',
      limitBase: ', sobre una base de {base} al año como máximo',
      limitCap: ', con un límite de {individual} al año ({joint} en declaración conjunta)',

      labelGeneralRate: 'el tipo general',
      labelGeneralTariff: 'la tarifa general ({amount}, una media del {rate} sobre este precio)',
      labelGeneralPercent: 'el {rate} general',
      labelAlreadyQualify: 'el {rate} al que ya tienes derecho en cualquier municipio de Cataluña ({title})',

      lostMeasureEnds:
        '{months, plural, one {la medida está vigente hasta el {through} y no está confirmada para el {date}, el día en que podrías comprar (# mes después de la fecha del plan).} other {la medida está vigente hasta el {through} y no está confirmada para el {date}, el día en que podrías comprar (# meses después de la fecha del plan).}}',
      lostNotOnDay:
        '{months, plural, one {se aplica si compras en la fecha del plan, pero no el {date}, el día en que podrías comprar (# mes después de la fecha del plan).} other {se aplica si compras en la fecha del plan, pero no el {date}, el día en que podrías comprar (# meses después de la fecha del plan).}}',
      lostNotCertain:
        '{months, plural, one {se aplica si compras en la fecha del plan, pero no es seguro el {date}, el día en que podrías comprar (# mes después de la fecha del plan).} other {se aplica si compras en la fecha del plan, pero no es seguro el {date}, el día en que podrías comprar (# meses después de la fecha del plan).}}',
      criteriaNotMetByThen: 'Criterios que para entonces no se cumplen: {criteria}',
      toVerify: 'Hay que verificar: {criteria}',

      notCounted: 'No se cuenta: {reason}',
      notCountedCriteria: 'No se cuenta, no se cumplen los criterios: {criteria}',
      callClosed: 'No se cuenta: la convocatoria está cerrada.',
      callUpcoming: 'No se cuenta: la convocatoria aún no se ha abierto.',
      callNone:
        'No se cuenta: no se ha podido verificar ninguna convocatoria, así que esta ayuda aún no puede solicitarse.',
      callClosesBefore:
        'No se cuenta: la convocatoria está abierta hoy pero se cierra antes del {date}, el día en que podrías comprar, y no se conoce ninguna convocatoria posterior.',
      notInForceOn: 'No se cuenta: no está confirmado que la medida esté vigente el {date}.',
      notInForceOnPlanDate: 'No se cuenta: no está confirmado que la medida esté vigente en la fecha del plan.',
      untilVerifiedGeo: 'No se cuenta hasta que se verifique: {criteria}',
      shownUntilVerified: 'Se muestra, pero no se cuenta hasta que se verifique: {criteria}',
      amountUnknown: 'No se cuenta: el importe no puede calcularse con los hechos conocidos.',
      noReduction: 'No se cuenta: no aporta ninguna reducción en este lugar.',
      afterPurchase:
        'No se cuenta: se recibe después de la compra (con una declaración de la renta posterior), así que no acorta el tiempo necesario para reunir el dinero inicial. Reduce costes más adelante.',
      alreadyLiveHere: 'No se cuenta: ya vives aquí, así que, si lo recibes, ya forma parte de tus ingresos y ahorros.',

      countedAtPurchase: 'Se cuenta: reduce el dinero inicial necesario en {amount}.',
      countedAnnual:
        'Se cuenta como {amount} de ahorro mensual adicional a partir del mes {month}, suponiendo que te trasladas aquí en la fecha del plan y compras más adelante.',
      countedOneOff:
        'Se cuenta como {amount} recibidos al cabo de {months} meses, suponiendo que te trasladas aquí en la fecha del plan y compras más adelante.',
      countedUnverified: 'Se cuenta porque lo has pedido, aunque la elegibilidad no está verificada.',

      appliedBaseline:
        'Se aplica a tu referencia: reduce el dinero inicial en {amount} compres donde compres en Cataluña, así que no se cuenta como un ahorro de este lugar.',
      notApplied: 'No se aplica: {reason}',
      notAppliedCriteria: 'No se aplica, no se cumplen los criterios: {criteria}',
      notAppliedNotInForce: 'No se aplica: no está confirmado que la medida esté vigente el {date}.',
      notAppliedUntilVerified: 'No se aplica a tu referencia hasta que se verifique: {criteria}',
      ifYouQualify:
        'Si tienes derecho, pagas menos impuesto de transmisiones patrimoniales en todas partes, y el ahorro en ese impuesto que ofrece este lugar es menor que el que se muestra.',
      notAppliedAnother: 'No se aplica: otro tipo reducido ya es tu referencia, y los tipos reducidos no se acumulan.',
      notAppliedNotLower:
        'No se aplica: no es inferior al impuesto de transmisiones patrimoniales general para este precio.',

      assumeBudget: 'El precio es el presupuesto que has indicado, de {amount}.',
      missingBudgetPositive: 'person.home.budgetCents (debe ser superior a cero)',
      missingAreaOrBudget: 'person.home.floorAreaM2 o person.home.budgetCents',
      missingResale: 'precio de segunda mano por m² en {place}',
      missingMunicipalResale: 'precio municipal de segunda mano por m² en {place} (se ha usado la media de la comarca)',
      missingStandardRate:
        'tipo general del impuesto de transmisiones patrimoniales (ninguna medida de la recopilación lo indica)',
      missingGeneralRates:
        'hechos del hogar para los tipos reducidos del impuesto de transmisiones patrimoniales que se aplican en toda Cataluña ({ids}): la referencia usa {baseline} y el tipo podría ser tan bajo como el {rate}, lo que acortaría la referencia y reduciría el ahorro en ese impuesto que ofrece este lugar',
      assumePriceTown:
        'El precio es {area} m² × {perM2}/m² en {place} ({observedAt}) = {price}. Es una media de ventas pasadas, no un anuncio.',
      assumePriceComarca:
        'El precio es {area} m² × {perM2}/m², la media de la comarca ({comarca}, {observedAt}) = {price}. Es una media de ventas pasadas, no un anuncio.',
      assumeUpfront:
        'Dinero inicial = entrada del {depositRate} ({deposit}) + impuesto de transmisiones patrimoniales aplicando {baseline} ({tax}) + {feesRate} de notaría, registro y gastos similares ({fees}) = {total}. Se supone que el resto del precio se financia; ninguna entidad lo ha evaluado.',
      assumeBaselineApplied:
        'El impuesto de transmisiones patrimoniales de referencia es del {rate}, y no {standard}, porque todas las condiciones de «{title}» están confirmadas y ese tipo se aplica en cualquier municipio de Cataluña. A un lugar solo se le atribuye la diferencia entre ese tipo y el suyo.',
      assumeBaselinePossiblyLower:
        'El impuesto de transmisiones patrimoniales de referencia es {standard}. No se supone un tipo inferior de los que se aplican en toda Cataluña, porque no todas sus condiciones están confirmadas; si tienes derecho, la referencia es más corta y el ahorro en ese impuesto que ofrece un lugar rural es menor que el que se muestra.',
      assumeBaselineStandard:
        'El impuesto de transmisiones patrimoniales de referencia es {standard}: no tienes verificado ningún tipo reducido de los que se aplican en toda Cataluña.',
      assumeSavingsReserve:
        'Los ahorros disponibles son {available}: los ahorros actuales menos la reserva de emergencia de {reserve}.',
      assumeSavingsNoReserve:
        'Los ahorros disponibles son {available}. No se ha declarado ninguna reserva de emergencia, así que no se aparta ninguna.',
      assumeMonthly: 'El ahorro mensual son los ingresos menos los gastos ({amount}), a partir de cifras {basis}.',
      assumeMonthlyAsOf:
        'El ahorro mensual son los ingresos menos los gastos ({amount}), a partir de cifras {basis} a fecha {asOf}.',
      'basis.declared': 'declaradas',
      'basis.bank_observed': 'observadas en el banco',
      'basis.mixed': 'mixtas',
      'basis.unknown': 'de origen desconocido',
      assumeTariff:
        'El precio supera {threshold}, así que el impuesto de transmisiones patrimoniales general no es un tipo único. Sigue la tarifa por valor total ({steps}): {tax} para este precio. El precio se toma como el valor total del inmueble, y la agencia tributaria redondea el tipo medio, así que la cuota puede variar unos euros.',
      tariffStep: '{rate} a partir de {amount}',
      assumeHabitsCounted:
        '{count, plural, one {# hábito añade {amount} al mes} other {# hábitos añaden {amount} al mes}}: cada ahorro previsto se ajusta según el cumplimiento de los registros de seguimiento, o se cuenta entero cuando aún no hay ninguno. Los ahorros de los hábitos son estimaciones de la propia persona.',
      assumeHabitsWithheld:
        '{count, plural, one {# hábito activo se muestra pero no se cuenta} other {# hábitos activos se muestran pero no se cuentan}} ({titles}): tus gastos mensuales proceden de movimientos bancarios, que ya incluyen el efecto de un hábito que entonces estaba en marcha. Un hábito solo se añade cuando tiene una fecha de inicio posterior a ese periodo.',
      assumeHabitsWithheldUpTo:
        '{count, plural, one {# hábito activo se muestra pero no se cuenta} other {# hábitos activos se muestran pero no se cuentan}} ({titles}): tus gastos mensuales proceden de movimientos bancarios hasta el {asOf}, que ya incluyen el efecto de un hábito que entonces estaba en marcha. Un hábito solo se añade cuando tiene una fecha de inicio posterior a ese periodo.',
      assumeProposed: 'Los hábitos que solo están propuestos se cuentan como si se hubieran adoptado.',
      purchaseDayNone: 'no se puede estimar ningún día de compra, así que se comprueba en la fecha del plan',
      purchaseDayOn:
        '{months, plural, one {{date} (# mes después del {asOf})} other {{date} (# meses después del {asOf})}}',
      assumeScreening:
        'Los beneficios vinculados a la compra se comprueban para el día en que podrías comprar, con las edades avanzadas hasta ese día, no en la fecha del plan. Con los beneficios de este lugar: {place}. La referencia: {baseline}. Se supone que las bases imponibles, la situación familiar y las propias reglas se mantienen como el {asOf}.',
      assumeTaxDiffers:
        'El impuesto de transmisiones patrimoniales en toda Cataluña es distinto en los dos días: {baseline} para la referencia y {place} con los beneficios de este lugar, que es el tipo con el que se compara este lugar.',
      assumeHeld:
        'Con tus hábitos tendrías el dinero antes del {date}, pero en ese día anterior no se aplica el impuesto de transmisiones patrimoniales en el que se basa la referencia, y el plan no busca ningún día intermedio. Por eso el plazo con hábitos es el día de la referencia, el {date}: ahorrar más nunca retrasa la compra.',
      timelineBaseline: 'referencia',
      timelineHabits: 'con hábitos',
      timelinePlace: 'con los beneficios de este lugar',
      assumeNoDay:
        'No hay ningún día de compra para estos plazos ({timelines}): un beneficio que se cumple en la fecha del plan ya no se cumpliría cuando se hubiera podido ahorrar el dinero, y sin él el dinero inicial queda más allá del horizonte. Los beneficios se muestran tal como se comprueban en la fecha del plan, el {asOf}, y no se cuenta ninguno.',
      assumeUnsettled:
        'El día en que podrías comprar no se ha estabilizado para estos plazos ({timelines}): contar un beneficio trasladaba la compra a un día en el que no se aplica. Los beneficios que dependen de ese día se dejan fuera en ellos, que es la cifra prudente.',
      assumeBeyond:
        'No se da ningún plazo: con {amount} al mes, el dinero inicial queda a más de {months} meses ({years} años), más allá de lo que este plan estima.',
      assumeBeyondBaseline:
        'No se da ningún plazo para la referencia: con {amount} al mes, el dinero inicial queda a más de {months} meses ({years} años), más allá de lo que este plan estima.',
      assumeUnverifiedCounted:
        'Los beneficios con la elegibilidad aún no verificada se cuentan porque lo has pedido; considera provisional el plazo más corto.',
      assumeOnlyVerified:
        'Solo se cuentan los beneficios con todas las condiciones de elegibilidad confirmadas; los demás se muestran, pero no se cuentan.',
      assumeTiming:
        'Un beneficio vinculado a la compra reduce el dinero inicial. Un beneficio vinculado a vivir o alquilar en el lugar solo cuenta si se supone que te trasladas allí en la fecha del plan y compras más adelante, y llega con un ejercicio fiscal de retraso. Un beneficio que se recibe después de la compra no se cuenta nunca.',
    },
  },
);

/** What the plan says about the person's facts: what a question could change, and where a fact came from. */
export const factMessages = defineMessages(
  {
    alsoDependsOn: 'It also depends on: {list}.',
    effectBaseline:
      'Could lower the transfer tax you would pay anywhere in Catalonia by up to {amount} ({title}). The estimate for {place} stays as it is, because a lower rate is already counted there.',
    effectMonthsAndCash:
      'Could shorten the wait by up to {months, plural, one {# month} other {# months}} in {place} and lower the upfront cash by up to {amount}, through “{title}”.',
    effectMonths:
      'Could shorten the wait by up to {months, plural, one {# month} other {# months}} in {place}, through “{title}”.',
    effectCash: 'Could lower the upfront cash by up to {amount} in {place}, through “{title}”.',
    requiredPrice:
      'Needed to price the home: without a budget or a size, no upfront cash can be computed for any place.',
    requiredTimeline: 'Needed before any timeline can be estimated.',
    assumedDeposit:
      'The plan assumes a deposit of {rate} of the price. Your own figure changes the upfront cash directly.',
    assumedReserve:
      'The plan sets no emergency reserve aside, so all your savings count towards the purchase. A reserve is taken off them first.',

    'source.profile': 'your saved profile',
    'source.interview': 'the interview',
    'source.manual': 'typed in by you',
    'source.bank': 'bank movements',
    'source.listing': 'a listing',
    'source.what_if': 'this estimate only, not saved',
    'source.request': 'stated with this request',

    staleAge: 'Given as an age on {given}. An age goes out of date with a birthday: give the date of birth instead.',
    staleTaxYear:
      'Given on {given}, in an earlier year. It belongs to one tax return and a newer one probably exists: check it.',
    staleSchoolYear: 'Given on {given}, before the current school year began. Check that it still holds.',

    reliedOn: 'Facts about you this plan relied on: {facts}.',
    reliedFact: '{label}: {value} ({details})',
    reliedGiven: 'given {date}',
    reliedConfirmed: 'confirmed',
    reliedNotConfirmed: 'not confirmed',
    reliedStale: 'possibly out of date',

    bankUnreadable: 'Bank movements could not be read; only declared figures were used.',
    habitsUnreadable: 'Habits could not be read; none were counted.',
  },
  {
    ca: {
      alsoDependsOn: 'També depèn de: {list}.',
      effectBaseline:
        'Podria reduir en fins a {amount} l’impost de transmissions patrimonials que pagaries a qualsevol municipi de Catalunya ({title}). L’estimació per a {place} es queda com està, perquè allà ja es compta un tipus inferior.',
      effectMonthsAndCash:
        'Podria escurçar l’espera en fins a {months, plural, one {# mes} other {# mesos}} a {place} i reduir els diners inicials en fins a {amount}, gràcies a «{title}».',
      effectMonths:
        'Podria escurçar l’espera en fins a {months, plural, one {# mes} other {# mesos}} a {place}, gràcies a «{title}».',
      effectCash: 'Podria reduir els diners inicials en fins a {amount} a {place}, gràcies a «{title}».',
      requiredPrice:
        'Cal per posar preu a l’habitatge: sense un pressupost o una superfície, no es poden calcular els diners inicials per a cap lloc.',
      requiredTimeline: 'Cal abans de poder estimar cap termini.',
      assumedDeposit:
        'El pla suposa una entrada del {rate} del preu. La teva pròpia xifra canvia directament els diners inicials.',
      assumedReserve:
        'El pla no aparta cap reserva d’emergència, de manera que tots els teus estalvis compten per a la compra. Una reserva se’n resta primer.',

      'source.profile': 'el teu perfil desat',
      'source.interview': 'l’entrevista',
      'source.manual': 'escrit per tu',
      'source.bank': 'moviments bancaris',
      'source.listing': 'un anunci',
      'source.what_if': 'només en aquesta estimació, no desat',
      'source.request': 'indicat amb aquesta consulta',

      staleAge:
        'Indicat com a edat el {given}. Una edat queda desfasada amb un aniversari: indica la data de naixement.',
      staleTaxYear:
        'Indicat el {given}, en un any anterior. Correspon a una declaració de la renda concreta i probablement n’hi ha una de més recent: comprova-ho.',
      staleSchoolYear:
        'Indicat el {given}, abans que comencés el curs escolar actual. Comprova que encara sigui vàlid.',

      reliedOn: 'Fets sobre tu en què s’ha basat aquest pla: {facts}.',
      reliedFact: '{label}: {value} ({details})',
      reliedGiven: 'indicat el {date}',
      reliedConfirmed: 'confirmat',
      reliedNotConfirmed: 'no confirmat',
      reliedStale: 'possiblement desfasat',

      bankUnreadable: 'No s’han pogut llegir els moviments bancaris; només s’han fet servir les xifres declarades.',
      habitsUnreadable: 'No s’han pogut llegir els hàbits; no se n’ha comptat cap.',
    },
    es: {
      alsoDependsOn: 'También depende de: {list}.',
      effectBaseline:
        'Podría reducir en hasta {amount} el impuesto de transmisiones patrimoniales que pagarías en cualquier municipio de Cataluña ({title}). La estimación para {place} se queda como está, porque allí ya se cuenta un tipo inferior.',
      effectMonthsAndCash:
        'Podría acortar la espera en hasta {months, plural, one {# mes} other {# meses}} en {place} y reducir el dinero inicial en hasta {amount}, gracias a «{title}».',
      effectMonths:
        'Podría acortar la espera en hasta {months, plural, one {# mes} other {# meses}} en {place}, gracias a «{title}».',
      effectCash: 'Podría reducir el dinero inicial en hasta {amount} en {place}, gracias a «{title}».',
      requiredPrice:
        'Hace falta para poner precio a la vivienda: sin un presupuesto o una superficie, no se puede calcular el dinero inicial para ningún lugar.',
      requiredTimeline: 'Hace falta antes de poder estimar ningún plazo.',
      assumedDeposit:
        'El plan supone una entrada del {rate} del precio. Tu propia cifra cambia directamente el dinero inicial.',
      assumedReserve:
        'El plan no aparta ninguna reserva de emergencia, así que todos tus ahorros cuentan para la compra. Una reserva se resta de ellos primero.',

      'source.profile': 'tu perfil guardado',
      'source.interview': 'la entrevista',
      'source.manual': 'escrito por ti',
      'source.bank': 'movimientos bancarios',
      'source.listing': 'un anuncio',
      'source.what_if': 'solo en esta estimación, no guardado',
      'source.request': 'indicado con esta consulta',

      staleAge:
        'Indicado como edad el {given}. Una edad queda desfasada con un cumpleaños: indica la fecha de nacimiento.',
      staleTaxYear:
        'Indicado el {given}, en un año anterior. Corresponde a una declaración de la renta concreta y probablemente hay una más reciente: compruébalo.',
      staleSchoolYear:
        'Indicado el {given}, antes de que empezara el curso escolar actual. Comprueba que siga siendo válido.',

      reliedOn: 'Hechos sobre ti en los que se ha basado este plan: {facts}.',
      reliedFact: '{label}: {value} ({details})',
      reliedGiven: 'indicado el {date}',
      reliedConfirmed: 'confirmado',
      reliedNotConfirmed: 'no confirmado',
      reliedStale: 'posiblemente desfasado',

      bankUnreadable: 'No se han podido leer los movimientos bancarios; solo se han usado las cifras declaradas.',
      habitsUnreadable: 'No se han podido leer los hábitos; no se ha contado ninguno.',
    },
  },
);
