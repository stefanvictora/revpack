import { describe, it, expect } from 'vitest';
import {
  parseCheckpointMarker,
  buildCheckpointState,
  encodeCheckpointState,
  buildReviewNoteBody,
  updateReviewNoteBody,
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
      tool: { name: 'revkit', version: '0.2.0' },
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
    const state = buildCheckpointState(
      targetRef, 'abc', 'def', 'def', null,
    );
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
${Buffer.from(JSON.stringify({ schemaVersion: 1, tool: { name: 'revkit' } })).toString('base64url')}
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
    expect(state.tool.name).toBe('revkit');
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
    const state = buildCheckpointState(
      targetRef, 'abc', 'def', 'def', 'sha256:test',
    );

    const encoded = encodeCheckpointState(state);
    const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));

    expect(decoded.checkpoint.headSha).toBe('abc');
    expect(decoded.checkpoint.threadsDigest).toBe('sha256:test');
  });
});

describe('buildReviewNoteBody', () => {
  it('builds note with visible content and hidden marker', () => {
    const state = buildCheckpointState(
      targetRef, 'abc', 'def', 'def', null,
    );
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
    const state = buildCheckpointState(
      targetRef, 'abc', 'def', 'def', null,
    );
    const body = buildReviewNoteBody('', state);

    expect(body).toContain(REVIEW_NOTE_MARKER);
    expect(body).toContain(CHECKPOINT_MARKER_START);
  });
});

describe('updateReviewNoteBody', () => {
  it('preserves existing visible content when newVisibleContent is empty', () => {
    const oldState = buildCheckpointState(
      targetRef, 'old-head', 'def', 'def', null,
    );
    const existingBody = buildReviewNoteBody('Existing review text.', oldState);

    const newState = buildCheckpointState(
      targetRef, 'new-head', 'def', 'def', 'sha256:new',
    );
    const updatedBody = updateReviewNoteBody(existingBody, newState, '');

    const parsed = parseCheckpointMarker(updatedBody);
    expect(parsed).not.toBeNull();
    expect(parsed!.state.checkpoint.headSha).toBe('new-head');
    expect(parsed!.visibleContent).toContain('Existing review text.');
  });

  it('replaces visible content when newVisibleContent is provided', () => {
    const oldState = buildCheckpointState(
      targetRef, 'old-head', 'def', 'def', null,
    );
    const existingBody = buildReviewNoteBody('Old text.', oldState);

    const newState = buildCheckpointState(
      targetRef, 'new-head', 'def', 'def', null,
    );
    const updatedBody = updateReviewNoteBody(existingBody, newState, 'New visible text.');

    const parsed = parseCheckpointMarker(updatedBody);
    expect(parsed).not.toBeNull();
    expect(parsed!.state.checkpoint.headSha).toBe('new-head');
    expect(parsed!.visibleContent).toContain('New visible text.');
    expect(parsed!.visibleContent).not.toContain('Old text.');
  });
});
