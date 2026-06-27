import type { TargetType } from './types.js';

export function formatTargetKind(target: { targetType: TargetType }): string {
  switch (target.targetType) {
    case 'merge_request':
      return 'MR';
    case 'pull_request':
      return 'PR';
    case 'local_review':
      return 'Local review';
  }
}
