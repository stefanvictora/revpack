import { describe, expect, it } from 'vitest';
import { ConfigError } from '../core/errors.js';
import { CONFIG_KEYS, VALID_CONFIG_KEYS } from './keys.js';

describe('CONFIG_KEYS', () => {
  it('lists every supported config key', () => {
    expect(VALID_CONFIG_KEYS).toEqual(['provider', 'url', 'tokenEnv', 'remotePatterns', 'caFile', 'tlsVerify', 'sshClone']);
  });

  it('parses provider values', () => {
    expect(CONFIG_KEYS.provider.parse('gitlab')).toBe('gitlab');
    expect(CONFIG_KEYS.provider.parse('github')).toBe('github');
    expect(() => CONFIG_KEYS.provider.parse('local')).toThrow(ConfigError);
    expect(() => CONFIG_KEYS.provider.parse('local')).toThrow('Invalid provider: "local". Must be "gitlab" or "github".');
  });

  it('validates URL values', () => {
    expect(CONFIG_KEYS.url.parse('https://gitlab.example.com')).toBe('https://gitlab.example.com');
    expect(() => CONFIG_KEYS.url.parse('not-a-url')).toThrow(ConfigError);
    expect(() => CONFIG_KEYS.url.parse('not-a-url')).toThrow('Invalid URL: "not-a-url"');
  });

  it('validates token environment variable names', () => {
    expect(CONFIG_KEYS.tokenEnv.parse('GITLAB_TOKEN_1')).toBe('GITLAB_TOKEN_1');
    expect(CONFIG_KEYS.tokenEnv.parse('_TOKEN')).toBe('_TOKEN');
    expect(() => CONFIG_KEYS.tokenEnv.parse('1TOKEN')).toThrow('Invalid environment variable name: "1TOKEN"');
    expect(() => CONFIG_KEYS.tokenEnv.parse('BAD-NAME')).toThrow('Invalid environment variable name: "BAD-NAME"');
  });

  it('parses comma-separated remote patterns', () => {
    expect(CONFIG_KEYS.remotePatterns.isArray).toBe(true);
    expect(CONFIG_KEYS.remotePatterns.parse(' gitlab.example.com,github.com,, internal ')).toEqual([
      'gitlab.example.com',
      'github.com',
      'internal',
    ]);
    expect(CONFIG_KEYS.remotePatterns.parse(' , , ')).toEqual([]);
  });

  it('keeps string values unchanged for caFile', () => {
    expect(CONFIG_KEYS.caFile.parse(' C:/certs/root.pem ')).toBe(' C:/certs/root.pem ');
  });

  it.each([
    ['true', true],
    ['1', true],
    ['yes', true],
    ['on', true],
    [' TRUE ', true],
    ['false', false],
    ['0', false],
    ['no', false],
    ['off', false],
    [' OFF ', false],
  ])('parses boolean value %s', (value, expected) => {
    expect(CONFIG_KEYS.tlsVerify.parse(value)).toBe(expected);
    expect(CONFIG_KEYS.sshClone.parse(value)).toBe(expected);
  });

  it('rejects invalid booleans', () => {
    expect(() => CONFIG_KEYS.tlsVerify.parse('maybe')).toThrow(ConfigError);
    expect(() => CONFIG_KEYS.tlsVerify.parse('maybe')).toThrow(
      'Invalid boolean: "maybe". Use true/false, yes/no, 1/0, on/off.',
    );
  });

  it('keeps descriptions attached to every key', () => {
    for (const key of VALID_CONFIG_KEYS) {
      expect(CONFIG_KEYS[key].description).toEqual(expect.any(String));
      expect(CONFIG_KEYS[key].description.length).toBeGreaterThan(0);
    }
  });
});
