/**
 * Base error class for WoT SDK errors
 */
export class WoTError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WoTError';
    // Maintains proper stack trace for where error was thrown (V8 engines)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
    // Fix prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when a network request fails
 */
export class NetworkError extends WoTError {
  public readonly statusCode?: number;
  public readonly url?: string;

  constructor(message: string, statusCode?: number, url?: string) {
    super(message);
    this.name = 'NetworkError';
    this.statusCode = statusCode;
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when a pubkey is not found in the graph
 */
export class NotFoundError extends WoTError {
  public readonly pubkey: string;

  constructor(pubkey: string, message?: string) {
    super(message || `Pubkey not found in graph: ${pubkey}`);
    this.name = 'NotFoundError';
    this.pubkey = pubkey;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when a request times out
 */
export class TimeoutError extends WoTError {
  public readonly timeout: number;

  constructor(timeout: number, message?: string) {
    super(message || `Request timed out after ${timeout}ms`);
    this.name = 'TimeoutError';
    this.timeout = timeout;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Error thrown when validation fails
 */
export class ValidationError extends WoTError {
  public readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
