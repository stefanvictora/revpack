// Application-level error types.

export class ReviewAssistError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ReviewAssistError';
  }
}

export class ProviderError extends ReviewAssistError {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly statusCode?: number,
  ) {
    super(message, 'PROVIDER_ERROR');
    this.name = 'ProviderError';
  }
}

export class AuthenticationError extends ReviewAssistError {
  constructor(
    message: string,
    public readonly provider: string,
  ) {
    super(message, 'AUTH_ERROR');
    this.name = 'AuthenticationError';
  }
}

export class ConfigError extends ReviewAssistError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class WorkspaceError extends ReviewAssistError {
  constructor(message: string) {
    super(message, 'WORKSPACE_ERROR');
    this.name = 'WorkspaceError';
  }
}
