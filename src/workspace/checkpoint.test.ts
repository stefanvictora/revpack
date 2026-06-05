import { describe, it, expect } from 'vitest';
import {
  buildCheckpointState,
  encodeCheckpointState,
  parseDescriptionState,
  buildDescriptionStateBlock,
  patchDescriptionWithState,
  sanitizeDescriptionForAgent,
  stripReviewNoteFooter,
  CHECKPOINT_MARKER_START,
  CHECKPOINT_MARKER_END,
  CHECKPOINT_STATE_BLOCK_REGEX,
  REVIEW_NOTE_MARKER,
  REVIEW_NOTE_FOOTER,
} from './checkpoint.js';
import type { ReviewTargetRef } from '../core/types.js';

const targetRef: ReviewTargetRef = {
  provider: 'gitlab',
  repository: 'edm/zareg/edmreg',
  targetType: 'merge_request',
  targetId: '902',
};

describe('checkpoint serializer', () => {
  it('builds checkpoint state with all fields', () => {
    const state = buildCheckpointState(
      targetRef,
      'headabc',
      'basedef',
      'startdef',
      'sha256:threads123',
      'v42',
      'sha256:desc456',
    );

    expect(state.schemaVersion).toBe(1);
    expect(state.tool.name).toBe('revpack');
    expect(state.target.provider).toBe('gitlab');
    expect(state.target.id).toBe('902');
    expect(state.checkpoint.headSha).toBe('headabc');
    expect(state.checkpoint.baseSha).toBe('basedef');
    expect(state.checkpoint.providerVersionId).toBe('v42');
    expect(state.checkpoint.threadsDigest).toBe('sha256:threads123');
    expect(state.checkpoint.descriptionDigest).toBe('sha256:desc456');
    expect(state.checkpoint.createdAt).toBeTruthy();
  });

  it('encodes to base64url and roundtrips', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', 'sha256:test');

    const encoded = encodeCheckpointState(state);
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));

    expect(decoded.checkpoint.headSha).toBe('abc');
    expect(decoded.checkpoint.threadsDigest).toBe('sha256:test');
  });
});

// ─── Description-body state block tests ──────────────────

describe('parseDescriptionState', () => {
  it('parses state block from description', () => {
    const state = buildCheckpointState(targetRef, 'abc123', 'def456', 'def456', 'sha256:threads');
    const description = `# My MR

Some description text.

${buildDescriptionStateBlock(state)}`;

    const parsed = parseDescriptionState(description);
    expect(parsed).not.toBeNull();
    expect(parsed!.checkpoint.headSha).toBe('abc123');
    expect(parsed!.checkpoint.threadsDigest).toBe('sha256:threads');
    expect(parsed!.target.id).toBe('902');
  });

  it('returns null when no state block exists', () => {
    const description = '# My MR\n\nJust a normal description.';
    expect(parseDescriptionState(description)).toBeNull();
  });

  it('throws on multiple state blocks', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', null);
    const block = buildDescriptionStateBlock(state);
    const description = `# My MR\n\n${block}\n\nSome text\n\n${block}`;

    expect(() => parseDescriptionState(description)).toThrow('multiple revpack state blocks');
  });

  it('handles malformed state block gracefully', () => {
    const description = `# My MR\n\n<!-- revpack:state\nnot-valid-data\n-->`;
    expect(parseDescriptionState(description)).toBeNull();
  });
});

describe('patchDescriptionWithState', () => {
  it('appends state block to description without existing state', () => {
    const state = buildCheckpointState(targetRef, 'head1', 'base1', 'start1', null);
    const result = patchDescriptionWithState('# My MR\n\nDescription text.', state);

    expect(result).toContain('# My MR');
    expect(result).toContain('Description text.');
    expect(result).toContain('<!-- revpack:state');

    // Verify roundtrip
    const parsed = parseDescriptionState(result);
    expect(parsed).not.toBeNull();
    expect(parsed!.checkpoint.headSha).toBe('head1');
  });

  it('replaces existing state block in place', () => {
    const oldState = buildCheckpointState(targetRef, 'old-head', 'base', 'start', null);
    const existing = patchDescriptionWithState('# My MR\n\nOriginal text.', oldState);

    const newState = buildCheckpointState(targetRef, 'new-head', 'base', 'start', 'sha256:threads');
    const updated = patchDescriptionWithState(existing, newState);

    // Should only have one state block
    const matches = [...updated.matchAll(/<!-- revpack:state/g)];
    expect(matches).toHaveLength(1);

    // Should preserve original text
    expect(updated).toContain('# My MR');
    expect(updated).toContain('Original text.');

    // Should have new state
    const parsed = parseDescriptionState(updated);
    expect(parsed!.checkpoint.headSha).toBe('new-head');
    expect(parsed!.checkpoint.threadsDigest).toBe('sha256:threads');
  });

  it('throws on multiple state blocks', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', null);
    const block = buildDescriptionStateBlock(state);
    const description = `# My MR\n\n${block}\n\nText\n\n${block}`;

    expect(() => patchDescriptionWithState(description, state)).toThrow('multiple revpack state blocks');
  });

  it('preserves unrelated description content', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    const description = `# Feature: Login

## Summary
Implements OAuth login flow.

<!-- revpack:start -->
## Changed
- Added OAuth support.
<!-- revpack:end -->

## Notes
Some extra notes.`;

    const result = patchDescriptionWithState(description, state);
    expect(result).toContain('# Feature: Login');
    expect(result).toContain('## Summary');
    expect(result).toContain('Implements OAuth login flow.');
    expect(result).toContain('<!-- revpack:start -->');
    expect(result).toContain('<!-- revpack:end -->');
    expect(result).toContain('## Notes');
    expect(result).toContain('Some extra notes.');
  });
});

describe('sanitizeDescriptionForAgent', () => {
  it('removes state block from description', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', null);
    const description = patchDescriptionWithState('# My MR\n\nSome text here.', state);

    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).toContain('# My MR');
    expect(sanitized).toContain('Some text here.');
    expect(sanitized).not.toContain('<!-- revpack:state');
  });

  it('strips the revpack-generated summary marker block', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', null);
    const description = `# My MR

<!-- revpack:start -->
## Changed
- Updated login flow.
<!-- revpack:end -->

${buildDescriptionStateBlock(state)}`;

    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).toContain('# My MR');
    expect(sanitized).not.toContain('<!-- revpack:start -->');
    expect(sanitized).not.toContain('## Changed');
    expect(sanitized).not.toContain('<!-- revpack:end -->');
    expect(sanitized).not.toContain('<!-- revpack:state');
  });

  it('returns description unchanged when no state block', () => {
    const description = '# My MR\n\nJust a normal description.';
    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).toBe(description);
  });

  it('strips the summary block and its separator when appended to existing description', () => {
    // Simulate the structure mergeWithMarkers produces when appending
    const description = `# My MR\n\nSome text here.\n\n---\n\n<!-- revpack:start -->\n## Changed\n- Updated login flow.\n<!-- revpack:end -->`;

    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).toContain('# My MR');
    expect(sanitized).toContain('Some text here.');
    expect(sanitized).not.toContain('---');
    expect(sanitized).not.toContain('<!-- revpack:start -->');
    expect(sanitized).not.toContain('<!-- revpack:end -->');
  });

  it('collapses excessive trailing newlines to a single newline', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', null);
    const description = `# My MR\n\n\n\n\n${buildDescriptionStateBlock(state)}`;

    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).not.toMatch(/\n{3,}$/);
    expect(sanitized).toBe('# My MR');
  });

  it('trims trailing whitespace from result', () => {
    const description = '# My MR   ';
    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).toBe('# My MR');
  });

  it('preserves content after the revpack:end marker', () => {
    const description = `# My MR\n\n---\n\n<!-- revpack:start -->\n## Changed\n<!-- revpack:end -->\n\nAfter marker content.`;

    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).toContain('After marker content.');
    expect(sanitized).not.toContain('<!-- revpack:start -->');
  });

  it('handles MARKER_START present but no MARKER_END', () => {
    const description = `# My MR\n\n<!-- revpack:start -->\nUnclosed section`;
    const sanitized = sanitizeDescriptionForAgent(description);
    // Should leave content as-is since the section is unclosed
    expect(sanitized).toContain('<!-- revpack:start -->');
    expect(sanitized).toContain('Unclosed section');
  });
});

// ─── Constants ───────────────────────────────────────────

describe('checkpoint constants', () => {
  it('CHECKPOINT_MARKER_START has correct value', () => {
    expect(CHECKPOINT_MARKER_START).toBe('<!-- revpack:state');
  });

  it('CHECKPOINT_MARKER_END has correct value', () => {
    expect(CHECKPOINT_MARKER_END).toBe('-->');
  });

  it('REVIEW_NOTE_MARKER has correct value', () => {
    expect(REVIEW_NOTE_MARKER).toBe('<!-- revpack:review-note -->');
  });

  it('REVIEW_NOTE_FOOTER contains the expected content', () => {
    expect(REVIEW_NOTE_FOOTER).toContain('<sub>');
    expect(REVIEW_NOTE_FOOTER).toContain('revpack');
  });

  it('CHECKPOINT_STATE_BLOCK_REGEX matches state blocks', () => {
    const block = '<!-- revpack:state\nSOME_DATA\n-->';
    const matches = block.match(CHECKPOINT_STATE_BLOCK_REGEX);
    expect(matches).toHaveLength(1);
    expect(matches![0]).toBe(block);
  });
});

// ─── stripReviewNoteFooter ───────────────────────────────

describe('stripReviewNoteFooter', () => {
  it('removes the footer from content that has it', () => {
    const content = `## Review Notes\n\nLooks good.${REVIEW_NOTE_FOOTER}`;
    const stripped = stripReviewNoteFooter(content);
    expect(stripped).toBe('## Review Notes\n\nLooks good.');
    expect(stripped).not.toContain('<sub>');
  });

  it('returns content unchanged when no footer present', () => {
    const content = '## Review Notes\n\nLooks good.';
    const stripped = stripReviewNoteFooter(content);
    expect(stripped).toBe(content);
  });

  it('trims trailing whitespace from result', () => {
    const content = '## Review Notes   ';
    const stripped = stripReviewNoteFooter(content);
    expect(stripped).toBe('## Review Notes');
  });

  it('handles content that is just the footer', () => {
    const stripped = stripReviewNoteFooter(REVIEW_NOTE_FOOTER.trimStart());
    expect(stripped).toBe('');
  });
});

// ─── Additional buildCheckpointState assertions ──────────

describe('buildCheckpointState defaults', () => {
  it('sets descriptionDigest to null when not provided', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    expect(state.checkpoint.descriptionDigest).toBeNull();
  });

  it('sets threadDigests to empty object when not provided', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    expect(state.checkpoint.threadDigests).toEqual({});
  });

  it('preserves provided threadDigests', () => {
    const digests = { t1: 'sha256:aaa', t2: 'sha256:bbb' };
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null, undefined, null, digests);
    expect(state.checkpoint.threadDigests).toEqual(digests);
  });

  it('sets descriptionDigest to null when explicitly passed undefined', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null, undefined, undefined);
    expect(state.checkpoint.descriptionDigest).toBeNull();
  });
});

// ─── Additional parseDescriptionState edge cases ─────────

describe('parseDescriptionState edge cases', () => {
  it('returns null when decoded JSON is a non-object (number)', () => {
    const encoded = Buffer.from('42').toString('base64url');
    const description = `# MR\n\n<!-- revpack:state\n${encoded}\n-->`;
    expect(parseDescriptionState(description)).toBeNull();
  });

  it('returns null when decoded JSON is null', () => {
    const encoded = Buffer.from('null').toString('base64url');
    const description = `# MR\n\n<!-- revpack:state\n${encoded}\n-->`;
    expect(parseDescriptionState(description)).toBeNull();
  });

  it('returns null when checkpoint field is missing', () => {
    const obj = { schemaVersion: 1, tool: { name: 'revpack' }, target: {} };
    const encoded = Buffer.from(JSON.stringify(obj)).toString('base64url');
    const description = `# MR\n\n<!-- revpack:state\n${encoded}\n-->`;
    expect(parseDescriptionState(description)).toBeNull();
  });

  it('returns null when headSha is not a string', () => {
    const obj = {
      schemaVersion: 1,
      tool: { name: 'revpack', version: '0.2.0' },
      target: {},
      checkpoint: { headSha: 999, baseSha: 'b', startSha: 'b', threadsDigest: null, createdAt: '' },
    };
    const encoded = Buffer.from(JSON.stringify(obj)).toString('base64url');
    const description = `# MR\n\n<!-- revpack:state\n${encoded}\n-->`;
    expect(parseDescriptionState(description)).toBeNull();
  });

  it('initializes threadDigests when missing from parsed state', () => {
    const obj = {
      schemaVersion: 1,
      tool: { name: 'revpack', version: '0.2.0' },
      target: { provider: 'github', repository: 'org/repo', type: 'pull_request', id: '1' },
      checkpoint: { headSha: 'abc', baseSha: 'def', startSha: 'def', threadsDigest: null, createdAt: '' },
    };
    const encoded = Buffer.from(JSON.stringify(obj)).toString('base64url');
    const description = `# MR\n\n<!-- revpack:state\n${encoded}\n-->`;
    const result = parseDescriptionState(description);
    expect(result).not.toBeNull();
    expect(result!.checkpoint.threadDigests).toEqual({});
  });

  it('returns null when end marker is missing within the block', () => {
    // Edge: block regex matches but internal parsing has no end marker
    // Actually the regex requires -->, so this tests a different path
    const description = `# MR\n\n<!-- revpack:state\n-->`;
    // The content between markers is empty
    expect(parseDescriptionState(description)).toBeNull();
  });
});

// ─── Additional patchDescriptionWithState tests ──────────

describe('patchDescriptionWithState edge cases', () => {
  it('handles empty description by not adding separator', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    const result = patchDescriptionWithState('', state);
    expect(result.startsWith('\n\n')).toBe(false);
    expect(result).toContain(CHECKPOINT_MARKER_START);
    const parsed = parseDescriptionState(result);
    expect(parsed).not.toBeNull();
    expect(parsed!.checkpoint.headSha).toBe('head');
  });

  it('handles whitespace-only description by not adding separator', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    const result = patchDescriptionWithState('   \n  ', state);
    expect(result).toContain(CHECKPOINT_MARKER_START);
    expect(result).not.toContain('   \n  \n\n');
  });

  it('trims trailing whitespace from description before appending', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    const result = patchDescriptionWithState('# MR   \n\n  ', state);
    expect(result).toContain('# MR');
    // Should be trimmed - no trailing spaces before the separator
    expect(result).toMatch(/# MR\n\n<!-- revpack:state/);
  });

  it('does not add extra content before the state block for whitespace-only description', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    const result = patchDescriptionWithState('   ', state);
    // Whitespace-only is treated as empty - no separator added
    expect(result).toBe(buildDescriptionStateBlock(state));
  });

  it('appends with double-newline separator for non-empty description', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    const result = patchDescriptionWithState('Content', state);
    expect(result).toMatch(/^Content\n\n<!-- revpack:state/);
  });
});

// ─── Additional sanitizeDescriptionForAgent edge cases ───

describe('sanitizeDescriptionForAgent advanced', () => {
  it('handles description with MARKER_END but no MARKER_START (long prefix)', () => {
    // The prefix must be long enough (>22 chars) so that if the startIdx=-1 guard is skipped,
    // indexOf(MARKER_END, -1+22=21) would still find the end marker and garble content.
    const description = 'A long description prefix that exceeds marker length.\n<!-- revpack:end -->\nTrailing.';
    const sanitized = sanitizeDescriptionForAgent(description);
    // Should return the input unchanged (no MARKER_START means no stripping)
    expect(sanitized).toBe(description);
  });

  it('correctly finds MARKER_END after MARKER_START, not before it', () => {
    // Place a <!-- revpack:end --> right before <!-- revpack:start --> so that
    // searching from (startIdx - length) would find the wrong end marker,
    // but searching from (startIdx + length) finds the correct one.
    const description =
      'Content before here.<!-- revpack:end --><!-- revpack:start -->\n## Summary\n<!-- revpack:end -->';
    const sanitized = sanitizeDescriptionForAgent(description);
    // The real start..end block (## Summary) should be stripped
    expect(sanitized).not.toContain('## Summary');
    // The early end marker in the content should remain
    expect(sanitized).toContain('Content before here.');
    expect(sanitized).toContain('<!-- revpack:end -->');
  });

  it('preserves content-embedded horizontal rules that are not the revpack separator', () => {
    // Has \n\n---\n\n inside the description content, not as a revpack separator
    const description = `# My MR\n\nSection 1\n\n---\n\nSection 2\n\n---\n\n<!-- revpack:start -->\n## Summary\n<!-- revpack:end -->`;
    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).toContain('Section 1');
    expect(sanitized).toContain('Section 2');
    // The content-embedded --- must be preserved as separator between sections
    expect(sanitized).toContain('Section 1\n\n---\n\nSection 2');
  });

  it('removes the revpack separator but not content horizontal rules', () => {
    const description = `# My MR\n\nSection with ---\n\n---\n\n<!-- revpack:start -->\n## Summary\n<!-- revpack:end -->`;
    const sanitized = sanitizeDescriptionForAgent(description);
    expect(sanitized).toContain('Section with ---');
    expect(sanitized).not.toContain('<!-- revpack:start -->');
    // After stripping, the trailing separator should be gone but inline --- preserved
    expect(sanitized).toBe('# My MR\n\nSection with ---');
  });
});

// ─── buildCheckpointState version assertion ──────────────

describe('buildCheckpointState tool info', () => {
  it('sets tool version to 0.2.0', () => {
    const state = buildCheckpointState(targetRef, 'head', 'base', 'start', null);
    expect(state.tool.version).toBe('0.2.0');
  });
});
