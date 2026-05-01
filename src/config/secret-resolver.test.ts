import { describe, it, expect } from 'vitest';
import { SecretResolver } from './secret-resolver.js';

describe('SecretResolver', () => {
  it('resolves env token source', async () => {
    process.env.TEST_SECRET_RESOLVER_TOKEN = 'test-value';
    try {
      const resolver = new SecretResolver();
      const result = await resolver.resolve({ type: 'env', name: 'TEST_SECRET_RESOLVER_TOKEN' });
      expect(result.value).toBe('test-value');
      expect(result.sourceDescription).toBe('env:TEST_SECRET_RESOLVER_TOKEN');
    } finally {
      delete process.env.TEST_SECRET_RESOLVER_TOKEN;
    }
  });

  it('reports missing env token', async () => {
    delete process.env.NONEXISTENT_TOKEN_12345;
    const resolver = new SecretResolver();
    const result = await resolver.resolve({ type: 'env', name: 'NONEXISTENT_TOKEN_12345' });
    expect(result.value).toBeUndefined();
    expect(result.sourceDescription).toBe('env:NONEXISTENT_TOKEN_12345');
  });

  it('does not expose token value in source description', async () => {
    process.env.TEST_SECRET_SAFE = 'my-secret-value';
    try {
      const resolver = new SecretResolver();
      const result = await resolver.resolve({ type: 'env', name: 'TEST_SECRET_SAFE' });
      expect(result.sourceDescription).not.toContain('my-secret-value');
    } finally {
      delete process.env.TEST_SECRET_SAFE;
    }
  });

  it('isResolved returns true when env var is set', async () => {
    process.env.TEST_SECRET_RESOLVED = 'value';
    try {
      const resolver = new SecretResolver();
      const resolved = await resolver.isResolved({ type: 'env', name: 'TEST_SECRET_RESOLVED' });
      expect(resolved).toBe(true);
    } finally {
      delete process.env.TEST_SECRET_RESOLVED;
    }
  });

  it('isResolved returns false when env var is not set', async () => {
    delete process.env.MISSING_ENV_VAR_999;
    const resolver = new SecretResolver();
    const resolved = await resolver.isResolved({ type: 'env', name: 'MISSING_ENV_VAR_999' });
    expect(resolved).toBe(false);
  });

  it('getSourceDescription returns safe description', () => {
    const resolver = new SecretResolver();
    const desc = resolver.getSourceDescription({ type: 'env', name: 'MY_TOKEN' });
    expect(desc).toBe('env:MY_TOKEN');
  });
});
