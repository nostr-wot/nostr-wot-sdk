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
import { ApprovalQueue, SignerCore, type SignerCoreDeps } from '../src/index.js';

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
