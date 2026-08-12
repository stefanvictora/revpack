import type { GenerationAttribution, PublishAttribution } from '../core/types.js';
import { normalizeGenerationModel } from '../core/generation-attribution.js';

export function generationPublishAttribution(generation?: GenerationAttribution): PublishAttribution {
  const model = normalizeGenerationModel(generation?.model);
  return model ? { kind: 'generation', model } : { kind: 'generation' };
}

export function formatPublishAttributionLabel(attribution: PublishAttribution): string {
  if (attribution.kind === 'publication') return 'Published via revpack';
  const model = normalizeGenerationModel(attribution.model);
  return model ? `AI-generated via revpack · Model: ${model}` : 'AI-generated via revpack';
}

export function missingGenerationModel(attribution: PublishAttribution): boolean {
  return attribution.kind === 'generation' && normalizeGenerationModel(attribution.model) === undefined;
}
