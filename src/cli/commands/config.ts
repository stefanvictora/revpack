import type { Command } from 'commander';
import chalk from 'chalk';
import { loadDisplayConfig, saveConfig, unsetConfig, CONFIG_FILE } from '../../config/index.js';
import { handleError, outputJson } from '../helpers.js';

export function registerConfigCommand(program: Command): void {
  const configCmd = program.command('config').description('View or update configuration');

  configCmd
    .command('show')
    .description('Show current configuration')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const display = await loadDisplayConfig();
        if (opts.json) {
          outputJson(display);
          return;
        }

        console.log(chalk.bold('Current configuration:'));
        console.log('');
        if (display.activeProfile) {
          console.log(`  ${chalk.dim('Profile:')}     ${display.activeProfile}`);
        }
        console.log(`  ${chalk.dim('Provider:')}    ${display.provider ?? chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('GitLab URL:')} ${display.gitlabUrl ?? chalk.dim('(not set)')}`);
        console.log(
          `  ${chalk.dim('GitLab token:')} ${formatTokenDisplay(display.gitlabTokenSource)}`,
        );
        console.log(
          `  ${chalk.dim('GitHub token:')} ${formatTokenDisplay(display.githubTokenSource)}`,
        );
        console.log(`  ${chalk.dim('Default repo:')} ${display.defaultRepository ?? chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('CA file:')}    ${display.caFile ?? chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('TLS verify:')} ${display.tlsVerify ? chalk.green('true') : chalk.yellow('false')}`);

        console.log('');
        console.log(chalk.dim(`Config file: ${CONFIG_FILE}`));
      } catch (err) {
        handleError(err);
      }
    });

  configCmd
    .command('set <key> <value>')
    .description('Set a configuration value')
    .action(async (key: string, value: string) => {
      try {
        const allowedKeys = [
          'provider',
          'gitlabUrl',
          'defaultRepository',
          'caFile',
          'tlsVerify',
        ];
        if (!allowedKeys.includes(key)) {
          console.error(chalk.red(`Unknown config key: ${key}. Allowed: ${allowedKeys.join(', ')}`));
          process.exit(1);
        }
        await saveConfig({ [key]: parseConfigValue(key, value) });
        console.log(chalk.green(`✓ ${key} updated`));
      } catch (err) {
        handleError(err);
      }
    });

  configCmd
    .command('unset <key>')
    .description('Remove a configuration value')
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

  configCmd
    .command('init')
    .description('Interactive configuration setup')
    .action(() => {
      try {
        console.log(chalk.bold('revkit — Configuration'));
        console.log('');
        console.log('Set environment variables or use `revkit config set`:');
        console.log('');
        console.log(`  ${chalk.cyan('REVKIT_PROVIDER')}        gitlab | github`);
        console.log(`  ${chalk.cyan('REVKIT_GITLAB_URL')}      https://gitlab.example.com`);
        console.log(`  ${chalk.cyan('REVKIT_GITLAB_TOKEN')}    your-token (env var)`);
        console.log(`  ${chalk.cyan('GITLAB_TOKEN')}           (fallback for GitLab token)`);
        console.log(`  ${chalk.cyan('REVKIT_REPO')}            group/project`);
        console.log('');
        console.log('Or configure via file:');
        console.log(`  ${chalk.dim(CONFIG_FILE)}`);
        console.log('');
        console.log('Example (token source based):');
        console.log(`  ${chalk.cyan('revkit config set provider gitlab')}`);
        console.log(`  ${chalk.cyan('revkit config set gitlabUrl https://gitlab.example.com')}`);
        console.log(`  ${chalk.cyan('revkit config set gitlabToken glpat-xxxxxxxxxxxx')}`);
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
