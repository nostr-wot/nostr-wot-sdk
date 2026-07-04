// Facade — primary public API
export { WotGraph } from './wot-graph';
export type { WotGraphOptions, WotGraphStats } from './wot-graph';

// Scoring (pure)
export { calculateScore, DEFAULT_SCORING } from './scoring';

// Layers (exported for advanced usage / custom wiring)
export { LocalGraph } from './graph';
export { GraphStorage, encodeFollows, decodeFollows } from './storage';
export { GraphCrawler, CrawlError } from './crawl';
export type {
  CrawlPool,
  CrawlEvent,
  CrawlSubCloser,
  GraphCrawlerOptions,
} from './crawl';

// wot adapter
export { createWoTSource } from './wot-source';
export type { WoTSourceGraph } from './wot-source';

// Types
export type {
  ScoringConfig,
  DistanceInfo,
  GraphMeta,
  StorageStats,
  CrawlOptions,
  CrawlProgress,
  CrawlResult,
  FilterByWoTOptions,
  WebSocketLike,
  WoTLocalSource,
} from './types';
