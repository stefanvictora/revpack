import type {
  ReviewTarget,
  ReviewDiff,
  ReviewThread,
  ReviewSummary,
  FileSummary,
} from '../core/types.js';

/**
 * Generates review summary artifacts. The summary.md is a changelog-style
 * description for the MR/PR description body (not a code walkthrough).
 * The agent is expected to enhance this with meaningful descriptions.
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
      highLevelSummary: this.buildHighLevelSummary(target, diffs),
      changedFilesSummary: this.buildFileSummaries(diffs),
      unresolvedThreadCount: unresolvedThreads.length,
      resolvedThreadCount: resolvedThreads.length,
    };
  }

  /**
   * Generate the summary.md content — a changelog-style description
   * suitable for the MR/PR description.
   */
  generateMarkdown(summary: ReviewSummary): string {
    const lines: string[] = [];

    lines.push('<!-- review-assist:summary -->');
    lines.push('## Summary by review-assist');
    lines.push('');

    // Group files by change category
    const added = summary.changedFilesSummary.filter((f) => f.changeType === 'added');
    const modified = summary.changedFilesSummary.filter((f) => f.changeType === 'modified');
    const deleted = summary.changedFilesSummary.filter((f) => f.changeType === 'deleted');
    const renamed = summary.changedFilesSummary.filter((f) => f.changeType === 'renamed');

    // Placeholder categories — the agent should fill these in with meaningful descriptions
    if (modified.length > 0 || added.length > 0) {
      lines.push('* **Changes**');
      for (const f of [...modified, ...added]) {
        lines.push(`  * \`${f.filePath}\` (${f.changeType})`);
      }
    }
    if (deleted.length > 0) {
      lines.push('* **Removed**');
      for (const f of deleted) {
        lines.push(`  * \`${f.filePath}\``);
      }
    }
    if (renamed.length > 0) {
      lines.push('* **Renamed**');
      for (const f of renamed) {
        lines.push(`  * \`${f.filePath}\``);
      }
    }
    lines.push('');
    lines.push('<!-- end of review-assist:summary -->');

    return lines.join('\n');
  }

  private buildHighLevelSummary(
    target: ReviewTarget,
    diffs: ReviewDiff[],
  ): string {
    const parts: string[] = [];
    parts.push(
      `MR !${target.targetId} by @${target.author}: "${target.title}".`,
    );
    parts.push(
      `${diffs.length} changed file(s).`,
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
