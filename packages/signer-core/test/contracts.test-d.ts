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
  type SignerErrorCode,
  type UnlockPort,
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
