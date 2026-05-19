import { describe, expect, it } from 'vitest';
import { MARKER_END, MARKER_START, extractMarkedSummary, mergeWithMarkers } from './description-summary.js';

describe('description summary markers', () => {
  it('appends a marked section to an empty description', () => {
    expect(mergeWithMarkers('', ' New summary\n')).toBe(`${MARKER_START}\nNew summary\n${MARKER_END}`);
  });

  it('appends a marked section after existing content with a separator', () => {
    expect(mergeWithMarkers('Existing description\n\n', 'New summary')).toBe(
      `Existing description\n\n---\n\n${MARKER_START}\nNew summary\n${MARKER_END}`,
    );
  });

  it('replaces an existing marked section without disturbing surrounding text', () => {
    const existing = `Before\n${MARKER_START}\nOld summary\n${MARKER_END}\nAfter`;

    expect(mergeWithMarkers(existing, 'New summary')).toBe(
      `Before\n${MARKER_START}\nNew summary\n${MARKER_END}\nAfter`,
    );
  });

  it('replaces a marked section when the start marker begins at offset one', () => {
    const existing = `\n${MARKER_START}\nOld summary\n${MARKER_END}`;

    expect(mergeWithMarkers(existing, 'New summary')).toBe(`\n${MARKER_START}\nNew summary\n${MARKER_END}`);
  });

  it('replaces an empty marked section', () => {
    expect(mergeWithMarkers(`${MARKER_START}${MARKER_END}`, 'New summary')).toBe(
      `${MARKER_START}\nNew summary\n${MARKER_END}`,
    );
  });

  it('appends instead of replacing when only the start marker exists', () => {
    expect(mergeWithMarkers(`Before\n${MARKER_START}\nOld summary`, 'New summary')).toBe(
      `Before\n${MARKER_START}\nOld summary\n\n---\n\n${MARKER_START}\nNew summary\n${MARKER_END}`,
    );
  });

  it('appends instead of replacing when only the end marker exists', () => {
    expect(mergeWithMarkers(`Before\n${MARKER_END}\nAfter`, 'New summary')).toBe(
      `Before\n${MARKER_END}\nAfter\n\n---\n\n${MARKER_START}\nNew summary\n${MARKER_END}`,
    );
  });

  it('appends instead of replacing when only a late end marker exists', () => {
    const existing = `${'Before missing start marker '.repeat(2)}${MARKER_END}`;

    expect(mergeWithMarkers(existing, 'New summary')).toBe(
      `${existing}\n\n---\n\n${MARKER_START}\nNew summary\n${MARKER_END}`,
    );
  });

  it('appends instead of replacing when the end marker appears before the start marker', () => {
    const existing = `${MARKER_END}\nBefore\n${MARKER_START}`;

    expect(mergeWithMarkers(existing, 'New summary')).toBe(
      `${existing}\n\n---\n\n${MARKER_START}\nNew summary\n${MARKER_END}`,
    );
  });

  it('extracts trimmed content from a marked section', () => {
    expect(extractMarkedSummary(`Before\n${MARKER_START}\n  Summary body\n\n${MARKER_END}\nAfter`)).toBe(
      'Summary body',
    );
  });

  it('extracts a summary when the start marker begins at offset one', () => {
    expect(extractMarkedSummary(`\n${MARKER_START}\nSummary body\n${MARKER_END}`)).toBe('Summary body');
  });

  it('returns null when markers are missing, incomplete, or empty', () => {
    expect(extractMarkedSummary('No revpack summary')).toBeNull();
    expect(extractMarkedSummary(`${MARKER_START}\nSummary without end`)).toBeNull();
    expect(extractMarkedSummary(`${'Before missing start marker '.repeat(2)}${MARKER_END}`)).toBeNull();
    expect(extractMarkedSummary(`${MARKER_START}\n   \n${MARKER_END}`)).toBeNull();
  });
});
