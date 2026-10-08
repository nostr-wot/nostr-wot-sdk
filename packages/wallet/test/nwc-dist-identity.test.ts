import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Node loads the real built entrypoints, without Vitest merging source modules. */
describe('published NWC entrypoint identity', () => {
  it.each(['js', 'cjs'])('shares errors and payment outcome checks across the %s surfaces', (extension) => {
    const rootUrl = new URL(`../dist/index.${extension}`, import.meta.url);
    const protocolUrl = new URL(`../dist/nwc/index.${extension}`, import.meta.url);
    expect(existsSync(rootUrl), 'build @nostr-wot/wallet before testing its published surface').toBe(true);
    expect(existsSync(protocolUrl)).toBe(true);
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { fileURLToPath } from 'node:url';
      import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools';
      const require = createRequire(import.meta.url);
      const load = ${JSON.stringify(extension)} === 'cjs'
        ? async (url) => require(fileURLToPath(url))
        : async (url) => import(url);
      const root = await load(${JSON.stringify(rootUrl.href)});
      const protocol = await load(${JSON.stringify(protocolUrl.href)});
      assert.throws(() => new root.NwcClient({
        walletPubkey: 'invalid', relay: 'wss://relay.example', clientSecretKey: new Uint8Array(32).fill(1),
      }), (error) => error instanceof protocol.NwcError && !protocol.mayHavePaid(error));

      const walletKey = generateSecretKey();
      const info = finalizeEvent({ kind: 13194, created_at: 1, tags: [], content: 'get_balance' }, walletKey);
      const pool = {
        querySync: async () => [info],
        subscribeMany: (_relays, _filter, handlers) => {
          queueMicrotask(handlers.oneose);
          return { close() {} };
        },
        publish: () => { throw new Error('delivery uncertain'); },
      };
      const client = new root.NwcClient({
        walletPubkey: getPublicKey(walletKey), relay: 'wss://relay.example', clientSecretKey: generateSecretKey(),
      }, pool);
      await assert.rejects(client.getBalance(), (error) => {
        assert.ok(error instanceof protocol.NwcError);
        assert.equal(error.outcome, 'unknown');
        assert.equal(protocol.mayHavePaid(error), true);
        return true;
      });
      console.log('shared NWC error identity and unknown-payment handling verified');
    `], { encoding: 'utf8', timeout: 10_000 });
    expect(output).toContain('shared NWC error identity');
  });
});
