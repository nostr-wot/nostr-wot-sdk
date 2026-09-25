/**
 * Which stored labels a caller's rules may come from, and the one spelling of an http(s)
 * origin that they are stored under.
 *
 * Permissions were originally keyed by hostname and are now keyed by exact origin. Both
 * shapes exist in stores in the field, so a read has to look at both while a write only
 * ever produces the exact one. Nothing here creates a grant: an origin that has no stored
 * rule under either label still resolves to `ask`.
 *
 * ## Why this parses origins itself
 *
 * A rule stored for `https://example.com` must not be dodged by `https://EXAMPLE.COM`,
 * `https://example.com:443`, `https://user@example.com` or an address written differently.
 * Checking `new URL(x).origin === x` proves that only where `URL` is a WHATWG parser. React
 * Native's `URL` implements `origin`, `protocol` and `hostname` as regex slices of the input,
 * with no lowercasing and no default-port folding, so on the phone every one of those
 * spellings is its own permission key. So the canonical form is computed here, from the
 * grammar of an origin, and nothing in this package consults the host's `URL`.
 */
import type { PermissionBucket, PermissionDecision, PermissionMap } from './types.js';

const DEFAULT_PORT: Record<string, number> = { http: 80, https: 443 };
/** `scheme://authority`, and nothing after the authority: no path, query or fragment. */
const ORIGIN_SHAPE = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)$/;
/** A domain label set as a page reports it: ASCII, already punycoded, a trailing dot allowed. */
const DOMAIN = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*\.?$/;
const IPV4_PART = /^(?:0x[0-9a-f]*|[0-9]+)$/i;

/**
 * A host whose last label is numeric is an IPv4 address and must parse as one, as the URL
 * standard has it: `127.1`, `0x7f.0.0.1`, `0177.0.0.1` and `2130706433` are all
 * `127.0.0.1`, and a host that looks numeric but is not a valid address is refused rather
 * than kept as a name. Returns null when the host is not numeric at all.
 */
function canonicalIpv4(host: string): string | null | false {
  const parts = host.split('.');
  if (parts.length > 1 && parts[parts.length - 1] === '') parts.pop();
  const last = parts[parts.length - 1]!;
  if (!IPV4_PART.test(last)) return null;
  if (parts.length > 4) return false;
  const numbers: number[] = [];
  for (const part of parts) {
    if (!IPV4_PART.test(part)) return false;
    let value: number;
    if (/^0x/i.test(part)) value = part.length === 2 ? 0 : parseInt(part.slice(2), 16);
    else if (part.length > 1 && part.startsWith('0')) {
      if (!/^[0-7]+$/.test(part)) return false;
      value = parseInt(part, 8);
    } else value = parseInt(part, 10);
    if (!Number.isFinite(value)) return false;
    numbers.push(value);
  }
  const tail = numbers.pop()!;
  if (numbers.some((value) => value > 255)) return false;
  if (tail >= 256 ** (4 - numbers.length)) return false;
  let address = tail;
  numbers.forEach((value, index) => {
    address += value * 256 ** (3 - index);
  });
  return [24, 16, 8, 0].map((shift) => Math.floor(address / 2 ** shift) % 256).join('.');
}

/**
 * The bracketed IPv6 form the URL standard produces: lowercase hex, no leading zeros, the
 * longest run of zero groups (of two or more) compressed to `::`, a dotted-quad tail folded
 * into two groups. Anything that is not a valid address is refused.
 */
function canonicalIpv6(inner: string): string | null {
  let text = inner.toLowerCase();
  // A dotted-quad tail becomes its two hex groups before the groups are parsed.
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const quad = canonicalIpv4(dotted[1]!);
    if (!quad) return null;
    const octets = quad.split('.').map(Number);
    const groups = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    text = text.slice(0, text.length - dotted[1]!.length) + groups.map((g) => g.toString(16)).join(':');
  }
  if (!/^[0-9a-f:]+$/.test(text)) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const values: number[] = [];
    for (const group of groups) {
      if (group.length === 0 || group.length > 4) return null;
      values.push(parseInt(group, 16));
    }
    return values;
  };
  const head = parse(halves[0]!);
  const tail = halves.length === 2 ? parse(halves[1]!) : [];
  if (head === null || tail === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null;
    groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
  } else {
    if (head.length !== 8) return null;
    groups = head;
  }
  // Longest zero run of length >= 2, first one wins on a tie.
  let best = { start: -1, length: 0 };
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j += 1;
    if (j - i > best.length && j - i >= 2) best = { start: i, length: j - i };
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best.start < 0) return `[${hex.join(':')}]`;
  const before = hex.slice(0, best.start).join(':');
  const after = hex.slice(best.start + best.length).join(':');
  return `[${before}::${after}]`;
}

/**
 * The one spelling of an http(s) origin, or null when `value` is not one.
 *
 * Accepts exactly `scheme://host[:port]` with an `http` or `https` scheme: the scheme and host
 * are lowercased, a port equal to the scheme's default is dropped and any other is written
 * without leading zeros, an IPv6 address is compressed and an IPv4 address is written as a
 * dotted quad. Refused: credentials (`user@`), a path, query or fragment (even a bare `/`), an
 * empty or malformed host, a port that is empty, non-numeric or above 65535, and any other
 * scheme. A trailing dot on a domain is kept, because a page reports it, and `example.com.`
 * is a different origin from `example.com` in every browser.
 */
export function canonicalHttpOrigin(value: string): string | null {
  const shape = ORIGIN_SHAPE.exec(value);
  if (!shape) return null;
  const scheme = shape[1]!.toLowerCase();
  const defaultPort = DEFAULT_PORT[scheme];
  if (defaultPort === undefined) return null;
  const authority = shape[2]!;
  if (authority.includes('@')) return null;

  let hostText: string;
  let portText: string | undefined;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0) return null;
    hostText = authority.slice(0, close + 1);
    const rest = authority.slice(close + 1);
    if (rest.length > 0) {
      if (!rest.startsWith(':')) return null;
      portText = rest.slice(1);
    }
  } else {
    const colon = authority.indexOf(':');
    hostText = colon < 0 ? authority : authority.slice(0, colon);
    if (colon >= 0) portText = authority.slice(colon + 1);
  }

  let host: string;
  if (hostText.startsWith('[')) {
    const address = canonicalIpv6(hostText.slice(1, -1));
    if (address === null) return null;
    host = address;
  } else {
    const lowered = hostText.toLowerCase();
    if (!DOMAIN.test(lowered)) return null;
    const ipv4 = canonicalIpv4(lowered);
    if (ipv4 === false) return null;
    host = ipv4 ?? lowered;
  }

  let port = '';
  if (portText !== undefined) {
    if (!/^[0-9]{1,5}$/.test(portText)) return null;
    const number = parseInt(portText, 10);
    if (number > 65535) return null;
    if (number !== defaultPort) port = `:${number}`;
  }
  return `${scheme}://${host}${port}`;
}

/**
 * The one spelling of a bare hostname, or null when `value` is not one.
 *
 * The legacy key: lowercased, trailing dots removed (older stores never kept one), an IPv4
 * address written as a dotted quad, and only the characters a hostname a page reports can
 * hold. Anything else — a path, credentials, whitespace, a port, a bracketed address, an
 * empty label — is not a hostname and is refused rather than becoming its own key.
 */
export function canonicalHostname(value: string): string | null {
  const lowered = value.toLowerCase().replace(/\.+$/, '');
  if (lowered.length === 0 || !DOMAIN.test(lowered)) return null;
  const ipv4 = canonicalIpv4(lowered);
  if (ipv4 === false) return null;
  return ipv4 ?? lowered;
}

/** The bare hostname of a canonical origin: what older stores keyed on. */
function hostnameOf(canonical: string): string {
  const authority = canonical.slice(canonical.indexOf('//') + 2);
  if (authority.startsWith('[')) return authority.slice(0, authority.indexOf(']') + 1);
  const colon = authority.indexOf(':');
  return colon < 0 ? authority : authority.slice(0, colon);
}

/**
 * The labels to read for a caller, most specific first.
 *
 * An `http(s)` origin is read under its canonical spelling and, underneath it, its bare
 * hostname, because that is what older versions stored. Anything else — an Android package
 * name, a NIP-46 public key, an internal label — is only ever itself; there is no hostname
 * to fall back to, and a caller label is never parsed into one.
 */
export function siteScopes(origin: string): string[] {
  const canonical = canonicalHttpOrigin(origin);
  if (canonical === null) return [origin];
  return [canonical, hostnameOf(canonical)];
}

/** The label a caller's rules are written under: the canonical origin, or the label itself. */
export function storageLabel(origin: string): string {
  return siteScopes(origin)[0]!;
}

/** Whether any of `origin`'s scopes appears in a stored list of labels. */
export function hasSiteScope(stored: readonly string[], origin: string): boolean {
  return siteScopes(origin).some((scope) => stored.includes(scope));
}

/**
 * The effective bucket for one origin: the legacy hostname rules, then the exact-origin
 * rules layered on top, so an exact-origin edit overrides the same legacy key while
 * unrelated legacy rules survive.
 */
export function originPermissionBucket(
  stored: PermissionMap,
  origin: string,
  bucket: string,
): PermissionBucket {
  const result: PermissionBucket = {};
  for (const scope of siteScopes(origin).reverse()) {
    for (const [key, value] of Object.entries(stored[scope]?.[bucket] ?? {})) {
      result[key] = value as PermissionDecision;
    }
  }
  return result;
}
