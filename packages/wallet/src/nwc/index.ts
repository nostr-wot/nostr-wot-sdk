/** Transport-injected NIP-47: caller-owned connections, negotiated encryption and typed payment outcomes. */
export { NwcError, codeForWalletError, mayHavePaid } from './errors';
export type { NwcErrorCode, NwcOutcome } from './errors';
export { parseNwcUri, MAX_NWC_RELAYS } from './uri';
export type { NwcConnection } from './uri';
export { NWC_KINDS, canPay, chooseEncryption, parseNwcInfo } from './info';
export type { NwcEncryption, NwcInfo } from './info';
export { NwcClient, DEFAULT_NWC_TIMEOUTS } from './client';
export type { NwcBudget, NwcPayResult, NwcSubscription, NwcTimeouts, NwcTransport } from './client';
export { createPoolNwcTransport } from './pool-transport';
