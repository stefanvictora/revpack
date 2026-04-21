import { describe, it, expect } from 'vitest';
import { mergeWithMarkers, MARKER_START, MARKER_END } from './update-description.js';

describe('mergeWithMarkers', () => {
  it('appends marked section to an empty description', () => {
    const result = mergeWithMarkers('', 'New summary content');

    expect(result).toContain(MARKER_START);
    expect(result).toContain(MARKER_END);
    expect(result).toContain('New summary content');
  });

  it('appends marked section after existing description with separator', () => {
    const result = mergeWithMarkers('Original MR description', 'Review summary');

    expect(result).toContain('Original MR description');
    expect(result).toContain('---');
    expect(result).toContain(MARKER_START);
    expect(result).toContain('Review summary');
    expect(result).toContain(MARKER_END);
  });

  it('preserves the original description text', () => {
    const original = 'This MR implements feature X.\n\nIt changes the login flow.';
    const result = mergeWithMarkers(original, 'Summary');

    expect(result).toContain(original.trimEnd());
  });

  it('replaces content between existing markers', () => {
    const existing = [
      'Original description',
      '',
      '---',
      '',
      MARKER_START,
      'Old summary v1',
      MARKER_END,
    ].join('\n');

    const result = mergeWithMarkers(existing, 'Updated summary v2');

    expect(result).toContain('Original description');
    expect(result).toContain('Updated summary v2');
    expect(result).not.toContain('Old summary v1');
    // Should have exactly one pair of markers
    expect(result.split(MARKER_START).length).toBe(2);
    expect(result.split(MARKER_END).length).toBe(2);
  });

  it('preserves text before and after markers when replacing', () => {
    const existing = [
      'Before the markers',
      MARKER_START,
      'Old content',
      MARKER_END,
      'After the markers',
    ].join('\n');

    const result = mergeWithMarkers(existing, 'New content');

    expect(result).toContain('Before the markers');
    expect(result).toContain('After the markers');
    expect(result).toContain('New content');
    expect(result).not.toContain('Old content');
  });

  it('trims whitespace from new content', () => {
    const result = mergeWithMarkers('', '  \n  padded content  \n  ');

    expect(result).toContain(`${MARKER_START}\npadded content\n${MARKER_END}`);
  });

  it('handles whitespace-only existing description', () => {
    const result = mergeWithMarkers('   \n  ', 'Content');

    // Should not add separator when existing is effectively empty
    expect(result).not.toContain('---');
  });

  it('handles multiple replace cycles idempotently', () => {
    let desc = 'Original';

    desc = mergeWithMarkers(desc, 'First pass');
    expect(desc).toContain('First pass');

    desc = mergeWithMarkers(desc, 'Second pass');
    expect(desc).toContain('Second pass');
    expect(desc).not.toContain('First pass');
    expect(desc).toContain('Original');

    // Still exactly one marker pair
    expect(desc.split(MARKER_START).length).toBe(2);
  });
});
