import chalk from 'chalk';
import { loadConfig } from '../config/index.js';
import { createProvider } from '../providers/factory.js';
import { ReviewOrchestrator } from '../orchestration/orchestrator.js';
import { ReviewAssistError } from '../core/errors.js';

/**
 * Create an orchestrator from config. Shared setup for all CLI commands.
 */
export async function createOrchestrator(): Promise<ReviewOrchestrator> {
  const config = await loadConfig();
  const provider = createProvider(config);
  return new ReviewOrchestrator({
    provider,
    workingDir: process.cwd(),
    bundleDirName: config.bundleDir,
  });
}

/**
 * Get default repository from config or git.
 */
export async function getDefaultRepo(): Promise<string | undefined> {
  const config = await loadConfig();
  return config.defaultRepository;
}

/**
 * Standard error handler for CLI commands.
 */
export function handleError(err: unknown): never {
  if (err instanceof ReviewAssistError) {
    console.error(chalk.red(`[${err.code}] ${err.message}`));
  } else if (err instanceof Error) {
    console.error(chalk.red(err.message));
    // Walk the cause chain to surface the root network error
    let cause = (err as NodeJS.ErrnoException).cause;
    while (cause) {
      console.error(chalk.dim(`  caused by: ${cause}`) );
      cause = (cause as NodeJS.ErrnoException).cause;
    }
  } else {
    console.error(chalk.red('An unexpected error occurred'));
  }

  if (process.env.DEBUG) {
    console.error(err);
  } else {
    console.error(chalk.dim('  Set DEBUG=1 for full stack trace'));
  }

  process.exit(1);
}

/**
 * Output data as JSON (for --json flag) or return it.
 */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}
