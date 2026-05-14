import type { ProviderType, TargetType } from './types.js';

export interface TargetDisplayRef {
  provider: ProviderType;
  targetType?: TargetType;
  targetId: string;
}

export function formatTargetDisplayId(target: TargetDisplayRef): string {
  switch (target.provider) {
    case 'gitlab':
      return `!${target.targetId}`;
    case 'github':
      return `#${target.targetId}`;
    case 'local':
      return target.targetId;
  }
}

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
