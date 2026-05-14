import type { NewFinding } from '../core/types.js';

// ─── Severity → emoji mapping ────────────────────────────

const SEVERITY_ICON: Record<string, string> = {
  blocker: '🔴',
  high: '🔴',
  medium: '🟡',
  low: '🟢',
  info: '🟢',
  nit: '🟢',
};

/**
 * Build the severity/category header line for a finding comment.
 * Used by the publish formatter and benchmark exporter.
 */
export function buildFindingHeader(severity: string, category: string): string {
  const icon = SEVERITY_ICON[severity] ?? '🟡';
  const sevLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
  return `_${icon} ${sevLabel}_ | _${category}_\n\n`;
}

/**
 * Render the full publish body for a finding.
 * Returns the same body shape that revpack publishes via `publish findings`.
 */
export function renderPublishFindingBody(finding: Pick<NewFinding, 'severity' | 'category' | 'body'>): string {
  return buildFindingHeader(finding.severity, finding.category) + finding.body;
}
