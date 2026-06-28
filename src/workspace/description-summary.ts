// Marker-based MR/PR description summary section.
export const MARKER_START = '<!-- revpack:start -->';
export const MARKER_END = '<!-- revpack:end -->';
export const MARKDOWN_HEADING_MARKER_START = '###### revpack:summary';
export const MARKDOWN_HEADING_MARKER_END = '###### revpack:end';

export type DescriptionMarkerStyle = 'html' | 'markdown-heading';

interface MarkedSection {
  startIdx: number;
  endIdx: number;
  contentStart: number;
  markerEnd: string;
}

function markersForStyle(style: DescriptionMarkerStyle): { start: string; end: string } {
  return style === 'markdown-heading'
    ? { start: MARKDOWN_HEADING_MARKER_START, end: MARKDOWN_HEADING_MARKER_END }
    : { start: MARKER_START, end: MARKER_END };
}

function buildMarkedSection(newContent: string, style: DescriptionMarkerStyle): string {
  const { start, end } = markersForStyle(style);
  return `${start}\n${newContent.trim()}\n${end}`;
}

function findMarkedSection(description: string): MarkedSection | null {
  const candidates = [markersForStyle('html'), markersForStyle('markdown-heading')]
    .map(({ start, end }) => {
      const startIdx = description.indexOf(start);
      if (startIdx === -1) return null;
      const contentStart = startIdx + start.length;
      const endIdx = description.indexOf(end, contentStart);
      if (endIdx < contentStart) return null;
      return { startIdx, endIdx, contentStart, markerEnd: end };
    })
    .filter((candidate): candidate is MarkedSection => candidate !== null)
    .sort((a, b) => a.startIdx - b.startIdx);

  return candidates[0] ?? null;
}

/**
 * Merge new content into the description using revpack markers.
 * If markers exist, replaces the content between them.
 * If no markers exist, appends a new marked section.
 */
export function mergeWithMarkers(
  existing: string,
  newContent: string,
  options?: { markerStyle?: DescriptionMarkerStyle },
): string {
  const markerStyle = options?.markerStyle ?? 'html';
  const markedSection = buildMarkedSection(newContent, markerStyle);
  const section = findMarkedSection(existing);

  if (section) {
    return (
      existing.slice(0, section.startIdx) + markedSection + existing.slice(section.endIdx + section.markerEnd.length)
    );
  }

  const separator = existing.trim() ? '\n\n---\n\n' : '';
  return existing.trimEnd() + separator + markedSection;
}

/**
 * Extract the published revpack summary section from an MR/PR description.
 */
export function extractMarkedSummary(description: string): string | null {
  const section = findMarkedSection(description);
  if (!section) return null;

  const content = description.slice(section.contentStart, section.endIdx).trim();
  return content ? content : null;
}

export function stripMarkedSummary(description: string): string {
  const section = findMarkedSection(description);
  if (!section) return description;

  const before = description.slice(0, section.startIdx);
  const after = description.slice(section.endIdx + section.markerEnd.length);
  return before.replace(/\n\n---\n\n$/, '') + after;
}
