# Benchmark export

The `eval:export-code-review-benchmark` script exports locally produced revpack findings into a [Martian code-review-benchmark](https://github.com/MartianLabs/code-review-benchmark) compatible `benchmark_data.json` file.

The script is an **exporter only**. It does not checkout PRs, run `revpack prepare`, invoke a review agent, or publish comments.

## Workflow

```text
1. Checkout and prepare benchmark PRs locally with revpack.
2. Run your review agent manually for each prepared workspace.
3. Export all reviewed workspaces into a slim benchmark data file.
4. Run the Martian benchmark scripts separately with --tool <tool>.
```

## Prerequisites

Each workspace must contain:

```text
<workspace>/.revpack/bundle.json
<workspace>/.revpack/outputs/new-findings.json
```

## Usage

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data <path> \
  (--workspace <repo-root> | --workspace-root <parent-dir>) \
  [--tool <name>]
```

Required arguments:

- `--benchmark-data <path>` — path to the Martian benchmark data JSON file
- exactly one of:
    - `--workspace <repo-root>` — export one prepared revpack workspace
    - `--workspace-root <parent-dir>` — export all immediate child directories that are prepared revpack workspaces

Optional argument:

- `--tool <name>` — tool identity written into the benchmark output. Default: `revpack`

## Examples

Export one workspace:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace ../revpack-benchmark-workspaces/cal.com-pr-10600
```

Export all prepared workspaces under a parent directory:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace-root ../revpack-benchmark-workspaces
```

Export under a custom tool name:

```bash
npm run eval:export-code-review-benchmark -- \
  --benchmark-data ../code-review-benchmark/offline/results/benchmark_data.json \
  --workspace-root ../revpack-benchmark-workspaces \
  --tool revpack-gpt-5.5
```

## Output

The exporter writes a file next to `--benchmark-data`, named after the tool slug:

```text
benchmark_data.revpack.json
benchmark_data.revpack-gpt-5-5.json
```

The output contains only benchmark PR entries for which revpack produced a review. Each exported entry preserves the original PR metadata and contains exactly one `reviews` entry for the selected tool.

Workspaces are skipped with a warning when:

- the bundle target is not a GitHub pull request
- the bundle's PR URL does not match any entry in the benchmark data
- `.revpack/outputs/new-findings.json` is missing

The script fails without writing output when arguments are invalid, benchmark data is malformed, zero reviews would be exported, or any matched workspace has corrupt findings.