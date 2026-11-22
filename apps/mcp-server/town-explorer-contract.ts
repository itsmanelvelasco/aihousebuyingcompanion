import { z } from 'zod';
import { municipalityCode, profileRecommendationInput, recommendationInput } from '../../packages/contracts/places.ts';

const explorerRecommendation = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('recommend_towns'), arguments: recommendationInput }).strict(),
  z.object({ tool: z.literal('recommend_towns_for_profile'), arguments: profileRecommendationInput }).strict(),
]);

export const explorerInput = z
  .object({
    municipalityCode: municipalityCode.optional(),
    recommendation: explorerRecommendation
      .optional()
      .describe(
        'For a shortlist, pass the original recommendation tool name and its exact arguments, preserving all confirmed filters.',
      ),
  })
  .strict();

export const explorerResult = explorerInput.extend({ municipalityCode: municipalityCode.nullable() });
export type ExplorerResult = z.infer<typeof explorerResult>;
