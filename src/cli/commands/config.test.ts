import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deriveProfileNameFromProviderUrl,
  getSetupProviderDefault,
  inferProviderFromUrl,
  isManagedCloudProvider,
  isTokenEnvResolved,
  normalizeProviderInput,
  normalizeProviderUrlInput,
  shouldPromptForSetupProvider,
  validateProviderUrlForProvider,
} from '../../config/index.js';
import { ConfigError } from '../../core/errors.js';
import { registerConfigCommand, registerPrimaryConfigCommands } from './config.js';

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
    expect(help).toContain('Current project:');
    expect(help).toContain('revpack config show');
    expect(help).toContain('Saved profiles:');
    expect(help).toContain('revpack config profile list');
    expect(help).toContain('revpack config profile delete <name>');
    expect(help).not.toContain('setup');
    expect(help).not.toContain('doctor');
    expect(help).not.toContain('No active profile');
  });

  it('registers top-level auth and doctor commands', async () => {
    const output: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    registerPrimaryConfigCommands(program);

    try {
      await program.parseAsync(['node', 'revpack', 'auth', '--help']);
    } catch {
      // Commander exits after printing --help when exitOverride is enabled.
    }

    const help = output.join('');
    expect(help).toContain('Usage: revpack auth [options] [command]');
    expect(help).toContain('setup');
    expect(help).toContain('Set up provider authentication');
    expect(help).toContain('doctor');
    expect(help).toContain('Check provider authentication');
    expect(help).toContain('show');
    expect(help).toContain('Show resolved provider authentication settings');
    expect(program.commands.map((command) => command.name())).toEqual(['auth', 'doctor']);
  });

  it('registers auth doctor and top-level doctor with matching options', async () => {
    for (const args of [
      ['node', 'revpack', 'auth', 'doctor', '--help'],
      ['node', 'revpack', 'doctor', '--help'],
    ]) {
      const output: string[] = [];
      const program = new Command();
      program.exitOverride();
      program.configureOutput({
        writeOut: (value) => output.push(value),
        writeErr: (value) => output.push(value),
      });
      registerPrimaryConfigCommands(program);

      try {
        await program.parseAsync(args);
      } catch {
        // Commander exits after printing --help when exitOverride is enabled.
      }

      const help = output.join('');
      expect(help).toContain('--profile <name>');
      expect(help).toContain('--json');
    }
  });

  it('registers auth show with resolved-profile options', async () => {
    const output: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    registerPrimaryConfigCommands(program);

    try {
      await program.parseAsync(['node', 'revpack', 'auth', 'show', '--help']);
    } catch {
      // Commander exits after printing --help when exitOverride is enabled.
    }

    const help = output.join('');
    expect(help).toContain('Usage: revpack auth show [options]');
    expect(help).toContain('--profile <name>');
    expect(help).toContain('--json');
    expect(help).toContain('--sources');
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

describe('auth setup provider prompts', () => {
  afterEach(() => {
    delete process.env.REVPACK_TEST_TOKEN;
    delete process.env.REVPACK_MISSING_TEST_TOKEN;
  });

  it('infers known providers from the provider URL', () => {
    expect(inferProviderFromUrl('https://gitlab.com')).toBe('gitlab');
    expect(inferProviderFromUrl('https://gitlab.example.com')).toBe('gitlab');
    expect(inferProviderFromUrl('https://github.com')).toBe('github');
    expect(inferProviderFromUrl('https://github.example.com')).toBe('github');
    expect(inferProviderFromUrl('https://bitbucket.org')).toBe('bitbucket-cloud');
    expect(inferProviderFromUrl('https://bitbucket.example.com')).toBeNull();
  });

  it('only prompts for provider selection when the provider URL is ambiguous', () => {
    expect(shouldPromptForSetupProvider('https://gitlab.com')).toBe(false);
    expect(shouldPromptForSetupProvider('https://github.example.com')).toBe(false);
    expect(shouldPromptForSetupProvider('https://bitbucket.org')).toBe(false);
    expect(shouldPromptForSetupProvider('https://review.example.com')).toBe(true);
    expect(shouldPromptForSetupProvider('')).toBe(true);
  });

  it('keeps detected provider and gitlab fallback defaults for ambiguous setup URLs', () => {
    expect(getSetupProviderDefault('https://github.com', null)).toBe('github');
    expect(getSetupProviderDefault('https://review.example.com', 'github')).toBe('github');
    expect(getSetupProviderDefault('https://review.example.com', null)).toBe('gitlab');
  });

  it('does not treat an entered URL as a provider choice', () => {
    expect(() => normalizeProviderInput('https://gitlab.com')).toThrow(ConfigError);
    expect(() => normalizeProviderInput('https://gitlab.com')).toThrow(
      'Invalid provider: "https://gitlab.com". Must be "gitlab", "github", or "bitbucket-cloud".',
    );
  });

  it('validates provider URL input before deriving provider defaults', () => {
    expect(normalizeProviderUrlInput(' https://gitlab.com ')).toBe('https://gitlab.com');
    expect(normalizeProviderUrlInput('http://gitlab.example.com')).toBe('http://gitlab.example.com');
    expect(normalizeProviderUrlInput('HTTPS://GITLAB.COM/')).toBe('https://gitlab.com');
    expect(normalizeProviderUrlInput('')).toBe('');
  });

  it('rejects provider URLs that are not HTTP(S) origins', () => {
    for (const value of [
      'ssh://gitlab.com',
      'https://gitlab.com/api/v4',
      'https://gitlab.com?tab=projects',
      'https://gitlab.com#projects',
    ]) {
      expect(() => normalizeProviderUrlInput(value)).toThrow(ConfigError);
      expect(() => normalizeProviderUrlInput(value)).toThrow(
        `Invalid provider URL: "${value}". Expected an absolute URL like "https://gitlab.com".`,
      );
    }
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
    expect(isManagedCloudProvider('https://bitbucket.org', 'bitbucket-cloud')).toBe(true);
    expect(isManagedCloudProvider('https://gitlab.example.com', 'gitlab')).toBe(false);
    expect(isManagedCloudProvider('https://github.example.com', 'github')).toBe(false);
    expect(isManagedCloudProvider('https://bitbucket.example.com', 'bitbucket-cloud')).toBe(false);
  });

  it('requires the exact Bitbucket Cloud HTTPS provider URL', () => {
    expect(() => validateProviderUrlForProvider('https://bitbucket.org', 'bitbucket-cloud')).not.toThrow();

    for (const value of ['http://bitbucket.org', 'ssh://bitbucket.org', 'https://bitbucket.org/workspace']) {
      expect(() => validateProviderUrlForProvider(value, 'bitbucket-cloud')).toThrow(ConfigError);
      expect(() => validateProviderUrlForProvider(value, 'bitbucket-cloud')).toThrow(
        'Bitbucket Cloud profiles must use https://bitbucket.org.',
      );
    }
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
