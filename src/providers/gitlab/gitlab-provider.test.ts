import { describe, it, expect } from 'vitest';
import { GitLabProvider } from './gitlab-provider.js';

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

  it('parses http:// URLs', () => {
    const ref = provider.resolveTarget('http://gitlab.local/group/project/-/merge_requests/7');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '7',
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

  it('rejects repo!id format with trailing content', () => {
    expect(() => provider.resolveTarget('group/project!123suffix')).toThrow('Cannot parse');
  });

  it('rejects bare numbers with trailing text', () => {
    expect(() => provider.resolveTarget('42abc')).toThrow('Cannot parse');
  });

  it('rejects bare numbers with leading text', () => {
    expect(() => provider.resolveTarget('abc42')).toThrow('Cannot parse');
  });

  it('rejects !id with trailing text', () => {
    expect(() => provider.resolveTarget('!42abc')).toThrow('Cannot parse');
  });
});

describe('GitLabProvider constructor and options', () => {
  it('strips trailing slashes from base URL', () => {
    const provider = new GitLabProvider('https://gitlab.example.com///', 'token');
    expect(provider.getCloneUrl('group/project')).toBe('https://gitlab.example.com/group/project.git');
  });

  it('uses SSH clone URL when sshClone is enabled', () => {
    const provider = new GitLabProvider('https://gitlab.example.com', 'token', { sshClone: true });
    expect(provider.getCloneUrl('group/project')).toBe('git@gitlab.example.com:group/project.git');
  });

  it('uses HTTPS clone URL when sshClone is disabled', () => {
    const provider = new GitLabProvider('https://gitlab.example.com', 'token', { sshClone: false });
    expect(provider.getCloneUrl('group/project')).toBe('https://gitlab.example.com/group/project.git');
  });

  it('uses HTTPS clone URL by default when sshClone is not specified', () => {
    const provider = new GitLabProvider('https://gitlab.example.com', 'token');
    expect(provider.getCloneUrl('group/project')).toBe('https://gitlab.example.com/group/project.git');
  });
});

describe('GitLabProvider checkout fallback', () => {
  const provider = new GitLabProvider('https://gitlab.example.com', 'fake-token');

  it('returns the temporary MR head ref and deterministic local branch', () => {
    const fallback = provider.getCheckoutFallbackRef({
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '42',
    });

    expect(fallback).toEqual({
      remoteRef: 'refs/merge-requests/42/head',
      localBranch: 'revpack/mr-42',
    });
  });

  it('returns the fallback branch for bundle-shaped targets', () => {
    const branch = provider.getCheckoutFallbackBranch({
      provider: 'gitlab',
      type: 'merge_request',
      id: '42',
      sourceBranch: 'feature/test',
    });

    expect(branch).toBe('revpack/mr-42');
  });

  it('formats the GitLab temporary-ref expiration message', () => {
    const error = provider.formatCheckoutFallbackError(
      {
        provider: 'gitlab',
        repository: 'group/project',
        targetType: 'merge_request',
        targetId: '42',
        title: 'Test MR',
        description: 'Test',
        author: 'alice',
        state: 'merged',
        sourceBranch: 'feature/test',
        targetBranch: 'main',
        webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/42',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        labels: [],
        diffRefs: { baseSha: 'aaa', headSha: 'bbb', startSha: 'aaa' },
      },
      new Error('source branch missing'),
      new Error('MR head ref missing'),
    );

    expect(error.message).toContain('source branch "feature/test" may have been deleted');
    expect(error.message).toContain('refs/merge-requests/42/head');
    expect(error.message).toContain('GitLab 16.6 and newer');
    expect(error.message).toContain('14 days after merge or close');
  });
});
