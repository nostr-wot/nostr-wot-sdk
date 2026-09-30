---
'@nostr-wot/wot': minor
---

Speak nostr-wot-oracle's real contract in the `WoT` class.

Every remote query in this package addressed a server that does not exist. The default
oracle, `https://wot-oracle.mappingbitcoin.com`, answers `GET /` with
`{"service":"nostr-wot-oracle","version":"0.3.1"}` and its own endpoint list, and this
client's routes are in none of it. Checked against that repository's `docs/API.md`,
`src/api/http.rs` and `src/graph/bfs.rs`, the two disagreed on eight points, and every
one of them failed silently:

- Distance is `GET /distance?from=&to=&max_hops=`, not `GET /api/distance/FROM/TO?maxHops=`.
  Nothing is served under `/api`.
- The distance field is `hops`, not `distance`. `bfs::DistanceResult` has no `distance`
  member, so `getDistance` resolved `undefined` where it promises `number | null`, and
  `isInMyWoT` turned that into a quiet `false`.
- There is no `/details` route. `GET /distance` already carries the detail, so
  `getDetails` asks that.
- The path count is `path_count`, not `paths`.
- The mutual-follow flag is `mutual_follow`, not `mutual`.
- Batch distance is `POST /distance/batch` with a JSON body, not
  `GET /api/batch/FROM?targets=a,b`, and it accepts up to 100 targets rather than the 50
  this client chunked to for a URL length limit that no longer applies.
- A batch result names its endpoints `from` and `to`. There is no `pubkey` member, so
  `batchCheck` filed every result under the key `"undefined"` and no target could be
  found in the map it returned.
- `max_hops` was never sent, so the server's default of 3 decided the depth: a caller
  configured to 2 was answered at 3. It is now sent, clamped to the 1..5 the oracle
  accepts, since a value it rejects is a 400 rather than a shallower answer.

A 404 is now raised instead of being reported as an unreached target. nostr-wot-oracle
reports "no route found within the depth searched" as `hops: null` on a 200 and never as
a 404, so a 404 means the client is not talking to the server it thinks it is. Reading it
as "not in the web of trust" is what let this package point at the right host and report
an empty graph for every query. Callers that treated `null` as unreachable keep working;
a caller pointed at a wrong base URL now hears about it.

A saturated `path_count` is clamped rather than refused: the oracle documents that counts
saturate at the maximum unsigned 64-bit integer, which is past `Number.MAX_SAFE_INTEGER`.

Adds `QueryOptions.includeBridges`, off by default like the oracle's own
`include_bridges`, because `DistanceResult.bridges` was otherwise unreachable. Its
documentation now says what the oracle actually returns: the meeting nodes of a
bidirectional search, not the first hop on a path. Exports `ORACLE_MIN_HOPS`,
`ORACLE_MAX_HOPS`, `ORACLE_MAX_BATCH_TARGETS` and `clampMaxHops`.

Eighteen tests, written from the oracle repository, pin each wire field and each of these
divergences. All eighteen fail against the previous spelling.
