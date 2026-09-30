/**
 * What a remote signer hands back, checked against what was asked for.
 *
 * A NIP-46 bunker is not trusted the way the local vault is. It is a separate process, reached
 * over relays, and the only thing this pipeline knows about its answer is that it arrived. Until
 * now that answer was returned to the caller verbatim, which means a bunker (or anything that
 * could answer in its place) could return a signature over a DIFFERENT event than the one the
 * request named: another kind, other tags, other content, another author. The caller publishes
 * it believing it is what it asked for, and every downstream reader believes the account behind
 * the key said it.
 *
 * So the result is verified against the template, field by field, and only the canonical signed
 * fields are returned. Ported from the extension's `services/signing/remoteEventVerifier.ts`
 * (`5659678`, "Harden authentication boundaries").
 *
 * Two deliberate differences from the extension's version:
 *
 *  - It does not default `created_at` before sending. The extension fills in `now` and then
 *    demands equality. Here the template reaches the remote port exactly as the caller wrote it,
 *    because `params` is the host's contract with its own port and silently rewriting it would
 *    change what every existing bunker receives. So an UNSTATED `created_at` stays the remote's
 *    to choose and is only required to be a plausible integer; a STATED one must come back
 *    unchanged. A caller that wants the timestamp pinned states it, which is the same control by
 *    a different route.
 *  - The frozen validated template is not re-cloned on the way in. `validateRequest` already
 *    produced a deep copy and froze it, so a remote port cannot mutate what the prompt showed;
 *    the extension clones because its snapshot is an ordinary object.
 */
import { verifyEvent } from 'nostr-tools';
import { SignerError } from './errors.js';
import type { EventTemplateInput } from './types.js';

/** The fields a signature covers, and the only ones handed back to a caller. */
export interface VerifiedRemoteEvent {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Deep equality for a tag list, by the one canonical spelling a signature covers. */
function sameTags(left: unknown, right: readonly string[][]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The remote's answer to a `signEvent`, or a refusal.
 *
 * @param result - whatever the remote port returned
 * @param template - the validated template the request named, as the prompt showed it
 * @param expectedPubkey - the account the request was resolved for
 * @throws `author_mismatch` when the event is signed by another key, `operation_failed` when the
 *   remote changed the event, returned something that is not an event, or returned a signature
 *   that does not verify
 */
export function verifyRemoteSignedEvent(
  result: unknown,
  template: EventTemplateInput,
  expectedPubkey: string,
): VerifiedRemoteEvent {
  if (typeof result !== 'object' || result === null) {
    throw new SignerError('operation_failed', 'Remote signer did not return an event');
  }
  const event = result as Record<string, unknown>;

  // The author first, and with its own error: "a different account signed this" is a different
  // thing for a host to report than "the bunker altered the event", and the user approved as one
  // identity. `template.pubkey`, when the caller stated one, was already checked against the
  // account at the boundary, so this is the account's key either way.
  if (event['pubkey'] !== expectedPubkey) {
    throw new SignerError('author_mismatch', 'Event author does not match the active account');
  }

  const changed =
    event['kind'] !== template.kind ||
    event['content'] !== template.content ||
    !sameTags(event['tags'], template.tags) ||
    // A stated timestamp must come back unchanged. An unstated one was the remote's to pick, as
    // it is on the local path where the signer fills it in, so only its shape is checked.
    (template.created_at === undefined
      ? !isNonNegativeInteger(event['created_at'])
      : event['created_at'] !== template.created_at);
  if (changed) {
    throw new SignerError('operation_failed', 'Remote signer changed the approved event');
  }

  if (typeof event['id'] !== 'string' || typeof event['sig'] !== 'string') {
    throw new SignerError('operation_failed', 'Remote signer did not return a signed event');
  }

  // Rebuilt as a fresh plain object BEFORE it is verified, and this order is the point.
  //
  // `nostr-tools` memoises verification on a module-private symbol: `finalizeEvent` stamps the
  // event it produced, and `verifyEvent` returns that stamp without re-checking anything. An
  // object spread copies own symbol properties, so a remote port that uses nostr-tools itself,
  // as every NIP-46 client does, can sign one event, spread it with a different `id` and hand
  // back something `verifyEvent` calls valid. Measured: a forged id on a spread of a finalized
  // event verifies true, and the same fields on a plain object verify false.
  //
  // A fresh object carries no symbols, so the check below is a real one. It also means only the
  // fields a signature covers are handed to a caller, rather than whatever else the remote
  // decorated its reply with, which would be unverified data inside an object treated as
  // verified. The extension gets both properties from `structuredClone`, which drops symbols.
  const verified: VerifiedRemoteEvent = {
    id: event['id'],
    pubkey: expectedPubkey,
    created_at: event['created_at'] as number,
    kind: template.kind,
    tags: template.tags.map((tag) => [...tag]),
    content: template.content,
    sig: event['sig'],
  };
  // Last, because it is the expensive one and the cheap structural checks have already
  // established that this is the right event. It covers the id as the hash of the canonical
  // fields as well as the signature over it.
  if (!verifyEvent(verified)) {
    throw new SignerError('operation_failed', 'Remote signer returned an invalid signature');
  }
  return verified;
}
