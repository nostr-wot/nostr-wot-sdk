/**
 * The account record every `@nostr-wot` host stores, and the public projection of it.
 *
 * Ported from the browser extension's `src/domain/accounts/types.ts`. The one field left
 * behind is `walletConfig`: it types against the extension's wallet domain, which this
 * layer must not depend on. It comes back when the wallet package exists.
 */

// ── Accounts ──

export type AccountType = 'generated' | 'nsec' | 'npub' | 'nip46' | 'external';

export interface Nip46Config {
  bunkerUrl: string;
  relay: string | null;
  secret: string | null;
  localPrivkey?: string;
  localPubkey?: string;
}

/**
 * Post-quantum keys imported from outside, for an account that cannot derive its own.
 *
 * Only ever set on accounts with no 24-word mnemonic. Unlike derived keys these are NOT
 * recoverable from the seed phrase — they are independent secrets the user must back up
 * separately, which is why the UI says so persistently rather than once.
 *
 * All four values are base64. The two `secret` halves are key material: this type must
 * stay out of `SafeAccount`.
 */
export interface PqImportedKeys {
  /** Derivation profile the key file declared, e.g. "nip-pqc/v1". */
  profile: string;
  kem: { public: string; secret: string };
  dsa: { public: string; secret: string };
  importedAt: number;
}

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  pubkey: string;
  privkey: string | null;
  mnemonic: string | null;
  nip46Config: Nip46Config | null;
  readOnly: boolean;
  createdAt: number;
  derivationIndex?: number;
  /** Canonical BIP-32 path required to restore this identity from its seed. */
  derivationPath?: string;
  /** Imported post-quantum keys. Absent when the account derives them from its seed. */
  pqKeys?: PqImportedKeys | null;
}

/** Explicit public metadata allowlist. New Account fields are private by default. */
export type SafeAccount = Pick<
  Account,
  'id' | 'name' | 'type' | 'pubkey' | 'readOnly' | 'createdAt' | 'derivationIndex' | 'derivationPath'
>;

/**
 * Copy only the documented public fields.
 *
 * The type alone is a promise; this is the enforcement. Spreading an `Account` into a
 * response is what leaks `privkey` and `mnemonic`, so every boundary goes through here.
 */
export function toSafeAccount(account: SafeAccount): SafeAccount {
  return {
    id: account.id,
    name: account.name,
    type: account.type,
    pubkey: account.pubkey,
    readOnly: account.readOnly,
    createdAt: account.createdAt,
    ...(account.derivationIndex !== undefined ? { derivationIndex: account.derivationIndex } : {}),
    ...(account.derivationPath !== undefined ? { derivationPath: account.derivationPath } : {}),
  };
}
