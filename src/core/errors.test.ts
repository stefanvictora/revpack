import { describe, expect, it } from 'vitest';
import { AuthenticationError, ConfigError, ProviderError, ReviewAssistError, WorkspaceError } from './errors.js';

describe('application errors', () => {
  it('preserves the base error contract', () => {
    const error = new ReviewAssistError('Something failed', 'CUSTOM_CODE');

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ReviewAssistError);
    expect(error.message).toBe('Something failed');
    expect(error.code).toBe('CUSTOM_CODE');
    expect(error.name).toBe('ReviewAssistError');
  });

  it('preserves provider error details', () => {
    const error = new ProviderError('Request failed', 'github', 500);

    expect(error).toBeInstanceOf(ReviewAssistError);
    expect(error.message).toBe('Request failed');
    expect(error.code).toBe('PROVIDER_ERROR');
    expect(error.name).toBe('ProviderError');
    expect(error.provider).toBe('github');
    expect(error.statusCode).toBe(500);
  });

  it('allows provider errors without a status code', () => {
    const error = new ProviderError('Network failed', 'gitlab');

    expect(error.provider).toBe('gitlab');
    expect(error.statusCode).toBeUndefined();
  });

  it('preserves authentication error details', () => {
    const error = new AuthenticationError('Missing token', 'gitlab');

    expect(error).toBeInstanceOf(ReviewAssistError);
    expect(error.message).toBe('Missing token');
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.name).toBe('AuthenticationError');
    expect(error.provider).toBe('gitlab');
  });

  it('preserves config error details', () => {
    const error = new ConfigError('Invalid profile');

    expect(error).toBeInstanceOf(ReviewAssistError);
    expect(error.message).toBe('Invalid profile');
    expect(error.code).toBe('CONFIG_ERROR');
    expect(error.name).toBe('ConfigError');
  });

  it('preserves workspace error details', () => {
    const error = new WorkspaceError('Unable to write bundle');

    expect(error).toBeInstanceOf(ReviewAssistError);
    expect(error.message).toBe('Unable to write bundle');
    expect(error.code).toBe('WORKSPACE_ERROR');
    expect(error.name).toBe('WorkspaceError');
  });
});
