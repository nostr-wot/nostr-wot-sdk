/**
 * Adapter turning a {@link WotGraph} into the small `WoTLocalSource` shape that
 * `@nostr-wot/wot`'s `WoT` class can consume as a local query source instead of
 * the remote Oracle.
 */

import type { FilterByWoTOptions, WoTLocalSource } from './types';

/** Minimal surface {@link createWoTSource} needs from a graph. */
export interface WoTSourceGraph {
  getDistance(pubkey: string): { hops: number; paths: number } | null;
  isInWoT(pubkey: string, maxHops?: number): boolean;
  filterByWoT(pubkeys: string[], opts?: FilterByWoTOptions): string[];
}

export function createWoTSource(graph: WoTSourceGraph): WoTLocalSource {
  return {
    getDistance(target: string): number | null {
      const info = graph.getDistance(target);
      return info ? info.hops : null;
    },
    isInMyWoT(target: string, maxHops?: number): boolean {
      return graph.isInWoT(target, maxHops);
    },
    filterByWoT(pubkeys: string[], opts?: FilterByWoTOptions): string[] {
      return graph.filterByWoT(pubkeys, opts);
    },
  };
}
