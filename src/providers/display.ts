import type { ProviderType, TargetType } from '../core/types.js';

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
      return target.provider;
    }
  }
}
