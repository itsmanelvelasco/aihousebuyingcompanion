import type { z } from 'zod';
import type { relocationResult, Snapshot } from '../contracts/places.ts';

export function getRelocationResearch(
  snapshot: Snapshot,
  code: string,
  asOf: string,
): z.infer<typeof relocationResult> {
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
      ? [
          ...dataset!.scopeNotes,
          'Research status describes sources at the check date, not live availability or household eligibility. Confirm current terms with the source.',
          'Opportunity rents and business fees are separate from municipal market averages. Research does not affect town budget screening or ranking.',
          'Historical leads and the bundled public-data snapshot are not used as current municipal evidence.',
        ]
      : ['No detailed relocation research is loaded for this municipality. This does not mean no opportunities exist.'],
  };
}
