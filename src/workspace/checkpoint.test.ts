import { describe, it, expect } from 'vitest';
import {
  parseCheckpointMarker,
  buildCheckpointState,
  encodeCheckpointState,
  buildReviewNoteBody,
  updateReviewNoteBody,
  parseDescriptionState,
  buildDescriptionStateBlock,
  patchDescriptionWithState,
  sanitizeDescriptionForAgent,
  CHECKPOINT_MARKER_START,
  CHECKPOINT_MARKER_END,
  REVIEW_NOTE_MARKER,
} from './checkpoint.js';
import type { ReviewTargetRef } from '../core/types.js';

const targetRef: ReviewTargetRef = {
  provider: 'gitlab',
  repository: 'edm/zareg/edmreg',
  targetType: 'merge_request',
  targetId: '902',
};

describe('checkpoint parser', () => {
  it('parses existing managed note with valid base64url checkpoint marker', () => {
    const state = buildCheckpointState(
      targetRef,
      'c304af19156d686a02f6e80be15b8fe6c445c00b',
      '65bd426b0bc8bbf8ff9f3923a2689115233a98e1',
      '65bd426b0bc8bbf8ff9f3923a2689115233a98e1',
      'sha256:abc123',
      '91295',
    );
    const noteBody = buildReviewNoteBody('Some review notes here.', state);

    const result = parseCheckpointMarker(noteBody);

    expect(result).not.toBeNull();
    expect(result!.state.checkpoint.headSha).toBe('c304af19156d686a02f6e80be15b8fe6c445c00b');
    expect(result!.state.checkpoint.baseSha).toBe('65bd426b0bc8bbf8ff9f3923a2689115233a98e1');
    expect(result!.state.checkpoint.threadsDigest).toBe('sha256:abc123');
    expect(result!.state.checkpoint.providerVersionId).toBe('91295');
    expect(result!.state.target.provider).toBe('gitlab');
    expect(result!.state.target.repository).toBe('edm/zareg/edmreg');
    expect(result!.visibleContent).toContain('Some review notes here.');
  });

  it('parses raw JSON inside HTML comment', () => {
    const state = {
      schemaVersion: 1,
      tool: { name: 'revpack', version: '0.2.0' },
      target: { provider: 'gitlab', repository: 'group/proj', type: 'merge_request', id: '42' },
      checkpoint: {
        createdAt: '2026-04-27T12:00:00Z',
        headSha: 'abc123',
        baseSha: 'def456',
        startSha: 'def456',
        threadsDigest: null,
      },
    };
    const noteBody = `${REVIEW_NOTE_MARKER}
Visible content here

${CHECKPOINT_MARKER_START}
${JSON.stringify(state)}
${CHECKPOINT_MARKER_END}`;

    const result = parseCheckpointMarker(noteBody);

    expect(result).not.toBeNull();
    expect(result!.state.checkpoint.headSha).toBe('abc123');
    expect(result!.state.checkpoint.threadDigests).toEqual({});
    expect(result!.visibleContent).toContain('Visible content here');
  });

  it('handles missing checkpoint marker as null', () => {
    const noteBody = `${REVIEW_NOTE_MARKER}
Just some review notes without a checkpoint.
`;

    const result = parseCheckpointMarker(noteBody);
    expect(result).toBeNull();
  });

  it('handles malformed base64url marker gracefully', () => {
    const noteBody = `${REVIEW_NOTE_MARKER}
Notes

${CHECKPOINT_MARKER_START}
not-valid-base64-and-not-valid-json!!!
${CHECKPOINT_MARKER_END}`;

    const result = parseCheckpointMarker(noteBody);
    expect(result).toBeNull();
  });

  it('handles empty marker content as null', () => {
    const noteBody = `${CHECKPOINT_MARKER_START}
${CHECKPOINT_MARKER_END}`;

    const result = parseCheckpointMarker(noteBody);
    expect(result).toBeNull();
  });

  it('ignores unrelated HTML comments', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', null);
    const noteBody = `<!-- some-other-tool: data -->
${REVIEW_NOTE_MARKER}
Notes

<!-- unrelated comment -->

${CHECKPOINT_MARKER_START}
${encodeCheckpointState(state)}
${CHECKPOINT_MARKER_END}`;

    const result = parseCheckpointMarker(noteBody);
    expect(result).not.toBeNull();
    expect(result!.state.checkpoint.headSha).toBe('abc');
  });

  it('handles marker with missing required fields as null', () => {
    const noteBody = `${CHECKPOINT_MARKER_START}
${Buffer.from(JSON.stringify({ schemaVersion: 1, tool: { name: 'revpack' } })).toString('base64url')}
${CHECKPOINT_MARKER_END}`;

    const result = parseCheckpointMarker(noteBody);
    expect(result).toBeNull();
  });
});

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

describe('buildReviewNoteBody', () => {
  it('builds note with visible content and hidden marker', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', null);
    const body = buildReviewNoteBody('## Review Notes\n\nLooks good.', state);

    expect(body).toContain(REVIEW_NOTE_MARKER);
    expect(body).toContain('## Review Notes');
    expect(body).toContain('Looks good.');
    expect(body).toContain(CHECKPOINT_MARKER_START);
    expect(body).toContain(CHECKPOINT_MARKER_END);

    // Roundtrip parse
    const parsed = parseCheckpointMarker(body);
    expect(parsed).not.toBeNull();
    expect(parsed!.state.checkpoint.headSha).toBe('abc');
    expect(parsed!.visibleContent).toContain('Looks good.');
  });

  it('handles empty visible content', () => {
    const state = buildCheckpointState(targetRef, 'abc', 'def', 'def', null);
    const body = buildReviewNoteBody('', state);

    expect(body).toContain(REVIEW_NOTE_MARKER);
    expect(body).toContain(CHECKPOINT_MARKER_START);
  });
});

describe('updateReviewNoteBody', () => {
  it('preserves existing visible content when newVisibleContent is empty', () => {
    const oldState = buildCheckpointState(targetRef, 'old-head', 'def', 'def', null);
    const existingBody = buildReviewNoteBody('Existing review text.', oldState);

    const newState = buildCheckpointState(targetRef, 'new-head', 'def', 'def', 'sha256:new');
    const updatedBody = updateReviewNoteBody(existingBody, newState, '');

    const parsed = parseCheckpointMarker(updatedBody);
    expect(parsed).not.toBeNull();
    expect(parsed!.state.checkpoint.headSha).toBe('new-head');
    expect(parsed!.visibleContent).toContain('Existing review text.');
  });

  it('replaces visible content when newVisibleContent is provided', () => {
    const oldState = buildCheckpointState(targetRef, 'old-head', 'def', 'def', null);
    const existingBody = buildReviewNoteBody('Old text.', oldState);

    const newState = buildCheckpointState(targetRef, 'new-head', 'def', 'def', null);
    const updatedBody = updateReviewNoteBody(existingBody, newState, 'New visible text.');

    const parsed = parseCheckpointMarker(updatedBody);
    expect(parsed).not.toBeNull();
    expect(parsed!.state.checkpoint.headSha).toBe('new-head');
    expect(parsed!.visibleContent).toContain('New visible text.');
    expect(parsed!.visibleContent).not.toContain('Old text.');
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
});
