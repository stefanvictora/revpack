import { InvalidArgumentError, type Command } from 'commander';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { formatGuidanceLine } from '../output.js';

interface SetupFile {
  /** Path relative to the target project root. */
  target: string;
  /** Source path relative to the templates/ dir. */
  source: string;
  /** Description shown in the output. */
  label: string;
  /** Whether revpack may refresh an unchanged generated file. */
  managed: boolean;
}

type AgentTarget = 'claude' | 'codex' | 'copilot' | 'cursor';
type SetupStatus = 'created' | 'updated' | 'skipped-customized' | 'skipped-exists' | 'skipped-current';

interface SetupResult {
  target: string;
  label: string;
  status: SetupStatus;
}

interface SetupOptions {
  cwd: string;
  prompts?: boolean;
  agent?: AgentTarget;
  dryRun?: boolean;
  force?: boolean;
}

interface SetupAgentOptions {
  cwd: string;
  target: AgentTarget;
  dryRun?: boolean;
  force?: boolean;
}

const SUPPORTED_AGENT_TARGETS: AgentTarget[] = ['claude', 'codex', 'copilot', 'cursor'];
const REVIEW_INCLUDE = '{{revpack-review-instructions}}';
const CONTEXT_INCLUDE = '{{revpack-context-instructions}}';
const MANAGED_MARKER_PATTERN = /\n<!-- revpack-managed: sha256:([a-f0-9]{64}) -->\n?$/;

// Rendered adapter hashes from before managed markers were introduced.
// Agent adapters first shipped in v0.4.0; the second group covers later pre-marker templates.
const LEGACY_MANAGED_HASHES = new Set([
  // v0.4.0: Claude/Codex, Copilot, Cursor
  '0ec04d176a3bba18640412d34eeff1b0093bf70e7eb0a4d0951be0fb0efe88a2',
  '3a594b3f2d300e65a802427f5fb8b4399987ce091011c4f378e71082d9274309',
  'e9a141de775aca0f2e8904da4fb02f36cd9446a32e30f085c0372dc4bba7e4ab',
  // Later pre-marker templates: Claude/Codex, Copilot, Cursor
  'f4d740ea24f13b9ed891966fbd4a9b0e2ea4062ed2c2e2686754a73d668a1334',
  'f135559846ee679e9c7ca9e9f718779f9f3e781ebf371abac37d2e0db6a76e64',
  'b690c4bac44177a5a3a07e5010e6af8d487afae6559ecc2821828ec1331e01e4',
]);

const REVIEW_CONFIG_FILE: SetupFile = {
  target: 'REVIEW.md',
  source: 'REVIEW.md',
  label: 'Review guidelines',
  managed: false,
};

const AGENT_FILES: Record<AgentTarget, SetupFile[]> = {
  claude: [
    managedAgentFile(
      path.join('.claude', 'skills', 'revpack-review', 'SKILL.md'),
      path.join('claude', 'skills', 'revpack-review', 'SKILL.md'),
      'Claude skill: revpack-review',
    ),
    managedAgentFile(
      path.join('.claude', 'skills', 'revpack-context', 'SKILL.md'),
      path.join('claude', 'skills', 'revpack-context', 'SKILL.md'),
      'Claude skill: revpack-context',
    ),
  ],
  codex: [
    managedAgentFile(
      path.join('.agents', 'skills', 'revpack-review', 'SKILL.md'),
      path.join('codex', 'skills', 'revpack-review', 'SKILL.md'),
      'Codex skill: revpack-review',
    ),
    managedAgentFile(
      path.join('.agents', 'skills', 'revpack-context', 'SKILL.md'),
      path.join('codex', 'skills', 'revpack-context', 'SKILL.md'),
      'Codex skill: revpack-context',
    ),
  ],
  copilot: [
    managedAgentFile(
      path.join('.github', 'prompts', 'revpack-review.prompt.md'),
      path.join('copilot', 'revpack-review.prompt.md'),
      'Copilot prompt: revpack-review',
    ),
    managedAgentFile(
      path.join('.github', 'prompts', 'revpack-context.prompt.md'),
      path.join('copilot', 'revpack-context.prompt.md'),
      'Copilot prompt: revpack-context',
    ),
  ],
  cursor: [
    managedAgentFile(
      path.join('.cursor', 'commands', 'revpack-review.md'),
      path.join('cursor', 'commands', 'revpack-review.md'),
      'Cursor command: revpack-review',
    ),
    managedAgentFile(
      path.join('.cursor', 'commands', 'revpack-context.md'),
      path.join('cursor', 'commands', 'revpack-context.md'),
      'Cursor command: revpack-context',
    ),
  ],
};

export function registerSetupCommand(program: Command): void {
  const setupCmd = program
    .command('setup')
    .description('Create REVIEW.md and optional agent harness files')
    .option(
      '--agent <target>',
      `Also install an agent harness adapter (${SUPPORTED_AGENT_TARGETS.join(', ')})`,
      parseAgentTarget,
    )
    .option('--prompts', 'Deprecated alias for `setup agent copilot`')
    .option('--force', 'Replace customized agent adapters with the current generated versions')
    .option('--dry-run', 'Show what would be created or updated without writing files')
    .action(async (opts: { agent?: AgentTarget; prompts?: boolean; force?: boolean; dryRun?: boolean }) => {
      await runSetup({
        cwd: process.cwd(),
        agent: opts.agent,
        prompts: opts.prompts,
        force: opts.force,
        dryRun: opts.dryRun,
      });
    });

  setupCmd
    .command('agent')
    .description('Install agent harness adapters')
    .argument('<target>', `Agent harness target (${SUPPORTED_AGENT_TARGETS.join(', ')})`, parseAgentTarget)
    .option('--force', 'Replace customized agent adapters with the current generated versions')
    .option('--dry-run', 'Show what would be created or updated without writing files')
    .action(async (target: AgentTarget, _opts: { force?: boolean; dryRun?: boolean }, cmd: Command) => {
      const opts = cmd.optsWithGlobals<{ force?: boolean; dryRun?: boolean }>();
      await runSetupAgent({ cwd: process.cwd(), target, force: opts.force, dryRun: opts.dryRun });
    });
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  const templatesDir = resolveTemplatesDir();
  const files = uniqueSetupFiles([
    REVIEW_CONFIG_FILE,
    ...(opts.agent ? AGENT_FILES[opts.agent] : []),
    ...(opts.prompts ? AGENT_FILES.copilot : []),
  ]);
  const results = await installCopiedFiles(opts.cwd, templatesDir, files, opts.dryRun, opts.force);

  printResults(results, opts.dryRun);
  if (opts.agent) printRefreshHint(results, opts.agent);
  if (opts.prompts && opts.agent !== 'copilot') printRefreshHint(results, 'copilot');

  const changed = results.some((result) => result.status === 'created' || result.status === 'updated');
  if (!opts.dryRun && opts.agent && changed) {
    printAgentUsage(opts.agent);
  }

  if (!opts.dryRun && changed) {
    console.log('');
    console.log(formatGuidanceLine('Next steps:'));
    if (results.some((result) => result.target === 'REVIEW.md' && result.status === 'created')) {
      console.log(formatGuidanceLine('  1. Edit REVIEW.md - tailor review priorities to your project'));
    }
    if (opts.agent) {
      console.log(formatGuidanceLine('  revpack prepare'));
    } else if (!opts.prompts) {
      console.log(formatGuidanceLine('  Tip: install an agent adapter, for example:'));
      console.log(formatGuidanceLine('  revpack setup agent codex'));
      console.log(formatGuidanceLine('  Or create both files at once:'));
      console.log(formatGuidanceLine('  revpack setup --agent codex'));
      console.log(formatGuidanceLine('  revpack prepare'));
    } else {
      console.log(formatGuidanceLine('  Tip: `revpack setup --prompts` is deprecated; use:'));
      console.log(formatGuidanceLine('  revpack setup agent copilot'));
      console.log(formatGuidanceLine('  revpack prepare'));
    }
  }
}

export async function runSetupAgent(opts: SetupAgentOptions): Promise<void> {
  const templatesDir = resolveTemplatesDir();
  const results = await installCopiedFiles(opts.cwd, templatesDir, AGENT_FILES[opts.target], opts.dryRun, opts.force);

  printResults(results, opts.dryRun);
  printRefreshHint(results, opts.target);
  printAgentUsage(opts.target);

  if (!(await fileExists(path.join(opts.cwd, 'REVIEW.md')))) {
    console.log(formatGuidanceLine('Tip: add project-specific review guidance in REVIEW.md.'));
    console.log(formatGuidanceLine('  revpack setup'));
  }
}

async function installCopiedFiles(
  cwd: string,
  templatesDir: string,
  files: SetupFile[],
  dryRun = false,
  force = false,
): Promise<SetupResult[]> {
  const results: SetupResult[] = [];

  for (const file of files) {
    const targetPath = path.join(cwd, file.target);
    const rendered = await renderTemplate(templatesDir, file.source);
    const desired = file.managed ? addManagedMarker(rendered) : rendered;
    const exists = await fileExists(targetPath);

    if (exists) {
      const existing = await fs.readFile(targetPath, 'utf-8');
      const status = setupStatusForExistingFile(existing, rendered, file.managed, force);
      if (status === 'updated' && !dryRun) {
        await fs.writeFile(targetPath, desired, 'utf-8');
      }
      results.push({ target: file.target, label: file.label, status });
      continue;
    }

    if (!dryRun) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, desired, 'utf-8');
    }

    results.push({ target: file.target, label: file.label, status: 'created' });
  }

  return results;
}

async function renderTemplate(templatesDir: string, source: string): Promise<string> {
  const content = await readTemplate(templatesDir, source);
  const reviewIncludeCount = content.split(REVIEW_INCLUDE).length - 1;
  const contextIncludeCount = content.split(CONTEXT_INCLUDE).length - 1;

  if (reviewIncludeCount === 0 && contextIncludeCount === 0) {
    return normalizeLineEndings(content);
  }

  if (reviewIncludeCount + contextIncludeCount !== 1) {
    throw new Error(`${source} must contain exactly one supported agent instruction marker.`);
  }

  const include = reviewIncludeCount === 1 ? REVIEW_INCLUDE : CONTEXT_INCLUDE;
  const instructionsFile =
    reviewIncludeCount === 1 ? 'revpack-review-instructions.md' : 'revpack-context-instructions.md';
  const instructions = normalizeLineEndings(
    await readTemplate(templatesDir, path.join('agent', instructionsFile)),
  ).trim();
  return normalizeLineEndings(content).replace(include, instructions);
}

async function readTemplate(templatesDir: string, source: string): Promise<string> {
  return fs.readFile(path.join(templatesDir, source), 'utf-8');
}

function printResults(results: SetupResult[], dryRun = false): void {
  const groups: Array<{ status: SetupStatus; title: string; marker: string }> = [
    { status: 'created', title: dryRun ? 'Would create' : 'Created', marker: '+' },
    { status: 'updated', title: dryRun ? 'Would update' : 'Updated', marker: '~' },
    { status: 'skipped-customized', title: 'Skipped (customized)', marker: '.' },
    { status: 'skipped-exists', title: 'Skipped (already exist)', marker: '.' },
    { status: 'skipped-current', title: 'Skipped (already current)', marker: '.' },
  ];

  let printed = false;
  for (const group of groups) {
    const matching = results.filter((result) => result.status === group.status);
    if (matching.length === 0) continue;

    if (printed) console.log('');
    console.log(
      group.status === 'created' || group.status === 'updated'
        ? chalk.green(`${group.title}:`)
        : chalk.dim(`${group.title}:`),
    );
    for (const result of matching) {
      const color = group.status === 'created' || group.status === 'updated' ? chalk.green : chalk.dim;
      console.log(`  ${color(group.marker)} ${result.target}  ${chalk.dim(result.label)}`);
    }
    printed = true;
  }

  if (dryRun && results.length > 0) {
    console.log('');
    console.log(chalk.dim('Dry run - no files written.'));
  }
}

function printAgentUsage(target: AgentTarget): void {
  console.log('');
  switch (target) {
    case 'claude':
      console.log(formatGuidanceLine('Use the revpack adapters in Claude Code with:'));
      console.log(formatGuidanceLine('  /revpack-review'));
      console.log(formatGuidanceLine('  /revpack-context'));
      break;
    case 'codex':
      console.log(formatGuidanceLine('Use the revpack adapters in Codex with:'));
      console.log(formatGuidanceLine('  $revpack-review'));
      console.log(formatGuidanceLine('  $revpack-context'));
      break;
    case 'copilot':
      console.log(formatGuidanceLine('Use the revpack adapters in Copilot Chat with:'));
      console.log(formatGuidanceLine('  /revpack-review'));
      console.log(formatGuidanceLine('  /revpack-context'));
      break;
    case 'cursor':
      console.log(formatGuidanceLine('Use the revpack adapters in Cursor with:'));
      console.log(formatGuidanceLine('  /revpack-review'));
      console.log(formatGuidanceLine('  /revpack-context'));
      break;
  }
}

function printRefreshHint(results: SetupResult[], target: AgentTarget): void {
  if (!results.some((result) => result.status === 'skipped-customized')) return;
  console.log('');
  console.log(
    formatGuidanceLine(`Customized agent adapters were preserved. Replace them with current templates using:`),
  );
  console.log(formatGuidanceLine(`  revpack setup agent ${target} --force`));
}

function parseAgentTarget(value: string): AgentTarget {
  if (SUPPORTED_AGENT_TARGETS.includes(value as AgentTarget)) {
    return value as AgentTarget;
  }
  throw new InvalidArgumentError(
    `Unsupported agent target: ${value}. Supported targets: ${SUPPORTED_AGENT_TARGETS.join(', ')}`,
  );
}

function uniqueSetupFiles(files: SetupFile[]): SetupFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.target)) return false;
    seen.add(file.target);
    return true;
  });
}

function managedAgentFile(target: string, source: string, label: string): SetupFile {
  return { target, source, label, managed: true };
}

function setupStatusForExistingFile(existing: string, rendered: string, managed: boolean, force: boolean): SetupStatus {
  if (!managed) return 'skipped-exists';

  const desiredBody = normalizeManagedBody(rendered);
  const desiredHash = hashManagedBody(desiredBody);
  const existingManaged = readManagedContent(existing);

  if (force) {
    return existingManaged?.body === desiredBody && existingManaged.valid ? 'skipped-current' : 'updated';
  }

  if (existingManaged) {
    if (!existingManaged.valid) return 'skipped-customized';
    return existingManaged.body === desiredBody ? 'skipped-current' : 'updated';
  }

  const existingHash = hashManagedBody(existing);
  if (existingHash === desiredHash || LEGACY_MANAGED_HASHES.has(existingHash)) return 'updated';
  return 'skipped-customized';
}

function addManagedMarker(content: string): string {
  const body = normalizeManagedBody(content);
  return `${body}\n<!-- revpack-managed: sha256:${hashManagedBody(body)} -->\n`;
}

function readManagedContent(content: string): { body: string; valid: boolean } | undefined {
  const normalized = normalizeLineEndings(content);
  const match = normalized.match(MANAGED_MARKER_PATTERN);
  if (match?.index === undefined) return undefined;

  const body = normalizeManagedBody(normalized.slice(0, match.index));
  return { body, valid: hashManagedBody(body) === match[1] };
}

function hashManagedBody(content: string): string {
  return createHash('sha256').update(normalizeManagedBody(content), 'utf-8').digest('hex');
}

function normalizeManagedBody(content: string): string {
  return `${normalizeLineEndings(content).trimEnd()}\n`;
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function resolveTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/cli/commands/setup.js -> package root -> templates/
  return path.resolve(path.dirname(thisFile), '..', '..', '..', 'templates');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
