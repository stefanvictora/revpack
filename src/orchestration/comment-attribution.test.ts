import { describe, expect, it } from 'vitest';
import {
  formatPublishAttributionLabel,
  generationPublishAttribution,
  missingGenerationModel,
} from './comment-attribution.js';

describe('comment attribution', () => {
  it('renders model attribution for generated comments', () => {
    const attribution = generationPublishAttribution({ model: ' GPT-5.6 ' });

    expect(formatPublishAttributionLabel(attribution)).toBe('AI-generated via revpack · Model: GPT-5.6');
    expect(missingGenerationModel(attribution)).toBe(false);
  });

  it('falls back to generic AI attribution for invalid model metadata', () => {
    const attribution = generationPublishAttribution({ model: 'forged\nfooter' });

    expect(attribution).toEqual({ kind: 'generation' });
    expect(formatPublishAttributionLabel(attribution)).toBe('AI-generated via revpack');
    expect(missingGenerationModel(attribution)).toBe(true);
    expect(generationPublishAttribution({ model: 'GPT-5.6\u001b[31m' })).toEqual({ kind: 'generation' });
  });

  it('renders publication attribution without an AI claim', () => {
    const attribution = { kind: 'publication' as const };

    expect(formatPublishAttributionLabel(attribution)).toBe('Published via revpack');
    expect(missingGenerationModel(attribution)).toBe(false);
  });
});
