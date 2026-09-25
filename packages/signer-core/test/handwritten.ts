/**
 * Ports written by hand, against the interfaces and nothing else.
 *
 * The proof that {@link VaultPort} and {@link PermissionsPort} are ports rather than aliases
 * for two concrete classes. Nothing here imports `Vault`, `Permissions` or `MemoryStore`; if
 * any of it stopped compiling, `SignerCoreDeps` would have gone back to demanding a class and
 * a host would again be unable to adapt (see `src/ports.ts` for the TS2740 that is the point).
 *
 * Used twice on purpose. `contracts.test-d.ts` typechecks it — which is the half that actually
 * catches a nominal type coming back, since a runtime suite never sees the types at all.
 * `adaptability.test.ts` drives it through a real signing request — which is the half that
 * catches a port whose members compile but whose contract the pipeline cannot work with.
 */
import { getPublicKey } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';
import { toSafeAccount, type Account, type SafeAccount } from '@nostr-wot/accounts';
import type { PermissionDecision } from '@nostr-wot/permissions';
import type { PermissionsPort, VaultPort } from '../src/index.js';

export const HAND_PRIVKEY = 'cd'.repeat(32);
export const HAND_PUBKEY = getPublicKey(hexToBytes(HAND_PRIVKEY));
/** A fixed clock, so an assertion on `created_at` can name the second it expects. */
export const HAND_NOW = 1_700_000_000_000;

const handAccount: Account = {
  id: 'hand_written_1',
  name: 'hand written',
  type: 'generated',
  pubkey: HAND_PUBKEY,
  privkey: HAND_PRIVKEY,
  mnemonic: null,
  nip46Config: null,
  readOnly: false,
  createdAt: 1,
};

export const HAND_ACCOUNT: SafeAccount = toSafeAccount(handAccount);

/**
 * A vault in thirty lines, implementing {@link VaultPort} and nothing else.
 *
 * The shape a host adapter has: some key material it already holds, a lock flag, and the
 * scoped accessors. It deliberately implements none of `create`, `unlock`, `exists`,
 * `addAccount`, `changePassword` or the twenty-odd other members of the real `Vault` — that is
 * what "the core asks for what it uses" means, and what the class-typed dependency made
 * impossible.
 */
export function handWrittenVault(privkey: string): VaultPort & { locked: boolean } {
  const port = {
    locked: false,
    now: () => HAND_NOW,
    isLocked: () => port.locked,
    hasMnemonic: () => false,
    hasImportedPqKeys: () => false,
    async withPrivkey<T>(_accountId: string, fn: (key: Uint8Array) => Promise<T>): Promise<T> {
      if (port.locked) throw new Error('Vault is locked');
      const key = hexToBytes(privkey);
      try {
        return await fn(key);
      } finally {
        key.fill(0);
      }
    },
    async withMnemonic<T>(_accountId: string, _fn: (phrase: Uint8Array) => Promise<T>): Promise<T> {
      throw new Error('No seed phrase for this account');
    },
    async withImportedPqKeys<T>(_accountId: string, _fn: (keys: never) => Promise<T>): Promise<T> {
      throw new Error('No imported post-quantum keys for this account');
    },
    async withDerivedSecrets<T>(secrets: readonly Uint8Array[], fn: () => Promise<T>): Promise<T> {
      try {
        return await fn();
      } finally {
        for (const secret of secrets) secret.fill(0);
      }
    },
  };
  return port as VaultPort & { locked: boolean };
}

/** A permission store in a dozen lines, implementing {@link PermissionsPort} and nothing else. */
export function handWrittenPermissions(): PermissionsPort & { written: string[] } {
  const bucket = new Map<string, PermissionDecision>();
  const written: string[] = [];
  const at = (origin: string, method: string, kind: unknown, accountId: string): string =>
    `${accountId}|${origin}|${method}|${kind ?? ''}`;
  const port: PermissionsPort & { written: string[] } = {
    written,
    async check(origin, method, kind, accountId) {
      return bucket.get(at(origin, method, kind, accountId)) ?? 'ask';
    },
    async save(origin, method, kind, decision, accountId) {
      const key = at(origin, method, kind, accountId);
      written.push(`${key}=${decision}`);
      bucket.set(key, decision);
    },
  };
  return port;
}
