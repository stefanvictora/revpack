// Validates findings against a line map before publishing.

import type { NewFinding } from '../core/types.js';
import type { LineMap } from './patch-parser.js';
import { newFindingsArraySchema } from '../core/schemas.js';

export interface ValidationError {
  index: number;
  finding: NewFinding;
  message: string;
}

export interface ValidationResult {
  valid: NewFinding[];
  errors: ValidationError[];
}

/**
 * Validate findings against schema and line map.
 * Returns validated findings and any errors.
 */
export function validateFindings(findings: unknown[], lineMap: LineMap): ValidationResult {
  // Step 1: Schema validation
  const schemaResult = newFindingsArraySchema.safeParse(findings);
  if (!schemaResult.success) {
    const errors: ValidationError[] = schemaResult.error.issues.map((issue) => {
      const pathIdx = typeof issue.path[0] === 'number' ? issue.path[0] : 0;
      return {
        index: pathIdx,
        finding: (findings[pathIdx] ?? {}) as NewFinding,
        message: `Schema error: ${issue.message} (at ${issue.path.join('.')})`,
      };
    });
    return { valid: [], errors };
  }

  const parsed = schemaResult.data as NewFinding[];
  const valid: NewFinding[] = [];
  const errors: ValidationError[] = [];

  // Step 2: Positional validation against line map
  for (let i = 0; i < parsed.length; i++) {
    const finding = parsed[i];
    const error = validateFindingPosition(finding, i, lineMap);
    if (error) {
      errors.push(error);
    } else {
      valid.push(finding);
    }
  }

  return { valid, errors };
}

function validateFindingPosition(finding: NewFinding, index: number, lineMap: LineMap): ValidationError | null {
  // Find matching file entry
  const fileEntry = lineMap.files.find(
    (f) => f.oldPath === finding.oldPath && f.newPath === finding.newPath,
  );

  if (!fileEntry) {
    return {
      index,
      finding,
      message:
        `No file entry found in diffs/latest.patch for oldPath="${finding.oldPath}", newPath="${finding.newPath}". ` +
        `The finding must reference a file that exists in the MR diff.`,
    };
  }

  const hasOldLine = finding.oldLine != null;
  const hasNewLine = finding.newLine != null;

  if (hasNewLine && !hasOldLine) {
    // Must match an added line
    const match = fileEntry.lines.find(
      (l) => l.type === 'added' && l.newLine === finding.newLine,
    );
    if (!match) {
      const contextMatch = fileEntry.lines.find(
        (l) => l.type === 'context' && l.newLine === finding.newLine,
      );
      if (contextMatch) {
        return {
          index,
          finding,
          message:
            `newLine-only findings must point to an added line. ` +
            `newLine=${finding.newLine} in ${finding.newPath} is a context line (oldLine=${contextMatch.oldLine}, newLine=${contextMatch.newLine}). ` +
            `Context lines require both oldLine and newLine.`,
        };
      }
      return {
        index,
        finding,
        message:
          `No valid added-line anchor found for ${finding.newPath} newLine ${finding.newLine}. ` +
          `If this is an unchanged context line, provide both oldLine and newLine. ` +
          `If this line is outside the visible diff, move the issue to review-notes.md or anchor it to the closest visible changed/context line.`,
      };
    }
  } else if (hasOldLine && !hasNewLine) {
    // Must match a removed line
    const match = fileEntry.lines.find(
      (l) => l.type === 'removed' && l.oldLine === finding.oldLine,
    );
    if (!match) {
      return {
        index,
        finding,
        message:
          `No valid removed-line anchor found for ${finding.oldPath} oldLine ${finding.oldLine}. ` +
          `If this line is outside the visible diff, move the issue to review-notes.md or anchor it to the closest visible changed/context line.`,
      };
    }
  } else if (hasOldLine && hasNewLine) {
    // Must match a context line
    const match = fileEntry.lines.find(
      (l) => l.type === 'context' && l.oldLine === finding.oldLine && l.newLine === finding.newLine,
    );
    if (!match) {
      return {
        index,
        finding,
        message:
          `No valid context-line anchor found for ${finding.newPath} with oldLine=${finding.oldLine}, newLine=${finding.newLine}. ` +
          `Context lines require both oldLine and newLine to match exactly.`,
      };
    }
  }

  return null;
}

/**
 * Format validation errors into a human-readable report.
 */
export function formatValidationErrors(errors: ValidationError[]): string {
  return errors.map((e) => {
    const location = [
      e.finding.oldPath ? `oldPath: ${e.finding.oldPath}` : null,
      e.finding.newPath ? `newPath: ${e.finding.newPath}` : null,
      e.finding.oldLine != null ? `oldLine: ${e.finding.oldLine}` : null,
      e.finding.newLine != null ? `newLine: ${e.finding.newLine}` : null,
    ].filter(Boolean).join('\n  ');

    return `Invalid finding position in outputs/new-findings.json[${e.index}]:\n\n  ${location}\n\n${e.message}`;
  }).join('\n\n---\n\n');
}
