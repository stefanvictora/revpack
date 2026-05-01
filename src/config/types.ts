// Configuration types for revkit.
// Separates file config, runtime config, and display config.

// ─── Token Source ────────────────────────────────────────

export type TokenSource = {
  type: 'env';
  name: string;
};

// ─── Profile Config ──────────────────────────────────────

export interface RevkitProfile {
  provider: 'gitlab' | 'github';

  /**
   * Used to match this profile to a local repository.
   * Examples:
   * - https://gitlab.customer-a.local/
   * - git@gitlab.customer-a.local:
   * - customer-a.local
   */
  remoteUrlPatterns?: string[];

  gitlabUrl?: string;
  gitlabTokenSource?: TokenSource;

  githubTokenSource?: TokenSource;

  defaultRepository?: string;

  caFile?: string;
  tlsVerify?: boolean;
}

// ─── App Config (file config) ────────────────────────────

export interface AppConfig {
  defaultProfile?: string;
  profiles?: Record<string, RevkitProfile>;

  // Flat fallback (single-profile use)
  provider?: 'gitlab' | 'github';

  gitlabUrl?: string;
  gitlabTokenSource?: TokenSource;

  githubTokenSource?: TokenSource;

  defaultRepository?: string;
  caFile?: string;
  tlsVerify?: boolean;
}

// ─── Runtime Config (resolved secrets) ───────────────────

export interface ResolvedAppConfig {
  provider: 'gitlab' | 'github';

  gitlabUrl?: string;
  gitlabToken?: string;

  githubToken?: string;

  defaultRepository?: string;
  caFile?: string;
  tlsVerify: boolean;
}

// ─── Display Config (safe for output) ────────────────────

export interface DisplayTokenInfo {
  type: 'env';
  name: string;
  resolved: boolean;
}

export interface DisplayAppConfig {
  provider?: 'gitlab' | 'github';
  activeProfile?: string;

  gitlabUrl?: string;
  gitlabTokenSource?: DisplayTokenInfo;

  githubTokenSource?: DisplayTokenInfo;

  defaultRepository?: string;
  caFile?: string;
  tlsVerify?: boolean;
}
