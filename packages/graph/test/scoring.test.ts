import { describe, it, expect } from 'vitest';
import { calculateScore, DEFAULT_SCORING } from '../src/scoring';
import type { ScoringConfig } from '../src/types';

describe('calculateScore', () => {
  it('returns 1 for self (0 hops)', () => {
    expect(calculateScore(0, 1)).toBe(1);
  });

  it('returns 0 when not connected (null/undefined hops)', () => {
    expect(calculateScore(null, null)).toBe(0);
    expect(calculateScore(undefined, null)).toBe(0);
  });

  it('applies hop distance weights', () => {
    expect(calculateScore(1, 1)).toBe(1.0);
    expect(calculateScore(2, 1)).toBe(0.5);
    expect(calculateScore(3, 1)).toBe(0.25);
    expect(calculateScore(4, 1)).toBe(0.1);
  });

  it('uses the hop-4 weight for anything beyond 4', () => {
    expect(calculateScore(9, 1)).toBe(0.1);
  });

  it('adds a path bonus only for hops > 1 with multiple paths', () => {
    // hop 1 never gets a bonus, even with many paths
    expect(calculateScore(1, 10)).toBe(1.0);
    // hop 2, 3 paths => base .5 + pathBonus[2]=.15 * (3-1) = .3 => .8
    expect(calculateScore(2, 3)).toBeCloseTo(0.8, 10);
  });

  it('caps the path bonus at maxPathBonus', () => {
    // hop 2, huge path count => bonus capped at .5 => .5 + .5 = 1.0
    expect(calculateScore(2, 1000)).toBe(1.0);
  });

  it('honors a custom scoring config', () => {
    const cfg: ScoringConfig = {
      distanceWeights: { 1: 0.9, 2: 0.4 },
      pathBonus: { 2: 0.05 },
      maxPathBonus: 0.1,
    };
    expect(calculateScore(1, 1, cfg)).toBe(0.9);
    expect(calculateScore(2, 3, cfg)).toBeCloseTo(0.5, 10); // .4 + .05*2 = .5
    expect(calculateScore(2, 100, cfg)).toBeCloseTo(0.5, 10); // capped at .1 bonus
  });

  it('exposes sensible defaults', () => {
    expect(DEFAULT_SCORING.distanceWeights[1]).toBe(1.0);
    expect(DEFAULT_SCORING.maxPathBonus).toBe(0.5);
  });
});
