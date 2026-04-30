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
