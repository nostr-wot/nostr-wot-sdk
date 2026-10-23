/**
 * Resolve a passkey without inventing an identity. Tagged modes are never second-guessed and a
 * 32-byte handle requires legacy recovery. Unknown handles need explicit exclusive deployment
 * knowledge, a remembered derived account, or user confirmation; relay data cannot establish them.
 */
import { validPasskeyRpId, type PasskeyVaultRecord } from './passkey.js';
import { DEFAULT_DERIVED_PARAMETER_SET, classifyPasskeyHandle, derivedPrfInput, deriveNostrKey, type DerivedParameterSet } from './passkey-modes.js';
import { findStoredRecords, openStoredRecords, storedPrfInput, type StoredPayload, type StoredRecordCandidate } from './passkey-store.js';
import {
  assertionHandle, findStoredRecovery, openStoredRecovery, RECOVERY_PRF_INPUT,
  type PasskeyAssertionResult, type RecoveryContext, type RecoveryEvent, type RecoveryPorts, type RecoveryScope, type RecoveryVerifier, type StoredLookup,
} from './recovery.js';

export type PasskeyIdentityError =
  /** Stored passkey whose record is on neither the provider nor the relays. */
  | 'missing-record'
  /** The newest stored record does not open with this passkey. Never rolled back to an older one. */
  | 'undecryptable-record'
  /** The record opened, but its author is not one of the keys it holds. */
  | 'author-mismatch'
  /** An untagged passkey whose largeBlob holds a tagged-format record: stored, but unreadable without the author only a tagged handle names. */
  | 'unreadable-record'
  /** An unsupported NPK handle, a derived parameter set the host does not implement, or legacy key-in-handle. */
  | 'unsupported-handle'
  /** The platform returned no usable PRF output, even on a targeted assertion. */
  | 'prf-unavailable'
  /** No credential ID in the assertion. */
  | 'invalid-assertion';

export type PasskeyIdentity =
  /** Caller owns `secret` and MUST zero it after use. */
  | { mode: 'derived'; credentialId: string; parameterSet: DerivedParameterSet; pubkey: string; secret: Uint8Array }
  /** Tagged-format record. The author is already checked against the payload. Caller zeroes a `key` payload. */
  | { mode: 'stored'; format: 'npk1'; source: 'passkey' | 'relays'; credentialId: string; author: string; payload: StoredPayload; event?: RecoveryEvent }
  /** Legacy record, exactly as `restoreRecovery` returns it. Caller owns, validates and zeroes `payload`. */
  | { mode: 'stored'; format: 'legacy'; source: 'passkey' | 'relays'; credentialId: string; payload: Uint8Array; context: RecoveryContext; event: RecoveryEvent }
  /** A largeBlob vault envelope (`PASSKEY_BACKUP_FORMAT`); open it with `openPasskeyRecord` and the PRF for its `prfSalt`. */
  | { mode: 'stored'; format: 'legacy'; source: 'passkey-vault'; credentialId: string; record: PasskeyVaultRecord }
  /** Show `pubkey` and ask the user; only after a yes call `derivePasskeyIdentity`. No secret is returned. */
  | { mode: 'ambiguous'; credentialId: string; parameterSet: DerivedParameterSet; pubkey: string }
  | { mode: 'error'; credentialId?: string; reason: PasskeyIdentityError; message: string };

export interface ResolvePasskeyIdentityOptions extends Omit<RecoveryPorts, 'relays'> {
  rpId: string;
  verify: RecoveryVerifier;
  /** Recovery relays. Optional here: without them only the provider blob is searched. */
  relays?: readonly string[];
  /**
   * Host configuration: the derived parameter set `rpId` is known to use, from the registry or the
   * host's own deployment. It is evaluated as `prf.eval.second`, a tagged handle naming it is
   * implemented. This alone does not authorize deriving an unknown credential. Without it,
   * `second` uses `0x01`; unknown handles require separate identity evidence or confirmation.
   */
  parameterSet?: DerivedParameterSet;
  /** True only when this deployment created every untagged credential as derived and RP association files list only its apps. */
  exclusiveDerivedDeployment?: boolean;
  /** The app's own record linking this credential to a derived public key (discovery step 3). */
  isKnownDerived?: (candidate: { credentialId: string; pubkey: string; parameterSet: DerivedParameterSet }) => boolean | Promise<boolean>;
  /** Reports a candidate that failed to open, including a relay record that may have been tampered with. */
  onRecoveryFailure?: (failure: { source: 'passkey' | 'relays'; author: string; error: unknown }) => void;
  /** Legacy records only: restrict the v4 scope or schema. */
  scope?: RecoveryScope;
  schema?: string;
}

const PRF_BYTES = 32;
const err = (credentialId: string, reason: PasskeyIdentityError, message: string): PasskeyIdentity => ({ mode: 'error', credentialId, reason, message });
const NEWER_APP = 'This passkey was made by a newer or different app';

type Output = 'stored' | 'legacy' | DerivedParameterSet;

/**
 * Log in with a discoverable passkey: one assertion evaluating the tagged stored input (`first`)
 * and a derived input (`second`) and reading the blob, then at most one targeted follow-up for what
 * the handle needs: the legacy input for a 32-byte handle, another parameter set, or outputs the
 * platform dropped on discoverable login. Every PRF output the provider returns is zeroed before
 * this resolves; only a `derived` result hands a secret to the caller. Provider failures and
 * cancellation reject.
 */
export async function resolvePasskeyIdentity(options: ResolvePasskeyIdentityOptions): Promise<PasskeyIdentity> {
  if (!validPasskeyRpId(options.rpId)) throw new Error('Invalid passkey RP');
  const known = options.parameterSet;
  const evaluated = known ?? DEFAULT_DERIVED_PARAMETER_SET;
  const loginInputs = { first: storedPrfInput(), second: derivedPrfInput(evaluated) }; // Throws on an invalid configured set.
  const { provider, rpId } = options;
  const outputs: Uint8Array[] = [];
  const keep = (assertion: PasskeyAssertionResult | undefined) => {
    for (const output of [assertion?.prf?.first, assertion?.prf?.second]) if (output instanceof Uint8Array) outputs.push(output);
    return assertion;
  };
  const usable = (output: Uint8Array | undefined) => output instanceof Uint8Array && output.length === PRF_BYTES ? output : undefined;
  try {
    const login = keep(await provider.discover({ rpId, prf: loginInputs, largeBlob: true }));
    const credentialId = login?.credentialId;
    if (typeof credentialId !== 'string' || !credentialId) return { mode: 'error', reason: 'invalid-assertion', message: 'The passkey returned no credential' };
    const kind = classifyPasskeyHandle(assertionHandle(login));
    // An assertion with no PRF results at all means the platform ignored the extensions on a
    // discoverable login, so whatever it left out has to be asked for again.
    const dropped = !login.prf;
    const prf: { stored?: Uint8Array; legacy?: Uint8Array; derived?: Uint8Array } = { stored: usable(login.prf?.first), derived: usable(login.prf?.second) };
    let blob = login.blob;

    /** One targeted assertion with up to two inputs; without `assert`, one `authenticate` per input. */
    const followUp = async (needs: Output[], largeBlob = false) => {
      const input = (need: Output) => need === 'stored' ? storedPrfInput() : need === 'legacy' ? new TextEncoder().encode(RECOVERY_PRF_INPUT) : derivedPrfInput(need);
      const store = (need: Output, output: Uint8Array | undefined) => {
        const value = usable(output);
        if (!value) return;
        if (need === 'stored') prf.stored = value; else if (need === 'legacy') prf.legacy = value; else prf.derived = value;
      };
      if (provider.assert) {
        const result = keep(await provider.assert({ rpId, credentialId, prf: { first: input(needs[0]), ...(needs[1] !== undefined ? { second: input(needs[1]) } : {}) }, ...(largeBlob ? { largeBlob: true } : {}) }));
        store(needs[0], result?.prf?.first);
        if (needs[1] !== undefined) store(needs[1], result?.prf?.second);
        if (largeBlob && result?.blob?.length) blob = result.blob;
        return;
      }
      for (const need of needs) { const output = await provider.authenticate({ credentialId, rpId, prfInput: input(need) }); outputs.push(output); store(need, output); }
    };
    /** Open tagged-format candidates with the tagged stored output. */
    const openTagged = async (candidates: StoredRecordCandidate[], author?: string): Promise<PasskeyIdentity | null> => {
      if (!prf.stored) await followUp(['stored']);
      if (!prf.stored) return err(credentialId, 'prf-unavailable', 'This passkey did not return a PRF result');
      options.assertSession?.();
      let opened: ReturnType<typeof openStoredRecords>;
      try { opened = openStoredRecords(candidates, prf.stored, { credentialId, rpId, author, onFailure: options.onRecoveryFailure }); }
      catch { return err(credentialId, 'author-mismatch', 'The stored record does not hold the key of its author'); }
      return opened && { mode: 'stored', format: 'npk1', source: opened.source, credentialId, author: opened.author, payload: opened.payload, ...(opened.event ? { event: opened.event } : {}) };
    };
    /** Open legacy events with the legacy output, asked for only now that a record exists. */
    const openLegacy = async (events: RecoveryEvent[], source: 'passkey' | 'relays', lookup: StoredLookup): Promise<PasskeyIdentity | null> => {
      if (!prf.legacy) await followUp(['legacy']);
      if (!prf.legacy) return err(credentialId, 'prf-unavailable', 'This passkey did not return a PRF result');
      options.assertSession?.();
      const opened = openStoredRecovery(events, prf.legacy, lookup);
      return opened && { mode: 'stored', format: 'legacy', source, credentialId, ...opened };
    };
    const ports = { ...options, relays: options.relays ?? [] };

    if (kind.mode === 'unsupported') return err(credentialId, 'unsupported-handle', NEWER_APP);
    if (kind.mode === 'derived') {
      // The handle states derived mode: the blob and the stored output are ignored, and an
      // unimplemented parameter set is refused rather than guessed past.
      const set = [evaluated, DEFAULT_DERIVED_PARAMETER_SET].find(candidate => candidate.id === kind.parameterSet);
      if (!set) return err(credentialId, 'unsupported-handle', NEWER_APP);
      if (set !== evaluated || !prf.derived) { prf.derived = undefined; await followUp([set]); }
      if (!prf.derived) return err(credentialId, 'prf-unavailable', 'This passkey did not return a PRF result');
      const key = deriveNostrKey(prf.derived, set);
      return { mode: 'derived', credentialId, parameterSet: set, pubkey: key.pubkey, secret: key.secret };
    }
    if (kind.mode === 'stored' && !('author' in kind)) return err(credentialId, 'unsupported-handle', 'Key-in-handle passkeys are not supported');
    if (kind.mode === 'stored' && !('confirmRecord' in kind)) {
      // Tagged stored. The derived output is ignored: a stored passkey never yields a derived identity.
      if (dropped && provider.assert) await followUp(['stored'], true);
      const candidates = await findStoredRecords(ports, { credentialId, rpId, author: kind.author, blob, verify: options.verify });
      if (!candidates.length) return err(credentialId, 'missing-record', "This passkey's key could not be found");
      return await openTagged(candidates, kind.author) ?? err(credentialId, 'undecryptable-record', 'The stored key for this passkey could not be decrypted');
    }

    const unknownLookup: StoredLookup = { credentialId, rpId, strict: false, scope: options.scope, schema: options.schema, verify: options.verify };
    if (kind.mode === 'stored') {
      // 32 bytes: probably a legacy stored handle. Confirm it with a legacy record for that author;
      // with none, report missing recovery data without deriving.
      if (dropped && provider.assert) await followUp(['legacy'], true);
      const lookup = { ...unknownLookup, author: kind.author };
      const found = await findStoredRecovery(ports, { ...lookup, blob });
      if (found.kind === 'passkey-vault') return { mode: 'stored', format: 'legacy', source: 'passkey-vault', credentialId, record: found.record };
      if (found.kind === 'events') return await openLegacy(found.events, found.source, lookup) ?? err(credentialId, 'undecryptable-record', 'The stored key for this passkey could not be decrypted');
      return err(credentialId, 'missing-record', "This passkey's key could not be found");
    }

    // Unknown handle: discovery, in order.
    if (dropped || !prf.stored || !prf.derived) await followUp(['stored', evaluated], true);
    // Unknown credentials have no trusted author: relay events cannot establish their identity.
    // Legacy recovery remains available through the explicit restoreRecovery API.
    if (blob?.length && !options.exclusiveDerivedDeployment) return err(credentialId, 'unreadable-record', 'This passkey holds data that cannot be opened');
    // 3 and 4.
    if (!prf.derived) return err(credentialId, 'prf-unavailable', 'This passkey did not return a PRF result');
    const candidate = deriveNostrKey(prf.derived, evaluated);
    let adopt = false;
    try {
      adopt = options.exclusiveDerivedDeployment === true || !!await options.isKnownDerived?.({ credentialId, pubkey: candidate.pubkey, parameterSet: evaluated });
    } finally { if (!adopt) candidate.secret.fill(0); }
    if (adopt) return { mode: 'derived', credentialId, parameterSet: evaluated, pubkey: candidate.pubkey, secret: candidate.secret };
    return { mode: 'ambiguous', credentialId, parameterSet: evaluated, pubkey: candidate.pubkey };
  } finally {
    for (const output of outputs) output.fill(0);
  }
}

/**
 * After the user confirmed an `ambiguous` result: one targeted assertion that reproduces exactly
 * that candidate. A different key (wrong credential or parameter set) is zeroed and rejected.
 * Caller owns the returned secret and MUST zero it after use.
 */
export async function derivePasskeyIdentity(options: { provider: RecoveryPorts['provider']; rpId: string; credentialId: string; parameterSet: DerivedParameterSet; expectedPubkey: string }): Promise<{ pubkey: string; secret: Uint8Array }> {
  if (!validPasskeyRpId(options.rpId)) throw new Error('Invalid passkey RP');
  if (!/^[a-f0-9]{64}$/.test(options.expectedPubkey)) throw new Error('Invalid expected public key');
  const output = await options.provider.authenticate({ credentialId: options.credentialId, rpId: options.rpId, prfInput: derivedPrfInput(options.parameterSet) });
  try {
    const key = deriveNostrKey(output, options.parameterSet);
    if (key.pubkey !== options.expectedPubkey) { key.secret.fill(0); throw new Error('Passkey did not reproduce the confirmed identity'); }
    return key;
  } finally { output.fill(0); }
}
