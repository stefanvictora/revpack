import type { Command } from 'commander';
import chalk from 'chalk';
import {
  loadFileConfig,
  loadDisplayConfig,
  saveFileConfig,
  runDoctor,
  resolveProfile,
  CONFIG_FILE,
} from '../../config/index.js';
import type { RevpackConfig, RevpackProfile } from '../../config/types.js';
import { CONFIG_KEYS, VALID_CONFIG_KEYS } from '../../config/keys.js';
import { ConfigError } from '../../core/errors.js';
import { GitHelper } from '../../workspace/git-helper.js';
import { handleError, outputJson } from '../helpers.js';

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('View or update configuration')
    .action(async () => {
      // `revpack config` behaves like `revpack config show`
      await showAction({ json: false, sources: false });
    });

  // ─── config show ─────────────────────────────────────────

  configCmd
    .command('show')
    .description('Show resolved configuration for the current directory')
    .option('--profile <name>', 'Show a specific profile')
    .option('--json', 'Output as JSON')
    .option('--sources', 'Show where each value comes from')
    .action(async (opts: { profile?: string; json?: boolean; sources?: boolean }) => {
      await showAction(opts);
    });

  // ─── config setup ────────────────────────────────────────

  configCmd
    .command('setup')
    .description('Interactive profile setup')
    .action(async () => {
      try {
        const remoteUrls = await getRemoteUrlsSafe();

        // Derive suggested values from git remotes
        let suggestedUrl = '';
        let suggestedName = '';
        let detectedProvider: 'github' | 'gitlab' | null = null;
        if (remoteUrls.length > 0) {
          const firstRemote = remoteUrls[0];
          try {
            // Handle SSH URLs like git@host:group/project.git
            const sshMatch = firstRemote.match(/@([^:]+):/);
            if (sshMatch) {
              suggestedUrl = `https://${sshMatch[1]}`;
              suggestedName = sshMatch[1].split('.')[0];
            } else {
              const parsed = new URL(firstRemote);
              suggestedUrl = `${parsed.protocol}//${parsed.host}`;
              suggestedName = parsed.hostname.split('.')[0];
            }
          } catch {
            // ignore parse errors
          }
          // Detect provider from URL
          if (firstRemote.includes('github.com')) {
            detectedProvider = 'github';
          } else if (firstRemote.includes('gitlab.')) {
            detectedProvider = 'gitlab';
          }
        }

        const defaultProvider = detectedProvider ?? 'gitlab';
        const defaultTokenEnv = defaultProvider === 'github' ? 'REVPACK_GITHUB_TOKEN' : 'REVPACK_GITLAB_TOKEN';
        // github.com and gitlab.com are managed cloud services — skip enterprise-only TLS/CA prompts
        const isCloudProvider =
          suggestedUrl === 'https://github.com' ||
          suggestedUrl === 'https://gitlab.com' ||
          detectedProvider === 'github';

        // Use readline for interactive prompts
        const { createInterface } = await import('node:readline');
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const ask = (prompt: string): Promise<string> => new Promise((resolve) => rl.question(prompt, resolve));

        console.log(chalk.bold('revpack — Profile Setup'));
        console.log('');

        const name =
          (await ask(`Profile name${suggestedName ? ` [${suggestedName}]` : ''}: `)) || suggestedName || 'default';
        const providerInput = (await ask(`Provider (gitlab/github) [${defaultProvider}]: `)) || defaultProvider;
        const url = (await ask(`Provider URL${suggestedUrl ? ` [${suggestedUrl}]` : ''}: `)) || suggestedUrl;
        const tokenEnv = (await ask(`Token environment variable [${defaultTokenEnv}]: `)) || defaultTokenEnv;

        // Derive host from URL for matching info
        let derivedHost = '';
        if (url) {
          try {
            derivedHost = new URL(url).host;
          } catch {
            /* ignore */
          }
        }
        const extraPatternPrompt = derivedHost
          ? `Custom remote match pattern? (optional, leave empty to use ${derivedHost}): `
          : `Remote match pattern: `;
        const extraPattern = await ask(extraPatternPrompt);

        let caFileInput = '';
        let tlsInput = 'yes';
        let sshCloneInput = 'no';
        if (!isCloudProvider) {
          caFileInput = await ask(`Custom CA file (optional): `);
          tlsInput = (await ask(`Verify TLS certificates [yes]: `)) || 'yes';
          sshCloneInput = (await ask(`Use SSH for git clone (revpack checkout) [no]: `)) || 'no';
        }

        rl.close();

        // Validate provider
        if (providerInput !== 'gitlab' && providerInput !== 'github') {
          throw new ConfigError(`Invalid provider: "${providerInput}". Must be "gitlab" or "github".`);
        }

        const profile: RevpackProfile = {
          provider: providerInput,
        };
        if (url) profile.url = url;
        if (tokenEnv) profile.tokenEnv = tokenEnv;
        if (extraPattern) {
          profile.remotePatterns = extraPattern
            .split(',')
            .map((p) => p.trim())
            .filter(Boolean);
        }
        if (caFileInput) profile.caFile = caFileInput.replace(/^['"]|['"]$/g, '');
        if (tlsInput.trim().toLowerCase() === 'no' || tlsInput.trim().toLowerCase() === 'false') {
          profile.tlsVerify = false;
        }
        if (['yes', 'true', '1', 'on'].includes(sshCloneInput.trim().toLowerCase())) {
          profile.sshClone = true;
        }

        // Write
        const config = await loadFileConfig();
        config.profiles ??= {};
        config.profiles[name] = profile;
        await saveFileConfig(config);

        // Summary
        console.log('');
        console.log(chalk.green(`✓ Profile "${name}" created`));
        console.log('');
        console.log(`  ${chalk.dim('Provider:')}         ${profile.provider}`);
        if (profile.url) console.log(`  ${chalk.dim('URL:')}              ${profile.url}`);
        if (profile.tokenEnv) console.log(`  ${chalk.dim('Token env:')}        ${profile.tokenEnv}`);
        const matchDisplay = derivedHost ? `${derivedHost} ${chalk.dim('(derived from URL)')}` : chalk.dim('(none)');
        console.log(`  ${chalk.dim('Remote matching:')}  ${matchDisplay}`);
        if (profile.remotePatterns?.length) {
          console.log(`  ${chalk.dim('Extra patterns:')}   ${profile.remotePatterns.join(', ')}`);
        }
        if (profile.caFile) console.log(`  ${chalk.dim('CA file:')}          ${profile.caFile}`);
        if (!isCloudProvider) {
          console.log(`  ${chalk.dim('TLS verify:')}       ${profile.tlsVerify === false ? 'false' : 'true'}`);
          if (profile.sshClone) console.log(`  ${chalk.dim('SSH clone:')}        true`);
        }
        console.log('');
        console.log(chalk.bold('Next:'));
        if (profile.tokenEnv) {
          console.log(`  export ${profile.tokenEnv}=...`);
        }
        console.log(`  revpack config doctor --profile ${name}`);
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config doctor ───────────────────────────────────────

  configCmd
    .command('doctor')
    .description('Check configuration health')
    .option('--profile <name>', 'Check a specific profile')
    .option('--json', 'Output as JSON')
    .action(async (opts: { profile?: string; json?: boolean }) => {
      try {
        const remoteUrls = await getRemoteUrlsSafe();
        const result = await runDoctor(remoteUrls, opts.profile);

        if (opts.json) {
          outputJson(result);
          return;
        }

        console.log(chalk.bold('Configuration check'));
        console.log('');
        for (const check of result.checks) {
          const icon = check.ok ? chalk.green('✓') : chalk.red('✗');
          const detail = check.detail ? chalk.dim(` — ${check.detail}`) : '';
          console.log(`  ${icon} ${check.label}${detail}`);
        }

        if (result.nextSteps.length > 0) {
          console.log('');
          console.log(chalk.bold('Next:'));
          for (const step of result.nextSteps) {
            console.log(`  ${step}`);
          }
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config get ──────────────────────────────────────────

  configCmd
    .command('get <key>')
    .description('Get a profile config value')
    .option('--profile <name>', 'Target profile')
    .action(async (key: string, opts: { profile?: string }) => {
      try {
        validateKey(key);
        const { profile } = await resolveWriteTarget(opts.profile);
        const value = profile[key as keyof RevpackProfile];
        if (value === undefined) {
          console.log(chalk.dim('(not set)'));
        } else {
          console.log(Array.isArray(value) ? value.join(', ') : String(value));
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config set ──────────────────────────────────────────

  configCmd
    .command('set <key> <value>')
    .description('Set a profile config value')
    .option('--profile <name>', 'Target profile')
    .option('--current', 'Resolve profile from current git repository')
    .action(async (key: string, value: string, opts: { profile?: string; current?: boolean }) => {
      try {
        validateKey(key);
        const parsed = CONFIG_KEYS[key].parse(value);
        const { profileName, config } = await resolveWriteTarget(opts.current ? undefined : opts.profile, opts.current);

        config.profiles ??= {};
        config.profiles[profileName] ??= { provider: 'gitlab' };
        (config.profiles[profileName] as unknown as Record<string, unknown>)[key] = parsed;

        await saveFileConfig(config);
        console.log(chalk.green(`✓ ${key} updated on profile "${profileName}"`));
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config unset ────────────────────────────────────────

  configCmd
    .command('unset <key>')
    .description('Remove a profile config value')
    .option('--profile <name>', 'Target profile')
    .option('--current', 'Resolve profile from current git repository')
    .action(async (key: string, opts: { profile?: string; current?: boolean }) => {
      try {
        validateKey(key);
        const { profileName, config } = await resolveWriteTarget(opts.current ? undefined : opts.profile, opts.current);

        const profile = config.profiles?.[profileName];
        if (!profile || !(key in profile)) {
          console.log(chalk.dim(`${key} was not set on profile "${profileName}"`));
          return;
        }

        delete (profile as unknown as Record<string, unknown>)[key];
        await saveFileConfig(config);
        console.log(chalk.green(`✓ ${key} removed from profile "${profileName}"`));
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config profile ──────────────────────────────────────

  const profileCmd = configCmd.command('profile').description('Manage configuration profiles');

  // profile list
  profileCmd
    .command('list')
    .description('List all configured profiles')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = await loadFileConfig();
        const profiles = config.profiles ?? {};
        const names = Object.keys(profiles);

        if (opts.json) {
          const items = names.map((name) => ({
            name,
            ...profiles[name],
          }));
          outputJson(items);
          return;
        }

        if (names.length === 0) {
          console.log(chalk.dim('No profiles configured.'));
          console.log('');
          console.log(`Run ${chalk.cyan('revpack config setup')} to create one.`);
          return;
        }

        console.log(chalk.bold(`Profiles (${names.length}):`));
        console.log('');
        for (const name of names) {
          const p = profiles[name];
          console.log(`  ${chalk.bold(name)}`);
          console.log(`    ${chalk.dim('Provider:')} ${p.provider}`);
          if (p.url) console.log(`    ${chalk.dim('URL:')}      ${p.url}`);
          // Show matching info
          let matchInfo = '';
          try {
            if (p.url) matchInfo = new URL(p.url).host;
          } catch {
            /* ignore */
          }
          if (p.remotePatterns?.length) {
            matchInfo += (matchInfo ? ', ' : '') + p.remotePatterns.join(', ');
          }
          if (matchInfo) console.log(`    ${chalk.dim('Matches:')}  ${matchInfo}`);
          if (p.tokenEnv) console.log(`    ${chalk.dim('Token:')}    env:${p.tokenEnv}`);
          console.log('');
        }
      } catch (err) {
        handleError(err);
      }
    });

  // profile show
  profileCmd
    .command('show <name>')
    .description('Show a specific profile')
    .option('--json', 'Output as JSON')
    .option('--sources', 'Show value sources')
    .action(async (name: string, opts: { json?: boolean; sources?: boolean }) => {
      try {
        const config = await loadFileConfig();
        const profile = config.profiles?.[name];
        if (!profile) {
          throw new ConfigError(
            `Profile "${name}" not found. Available: ${Object.keys(config.profiles ?? {}).join(', ') || '(none)'}`,
          );
        }

        if (opts.json) {
          const tokenResolved = profile.tokenEnv ? Boolean(process.env[profile.tokenEnv]) : false;
          outputJson({ name, ...profile, tokenResolved });
          return;
        }

        console.log(chalk.bold(`Profile: ${name}`));
        console.log('');
        printProfileDetails(profile, opts.sources);
      } catch (err) {
        handleError(err);
      }
    });

  // profile create
  profileCmd
    .command('create <name>')
    .description('Create or update a profile')
    .requiredOption('--provider <type>', 'Provider type: gitlab or github')
    .option('--url <url>', 'Provider base URL')
    .option('--token-env <name>', 'Environment variable name for the token')
    .option(
      '--match <pattern>',
      'Additional git remote URL pattern for selecting this profile (repeatable)',
      collectValues,
      [],
    )
    .option('--ca-file <path>', 'Path to CA certificate file')
    .option('--no-tls-verify', 'Disable TLS verification')
    .option('--ssh-clone', 'Use SSH instead of HTTPS for git clone')
    .action(
      async (
        name: string,
        opts: {
          provider: string;
          url?: string;
          tokenEnv?: string;
          match: string[];
          caFile?: string;
          tlsVerify?: boolean;
          sshClone?: boolean;
        },
      ) => {
        try {
          const provider = CONFIG_KEYS.provider.parse(opts.provider) as 'gitlab' | 'github';

          const profile: RevpackProfile = { provider };
          if (opts.url) profile.url = CONFIG_KEYS.url.parse(opts.url) as string;
          if (opts.tokenEnv) profile.tokenEnv = CONFIG_KEYS.tokenEnv.parse(opts.tokenEnv) as string;
          if (opts.match.length > 0) {
            profile.remotePatterns = opts.match;
          }
          if (opts.caFile) profile.caFile = opts.caFile;
          if (opts.tlsVerify === false) profile.tlsVerify = false;
          if (opts.sshClone) profile.sshClone = true;

          const config = await loadFileConfig();
          config.profiles ??= {};
          config.profiles[name] = profile;
          await saveFileConfig(config);

          console.log(chalk.green(`✓ Profile "${name}" saved`));
          console.log('');
          printProfileDetails(profile, false);
        } catch (err) {
          handleError(err);
        }
      },
    );

  // profile delete
  profileCmd
    .command('delete <name>')
    .description('Delete a profile')
    .action(async (name: string) => {
      try {
        const config = await loadFileConfig();
        if (!config.profiles?.[name]) {
          throw new ConfigError(
            `Profile "${name}" not found. Available: ${Object.keys(config.profiles ?? {}).join(', ') || '(none)'}`,
          );
        }

        delete config.profiles[name];
        await saveFileConfig(config);
        console.log(chalk.green(`✓ Profile "${name}" deleted`));
      } catch (err) {
        handleError(err);
      }
    });
}

// ─── Helpers ─────────────────────────────────────────────

async function showAction(opts: { profile?: string; json?: boolean; sources?: boolean }): Promise<void> {
  try {
    const remoteUrls = await getRemoteUrlsSafe();

    // Try to resolve. On failure, show helpful no-match message.
    let display;
    try {
      display = await loadDisplayConfig(remoteUrls, opts.profile);
    } catch (err) {
      if (opts.json) {
        outputJson({ error: (err as Error).message });
        return;
      }
      await showNoMatchMessage(remoteUrls);
      return;
    }

    if (opts.json) {
      outputJson(display);
      return;
    }

    console.log(chalk.bold('Current configuration'));
    console.log('');
    const matchDesc =
      display.matchedBy === 'explicit'
        ? '--profile flag'
        : display.matchSource === 'url-derived'
          ? `git remote matched provider host "${display.matchedPattern}"`
          : `git remote matched pattern "${display.matchedPattern}"`;
    console.log(`  ${chalk.dim('Profile:')}      ${chalk.cyan(display.profileName)}`);
    console.log(`  ${chalk.dim('Selected by:')}  ${matchDesc}`);
    console.log(`  ${chalk.dim('Provider:')}     ${display.provider}`);
    if (display.url) {
      console.log(
        `  ${chalk.dim('URL:')}          ${display.url}${src(opts.sources, 'profile:' + display.profileName)}`,
      );
    }
    const tokenStatus = display.tokenResolved ? chalk.green('set') : chalk.red('missing');
    console.log(
      `  ${chalk.dim('Token:')}        ${tokenStatus}${src(opts.sources, display.tokenEnv ? `env:${display.tokenEnv}` : undefined)}`,
    );
    if (display.tokenEnv) {
      console.log(`  ${chalk.dim('Token env:')}    ${display.tokenEnv}`);
    }
    if (display.caFile) {
      console.log(
        `  ${chalk.dim('CA file:')}      ${display.caFile}${src(opts.sources, 'profile:' + display.profileName)}`,
      );
    }
    console.log(`  ${chalk.dim('TLS verify:')}   ${display.tlsVerify}${src(opts.sources, 'default')}`);
    if (display.sshClone) {
      console.log(`  ${chalk.dim('SSH clone:')}    true${src(opts.sources, 'profile:' + display.profileName)}`);
    }
    console.log('');
    console.log(chalk.dim(`Config file: ${CONFIG_FILE}`));
  } catch (err) {
    handleError(err);
  }
}

async function showNoMatchMessage(remoteUrls: string[]): Promise<void> {
  console.log(chalk.yellow('No profile matched the current repository.'));
  console.log('');

  if (remoteUrls.length > 0) {
    console.log(chalk.dim('Current git remotes:'));
    for (const url of remoteUrls) {
      console.log(`  ${url}`);
    }
    console.log('');
  }

  const config = await loadFileConfig();
  const profiles = config.profiles ?? {};
  const names = Object.keys(profiles);

  if (names.length > 0) {
    console.log(chalk.dim('Configured profiles:'));
    for (const name of names) {
      const p = profiles[name];
      let matchInfo = '';
      try {
        if (p.url) matchInfo = new URL(p.url).host;
      } catch {
        /* ignore */
      }
      if (p.remotePatterns?.length) {
        matchInfo += (matchInfo ? ', ' : '') + p.remotePatterns.join(', ');
      }
      console.log(`  ${chalk.bold(name)}  ${p.provider}  matches: ${matchInfo || '(none)'}`);
    }
    console.log('');
    console.log(chalk.dim('Profiles are matched using:'));
    console.log(chalk.dim('  - the host from the profile URL'));
    console.log(chalk.dim('  - optional remotePatterns'));
    console.log('');
  }

  console.log(chalk.bold('Next:'));
  console.log(`  revpack config setup`);
  if (remoteUrls.length > 0 && names.length > 0) {
    const firstName = names[0];
    console.log(`  revpack config set remotePatterns <pattern> --profile ${firstName}`);
  }
}

function printProfileDetails(profile: RevpackProfile, sources?: boolean): void {
  console.log(`  ${chalk.dim('Provider:')}    ${profile.provider}`);
  if (profile.url) console.log(`  ${chalk.dim('URL:')}         ${profile.url}`);
  if (profile.tokenEnv) {
    const resolved = Boolean(process.env[profile.tokenEnv]);
    const status = resolved ? chalk.green('set') : chalk.red('missing');
    console.log(`  ${chalk.dim('Token:')}       ${status}${sources ? chalk.dim(` (env:${profile.tokenEnv})`) : ''}`);
    console.log(`  ${chalk.dim('Token env:')}   ${profile.tokenEnv}`);
  }
  if (profile.caFile) console.log(`  ${chalk.dim('CA file:')}     ${profile.caFile}`);
  console.log(`  ${chalk.dim('TLS verify:')}  ${profile.tlsVerify === false ? 'false' : 'true'}`);
  if (profile.sshClone) console.log(`  ${chalk.dim('SSH clone:')}   true`);
  console.log('');
  // Remote matching section
  console.log(`  ${chalk.dim('Remote matching:')}`);
  let derivedHost = '';
  if (profile.url) {
    try {
      derivedHost = new URL(profile.url).host;
    } catch {
      /* ignore */
    }
  }
  if (derivedHost) {
    console.log(`    ${chalk.dim('Derived from URL:')} ${derivedHost}`);
  } else {
    console.log(`    ${chalk.dim('Derived from URL:')} ${chalk.dim('(no URL set)')}`);
  }
  if (profile.remotePatterns?.length) {
    console.log(`    ${chalk.dim('Extra patterns:')}   ${profile.remotePatterns.join(', ')}`);
  } else {
    console.log(`    ${chalk.dim('Extra patterns:')}   ${chalk.dim('none')}`);
  }
}

function src(showSources: boolean | undefined, source: string | undefined): string {
  if (!showSources || !source) return '';
  return chalk.dim(`  [${source}]`);
}

function validateKey(key: string): void {
  if (!VALID_CONFIG_KEYS.includes(key)) {
    throw new ConfigError(`Unknown config key: "${key}". Valid keys: ${VALID_CONFIG_KEYS.join(', ')}`);
  }
}

async function resolveWriteTarget(
  explicitProfile?: string,
  useCurrent?: boolean,
): Promise<{ profileName: string; profile: RevpackProfile; config: RevpackConfig }> {
  const config = await loadFileConfig();

  if (explicitProfile) {
    const profile = config.profiles?.[explicitProfile];
    if (!profile) {
      throw new ConfigError(
        `Profile "${explicitProfile}" not found. Available: ${Object.keys(config.profiles ?? {}).join(', ') || '(none)'}`,
      );
    }
    return { profileName: explicitProfile, profile, config };
  }

  if (useCurrent) {
    const remoteUrls = await getRemoteUrlsSafe();
    const result = resolveProfile(config, remoteUrls);
    return { profileName: result.profileName, profile: result.profile, config };
  }

  // Try resolving from current dir
  const remoteUrls = await getRemoteUrlsSafe();
  if (remoteUrls.length > 0) {
    try {
      const result = resolveProfile(config, remoteUrls);
      return { profileName: result.profileName, profile: result.profile, config };
    } catch {
      // Fall through to error
    }
  }

  throw new ConfigError('Cannot determine target profile. Use --profile <name> or --current to specify.');
}

async function getRemoteUrlsSafe(): Promise<string[]> {
  try {
    const git = new GitHelper(process.cwd());
    return await git.listRemoteUrls();
  } catch {
    return [];
  }
}

function collectValues(value: string, previous: string[]): string[] {
  return [...previous, value];
}
