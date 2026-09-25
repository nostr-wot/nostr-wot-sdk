/**
 * The port is a port: a hand-written object satisfies it and drives a real request.
 *
 * This file exists because of a concrete failure. `SignerCoreDeps.vault` was typed as the
 * `Vault` CLASS, and `Vault` carries `#private` fields, which makes its type NOMINAL in
 * TypeScript: nothing structurally identical can stand in for it. A host trying to adopt this
 * package behind its own vault facade got
 *
 *     error TS2740: Type '{ isLocked(): boolean; withPrivkey<T>(…): Promise<T>; … }' is
 *       missing the following properties from type 'Vault': #private, exists, create, …
 *
 * and signer-core became unreachable. A ports-and-adapters boundary whose port is a concrete
 * class has no port at all.
 *
 * The objects come from `handwritten.ts`, which imports no `Vault`, no `Permissions` and no
 * `MemoryStore`. **The compile-time half of this proof is in `contracts.test-d.ts`**, and it is
 * the half that matters for the nominal-type problem: a vitest run never typechecks a
 * `*.test.ts` file, so this suite would go on passing if `SignerCoreDeps` went back to
 * demanding a class. What it adds is that the hand-written objects are enough to actually
 * produce a signature — verified with `nostr-tools`, through the whole pipeline.
 */
import { describe, expect, test } from 'vitest';
import { verifyEvent, type Event } from 'nostr-tools';
import {
  SignerCore,
  type ActivityEntry,
  type SignerCoreDeps,
  type SignerRequest,
} from '../src/index.js';
import {
  HAND_ACCOUNT,
  HAND_NOW,
  HAND_PRIVKEY,
  HAND_PUBKEY,
  handWrittenPermissions,
  handWrittenVault,
} from './handwritten.js';

function request(): SignerRequest {
  return {
    id: `req_hand_${Math.random().toString(36).slice(2)}`,
    origin: { kind: 'web', identifier: 'example.com' },
    method: 'signEvent',
    params: { event: { kind: 1, content: 'signed through a hand-written port', tags: [] } },
    receivedAt: HAND_NOW,
  };
}

function coreOver(overrides: Partial<SignerCoreDeps> = {}) {
  const entries: ActivityEntry[] = [];
  const vault = handWrittenVault(HAND_PRIVKEY);
  const core = new SignerCore({
    vault,
    permissions: handWrittenPermissions(),
    approval: { present: async () => ({ allow: true }), cancel: () => {} },
    activity: { record: async (entry) => void entries.push(entry) },
    identity: { getActiveAccount: async () => HAND_ACCOUNT },
    ...overrides,
  });
  return { core, vault, entries };
}

describe('a hand-written adapter satisfies the core', () => {
  test('SignerCore accepts objects that are neither Vault nor Permissions, and signs', async () => {
    const { core, entries } = coreOver();
    try {
      const signed = (await core.handle(request())) as Event;
      expect(verifyEvent(signed)).toBe(true);
      expect(signed.pubkey).toBe(HAND_PUBKEY);
      expect(signed.content).toBe('signed through a hand-written port');
      expect(entries.map((entry) => entry.decision)).toEqual(['allow']);
    } finally {
      core.dispose();
    }
  });

  test('the core reads the clock the hand-written port supplies, not one of its own', async () => {
    const { core } = coreOver();
    try {
      const signed = (await core.handle(request())) as Event;
      expect(signed.created_at).toBe(Math.floor(HAND_NOW / 1000));
    } finally {
      core.dispose();
    }
  });

  test('a locked hand-written vault refuses through the same path a real one does', async () => {
    const { core, vault } = coreOver();
    vault.locked = true;
    try {
      await expect(core.handle(request())).rejects.toMatchObject({ code: 'vault_locked' });
    } finally {
      core.dispose();
    }
  });

  test('a remembered approval is written through the hand-written permission port', async () => {
    const permissions = handWrittenPermissions();
    const { core } = coreOver({
      permissions,
      approval: { present: async () => ({ allow: true, remember: true }), cancel: () => {} },
    });
    try {
      await core.handle(request());
      expect(permissions.written).toEqual(['hand_written_1|example.com|signEvent|1=allow']);
      // And the stored decision is what the next request reads, so the prompt is not shown twice.
      expect(await permissions.check('example.com', 'signEvent', 1, 'hand_written_1')).toBe('allow');
    } finally {
      core.dispose();
    }
  });
});
