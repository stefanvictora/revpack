import { describe, it, expect } from 'vitest';
import { configSchema, newFindingSchema, newFindingsArraySchema, replyDraftSchema, severitySchema, findingCategorySchema } from '../core/schemas.js';

describe('configSchema', () => {
  it('validates a complete gitlab config', () => {
    const result = configSchema.safeParse({
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'glpat-abc123',
      bundleDir: '.revkit',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('gitlab');
      expect(result.data.gitlabUrl).toBe('https://gitlab.example.com');
    }
  });

  it('applies default bundleDir', () => {
    const result = configSchema.safeParse({
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'token',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bundleDir).toBe('.revkit');
    }
  });

  it('rejects invalid provider', () => {
    const result = configSchema.safeParse({
      provider: 'bitbucket',
      gitlabUrl: 'https://gitlab.example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid gitlabUrl', () => {
    const result = configSchema.safeParse({
      provider: 'gitlab',
      gitlabUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('allows minimal config', () => {
    const result = configSchema.safeParse({
      provider: 'gitlab',
    });
    expect(result.success).toBe(true);
  });
});

describe('newFindingSchema', () => {
  it('validates a complete finding with newLine only', () => {
    const result = newFindingSchema.safeParse({
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      newLine: 42,
      body: 'Potential issue',
      severity: 'high',
      category: 'correctness',
    });
    expect(result.success).toBe(true);
  });

  it('validates a finding with oldLine only', () => {
    const result = newFindingSchema.safeParse({
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      oldLine: 10,
      body: 'Removed important code',
      severity: 'high',
      category: 'correctness',
    });
    expect(result.success).toBe(true);
  });

  it('validates a finding with both oldLine and newLine', () => {
    const result = newFindingSchema.safeParse({
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      oldLine: 10,
      newLine: 12,
      body: 'Context line finding',
      severity: 'medium',
      category: 'correctness',
    });
    expect(result.success).toBe(true);
  });

  it('rejects finding with neither oldLine nor newLine', () => {
    const result = newFindingSchema.safeParse({
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      body: 'No line',
      severity: 'high',
      category: 'correctness',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid severity', () => {
    const result = newFindingSchema.safeParse({
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      newLine: 1,
      body: 'Test',
      severity: 'major',
      category: 'correctness',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid category', () => {
    const result = newFindingSchema.safeParse({
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      newLine: 1,
      body: 'Test',
      severity: 'high',
      category: 'bug',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive line numbers', () => {
    const result = newFindingSchema.safeParse({
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      newLine: 0,
      body: 'Test',
      severity: 'high',
      category: 'correctness',
    });
    expect(result.success).toBe(false);
  });
});

describe('newFindingsArraySchema', () => {
  it('validates empty array', () => {
    const result = newFindingsArraySchema.safeParse([]);
    expect(result.success).toBe(true);
  });

  it('validates array of valid findings', () => {
    const result = newFindingsArraySchema.safeParse([
      {
        oldPath: 'src/App.java',
        newPath: 'src/App.java',
        newLine: 2,
        body: 'Finding 1',
        severity: 'high',
        category: 'correctness',
      },
    ]);
    expect(result.success).toBe(true);
  });
});

describe('replyDraftSchema', () => {
  it('validates a complete reply', () => {
    const result = replyDraftSchema.safeParse({
      threadId: 'T-001',
      body: 'Good catch!',
      resolve: false,
    });
    expect(result.success).toBe(true);
  });

  it('validates a reply with disposition', () => {
    const result = replyDraftSchema.safeParse({
      threadId: 'T-001',
      body: 'Fixed!',
      resolve: true,
      disposition: 'suggest_fix',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid disposition', () => {
    const result = replyDraftSchema.safeParse({
      threadId: 'T-001',
      body: 'Test',
      resolve: false,
      disposition: 'invalid',
    });
    expect(result.success).toBe(false);
  });
});

describe('severitySchema', () => {
  it('accepts all valid severities', () => {
    for (const sev of ['blocker', 'high', 'medium', 'low', 'nit']) {
      expect(severitySchema.safeParse(sev).success).toBe(true);
    }
  });

  it('rejects info (removed)', () => {
    expect(severitySchema.safeParse('info').success).toBe(false);
  });
});

describe('findingCategorySchema', () => {
  it('accepts all valid categories', () => {
    for (const cat of ['security', 'correctness', 'performance', 'testing', 'architecture', 'style', 'documentation', 'naming', 'error-handling', 'general']) {
      expect(findingCategorySchema.safeParse(cat).success).toBe(true);
    }
  });

  it('rejects unknown categories', () => {
    expect(findingCategorySchema.safeParse('bug').success).toBe(false);
  });
});
