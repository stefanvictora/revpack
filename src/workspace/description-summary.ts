// Marker-based MR/PR description summary section.
export const MARKER_START = '<!-- revpack:start -->';
export const MARKER_END = '<!-- revpack:end -->';

/**
 * Merge new content into the description using HTML comment markers.
 * If markers exist, replaces the content between them.
 * If no markers exist, appends a new marked section.
 */
export function mergeWithMarkers(existing: string, newContent: string): string {
  const markedSection = `${MARKER_START}\n${newContent.trim()}\n${MARKER_END}`;

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + markedSection + existing.slice(endIdx + MARKER_END.length);
  }

  const separator = existing.trim() ? '\n\n---\n\n' : '';
  return existing.trimEnd() + separator + markedSection;
}

/**
 * Extract the published revpack summary section from an MR/PR description.
 */
export function extractMarkedSummary(description: string): string | null {
  const startIdx = description.indexOf(MARKER_START);
  if (startIdx === -1) return null;

  const contentStart = startIdx + MARKER_START.length;
  const endIdx = description.indexOf(MARKER_END, contentStart);
  if (endIdx === -1) return null;

  const content = description.slice(contentStart, endIdx).trim();
  return content ? content : null;
}
