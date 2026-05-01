import type { TokenSource } from './types.js';

export interface ResolvedSecret {
  value?: string;
  sourceDescription: string;
}

/**
 * Resolves token values from configured token sources.
 * Never exposes token values in descriptions or errors.
 */
export class SecretResolver {
  async resolve(source: TokenSource): Promise<ResolvedSecret> {
    switch (source.type) {
      case 'env':
        return this.resolveEnv(source.name);
      default:
        return { sourceDescription: `unknown source type` };
    }
  }

  private resolveEnv(envName: string): ResolvedSecret {
    const value = process.env[envName];
    const sourceDescription = `env:${envName}`;
    if (value && value.length > 0) {
      return { value, sourceDescription };
    }
    return { sourceDescription };
  }

  /**
   * Check if a token source can be resolved without returning the value.
   */
  async isResolved(source: TokenSource): Promise<boolean> {
    const result = await this.resolve(source);
    return result.value != null;
  }

  /**
   * Get a safe description of a token source for display (never includes the value).
   */
  getSourceDescription(source: TokenSource): string {
    switch (source.type) {
      case 'env':
        return `env:${source.name}`;
      default:
        return 'unknown';
    }
  }
}
