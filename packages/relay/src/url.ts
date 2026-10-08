/** Transport policy, separate from URL canonicalization and socket identity. */
export type RelayUrlPolicy = 'wss' | 'local-ws' | 'ws' | 'public-wss';

export interface ParseRelayUrlOptions {
  /** Defaults to encrypted WebSockets; local-ws permits plaintext only on exact loopback hosts. */
  policy?: RelayUrlPolicy;
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

/** Hostname filtering only: DNS resolution and rebinding require connection-layer controls. */
function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.onion') || host === 'host.docker.internal') return false;
  if (host.startsWith('[')) {
    const ip = host.slice(1, -1);
    // URL normalizes IPv6 first, including dotted IPv4-mapped forms.
    if (ip === '::' || ip === '::1' || ip.startsWith('::ffff:')) return false;
    if (/^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]|fe[cdef][0-9a-f]|ff[0-9a-f]{2}):/.test(ip)) return false;
    return true;
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  return true;
}

/**
 * Parse an explicit WebSocket URL without credentials. No scheme inference,
 * query sorting, fragment removal or path folding is applied; callers choose
 * their own canonicalization after validation. Public filtering is a lexical
 * host check, not a complete SSRF defense against DNS or redirects.
 */
export function parseRelayUrl(value: unknown, { policy = 'wss' }: ParseRelayUrlOptions = {}): URL | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  let url: URL;
  try { url = new URL(value.trim()); } catch { return null; }
  if (!url.hostname || url.username || url.password) return null;
  if (url.protocol !== 'wss:') {
    if (url.protocol !== 'ws:') return null;
    if (policy !== 'ws' && !(policy === 'local-ws' && isLoopbackHost(url.hostname))) return null;
  }
  if (policy === 'public-wss' && !isPublicHost(url.hostname)) return null;
  return url;
}

/** Encrypted, credential-free relay URL without local/private literal hosts. */
export function isPublicWssUrl(value: unknown): boolean {
  return parseRelayUrl(value, { policy: 'public-wss' }) !== null;
}
