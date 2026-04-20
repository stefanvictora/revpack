import type {
  ReviewTarget,
  ReviewDiff,
  ReviewThread,
  ReviewSummary,
  FileSummary,
} from '../core/types.js';

/**
 * Generates review summary artifacts (walkthrough, high-level summary,
 * changed files table). This is a deterministic/structural generator;
 * LLM-based summarization can be layered on top.
 */
export class SummaryGenerator {
  generateSummary(
    target: ReviewTarget,
    diffs: ReviewDiff[],
    threads: ReviewThread[],
  ): ReviewSummary {
    const resolvedThreads = threads.filter((t) => t.resolved);
    const unresolvedThreads = threads.filter((t) => t.resolvable && !t.resolved);

    return {
      targetRef: target,
      generatedAt: new Date().toISOString(),
      walkthrough: this.buildWalkthrough(target, diffs),
      highLevelSummary: this.buildHighLevelSummary(target, diffs, unresolvedThreads),
      changedFilesSummary: this.buildFileSummaries(diffs),
      unresolvedThreadCount: unresolvedThreads.length,
      resolvedThreadCount: resolvedThreads.length,
    };
  }

  generateMarkdown(summary: ReviewSummary): string {
    const lines: string[] = [];

    lines.push('## Summary');
    lines.push('');
    lines.push(summary.highLevelSummary);
    lines.push('');
    lines.push('## Walkthrough');
    lines.push('');
    lines.push(summary.walkthrough);
    lines.push('');
    lines.push('## Changed Files');
    lines.push('');
    lines.push('| File | Change | Summary |');
    lines.push('|------|--------|---------|');
    for (const file of summary.changedFilesSummary) {
      lines.push(`| \`${file.filePath}\` | ${file.changeType} | ${file.summary} |`);
    }
    lines.push('');
    lines.push('## Review Status');
    lines.push('');
    lines.push(`- Unresolved threads: **${summary.unresolvedThreadCount}**`);
    lines.push(`- Resolved threads: **${summary.resolvedThreadCount}**`);
    lines.push('');
    lines.push(`---`);
    lines.push(`*Generated at ${summary.generatedAt}*`);

    return lines.join('\n');
  }

  private buildWalkthrough(target: ReviewTarget, diffs: ReviewDiff[]): string {
    const lines: string[] = [];
    lines.push(
      `This MR "${target.title}" changes ${diffs.length} file(s) ` +
      `from \`${target.sourceBranch}\` into \`${target.targetBranch}\`.`,
    );
    lines.push('');

    const added = diffs.filter((d) => d.newFile);
    const deleted = diffs.filter((d) => d.deletedFile);
    const renamed = diffs.filter((d) => d.renamedFile);
    const modified = diffs.filter((d) => !d.newFile && !d.deletedFile && !d.renamedFile);

    if (added.length) lines.push(`- **Added**: ${added.map((d) => `\`${d.newPath}\``).join(', ')}`);
    if (deleted.length) lines.push(`- **Deleted**: ${deleted.map((d) => `\`${d.oldPath}\``).join(', ')}`);
    if (renamed.length) lines.push(`- **Renamed**: ${renamed.map((d) => `\`${d.oldPath}\` → \`${d.newPath}\``).join(', ')}`);
    if (modified.length) lines.push(`- **Modified**: ${modified.map((d) => `\`${d.newPath}\``).join(', ')}`);

    return lines.join('\n');
  }

  private buildHighLevelSummary(
    target: ReviewTarget,
    diffs: ReviewDiff[],
    unresolvedThreads: ReviewThread[],
  ): string {
    const parts: string[] = [];
    parts.push(
      `MR !${target.targetId} by @${target.author}: "${target.title}".`,
    );
    parts.push(
      `${diffs.length} changed file(s), ${unresolvedThreads.length} unresolved thread(s).`,
    );
    if (target.labels.length) {
      parts.push(`Labels: ${target.labels.join(', ')}.`);
    }
    return parts.join(' ');
  }

  private buildFileSummaries(diffs: ReviewDiff[]): FileSummary[] {
    return diffs.map((d) => {
      let changeType: FileSummary['changeType'];
      if (d.newFile) changeType = 'added';
      else if (d.deletedFile) changeType = 'deleted';
      else if (d.renamedFile) changeType = 'renamed';
      else changeType = 'modified';

      const lineCount = (d.diff.match(/\n/g) ?? []).length;
      const additions = (d.diff.match(/^\+[^+]/gm) ?? []).length;
      const deletions = (d.diff.match(/^-[^-]/gm) ?? []).length;

      return {
        filePath: d.newPath || d.oldPath,
        changeType,
        summary: `${additions} addition(s), ${deletions} deletion(s) (${lineCount} diff lines)`,
      };
    });
  }
}
