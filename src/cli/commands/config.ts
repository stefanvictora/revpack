import type { Command } from 'commander';
import chalk from 'chalk';
import {
  loadDisplayConfig,
  loadFileConfig,
  saveConfig,
  saveRawConfig,
  unsetConfig,
  CONFIG_FILE,
} from '../../config/index.js';
import type { RevkitProfile, TokenSource } from '../../config/types.js';
import { GitHelper } from '../../workspace/git-helper.js';
import { handleError, outputJson } from '../helpers.js';

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('View or update configuration');

  // ─── config show ─────────────────────────────────────────

  configCmd
    .command('show')
    .description('Show current configuration (resolved via git remote or --profile)')
    .option('--json', 'Output as JSON')
    .option('--profile <name>', 'Show configuration for a specific profile')
    .action(async (opts: { json?: boolean; profile?: string }) => {
      try {
        const remoteUrls = await getRemoteUrlsSafe();
        const display = await loadDisplayConfig(remoteUrls, opts.profile);

        if (opts.json) {
          outputJson(display);
          return;
        }

        console.log(chalk.bold('Current configuration:'));
        console.log('');
        if (display.activeProfile) {
          console.log(`  ${chalk.dim('Profile:')}      ${chalk.cyan(display.activeProfile)}`);
        }
        console.log(`  ${chalk.dim('Provider:')}     ${display.provider ?? chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('GitLab URL:')}   ${display.gitlabUrl ?? chalk.dim('(not set)')}`);
        console.log(
          `  ${chalk.dim('GitLab token:')} ${formatTokenDisplay(display.gitlabTokenSource)}`,
        );
        console.log(
          `  ${chalk.dim('GitHub token:')} ${formatTokenDisplay(display.githubTokenSource)}`,
        );
        console.log(
          `  ${chalk.dim('Default repo:')} ${display.defaultRepository ?? chalk.dim('(not set)')}`,
        );
        console.log(`  ${chalk.dim('CA file:')}      ${display.caFile ?? chalk.dim('(not set)')}`);
        console.log(
          `  ${chalk.dim('TLS verify:')}   ${display.tlsVerify ? chalk.green('true') : chalk.yellow('false')}`,
        );
        console.log('');
        console.log(chalk.dim(`Config file: ${CONFIG_FILE}`));
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config profiles ────────────────────────────────────

  configCmd
    .command('profiles')
    .description('List all configured profiles')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const fileConfig = await loadFileConfig();
        const profiles = fileConfig.profiles ?? {};
        const names = Object.keys(profiles);

        if (opts.json) {
          const items = names.map((name) => ({
            name,
            isDefault: fileConfig.defaultProfile === name,
            provider: profiles[name].provider,
            gitlabUrl: profiles[name].gitlabUrl,
            remoteUrlPatterns: profiles[name].remoteUrlPatterns ?? [],
          }));
          outputJson(items);
          return;
        }

        if (names.length === 0) {
          console.log(chalk.dim('No profiles configured.'));
          console.log('');
          console.log(`Run ${chalk.cyan('revkit config profile add <name>')} to create one.`);

          // Check for flat config fallback
          if (fileConfig.provider) {
            console.log('');
            console.log(chalk.dim('A flat (non-profile) configuration exists:'));
            console.log(`  ${chalk.dim('Provider:')} ${fileConfig.provider}`);
            if (fileConfig.gitlabUrl) {
              console.log(`  ${chalk.dim('GitLab URL:')} ${fileConfig.gitlabUrl}`);
            }
          }
          return;
        }

        console.log(chalk.bold(`Profiles (${names.length}):`));
        console.log('');
        for (const name of names) {
          const p = profiles[name];
          const isDefault = fileConfig.defaultProfile === name;
          const label = isDefault ? `${name} ${chalk.green('(default)')}` : name;
          console.log(`  ${chalk.bold(label)}`);
          console.log(`    ${chalk.dim('Provider:')} ${p.provider}`);
          if (p.gitlabUrl) console.log(`    ${chalk.dim('GitLab URL:')} ${p.gitlabUrl}`);
          if (p.gitlabTokenSource) {
            console.log(
              `    ${chalk.dim('GitLab token:')} env:${p.gitlabTokenSource.name}`,
            );
          }
          if (p.remoteUrlPatterns?.length) {
            console.log(`    ${chalk.dim('Remote patterns:')} ${p.remoteUrlPatterns.join(', ')}`);
          }
          if (p.defaultRepository) {
            console.log(`    ${chalk.dim('Default repo:')} ${p.defaultRepository}`);
          }
          console.log('');
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config profile add ─────────────────────────────────

  const profileCmd = configCmd
    .command('profile')
    .description('Manage configuration profiles');

  profileCmd
    .command('add <name>')
    .description('Create or update a named profile')
    .requiredOption('--provider <type>', 'Provider type: gitlab or github')
    .option('--gitlab-url <url>', 'GitLab instance URL')
    .option('--token-env <name>', 'Environment variable name for the provider token')
    .option('--remote-patterns <patterns>', 'Comma-separated git remote URL patterns for auto-matching')
    .option('--default-repo <repo>', 'Default repository (group/project)')
    .option('--ca-file <path>', 'Path to CA certificate file')
    .option('--no-tls-verify', 'Disable TLS verification')
    .option('--set-default', 'Set this profile as the default')
    .action(
      async (
        name: string,
        opts: {
          provider: string;
          gitlabUrl?: string;
          tokenEnv?: string;
          remotePatterns?: string;
          defaultRepo?: string;
          caFile?: string;
          tlsVerify?: boolean;
          setDefault?: boolean;
        },
      ) => {
        try {
          if (!['gitlab', 'github'].includes(opts.provider)) {
            console.error(chalk.red('--provider must be "gitlab" or "github"'));
            process.exit(1);
          }

          const profile: RevkitProfile = {
            provider: opts.provider as 'gitlab' | 'github',
          };

          if (opts.gitlabUrl) profile.gitlabUrl = opts.gitlabUrl;
          if (opts.tokenEnv) {
            const tokenSource: TokenSource = { type: 'env', name: opts.tokenEnv };
            if (opts.provider === 'gitlab') {
              profile.gitlabTokenSource = tokenSource;
            } else {
              profile.githubTokenSource = tokenSource;
            }
          }
          if (opts.remotePatterns) {
            profile.remoteUrlPatterns = opts.remotePatterns.split(',').map((p) => p.trim());
          }
          if (opts.defaultRepo) profile.defaultRepository = opts.defaultRepo;
          if (opts.caFile) profile.caFile = opts.caFile;
          if (opts.tlsVerify === false) profile.tlsVerify = false;

          const data: Record<string, unknown> = {
            profiles: { [name]: profile },
          };
          if (opts.setDefault) {
            data.defaultProfile = name;
          }

          await saveRawConfig(data);
          console.log(chalk.green(`✓ Profile "${name}" saved`));
          console.log('');
          console.log(`  ${chalk.dim('Provider:')} ${profile.provider}`);
          if (profile.gitlabUrl) console.log(`  ${chalk.dim('GitLab URL:')} ${profile.gitlabUrl}`);
          if (profile.gitlabTokenSource) {
            console.log(
              `  ${chalk.dim('GitLab token:')} env:${profile.gitlabTokenSource.name}`,
            );
          }
          if (profile.remoteUrlPatterns?.length) {
            console.log(
                `  ${chalk.dim('Remote patterns:')} ${profile.remoteUrlPatterns.join(', ')}`,
            );
          }
          if (opts.setDefault) {
            console.log(`  ${chalk.dim('Default:')} ${chalk.green('yes')}`);
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  profileCmd
    .command('remove <name>')
    .description('Remove a named profile')
    .action(async (name: string) => {
      try {
        const fileConfig = await loadFileConfig();
        if (!fileConfig.profiles?.[name]) {
          console.error(chalk.red(`Profile "${name}" not found`));
          process.exit(1);
        }

        delete fileConfig.profiles[name];

        // Clear defaultProfile if it points to the removed profile
        if (fileConfig.defaultProfile === name) {
          delete fileConfig.defaultProfile;
        }

        await saveRawConfig(fileConfig as unknown as Record<string, unknown>);
        console.log(chalk.green(`✓ Profile "${name}" removed`));
      } catch (err) {
        handleError(err);
      }
    });

  profileCmd
    .command('set-default <name>')
    .description('Set the default profile')
    .action(async (name: string) => {
      try {
        const fileConfig = await loadFileConfig();
        if (!fileConfig.profiles?.[name]) {
          console.error(chalk.red(`Profile "${name}" not found`));
          process.exit(1);
        }
        await saveRawConfig({ defaultProfile: name });
        console.log(chalk.green(`✓ Default profile set to "${name}"`));
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config set ──────────────────────────────────────────

  configCmd
    .command('set <key> <value>')
    .description('Set a flat configuration value')
    .action(async (key: string, value: string) => {
      try {
        const allowedKeys = ['provider', 'gitlabUrl', 'defaultRepository', 'caFile', 'tlsVerify'];
        if (!allowedKeys.includes(key)) {
          console.error(
            chalk.red(`Unknown config key: ${key}. Allowed: ${allowedKeys.join(', ')}`),
          );
          process.exit(1);
        }
        await saveConfig({ [key]: parseConfigValue(key, value) });
        console.log(chalk.green(`✓ ${key} updated`));
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config unset ────────────────────────────────────────

  configCmd
    .command('unset <key>')
    .description('Remove a configuration value (supports dotted keys)')
    .action(async (key: string) => {
      try {
        const removed = await unsetConfig(key);
        if (removed) {
          console.log(chalk.green(`✓ ${key} removed`));
        } else {
          console.log(chalk.dim(`${key} was not set`));
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ─── config init ─────────────────────────────────────────

  configCmd
    .command('init')
    .description('Show configuration help and examples')
    .action(() => {
      try {
        console.log(chalk.bold('revkit — Configuration'));
        console.log('');
        console.log(chalk.bold('Quick start (single instance):'));
        console.log('');
        console.log(`  ${chalk.cyan('revkit config set provider gitlab')}`);
        console.log(`  ${chalk.cyan('revkit config set gitlabUrl https://gitlab.example.com')}`);
        console.log(
          `  ${chalk.dim('# Set your token via environment variable (never stored in config):')}`,
        );
        console.log(`  ${chalk.cyan('export REVKIT_GITLAB_TOKEN=glpat-xxxxxxxxxxxx')}`);
        console.log('');
        console.log(chalk.bold('Profile-based setup (multiple instances):'));
        console.log('');
        console.log(
          `  ${chalk.cyan(`revkit config profile add my-gitlab \\`)}`,
        );
        console.log(
          `    ${chalk.cyan(`--provider gitlab \\`)}`,
        );
        console.log(
          `    ${chalk.cyan(`--gitlab-url https://gitlab.example.com \\`)}`,
        );
        console.log(
          `    ${chalk.cyan(`--token-env MY_GITLAB_TOKEN \\`)}`,
        );
        console.log(
          `    ${chalk.cyan(`--remote-patterns gitlab.example.com \\`)}`,
        );
        console.log(
          `    ${chalk.cyan(`--set-default`)}`,
        );
        console.log('');
        console.log(chalk.bold('View configuration:'));
        console.log('');
        console.log(`  ${chalk.cyan('revkit config show')}              ${chalk.dim('# resolved for current repo')}`);
        console.log(`  ${chalk.cyan('revkit config show --profile X')}  ${chalk.dim('# show specific profile')}`);
        console.log(`  ${chalk.cyan('revkit config show --json')}       ${chalk.dim('# JSON output')}`);
        console.log(`  ${chalk.cyan('revkit config profiles')}          ${chalk.dim('# list all profiles')}`);
        console.log('');
        console.log(chalk.bold('Token resolution (in priority order):'));
        console.log('');
        console.log(`  1. Profile ${chalk.cyan('gitlabTokenSource')} → env var name configured per profile`);
        console.log(`  2. ${chalk.cyan('REVKIT_GITLAB_TOKEN')} environment variable`);
        console.log(`  3. ${chalk.cyan('GITLAB_TOKEN')} environment variable (fallback)`);
        console.log('');
        console.log(chalk.bold('Profile auto-selection:'));
        console.log('');
        console.log(
          `  Profiles with ${chalk.cyan('remoteUrlPatterns')} are auto-selected when a pattern`,
        );
        console.log('  matches a git remote URL in the current repository.');
        console.log('');
        console.log(chalk.dim(`Config file: ${CONFIG_FILE}`));
      } catch (err) {
        handleError(err);
      }
    });
}

function parseConfigValue(key: string, value: string): string | boolean {
  if (key !== 'tlsVerify') return value;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error('tlsVerify must be one of: true, false, 1, 0, yes, no, on, off');
}

function formatTokenDisplay(tokenInfo?: { type: string; name: string; resolved: boolean }): string {
  if (!tokenInfo) return chalk.dim('(not set)');
  const status = tokenInfo.resolved ? chalk.green('set') : chalk.red('missing');
  return `${status} via ${tokenInfo.type}:${tokenInfo.name}`;
}

async function getRemoteUrlsSafe(): Promise<string[]> {
  try {
    const git = new GitHelper(process.cwd());
    return await git.listRemoteUrls();
  } catch {
    return [];
  }
}
