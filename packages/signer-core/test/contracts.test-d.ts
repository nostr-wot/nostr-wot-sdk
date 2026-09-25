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
  type PreparedParams,
  type SignerErrorCode,
  type UnlockPort,
  type ValidatedParams,
  type PermissionsPort,
  type VaultPort,
  withPqKeys,
} from '../src/index.js';
import { handWrittenPermissions, handWrittenVault, HAND_PRIVKEY } from './handwritten.js';

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

test('a post-quantum decrypt has to say whether the envelope is readable, so no path can assume it is', () => {
  // The defect this replaces: a payload naming our envelope that we cannot open answered false
  // to a boolean check and was routed classic. A consumer that does not look at `envelope`
  // cannot be written against the type.
  // @ts-expect-error `envelope` is required on a post-quantum decrypt
  const pq: ValidatedParams = { method: 'nip44Decrypt', pubkey: '', ciphertext: '', scheme: 'pq' };
  void pq;
  const params = {} as ValidatedParams;
  if (params.method === 'nip44Decrypt' && params.scheme === 'pq') {
    expectTypeOf(params.envelope).toEqualTypeOf<'hybrid' | 'unreadable'>();
  }
  if (params.method === 'nip44Decrypt' && params.scheme === 'classic') {
    // @ts-expect-error a classic payload has no envelope verdict
    params.envelope;
  }
});

test('an unprepared attestation cannot reach the signing backend', () => {
  // `signPqAttestation` arrives with no params and its event is built before the prompt. The
  // type is what keeps a future path from signing one that was never built or shown.
  // @ts-expect-error the attestation's event is required once params are prepared
  const bare: PreparedParams = { method: 'signPqAttestation' };
  void bare;
  const prepared: PreparedParams = { method: 'signPqAttestation', event: { kind: 10203, content: '', tags: [] } };
  if (prepared.method === 'signPqAttestation') expectTypeOf(prepared.event.tags).toEqualTypeOf<string[][]>();
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

test('the vault dependency is a PORT: a hand-written object satisfies it', () => {
  // The regression this pins. `SignerCoreDeps.vault` was the `Vault` class, whose `#private`
  // field makes the type nominal, so this assignment was `TS2740: … is missing the following
  // properties from type 'Vault': #private, exists, create, unlock, and 21 more` and no host
  // facade could be written at all. If the dependency ever goes back to naming a class, these
  // three lines stop compiling — which a runtime suite cannot notice, since vitest never
  // typechecks a `*.test.ts` file.
  const vault = handWrittenVault(HAND_PRIVKEY);
  const permissions = handWrittenPermissions();
  new SignerCore({
    vault,
    permissions,
    approval: { present: async () => ({ allow: true }), cancel: () => {} },
    activity: { record: async () => {} },
    identity: { getActiveAccount: async () => null },
  });
  expectTypeOf(vault).toExtend<SignerCoreDeps['vault']>();
  expectTypeOf(permissions).toExtend<SignerCoreDeps['permissions']>();
});

test('the concrete Vault and Permissions satisfy the ports they are the reference for', () => {
  // The other direction: the interface is not allowed to drift away from the implementation
  // the packages ship, or every host would be adapting to a contract nothing meets.
  expectTypeOf(new Vault({ store: new MemoryStore() })).toExtend<VaultPort>();
  expectTypeOf(new Permissions(new MemoryStore())).toExtend<PermissionsPort>();
});

test('the port is the smallest set the pipeline uses, so a host owes nothing more', () => {
  // Adding a member here is a breaking change for every host, so the shape is asserted
  // exactly rather than described in a comment that can go stale.
  expectTypeOf<keyof VaultPort>().toEqualTypeOf<
    | 'now'
    | 'isLocked'
    | 'hasMnemonic'
    | 'hasImportedPqKeys'
    | 'withPrivkey'
    | 'withMnemonic'
    | 'withImportedPqKeys'
    | 'withDerivedSecrets'
  >();
  expectTypeOf<keyof PermissionsPort>().toEqualTypeOf<'check' | 'save'>();
  // None of the vault's lifecycle is the pipeline's business.
  expectTypeOf<VaultPort>().not.toHaveProperty('create');
  expectTypeOf<VaultPort>().not.toHaveProperty('unlock');
  expectTypeOf<VaultPort>().not.toHaveProperty('changePassword');
  expectTypeOf<VaultPort>().not.toHaveProperty('addAccount');
});

test('the post-quantum scope takes the port too, not the class', () => {
  const vault = handWrittenVault(HAND_PRIVKEY);
  const account = {} as SafeAccount;
  void withPqKeys(vault, account, async () => undefined);
});
