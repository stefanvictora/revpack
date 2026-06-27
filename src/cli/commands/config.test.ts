import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../../core/errors.js';
import {
  deriveProfileNameFromProviderUrl,
  inferProviderFromUrl,
  isManagedCloudProvider,
  isTokenEnvResolved,
  normalizeProviderInput,
  normalizeProviderUrlInput,
  registerConfigCommand,
} from './config.js';

describe('config command', () => {
  it('prints help for the parent command instead of showing resolved config', async () => {
    const output: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    registerConfigCommand(program);

    await program.parseAsync(['node', 'revpack', 'config']);

    const help = output.join('');
    expect(help).toContain('Usage: revpack config [options] [command]');
    expect(help).toContain('show');
    expect(help).toContain('profile');
    expect(help).toContain('List, show, create, or delete saved profiles');
    expect(help).toContain('Create:');
    expect(help).toContain('revpack config setup');
    expect(help).toContain('Current project:');
    expect(help).toContain('revpack config doctor');
    expect(help).toContain('Saved profiles:');
    expect(help).toContain('revpack config profile list');
    expect(help).toContain('revpack config profile delete <name>');
    expect(help).not.toContain('No active profile');
  });

  it('describes profile create as the non-interactive creation path', async () => {
    const output: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    registerConfigCommand(program);

    try {
      await program.parseAsync(['node', 'revpack', 'config', 'profile', '--help']);
    } catch {
      // Commander exits after printing --help when exitOverride is enabled.
    }

    const help = output.join('');
    expect(help).toContain('create');
    expect(help).toContain('Create or update a profile non-interactively');
  });
});

describe('config setup provider prompts', () => {
  afterEach(() => {
    delete process.env.REVPACK_TEST_TOKEN;
    delete process.env.REVPACK_MISSING_TEST_TOKEN;
  });

  it('infers known providers from the provider URL', () => {
    expect(inferProviderFromUrl('https://gitlab.com')).toBe('gitlab');
    expect(inferProviderFromUrl('https://gitlab.example.com')).toBe('gitlab');
    expect(inferProviderFromUrl('https://github.com')).toBe('github');
  });

  it('does not treat an entered URL as a provider choice', () => {
    expect(() => normalizeProviderInput('https://gitlab.com')).toThrow(ConfigError);
    expect(() => normalizeProviderInput('https://gitlab.com')).toThrow(
      'Invalid provider: "https://gitlab.com". Must be "gitlab" or "github".',
    );
  });

  it('validates provider URL input before deriving provider defaults', () => {
    expect(normalizeProviderUrlInput(' https://gitlab.com ')).toBe('https://gitlab.com');
    expect(normalizeProviderUrlInput('')).toBe('');
  });

  it('explains bare provider hosts need a URL scheme', () => {
    expect(() => normalizeProviderUrlInput('gitlab.com')).toThrow(ConfigError);
    expect(() => normalizeProviderUrlInput('gitlab.com')).toThrow(
      'Invalid provider URL: "gitlab.com". Expected an absolute URL like "https://gitlab.com". Include the scheme, for example "https://gitlab.com".',
    );
  });

  it('derives the profile name default from the entered provider URL', () => {
    expect(deriveProfileNameFromProviderUrl('https://gitlab.com')).toBe('gitlab');
    expect(deriveProfileNameFromProviderUrl('https://review.example.com')).toBe('review');
  });

  it('only treats managed cloud hosts as cloud providers', () => {
    expect(isManagedCloudProvider('https://gitlab.com', 'gitlab')).toBe(true);
    expect(isManagedCloudProvider('https://github.com', 'github')).toBe(true);
    expect(isManagedCloudProvider('https://gitlab.example.com', 'gitlab')).toBe(false);
    expect(isManagedCloudProvider('https://github.example.com', 'github')).toBe(false);
  });

  it('detects whether the configured token environment variable is already available', () => {
    process.env.REVPACK_TEST_TOKEN = 'present';

    expect(isTokenEnvResolved('REVPACK_TEST_TOKEN')).toBe(true);
    expect(isTokenEnvResolved('REVPACK_MISSING_TEST_TOKEN')).toBe(false);
  });

  it('treats an empty token environment variable as missing', () => {
    process.env.REVPACK_TEST_TOKEN = '';

    expect(isTokenEnvResolved('REVPACK_TEST_TOKEN')).toBe(false);
  });
});
