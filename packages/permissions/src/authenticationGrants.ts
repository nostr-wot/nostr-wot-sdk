/**
 * The stored half of the destination model: remembered consents for authenticating to one
 * destination, as one account, from one site.
 *
 * `Permissions` answers "may this caller sign kind N?". That question has no room for a
 * destination, so a remembered yes to a relay-authentication event is a yes to every relay a
 * caller subsequently names (GHSA-vx4h-56qj-wcp7). This store answers the other question:
 * **this account, this requesting site, this protocol, this destination, this method.** All
 * five, or no match.
 *
 * ## The ordering properties, which are the whole security argument
 *
 * 1. **Deny wins.** A site-specific `deny` beats a shared relay `allow`, because the user
 *    saying "not from this site" is a later and narrower statement than "this relay is fine
 *    generally". Revocation in settings is the way to remove a deny; nothing implicit does.
 * 2. **`*` matches NIP-42 only.** A `connected-sites` grant is stored under the origin `*`,
 *    and the read only honours it for a relay. A relay is shared infrastructure many clients
 *    legitimately connect to on one user's behalf; an HTTP service is not, and a `*` record
 *    for one would be a credential handed to every connected site.
 *    {@link validAuthenticationScope} stops one being created, and this stops a hand-written
 *    or legacy one being honoured. Two guards, because one of them is a data check and the
 *    other is an input check, and only the data check holds for data already on disk.
 * 3. **A queued approval re-checks for a deny after taking the lock.** Two prompts for the
 *    same destination can be open at once, and a rejection can land while an approval sits in
 *    the lock queue with a stale read behind it. Writing that approval back would erase the
 *    rejection. So the deny check happens INSIDE the lock, after the read, and an approval
 *    that finds one refuses rather than overwriting it.
 *
 * ## Divergences from the extension's `services/permissions/authentication.ts`
 *
 * - **The port, not `browser.storage.local`.** Same storage KEY, so an extension migrating
 *   onto this package keeps the consents its users gave.
 * - **A class, not module functions**, because the store is injected rather than global. One
 *   instance per store, and {@link Permissions} owns one so that clearing a site's or an
 *   account's permissions cannot forget to revoke its grants. In the extension those two
 *   modules import each other to achieve the same thing.
 * - **No cache.** `Permissions` caches its tree; this deliberately does not. The tree is read
 *   on nearly every request and its cache is invalidated on every write from anywhere. This
 *   is read at the moment of a signature, where a stale answer is a credential issued after
 *   its consent was withdrawn, and the saving would be one store read.
 * - **An empty account id or origin throws**, as everywhere else in this package: `''` type
 *   checks, means nothing, and would otherwise store a grant nothing can revoke by site.
 * - **The filter origin and the grant origin are canonicalised** through `storageLabel`, so a
 *   host that hands over `https://EXAMPLE.COM` cannot end up with a grant its own revocation
 *   path will not match.
 * - **A stored value that is not an array reads as no grants**, which fails closed: a corrupt
 *   blob authorises nothing rather than throwing into a signing path.
 *
 * From the extension's `6db46fa` ("Bind Nostr authentication permissions to destinations and
 * accounts") and `ecac8ae` ("Simplify authentication review and remember scoped rejections").
 */
import type { KeyValueStore } from '@nostr-wot/storage';
import {
  validAuthenticationScope,
  type AuthenticationGrant,
  type AuthenticationRequest,
  type AuthenticationScope,
} from './authentication.js';
import { AUTHENTICATION_GRANTS_KEY } from './constants.js';
import { AsyncLock } from './lock.js';
import { siteScopes, storageLabel } from './scope.js';

/**
 * The origin a `connected-sites` grant is stored under.
 *
 * Not a wildcard pattern and never matched as one: it is a literal sentinel, compared with
 * `===`, and honoured only for NIP-42. A site cannot be called `*` because
 * {@link canonicalHttpOrigin} refuses it as an origin.
 */
export const SHARED_SITES_ORIGIN = '*';

/** Which grants to remove. An omitted field means "any". An empty filter removes all of them. */
export interface AuthenticationGrantFilter {
  /** One exact grant, by {@link AuthenticationGrant.id}. */
  id?: string;
  accountId?: string;
  /**
   * The requesting site. Matched against each grant's origin through `siteScopes`, so a legacy
   * hostname-keyed grant is found by an exact origin. A `connected-sites` grant is stored under
   * `*`, which is nobody's scope, so disconnecting ONE site does not revoke it: that grant was
   * given for the relay across every connected site and is removed by revoking it directly, by
   * clearing the account, or by passing `*`.
   */
  origin?: string;
}

/** Guards the empty string, which type checks everywhere a label is wanted and means nothing. */
function requireLabel(value: string, what: string): string {
  if (value === '') {
    throw new Error(`${what} must not be empty: an empty label is a caller bug, not a wildcard`);
  }
  return value;
}

/**
 * Every grant that governs this request, which is the only place the matching rule is written.
 *
 * All five fields, or no match: account, protocol, destination, method and origin. The `method`
 * comparison is `===` on two possibly-undefined values, which is exactly right — NIP-42 has no
 * method, so undefined matches undefined, and a NIP-98 `GET` consent does not answer a `DELETE`.
 */
function governing(
  grants: readonly AuthenticationGrant[],
  accountId: string,
  origin: string,
  auth: AuthenticationRequest,
): AuthenticationGrant[] {
  return grants.filter(
    (grant) =>
      grant.accountId === accountId &&
      grant.protocol === auth.protocol &&
      grant.destination === auth.destination &&
      grant.method === auth.method &&
      (grant.origin === origin ||
        (auth.protocol === 'nip42' && grant.origin === SHARED_SITES_ORIGIN)),
  );
}

/** The stable identity of a grant: the five fields it is keyed by, so a re-save replaces it. */
function grantId(
  accountId: string,
  origin: string,
  auth: AuthenticationRequest,
): string {
  return JSON.stringify([accountId, origin, auth.protocol, auth.destination, auth.method ?? '']);
}

/** Remembered consents for authenticating to a destination, over an injected store. */
export class AuthenticationGrants {
  readonly #store: KeyValueStore;
  readonly #lock = new AsyncLock();

  constructor(store: KeyValueStore) {
    this.#store = store;
  }

  /** Every stored grant. For a settings screen; the gate uses {@link decisionFor}. */
  async list(): Promise<AuthenticationGrant[]> {
    const stored = await this.#store.get<AuthenticationGrant[]>(AUTHENTICATION_GRANTS_KEY);
    // Fails closed: anything that is not an array authorises nothing, rather than throwing
    // into a signing path where the caller cannot tell a corrupt store from a refusal.
    return Array.isArray(stored) ? stored : [];
  }

  /**
   * What the user has said about this exact request: `allow`, `deny`, or `undefined` for
   * nothing said yet.
   *
   * Deny wins over every allow, including a shared relay one. `undefined` on a grant's
   * `decision` means allow, which is what records written before rejections were rememberable
   * look like.
   */
  async decisionFor(
    accountId: string,
    origin: string,
    auth: AuthenticationRequest,
  ): Promise<'allow' | 'deny' | undefined> {
    const matching = governing(await this.list(), accountId, storageLabel(origin), auth);
    // A site-specific rejection takes precedence over a shared relay allowance.
    if (matching.some((grant) => grant.decision === 'deny')) return 'deny';
    if (matching.some((grant) => grant.decision === undefined || grant.decision === 'allow')) {
      return 'allow';
    }
    return undefined;
  }

  /** Whether this request may proceed without asking. Never true while any deny matches. */
  async isAllowed(
    accountId: string,
    origin: string,
    auth: AuthenticationRequest,
  ): Promise<boolean> {
    return (await this.decisionFor(accountId, origin, auth)) === 'allow';
  }

  /**
   * Record a decision, or, for `once`, record nothing while still honouring a standing deny.
   *
   * @param assertCurrent - re-checked INSIDE the lock, after the read. The host's chance to
   *   throw when the account, session or pending request the consent belongs to has moved on
   *   while this waited. Required, not optional with a no-op default: a caller that has not
   *   thought about it is the caller this parameter exists for.
   * @throws when the scope is not one this request could have (see
   *   {@link validAuthenticationScope}), when a denial is asked for at any scope but `site`,
   *   or when an allow finds a deny already in force.
   */
  async save(
    accountId: string,
    origin: string,
    auth: AuthenticationRequest,
    scope: AuthenticationScope,
    assertCurrent: () => void,
    decision: 'allow' | 'deny' = 'allow',
  ): Promise<void> {
    requireLabel(accountId, 'account id');
    requireLabel(origin, 'origin');
    if (!validAuthenticationScope(auth, scope)) throw new Error('Invalid authentication scope');
    // A remembered rejection is per site and nothing else. `once` has nothing to remember, and
    // a shared-sites deny would be a refusal the user never made for sites they never visited.
    if (decision === 'deny' && scope !== 'site') {
      throw new Error('Invalid authentication denial scope');
    }
    const label = storageLabel(origin);
    const shared = scope === 'connected-sites';
    const grantOrigin = shared ? SHARED_SITES_ORIGIN : label;

    await this.#lock.run(async () => {
      const grants = await this.list();
      assertCurrent();
      // A queued approval must not erase a rejection saved while it waited for this lock.
      // Revocation in settings is the explicit way to remove a deny. Checked for `once` too:
      // it stores nothing, but it still authorises this one signature, and a deny refuses it.
      if (
        decision === 'allow' &&
        governing(grants, accountId, label, auth).some((grant) => grant.decision === 'deny')
      ) {
        throw new Error('Authentication permission denied');
      }
      if (scope === 'once') return;

      const grant: AuthenticationGrant = {
        decision,
        accountId,
        origin: grantOrigin,
        protocol: auth.protocol,
        destination: auth.destination,
        ...(auth.method ? { method: auth.method } : {}),
        id: grantId(accountId, grantOrigin, auth),
      };
      await this.#store.set(AUTHENTICATION_GRANTS_KEY, [
        ...grants.filter((item) => item.id !== grant.id),
        grant,
      ]);
    });
  }

  /**
   * Remove every grant the filter matches. An empty filter removes all of them, which is what
   * "forget every remembered decision" means.
   */
  async revoke(filter: AuthenticationGrantFilter = {}): Promise<void> {
    const origin = filter.origin === undefined ? undefined : storageLabel(filter.origin);
    await this.#lock.run(async () => {
      const grants = await this.list();
      await this.#store.set(
        AUTHENTICATION_GRANTS_KEY,
        grants.filter(
          (grant) =>
            !(
              (!filter.id || grant.id === filter.id) &&
              (!filter.accountId || grant.accountId === filter.accountId) &&
              (!origin || siteScopes(grant.origin).includes(origin))
            ),
        ),
      );
    });
  }
}
