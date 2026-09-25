/**
 * The compile-time half of the pipeline's contract: one clock, and the ports that are
 * required are required.
 *
 * Three independent `now` defaults (vault, core, queue) were one system on three clocks. The
 * core now reads the vault's, so the only way to fake time is to fake it in the vault, once.
 */
import { expectTypeOf, test } from 'vitest';
import { MemoryStore } from '@nostr-wot/storage';
import { Vault } from '@nostr-wot/vault';
import { Permissions } from '@nostr-wot/permissions';
import type { SafeAccount } from '@nostr-wot/accounts';
import {
  ApprovalQueue,
  SignerCore,
  type ApprovalDecision,
  type ApprovalPort,
  type BatchItemOutcome,
  type BatchResult,
  type SignerBatchRequest,
  type SignerCoreDeps,
  type PqKeyScope,
  type SignerErrorCode,
  type UnlockPort,
  type ValidatedParams,
  withPqKeys,
} from '../src/index.js';

const ports = {
  vault: new Vault({ store: new MemoryStore() }),
  permissions: new Permissions(new MemoryStore()),
  approval: { present: async () => ({ allow: true }), cancel: () => {} },
  activity: { record: async () => {} },
  identity: { getActiveAccount: async () => null },
};

test('the core has no clock of its own', () => {
  // @ts-expect-error `now` is not a dependency of the core: it reads the vault's clock
  new SignerCore({ ...ports, now: () => 0 });
  expectTypeOf<SignerCoreDeps>().not.toHaveProperty('now');
});

test('the queue states its clock', () => {
  // @ts-expect-error `now` is required
  new ApprovalQueue({});
  // @ts-expect-error options are required
  new ApprovalQueue();
  new ApprovalQueue({ now: () => 0 });
});

test('the identity port is required', () => {
  const { identity: _identity, ...withoutIdentity } = ports;
  // @ts-expect-error `identity` is required
  new SignerCore(withoutIdentity);
});

test('a host opts into batches by implementing the batch prompt; a port without it still compiles', () => {
  // The three required ports above have no `presentBatch` and construct a core. A host with
  // one is the same type, so nothing that consumed the port before batches has to change.
  new SignerCore({ ...ports, approval: { ...ports.approval, presentBatch: async () => ({ allow: true }) } });
  expectTypeOf<ApprovalPort['presentBatch']>().toEqualTypeOf<
    ((batch: SignerBatchRequest, account: SafeAccount) => Promise<ApprovalDecision>) | undefined
  >();
  expectTypeOf<UnlockPort['requestUnlockBatch']>().toEqualTypeOf<
    ((batch: SignerBatchRequest, account: SafeAccount) => Promise<void>) | undefined
  >();
});

test('a batch outcome discriminates on ok, so a caller cannot read a result off a failure', () => {
  const outcome = {} as BatchItemOutcome;
  if (outcome.ok) {
    expectTypeOf(outcome.result).toEqualTypeOf<unknown>();
    // @ts-expect-error a success carries no code
    outcome.code;
  } else {
    expectTypeOf(outcome.code).toEqualTypeOf<SignerErrorCode>();
    // @ts-expect-error a failure carries no result
    outcome.result;
  }
  expectTypeOf<BatchResult['items']>().toEqualTypeOf<readonly BatchItemOutcome[]>();
});

test('the NIP-44 scheme is decided at the boundary and required after it, never defaulted', () => {
  // A consumer of the typed params has to say which construction it handled: an encrypt
  // params object with no scheme is not a ValidatedParams, so a path that forgot to look
  // at it cannot be written against the type.
  // @ts-expect-error `scheme` is required on nip44Encrypt
  const encrypt: ValidatedParams = { method: 'nip44Encrypt', pubkey: '', plaintext: '' };
  // @ts-expect-error `scheme` is required on nip44Decrypt
  const decrypt: ValidatedParams = { method: 'nip44Decrypt', pubkey: '', ciphertext: '' };
  // @ts-expect-error a post-quantum encrypt carries the recipient's key
  const pq: ValidatedParams = { method: 'nip44Encrypt', pubkey: '', plaintext: '', scheme: 'pq' };
  void [encrypt, decrypt, pq];
  const params = {} as ValidatedParams;
  if (params.method === 'nip44Encrypt' && params.scheme === 'pq') {
    expectTypeOf(params.recipientKemKey).toEqualTypeOf<string>();
  }
  if (params.method === 'nip44Encrypt' && params.scheme === 'classic') {
    // @ts-expect-error a classic encrypt carries no recipient key
    params.recipientKemKey;
  }
});

test('the post-quantum scope names its account and hands out no key outside the callback', () => {
  const vault = new Vault({ store: new MemoryStore() });
  const account = {} as SafeAccount;
  // @ts-expect-error the account is required: "whatever is active now" is not an option
  void withPqKeys(vault, async () => undefined);
  void withPqKeys(vault, account, async (scope) => {
    expectTypeOf(scope.source).toEqualTypeOf<'derived' | 'imported'>();
    expectTypeOf(scope.keys.kem.secretKey).toEqualTypeOf<Uint8Array>();
  });
  expectTypeOf<PqKeyScope>().not.toHaveProperty('mnemonic');
  expectTypeOf<PqKeyScope>().not.toHaveProperty('seed');
});
