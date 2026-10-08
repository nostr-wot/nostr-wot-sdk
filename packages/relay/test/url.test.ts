import { describe, expect, it } from 'vitest';
import { isPublicWssUrl, parseRelayUrl } from '../src/url';

describe('parseRelayUrl', () => {
  it.each([null, 42, '', 'relay.example', 'invalid url', 'https://relay.example', 'wss://user@relay.example', 'wss://user:pw@relay.example'])('rejects malformed, non-WebSocket or credentialed input %s', (input) => {
    for (const policy of ['wss', 'local-ws', 'ws', 'public-wss'] as const) expect(parseRelayUrl(input, { policy })).toBeNull();
  });

  it('defaults to wss without changing path, query order, or fragment', () => {
    expect(parseRelayUrl(' WSS://Relay.Example:443/Path//?b=1&a=2#fragment ')?.toString()).toBe('wss://relay.example/Path//?b=1&a=2#fragment');
    expect(parseRelayUrl('ws://localhost')).toBeNull();
    expect(parseRelayUrl('wss://localhost')).not.toBeNull();
  });

  it('permits only exact loopback hosts for local plaintext WebSockets', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) expect(parseRelayUrl(`ws://${host}:7777`, { policy: 'local-ws' })).not.toBeNull();
    for (const host of ['relay.example', 'sub.localhost', 'localhost.', '127.0.0.2', '192.168.1.1', '[::ffff:127.0.0.1]']) expect(parseRelayUrl(`ws://${host}`, { policy: 'local-ws' })).toBeNull();
    expect(parseRelayUrl('ws://relay.example', { policy: 'ws' })).not.toBeNull();
  });
});

describe('public relay filtering', () => {
  it.each(['localhost', 'localhost.', 'dev.localhost', 'relay.local', 'host.docker.internal', 'abc.onion', '127.0.0.1', '127.1', '2130706433', '0x7f000001', '10.1.2.3', '192.168.0.1', '169.254.1.1', '172.16.0.1', '172.31.9.9', '0.0.0.0', '100.64.0.1', '224.0.0.1', '[::]', '[::1]', '[fe80::1]', '[febf::1]', '[fc00::1]', '[fd00::1]', '[fec0::1]', '[ff02::1]', '[::ffff:127.0.0.1]'])('rejects local/private host %s', (host) => {
    expect(isPublicWssUrl(`wss://${host}`)).toBe(false);
  });
  it('allows public addresses but requires wss and no credentials', () => {
    for (const host of ['relay.example', '172.32.0.1', '1.1.1.1', '[2606:4700:4700::1111]']) expect(isPublicWssUrl(`wss://${host}/relay`)).toBe(true);
    expect(isPublicWssUrl('ws://relay.example')).toBe(false);
    expect(isPublicWssUrl('wss://user:pw@relay.example')).toBe(false);
  });
});
