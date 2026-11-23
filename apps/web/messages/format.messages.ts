import { defineMessages } from '../../../packages/i18n/messages.ts';

/** Words of the workspace's own formatters: differences between timelines and "… ago" labels. */
export const formatMessages = defineMessages(
  {
    notComparable: 'Not comparable',
    noChange: 'No change',
    monthsSooner: '{count, plural, one {# month} other {# months}} sooner',
    monthsLater: '{count, plural, one {# month} other {# months}} later',
    justNow: 'just now',
    secondsAgo: '{count} s ago',
    minutesAgo: '{count} min ago',
    hoursAgo: '{count} h ago',
    daysAgo: '{count, plural, one {# day} other {# days}} ago',
    source: 'source',
  },
  {
    ca: {
      notComparable: 'No comparable',
      noChange: 'Sense canvis',
      monthsSooner: '{count, plural, one {# mes} other {# mesos}} abans',
      monthsLater: '{count, plural, one {# mes} other {# mesos}} més tard',
      justNow: 'ara mateix',
      secondsAgo: 'fa {count} s',
      minutesAgo: 'fa {count} min',
      hoursAgo: 'fa {count} h',
      daysAgo: 'fa {count, plural, one {# dia} other {# dies}}',
      source: 'font',
    },
    es: {
      notComparable: 'No comparable',
      noChange: 'Sin cambios',
      monthsSooner: '{count, plural, one {# mes} other {# meses}} antes',
      monthsLater: '{count, plural, one {# mes} other {# meses}} más tarde',
      justNow: 'ahora mismo',
      secondsAgo: 'hace {count} s',
      minutesAgo: 'hace {count} min',
      hoursAgo: 'hace {count} h',
      daysAgo: 'hace {count, plural, one {# día} other {# días}}',
      source: 'fuente',
    },
  },
);
