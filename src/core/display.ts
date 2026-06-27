import type { z } from 'zod';
import type { providerTypeSchema } from './schemas.js';
import type { TargetType } from './types.js';

type ProviderType = z.infer<typeof providerTypeSchema>;

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
    case 'bitbucket-cloud':
      return `#${target.targetId}`;
    case 'local':
      return target.targetId;
    default: {
      const exhaustive: never = target.provider;
      return exhaustive;
    }
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
