import type { z } from 'zod';
import type { relocationResult, Snapshot } from '../contracts/places.ts';
import { defaultLocale, type Locale } from '../i18n/locales.ts';
import { translator } from '../i18n/messages.ts';
import { accessMessages } from './messages.ts';

export function getRelocationResearch(
  snapshot: Snapshot,
  code: string,
  asOf: string,
  locale: Locale = defaultLocale,
): z.infer<typeof relocationResult> {
  // The scope notes come from the research dataset and stay as their source wrote them.
  const t = translator(accessMessages, locale);
  const dataset = snapshot.relocation;
  const research = dataset?.municipalities.find(town => town.municipalityCode === code) ?? null;
  return {
    coverage: research ? 'researched' : 'not_researched',
    checkedOn: research ? dataset!.checkedOn : null,
    sourcePage: research ? dataset!.sourcePage : null,
    asOf,
    research,
    opportunityChecks: (research?.opportunities ?? []).map(offer => ({
      id: offer.id,
      availability:
        offer.status === 'closed' || offer.status === 'filled' || offer.status === 'proposed'
          ? offer.status
          : 'needs_verification',
      eligibilityStatus: 'needs_verification',
      checkedBeforeAsOf: offer.checkedOn < asOf,
      deadlinePassed: offer.applicationDeadline !== null && offer.applicationDeadline < asOf,
      conflictingDeadlines: new Set(offer.reportedDeadlineDates).size > 1,
    })),
    limitations: research
      ? [...dataset!.scopeNotes, t('researchStatus'), t('researchSeparate'), t('researchHistorical')]
      : [t('researchNone')],
  };
}
