// Configuration types for revkit.
// Profile-only config model. No flat config, no default profile, no default repository.

// ─── Provider Type ───────────────────────────────────────

export type ProviderType = 'gitlab' | 'github';

// ─── Profile Config ──────────────────────────────────────

export interface RevkitProfile {
  provider: ProviderType;
  url?: string;
  tokenEnv?: string;
  remotePatterns?: string[];
  caFile?: string;
  tlsVerify?: boolean;
}

// ─── File Config ─────────────────────────────────────────

export interface RevkitConfig {
  profiles?: Record<string, RevkitProfile>;
}

// ─── Runtime Config (resolved at runtime) ────────────────

export interface ResolvedAppConfig {
  provider: ProviderType;
  url?: string;
  token?: string;
  caFile?: string;
  tlsVerify: boolean;
}

// ─── Profile Resolution Result ───────────────────────────

export interface ProfileResolutionResult {
  profile: RevkitProfile;
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
