import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WoT } from '../src/wot';
import { NetworkError, NotFoundError } from '../src/errors';
import { ORACLE_MAX_BATCH_TARGETS, ORACLE_MAX_HOPS } from '../src/utils';

/**
 * Every expectation in this file is taken from nostr-wot-oracle: the `docs/API.md`
 * endpoint table and the `DistanceQueryParams` / `BatchDistanceRequest` /
 * `bfs::DistanceResult` definitions in `src/api/http.rs` and `src/graph/bfs.rs`.
 * Nothing here is inferred from what this client used to send.
 *
 * `https://wot-oracle.mappingbitcoin.com`, this package's `DEFAULT_ORACLE`, answers
 * `GET /` with `{"service":"nostr-wot-oracle","version":"0.3.1",...}`, so that
 * contract is the one the default host speaks.
 *
 * Each case fails against the spelling this client used before, and asserts what
 * that spelling produced, because a field the oracle does not send reads as
 * `undefined` rather than raising.
 */

const ME = 'a'.repeat(64);
const THEM = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
const ORACLE = 'https://oracle.test';

interface Recorded {
  url: URL;
  method: string;
  body: unknown;
}

let calls: Recorded[] = [];
const realFetch = globalThis.fetch;

/** `bfs::DistanceResult` as the oracle serializes it. */
function distanceResult(
  from: string,
  to: string,
  hops: number | null,
  pathCount = 1,
  mutual = false
) {
  return { from, to, hops, path_count: hops === null ? 0 : pathCount, mutual_follow: mutual };
}

function serve(handler: (url: URL) => { status?: number; body?: unknown }) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(href);
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const { status = 200, body = {} } = handler(url);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
}

/** The live oracle's answer to anything not in its route table. */
function serveOnly(routes: Record<string, (url: URL) => unknown>) {
  serve((url) => {
    const route = routes[url.pathname];
    if (!route) return { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } };
    return { body: route(url) };
  });
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('GET /distance', () => {
  it('is addressed as a query, not as /api/distance/FROM/TO', async () => {
    serveOnly({ '/distance': (url) => distanceResult(url.searchParams.get('from')!, url.searchParams.get('to')!, 2) });

    const wot = new WoT({ oracle: ORACLE, myPubkey: ME });

    // The route exists only at /distance with from/to as query parameters. The
    // /api/distance/FROM/TO path this client used is not in the oracle's route
    // table, and a 404 is swallowed as "not reachable" by getDistance, so the old
    // spelling reported null for every pair in the graph.
    await expect(wot.getDistance(THEM)).resolves.toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].url.pathname).toBe('/distance');
    expect(calls[0].url.searchParams.get('from')).toBe(ME);
    expect(calls[0].url.searchParams.get('to')).toBe(THEM);
  });

  it('reads hops, the field the oracle sends, not distance', async () => {
    const payload = distanceResult(ME, THEM, 2);
    serveOnly({ '/distance': () => payload });

    // `bfs::DistanceResult` has no `distance` member, so reading one yielded
    // undefined: getDistance resolved undefined where it promises number | null,
    // and isInMyWoT turned that into a quiet false for everyone.
    expect(payload).not.toHaveProperty('distance');
    expect((payload as Record<string, unknown>).distance).toBeUndefined();

    const wot = new WoT({ oracle: ORACLE, myPubkey: ME, maxHops: 3 });
    await expect(wot.getDistance(THEM)).resolves.toBe(2);
    await expect(wot.isInMyWoT(THEM)).resolves.toBe(true);
  });

  it('sends max_hops, the spelling the oracle parses', async () => {
    serveOnly({ '/distance': () => distanceResult(ME, THEM, 1) });

    const wot = new WoT({ oracle: ORACLE, myPubkey: ME, maxHops: 2 });
    await wot.getDistance(THEM);

    // DistanceQueryParams deserializes `max_hops` and defaults it to
    // MAX_HOPS_DEFAULT (3). A camelCase `maxHops` is ignored, so the server's
    // default silently decided the depth: a caller asking for 2 was answered at 3.
    expect(calls[0].url.searchParams.get('max_hops')).toBe('2');
    expect(calls[0].url.searchParams.has('maxHops')).toBe(false);
  });

  it('clamps max_hops into the 1..5 the oracle accepts', async () => {
    serveOnly({ '/distance': () => distanceResult(ME, THEM, 1) });

    // validate_max_hops rejects anything outside 1..=MAX_HOPS_LIMIT with a 400 and
    // code INVALID_MAX_HOPS. An out-of-range value is a failed request, not a
    // shallower or deeper search, so it is clamped before it is sent.
    expect(ORACLE_MAX_HOPS).toBe(5);

    await new WoT({ oracle: ORACLE, myPubkey: ME, maxHops: 0 }).getDistance(THEM);
    await new WoT({ oracle: ORACLE, myPubkey: ME, maxHops: 9 }).getDistance(THEM);
    await new WoT({ oracle: ORACLE, myPubkey: ME }).getDistance(THEM, { maxHops: -4 });

    expect(calls.map((call) => call.url.searchParams.get('max_hops'))).toEqual(['1', '5', '1']);
  });

  it('treats hops: null as no route found within the depth searched', async () => {
    serveOnly({ '/distance': () => distanceResult(ME, THEM, null) });

    // API.md: "hops:null means no route was found within the requested depth in the
    // current indexed graph. It is not proof of no connection across Nostr." It
    // stays null rather than becoming a distance of zero.
    const wot = new WoT({ oracle: ORACLE, myPubkey: ME });
    await expect(wot.getDistance(THEM)).resolves.toBeNull();
    await expect(wot.isInMyWoT(THEM)).resolves.toBe(false);
    await expect(wot.getDetails(THEM)).resolves.toBeNull();

    // Every one of those answers has to have come from /distance. The old client
    // also reported null here, but only because its own 404 was swallowed, so
    // without this the case passes against the contract it is meant to pin.
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.url.pathname).toBe('/distance');
  });

  it('raises a 404 instead of reporting it as an unreached target', async () => {
    // The oracle answers an unreached target with hops: null on a 200, so a 404
    // is a path it does not route: a wrong base URL, or a server that is not
    // nostr-wot-oracle. Reading it as "not in the web of trust" is what let this
    // client point at the right host and report an empty graph for every query.
    serveOnly({});

    const wot = new WoT({ oracle: ORACLE, myPubkey: ME });
    await expect(wot.getDistance(THEM)).rejects.toThrow(NotFoundError);
    await expect(wot.getDistanceBetween(ME, THEM)).rejects.toThrow(NotFoundError);
    await expect(wot.getDetails(THEM)).rejects.toThrow(NotFoundError);
    await expect(wot.batchCheck([THEM])).rejects.toThrow(NotFoundError);
  });

  it('refuses a hop count the oracle could not have produced', async () => {
    // hops is an Option<u32> bounded by the max_hops the request carried, so a
    // value past ORACLE_MAX_HOPS or a non-integer is a server this client is not
    // talking to. It is raised rather than scored.
    serveOnly({ '/distance': () => ({ ...distanceResult(ME, THEM, 2), hops: 12 }) });
    await expect(new WoT({ oracle: ORACLE, myPubkey: ME }).getDistance(THEM)).rejects.toThrow(
      NetworkError
    );

    serveOnly({ '/distance': () => ({ ...distanceResult(ME, THEM, 2), hops: 1.5 }) });
    await expect(new WoT({ oracle: ORACLE, myPubkey: ME }).getDistance(THEM)).rejects.toThrow(
      NetworkError
    );
  });

  it('refuses a path_count that is not a count', async () => {
    // path_count is a non-optional u64. A missing or non-numeric one is the exact
    // shape that used to read as undefined and pass straight through.
    serveOnly({ '/distance': () => ({ from: ME, to: THEM, hops: 2, mutual_follow: false }) });
    await expect(new WoT({ oracle: ORACLE, myPubkey: ME }).getDetails(THEM)).rejects.toThrow(
      NetworkError
    );
  });
});

describe('getDetails', () => {
  it('asks /distance, because the oracle has no /details route', async () => {
    serveOnly({ '/distance': () => distanceResult(ME, THEM, 2, 4, true) });

    // The oracle's endpoint list is /health, /ready, /stats, /distance,
    // /distance/batch, /path, /follows, /common-follows, /mutes and /trust. A
    // request to /details is a 404, which getDetails swallowed as null.
    const wot = new WoT({ oracle: ORACLE, myPubkey: ME });
    await expect(wot.getDetails(THEM)).resolves.toEqual({ hops: 2, paths: 4, mutual: true });
    expect(calls[0].url.pathname).toBe('/distance');
  });

  it('reads path_count, not paths', async () => {
    const payload = distanceResult(ME, THEM, 2, 7);
    serveOnly({ '/distance': () => payload });

    // This is the divergence the extension hit: the count is `path_count`, and
    // `paths` is a field the oracle has never sent, so every detail query reported
    // an undefined count.
    expect(payload).not.toHaveProperty('paths');
    expect((payload as Record<string, unknown>).paths).toBeUndefined();

    const details = await new WoT({ oracle: ORACLE, myPubkey: ME }).getDetails(THEM);
    expect(details?.paths).toBe(7);
  });

  it('reads mutual_follow, not mutual', async () => {
    const payload = distanceResult(ME, THEM, 1, 1, true);
    serveOnly({ '/distance': () => payload });

    expect(payload).not.toHaveProperty('mutual');
    expect(payload.mutual_follow).toBe(true);

    const details = await new WoT({ oracle: ORACLE, myPubkey: ME }).getDetails(THEM);
    expect(details?.mutual).toBe(true);
  });

  it('clamps a saturated path_count instead of refusing the answer', async () => {
    // API.md: "Counts saturate at the maximum unsigned 64-bit integer rather than
    // overflowing." That maximum is past Number.MAX_SAFE_INTEGER, so a documented
    // answer must not be rejected for being an unsafe integer.
    serveOnly({ '/distance': () => ({ ...distanceResult(ME, THEM, 3), path_count: 18446744073709551615 }) });

    const details = await new WoT({ oracle: ORACLE, myPubkey: ME }).getDetails(THEM);
    expect(details?.paths).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('asks for bridges only when the caller wants them', async () => {
    serveOnly({
      '/distance': (url) =>
        url.searchParams.get('include_bridges') === 'true'
          ? { ...distanceResult(ME, THEM, 2), bridges: [OTHER] }
          : distanceResult(ME, THEM, 2),
    });

    const wot = new WoT({ oracle: ORACLE, myPubkey: ME });

    // include_bridges defaults to false on the server, and the field is skipped
    // when absent, so bridges arrive only if they were requested.
    await expect(wot.getDetails(THEM)).resolves.toEqual({ hops: 2, paths: 1, mutual: false });
    expect(calls[0].url.searchParams.has('include_bridges')).toBe(false);

    await expect(wot.getDetails(THEM, { includeBridges: true })).resolves.toEqual({
      hops: 2,
      paths: 1,
      mutual: false,
      bridges: [OTHER],
    });
    expect(calls[1].url.searchParams.get('include_bridges')).toBe('true');
  });
});

describe('POST /distance/batch', () => {
  it('posts a JSON body instead of a GET with a comma-joined targets query', async () => {
    serve((url) =>
      url.pathname === '/distance/batch'
        ? { body: { from: ME, results: [distanceResult(ME, THEM, 1), distanceResult(ME, OTHER, null)] } }
        : { status: 404, body: { error: 'Not found', code: 'NOT_FOUND' } }
    );

    // The batch route is a POST taking BatchDistanceRequest as a JSON body. The
    // GET /batch/FROM?targets=a,b this client used is not a route at all, and
    // batchCheck answers a failed batch with null distances for every target, so
    // the whole batch came back as "not in the web of trust".
    const results = await new WoT({ oracle: ORACLE, myPubkey: ME, maxHops: 2 }).batchCheck([THEM, OTHER]);

    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url.pathname).toBe('/distance/batch');
    expect(calls[0].body).toEqual({ from: ME, targets: [THEM, OTHER], max_hops: 2 });
    expect(results.get(THEM)).toEqual({ pubkey: THEM, distance: 1, inWoT: true });
    expect(results.get(OTHER)).toEqual({ pubkey: OTHER, distance: null, inWoT: false });
  });

  it('keys each result by to, the field the oracle puts the target in', async () => {
    const results = [distanceResult(ME, THEM, 1)];
    serve(() => ({ body: { from: ME, results } }));

    // bfs::DistanceResult names the endpoints `from` and `to`. There is no
    // `pubkey` member, so keying the map by one produced a single entry under the
    // key "undefined" and no target could ever be found in it.
    expect(results[0]).not.toHaveProperty('pubkey');

    const checked = await new WoT({ oracle: ORACLE, myPubkey: ME }).batchCheck([THEM]);
    expect([...checked.keys()]).toEqual([THEM]);
    expect(checked.has('undefined')).toBe(false);
  });

  it('raises a malformed result rather than filing it as no distance', async () => {
    // batchCheck answers a failed request by filling every target with a null
    // distance, which is right for a transient failure and wrong for a body this
    // client cannot read: it would report "not in the web of trust" for a server
    // speaking a contract nobody checked. Reading the answer therefore happens
    // outside that catch.
    serve(() => ({ body: { from: ME, results: [{ from: ME, hops: 1, path_count: 1 }] } }));
    await expect(new WoT({ oracle: ORACLE, myPubkey: ME }).batchCheck([THEM])).rejects.toThrow(
      NetworkError
    );

    serve(() => ({ body: { from: ME, results: [{ ...distanceResult(ME, THEM, 2), hops: 99 }] } }));
    await expect(new WoT({ oracle: ORACLE, myPubkey: ME }).batchCheck([THEM])).rejects.toThrow(
      NetworkError
    );
  });

  it('fills a transient failure with null distances and keeps going', async () => {
    // A 503 is documented for overload, and the existing contract is that a failed
    // batch reports null rather than throwing. That stays, and it is the only path
    // that swallows anything.
    serve(() => ({ status: 503, body: { error: 'Overloaded', code: 'OVERLOADED' } }));

    const results = await new WoT({ oracle: ORACLE, myPubkey: ME }).batchCheck([THEM, OTHER]);
    expect(results.get(THEM)).toEqual({ pubkey: THEM, distance: null, inWoT: false });
    expect(results.get(OTHER)).toEqual({ pubkey: OTHER, distance: null, inWoT: false });
  });

  it('never sends more than the 100 targets the oracle accepts', async () => {
    serve((url) => {
      const body = url.pathname === '/distance/batch' ? { from: ME, results: [] } : {};
      return { body };
    });

    // batch_distance rejects a request carrying more than 100 targets with
    // TOO_MANY_TARGETS, so the caller's list is split to that bound.
    expect(ORACLE_MAX_BATCH_TARGETS).toBe(100);

    const targets = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(64, '0'));
    await new WoT({ oracle: ORACLE, myPubkey: ME }).batchCheck(targets);

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect((call.body as { targets: string[] }).targets.length).toBeLessThanOrEqual(
        ORACLE_MAX_BATCH_TARGETS
      );
    }
    expect(calls.flatMap((call) => (call.body as { targets: string[] }).targets)).toEqual(targets);
  });
});

describe('request shape', () => {
  it('does not prefix the oracle path with /api', async () => {
    serveOnly({ '/distance': () => distanceResult(ME, THEM, 1) });

    // create_router mounts /distance, /distance/batch, /follows and the rest at
    // the root. Nothing is served under /api.
    await new WoT({ oracle: ORACLE, myPubkey: ME }).getDistance(THEM);
    expect(calls[0].url.pathname.startsWith('/api')).toBe(false);
  });

  it('keeps a base path the caller configured', async () => {
    serve((url) =>
      url.pathname === '/wot/distance'
        ? { body: distanceResult(ME, THEM, 1) }
        : { status: 404, body: {} }
    );

    // A self-hosted oracle behind a reverse proxy can live under a prefix, so the
    // configured base is a prefix rather than just an origin.
    await expect(
      new WoT({ oracle: `${ORACLE}/wot`, myPubkey: ME }).getDistance(THEM)
    ).resolves.toBe(1);
  });
});
