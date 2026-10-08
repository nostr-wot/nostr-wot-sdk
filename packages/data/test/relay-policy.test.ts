import { describe, expect, it } from 'vitest';
import type { Event } from 'nostr-tools';
import { isPublicWssUrl, parseRelayList } from '../src/parsers/kind10002';

const event = { pubkey: 'author', tags: [['r', 'wss://relay.example'], ['r', 'wss://[::1]'], ['r', 'wss://user:pw@relay.example'], ['r', 'ws://localhost']] } as Event;

describe('data public relay policy compatibility', () => {
  it('retains the existing export and applies shared policy to public lists', () => {
    expect(isPublicWssUrl('wss://relay.example')).toBe(true);
    expect(parseRelayList(event, 'public').read).toEqual(['wss://relay.example']);
  });
  it('preserves permissive all-mode parsing rather than silently changing published data', () => {
    expect(parseRelayList(event).read).toHaveLength(4);
  });
});
