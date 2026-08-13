export const GENERATION_MODEL_MAX_LENGTH = 80;

/**
 * Normalize an agent-reported model label for display.
 * Invalid labels are ignored so attribution metadata never blocks publication.
 */
export function normalizeGenerationModel(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) return undefined;
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.length > GENERATION_MODEL_MAX_LENGTH) return undefined;
  return normalized;
}
