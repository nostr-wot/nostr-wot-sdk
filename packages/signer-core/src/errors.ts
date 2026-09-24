/**
 * The one error type the pipeline throws.
 *
 * A transport has to turn every refusal into a wire error, and NIP-46, NIP-55 and a LAN frame
 * each spell those differently. Matching on message text is how a reworded error silently
 * turns a refusal into a retry loop, so every refusal carries a stable `code` and the message
 * is for people.
 */
export type SignerErrorCode =
  /** The request did not pass the boundary. Nothing downstream saw it. */
  | 'invalid_request'
  /** A stored permission denied it. The user was not asked. */
  | 'permission_denied'
  /** The user, or the host on the user's behalf, said no. */
  | 'rejected'
  /** The origin already has too many prompts open. */
  | 'too_many_pending'
  /** Nobody answered in time. */
  | 'timeout'
  /** The active account changed while the request was pending, or between prompt and signing. */
  | 'account_switched'
  /** The template names an author other than the active account. */
  | 'author_mismatch'
  /** The vault is locked and this host cannot, or did not, open it. */
  | 'vault_locked'
  /** There is no active account to act as. */
  | 'no_account'
  /** The account cannot perform this: read-only, or remote with no remote port. */
  | 'unsupported'
  /** The core was disposed. */
  | 'shutdown';

export class SignerError extends Error {
  constructor(
    readonly code: SignerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}

/** The message of whatever was thrown, for logs and activity entries. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
