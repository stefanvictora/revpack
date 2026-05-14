import { describe, it, expect, afterEach, vi } from 'vitest';
import { GitLabProvider } from './gitlab-provider.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GitLabProvider.resolveTarget', () => {
  const provider = new GitLabProvider('https://gitlab.example.com', 'fake-token');

  it('parses full URL', () => {
    const ref = provider.resolveTarget('https://gitlab.example.com/group/project/-/merge_requests/42');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '42',
    });
  });

  it('parses repo!id format', () => {
    const ref = provider.resolveTarget('my-group/my-project!123');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: 'my-group/my-project',
      targetType: 'merge_request',
      targetId: '123',
    });
  });

  it('parses !id format (no repo)', () => {
    const ref = provider.resolveTarget('!99');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: '',
      targetType: 'merge_request',
      targetId: '99',
    });
  });

  it('parses bare numeric id', () => {
    const ref = provider.resolveTarget('77');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: '',
      targetType: 'merge_request',
      targetId: '77',
    });
  });

  it('rejects unparseable refs', () => {
    expect(() => provider.resolveTarget('not-a-ref')).toThrow('Cannot parse');
  });

  it('parses nested group URL', () => {
    const ref = provider.resolveTarget('https://gitlab.example.com/org/team/project/-/merge_requests/5');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: 'org/team/project',
      targetType: 'merge_request',
      targetId: '5',
    });
  });
});

describe('GitLabProvider.getLatestDiff', () => {
  const provider = new GitLabProvider('https://gitlab.example.com', 'fake-token');
  const ref = {
    provider: 'gitlab' as const,
    repository: 'group/project',
    targetType: 'merge_request' as const,
    targetId: '42',
  };

  it('marks too_large diff entries as incomplete', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            old_path: 'src/large.ts',
            new_path: 'src/large.ts',
            diff: '',
            too_large: true,
          },
        ]),
        { headers: { 'x-total-pages': '1' } },
      ),
    );

    await expect(provider.getLatestDiff(ref)).resolves.toEqual([
      expect.objectContaining({
        oldPath: 'src/large.ts',
        newPath: 'src/large.ts',
        diff: '',
        incomplete: true,
        incompleteReason: 'too_large',
      }),
    ]);
  });

  it('marks collapsed entries with no usable diff as incomplete', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            old_path: 'src/collapsed.ts',
            new_path: 'src/collapsed.ts',
            collapsed: true,
          },
        ]),
        { headers: { 'x-total-pages': '1' } },
      ),
    );

    const diffs = await provider.getLatestDiff(ref);
    expect(diffs[0]).toMatchObject({
      incomplete: true,
      incompleteReason: 'collapsed_without_diff',
    });
  });
});
