/**
 * Error types raised by the SDK. Mirrors `python/openharness/exceptions.py`.
 */

export interface OpenHarnessErrorOptions {
  stderr?: string;
  exitCode?: number | null;
  cause?: unknown;
}

export class OpenHarnessError extends Error {
  readonly stderr: string | undefined;
  readonly exitCode: number | null | undefined;

  constructor(message: string, options: OpenHarnessErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "OpenHarnessError";
    this.stderr = options.stderr;
    this.exitCode = options.exitCode;
  }
}

export class OhBinaryNotFoundError extends OpenHarnessError {
  constructor(
    message = "Could not find the 'oh' CLI. Install it with `npm install -g @zhijiewang/openharness`, or set the OH_BINARY environment variable to its absolute path.",
  ) {
    super(message);
    this.name = "OhBinaryNotFoundError";
  }
}
