// Configuration types for revpack.
// Profile-only config model. No flat config, no default profile, no default repository.

// ─── Provider Type ───────────────────────────────────────

export type ProviderType = 'gitlab' | 'github';

// ─── Profile Config ──────────────────────────────────────

export interface RevpackProfile {
  provider: ProviderType;
  url?: string;
  tokenEnv?: string;
  remotePatterns?: string[];
  caFile?: string;
  tlsVerify?: boolean;
  sshClone?: boolean;
}

// ─── File Config ─────────────────────────────────────────

export interface RevpackConfig {
  profiles?: Record<string, RevpackProfile>;
}

// ─── Runtime Config (resolved at runtime) ────────────────

export interface ResolvedAppConfig {
  provider: ProviderType;
  url?: string;
  token?: string;
  caFile?: string;
  tlsVerify: boolean;
  sshClone?: boolean;
}

// ─── Profile Resolution Result ───────────────────────────

export interface ProfileResolutionResult {
  profile: RevpackProfile;
  profileName: string;
  matchedBy: 'explicit' | 'remote-match';
  matchedPattern?: string;
  matchSource?: 'url-derived' | 'remote-pattern';
}

// ─── Display Config (safe for output) ────────────────────

export interface DisplayAppConfig {
  profileName: string;
  matchedBy: 'explicit' | 'remote-match';
  matchedPattern?: string;
  matchSource?: 'url-derived' | 'remote-pattern';
  provider: ProviderType;
  url?: string;
  tokenEnv?: string;
  tokenResolved: boolean;
  caFile?: string;
  tlsVerify: boolean;
  sshClone: boolean;
}

// ─── Doctor Result ───────────────────────────────────────

export interface DoctorCheck {
  ok: boolean;
  label: string;
  detail?: string;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  profileName?: string;
  nextSteps: string[];
}
