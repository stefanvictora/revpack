import type { Command } from 'commander';
import chalk from 'chalk';
import { loadConfig, saveConfig, CONFIG_FILE } from '../../config/index.js';
import { handleError, outputJson } from '../helpers.js';

export function registerConfigCommand(program: Command): void {
  const configCmd = program
    .command('config')
    .description('View or update configuration');

  configCmd
    .command('show')
    .description('Show current configuration')
    .option('--json', 'Output as JSON')
    .action(async (opts: { json?: boolean }) => {
      try {
        const config = await loadConfig();
        if (opts.json) {
          outputJson(config);
          return;
        }

        console.log(chalk.bold('Current configuration:'));
        console.log('');
        console.log(`  ${chalk.dim('Provider:')}    ${config.provider}`);
        console.log(`  ${chalk.dim('GitLab URL:')} ${config.gitlabUrl ?? chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('GitLab token:')} ${config.gitlabToken ? chalk.green('set') : chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('GitHub token:')} ${config.githubToken ? chalk.green('set') : chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('Default repo:')} ${config.defaultRepository ?? chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('Bundle dir:')} ${config.bundleDir}`);
        console.log(`  ${chalk.dim('CA file:')}    ${config.caFile ?? chalk.dim('(not set)')}`);
        console.log(`  ${chalk.dim('TLS verify:')} ${config.tlsVerify ? chalk.green('true') : chalk.yellow('false')}`);
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
        const allowedKeys = ['provider', 'gitlabUrl', 'gitlabToken', 'githubToken', 'defaultRepository', 'bundleDir', 'caFile', 'tlsVerify'];
        if (!allowedKeys.includes(key)) {
          console.error(chalk.red(`Unknown config key: ${key}. Allowed: ${allowedKeys.join(', ')}`));
          process.exit(1);
        }
        await saveConfig({ [key]: value });
        console.log(chalk.green(`✓ ${key} updated`));
      } catch (err) {
        handleError(err);
      }
    });

  configCmd
    .command('init')
    .description('Interactive configuration setup')
    .action(async () => {
      try {
        console.log(chalk.bold('Review Assist — Configuration'));
        console.log('');
        console.log('Set environment variables or use `revkit config set`:');
        console.log('');
        console.log(`  ${chalk.cyan('REVKIT_PROVIDER')}        gitlab | github`);
        console.log(`  ${chalk.cyan('REVKIT_GITLAB_URL')}      https://gitlab.example.com`);
        console.log(`  ${chalk.cyan('REVKIT_GITLAB_TOKEN')}    your-token`);
        console.log(`  ${chalk.cyan('GITLAB_TOKEN')}           (fallback for GitLab token)`);
        console.log(`  ${chalk.cyan('REVKIT_REPO')}            group/project`);
        console.log('');
        console.log('Or configure via file:');
        console.log(`  ${chalk.dim(CONFIG_FILE)}`);
        console.log('');
        console.log('Example:');
        console.log(`  ${chalk.cyan('revkit config set gitlabUrl https://gitlab.example.com')}`);
        console.log(`  ${chalk.cyan('revkit config set gitlabToken glpat-xxxxxxxxxxxx')}`);
      } catch (err) {
        handleError(err);
      }
    });
}
