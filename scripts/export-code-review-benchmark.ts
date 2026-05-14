#!/usr/bin/env tsx
/**
 * Export locally produced revpack findings into a Martian code-review-benchmark
 * compatible benchmark_data JSON file.
 *
 * Usage:
 *   npm run eval:export-code-review-benchmark -- \
 *     --benchmark-data <path> \
 *     (--workspace <repo-root> | --workspace-root <parent-dir>) \
 *     [--tool <name>]
 */

import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as fss from 'node:fs';
import * as path from 'node:path';
import {
  slugifyToolName,
  resolveDefaultOutputPath,
  indexBenchmarkByGitHubIdentity,
  discoverImmediateChildWorkspaces,
  classifyWorkspace,
  mapFindingToBenchmarkReviewComment,
  buildReviewEntry,
  buildSlimOutputPreservingBenchmarkOrder,
  filterReviewsByTools,
  type BenchmarkData,
  type BenchmarkPrEntry,
  type ExportCandidate,
  type Skip,
  type PreparedWorkspace,
} from '../src/benchmark/export-adapter.js';
import { renderPublishFindingBody } from '../src/workspace/finding-formatter.js';
import { newFindingsArraySchema } from '../src/core/schemas.js';
import type { BundleState, NewFinding } from '../src/core/types.js';

// ─── CLI ──────────────────────────────────────────────────

interface CliOptions {
  benchmarkData: string;
  workspace?: string;
  workspaceRoot?: string;
  tool: string;
  includeTools: string[];
}

function parseArgs(): CliOptions {
  const program = new Command();
  program
    .name('export-code-review-benchmark')
    .description('Export revpack findings into a Martian code-review-benchmark data file')
    .requiredOption('--benchmark-data <path>', 'Path to the Martian benchmark data JSON')
    .option('--workspace <repo-root>', 'Export a single prepared revpack workspace')
    .option('--workspace-root <parent-dir>', 'Batch export immediate child prepared workspaces')
    .option('--tool <name>', 'Benchmark tool identity', 'revpack')
    .option(
      '--include-tools <names>',
      'Comma-separated list of other tool names from the benchmark data to include alongside revpack (e.g. "coderabbit,cubic-dev")',
      (val: string) =>
        val
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      [] as string[],
    );

  program.parse(process.argv);
  return program.opts() as CliOptions;
}

// ─── File helpers ─────────────────────────────────────────

async function readJsonFile<T>(filePath: string, label: string): Promise<T> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot read ${label} at "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    throw new Error(`Cannot parse ${label} at "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function writeJsonFile(filePath: string, data: unknown): Promise<void> {
  const json = JSON.stringify(data, null, 2);
  try {
    await fs.writeFile(filePath, json, 'utf-8');
  } catch (err) {
    throw new Error(`Cannot write output file "${filePath}": ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ─── Bundle reading ───────────────────────────────────────

async function readBundle(workspace: PreparedWorkspace): Promise<BundleState> {
  const bundlePath = path.join(workspace.root, '.revpack', 'bundle.json');
  return readJsonFile<BundleState>(bundlePath, 'bundle.json');
}

// ─── Findings reading & validation ───────────────────────

async function readAndValidateFindings(findingsPath: string): Promise<NewFinding[]> {
  const raw = await readJsonFile<unknown>(findingsPath, 'new-findings.json');
  if (!Array.isArray(raw)) {
    throw new Error(`${findingsPath}: expected a JSON array, got ${typeof raw}`);
  }
  const result = newFindingsArraySchema.safeParse(raw);
  if (!result.success) {
    const messages = result.error.issues.map((issue) => `  [${issue.path.join('.')}] ${issue.message}`).join('\n');
    throw new Error(`Malformed findings in "${findingsPath}":\n${messages}`);
  }
  return result.data as NewFinding[];
}

// ─── Benchmark data validation ────────────────────────────

function assertValidBenchmarkData(data: unknown, filePath: string): asserts data is BenchmarkData {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(
      `Benchmark data at "${filePath}" must be a JSON object (got ${Array.isArray(data) ? 'array' : String(data)})`,
    );
  }
}

// ─── Workspace discovery ──────────────────────────────────

async function resolveWorkspaces(opts: CliOptions): Promise<{ workspaces: PreparedWorkspace[]; mode: string }> {
  if (opts.workspace && opts.workspaceRoot) {
    throw new Error('Provide exactly one of --workspace or --workspace-root, not both.');
  }
  if (!opts.workspace && !opts.workspaceRoot) {
    throw new Error('Provide exactly one of --workspace or --workspace-root.');
  }

  if (opts.workspace) {
    const workspaceRoot = path.resolve(opts.workspace);
    const bundlePath = path.join(workspaceRoot, '.revpack', 'bundle.json');
    if (!fss.existsSync(bundlePath)) {
      throw new Error(
        `"${workspaceRoot}" does not appear to be a prepared revpack workspace (missing .revpack/bundle.json).`,
      );
    }
    return { workspaces: [{ root: workspaceRoot }], mode: 'workspace' };
  }

  const workspaceRoot = path.resolve(opts.workspaceRoot!);
  const workspaces = discoverImmediateChildWorkspaces(workspaceRoot);
  if (workspaces.length === 0) {
    throw new Error(
      `No prepared revpack workspaces found under "${workspaceRoot}".\n` +
        `Ensure each workspace directory contains .revpack/bundle.json.`,
    );
  }
  return { workspaces, mode: 'workspace-root' };
}

// ─── Sorting ──────────────────────────────────────────────

function sortCandidatesByIdentity(candidates: ExportCandidate[]): ExportCandidate[] {
  return [...candidates].sort((a, b) => {
    const aKey = `${a.identity.owner}/${a.identity.repo}#${String(a.identity.number).padStart(10, '0')}`;
    const bKey = `${b.identity.owner}/${b.identity.repo}#${String(b.identity.number).padStart(10, '0')}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
}

// ─── Console summary ──────────────────────────────────────

function printSummary(opts: {
  tool: string;
  includeTools: string[];
  benchmarkDataPath: string;
  outPath: string;
  mode: string;
  discoveredCount: number;
  exportedCandidates: ExportCandidate[];
  skipped: Skip[];
  findingCounts: Map<string, number>;
}): void {
  console.log('');
  console.log('Exported revpack benchmark data');
  console.log(`Tool: ${opts.tool}`);
  if (opts.includeTools.length > 0) {
    console.log(`Included tools: ${opts.includeTools.join(', ')}`);
  }
  console.log(`Input benchmark: ${opts.benchmarkDataPath}`);
  console.log(`Output benchmark: ${opts.outPath}`);
  console.log(`Mode: ${opts.mode}`);
  console.log(`Discovered prepared workspaces: ${opts.discoveredCount}`);
  console.log(`Exported reviews: ${opts.exportedCandidates.length}`);
  console.log(`Skipped workspaces: ${opts.skipped.length}`);

  if (opts.exportedCandidates.length > 0) {
    console.log('');
    console.log('Exported:');
    for (const candidate of opts.exportedCandidates) {
      const count = opts.findingCounts.get(candidate.identity.key) ?? 0;
      console.log(`- ${candidate.identity.label}: ${count} finding${count === 1 ? '' : 's'}`);
    }
  }

  if (opts.skipped.length > 0) {
    console.log('');
    console.log('Skipped:');
    for (const skip of opts.skipped) {
      console.log(`- ${skip.workspace.root}: ${skip.reason}`);
    }
  }
}

// ─── Main ─────────────────────────────────────────────────

async function main(): Promise<void> {
  const opts = parseArgs();

  const tool = opts.tool;
  const toolSlug = slugifyToolName(tool);
  const benchmarkDataPath = path.resolve(opts.benchmarkData);
  const outPath = resolveDefaultOutputPath(benchmarkDataPath, toolSlug);

  // Validate output directory exists
  const outDir = path.dirname(outPath);
  if (!fss.existsSync(outDir)) {
    throw new Error(`Output directory does not exist: "${outDir}"`);
  }

  // Read and validate benchmark data
  const rawBenchmark = await readJsonFile<unknown>(benchmarkDataPath, 'benchmark data');
  assertValidBenchmarkData(rawBenchmark, benchmarkDataPath);
  const benchmark = rawBenchmark as BenchmarkData;
  const benchmarkIndex = indexBenchmarkByGitHubIdentity(benchmark);

  // Discover workspaces
  const { workspaces, mode } = await resolveWorkspaces(opts);

  // Classify each workspace
  const skipped: Skip[] = [];
  const exportCandidates: ExportCandidate[] = [];

  for (const workspace of workspaces) {
    let bundle: BundleState;
    try {
      bundle = await readBundle(workspace);
    } catch (err) {
      skipped.push({
        type: 'skip',
        workspace,
        reason: `cannot read bundle.json: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const findingsPath = path.join(workspace.root, '.revpack', 'outputs', 'new-findings.json');
    const findingsExists = fss.existsSync(findingsPath);

    const classification = classifyWorkspace(bundle, benchmarkIndex, workspace, findingsExists);
    if (classification.type === 'skip') {
      skipped.push(classification);
    } else {
      exportCandidates.push(classification);
    }
  }

  // Check for duplicate benchmark identities
  const seenIdentities = new Map<string, string>();
  const duplicateErrors: string[] = [];
  for (const candidate of exportCandidates) {
    const existing = seenIdentities.get(candidate.identity.key);
    if (existing) {
      duplicateErrors.push(
        `Duplicate workspaces for ${candidate.identity.label}:\n  ${existing}\n  ${candidate.workspace.root}`,
      );
    } else {
      seenIdentities.set(candidate.identity.key, candidate.workspace.root);
    }
  }
  if (duplicateErrors.length > 0) {
    throw new Error(`Multiple workspaces map to the same benchmark PR:\n\n${duplicateErrors.join('\n\n')}`);
  }

  // Process each export candidate
  const sortedCandidates = sortCandidatesByIdentity(exportCandidates);
  const exportedEntries = new Map<string, BenchmarkPrEntry>();
  const findingCounts = new Map<string, number>();
  const processingErrors: string[] = [];

  for (const candidate of sortedCandidates) {
    let findings: NewFinding[];
    try {
      findings = await readAndValidateFindings(candidate.findingsPath);
    } catch (err) {
      processingErrors.push(
        `${candidate.identity.label} (${candidate.workspace.root}): ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    const reviewComments: ReturnType<typeof mapFindingToBenchmarkReviewComment>[] = [];
    let hadMappingError = false;

    for (const finding of findings) {
      try {
        const rawBody = renderPublishFindingBody(finding);
        const normalizedBody = rawBody.replaceAll('\r\n', '\n');
        const comment = mapFindingToBenchmarkReviewComment(finding, normalizedBody);
        reviewComments.push(comment);
      } catch (err) {
        processingErrors.push(`${candidate.identity.label}: ${err instanceof Error ? err.message : String(err)}`);
        hadMappingError = true;
      }
    }

    if (hadMappingError) continue;

    const review = buildReviewEntry(
      candidate.identity,
      candidate.benchmarkEntry.canonicalPrUrl,
      tool,
      toolSlug,
      reviewComments,
    );

    exportedEntries.set(candidate.benchmarkEntry.canonicalPrUrl, {
      ...candidate.benchmarkEntry.value,
      reviews: [...filterReviewsByTools(candidate.benchmarkEntry.value, opts.includeTools), review],
    });
    findingCounts.set(candidate.identity.key, findings.length);
  }

  // Report all collected processing errors before failing
  if (processingErrors.length > 0) {
    console.error('Export failed due to the following errors:\n');
    for (const msg of processingErrors) {
      console.error(`  - ${msg}`);
    }
    process.exit(1);
  }

  if (exportedEntries.size === 0) {
    throw new Error(
      'No reviews were exported. All workspaces were either skipped or failed to process.\n' +
        'Check the skipped workspace list above for details.',
    );
  }

  // Build and write slim output
  const slimOutput = buildSlimOutputPreservingBenchmarkOrder(benchmark, exportedEntries);
  await writeJsonFile(outPath, slimOutput);

  // Print summary
  const exportedSorted = sortCandidatesByIdentity(
    sortedCandidates.filter((c) => exportedEntries.has(c.benchmarkEntry.canonicalPrUrl)),
  );

  printSummary({
    tool,
    includeTools: opts.includeTools,
    benchmarkDataPath,
    outPath,
    mode,
    discoveredCount: workspaces.length,
    exportedCandidates: exportedSorted,
    skipped,
    findingCounts,
  });
}

main().catch((err: unknown) => {
  console.error(`\nError: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
