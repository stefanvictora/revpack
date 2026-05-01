import { describe, it, expect } from 'vitest';
import {
  configSchema,
  newFindingSchema,
  newFindingsArraySchema,
  replyDraftSchema,
  severitySchema,
  findingCategorySchema,
} from '../core/schemas.js';

describe('configSchema', () => {
  it('validates a profile-based config', () => {
    const result = configSchema.safeParse({
      profiles: {
        work: {
          provider: 'gitlab',
          url: 'https://gitlab.example.com',
          tokenEnv: 'GITLAB_TOKEN',
          remotePatterns: ['gitlab.example.com'],
        },
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.profiles?.work?.provider).toBe('gitlab');
    expect(result.data.profiles?.work?.url).toBe('https://gitlab.example.com');
  });

  it('rejects invalid provider in profile', () => {
    const result = configSchema.safeParse({
      profiles: {
        bad: {
          provider: 'bitbucket',
          url: 'https://example.com',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid url in profile', () => {
    const result = configSchema.safeParse({
      profiles: {
        bad: {
          provider: 'gitlab',
          url: 'not-a-url',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('allows minimal profile (provider only)', () => {
    const result = configSchema.safeParse({
      profiles: {
        min: { provider: 'gitlab' },
      },
    });
    expect(result.success).toBe(true);
  });

  it('validates multiple profiles', () => {
    const result = configSchema.safeParse({
      profiles: {
        work: {
          provider: 'gitlab',
          url: 'https://gitlab.work.com',
          remotePatterns: ['gitlab.work.com'],
          tokenEnv: 'WORK_TOKEN',
        },
        oss: {
          provider: 'github',
          tokenEnv: 'GH_TOKEN',
          remotePatterns: ['github.com'],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('allows empty config', () => {
    const result = configSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('validates profile with caFile and tlsVerify', () => {
    const result = configSchema.safeParse({
      profiles: {
        secure: {
          provider: 'gitlab',
          url: 'https://gitlab.internal.com',
          caFile: '/etc/ssl/custom-ca.pem',
          tlsVerify: false,
        },
      },
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
    for (const cat of [
      'security',
      'correctness',
      'performance',
      'testing',
      'architecture',
      'style',
      'documentation',
      'naming',
      'error-handling',
      'general',
    ]) {
      expect(findingCategorySchema.safeParse(cat).success).toBe(true);
    }
  });

  it('rejects unknown categories', () => {
    expect(findingCategorySchema.safeParse('bug').success).toBe(false);
  });
});
