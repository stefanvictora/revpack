import type { GenerationAttribution, ProviderType, PublishAttribution } from '../core/types.js';
import { normalizeGenerationModel } from '../core/generation-attribution.js';

const REVPK_LINK = '[revpack](https://github.com/stefanvictora/revpack)';

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

export function renderPublishAttributionFooter(provider: ProviderType, attribution: PublishAttribution): string {
  const model = attribution.kind === 'generation' ? normalizeGenerationModel(attribution.model) : undefined;
  const prefix = attribution.kind === 'generation' ? '🤖 AI-generated via' : 'Published via';
  const modelSuffix = model ? ` · Model: ${escapeAttributionText(model)}` : '';
  const content = `${prefix} ${REVPK_LINK}${modelSuffix}`;
  return provider === 'bitbucket-cloud' ? `\n\n###### ${content}` : `\n\n<sub>${content}</sub>`;
}

function escapeAttributionText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]()])/g, '\\$1');
}
