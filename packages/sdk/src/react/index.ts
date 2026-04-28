// Back-compat: combines @nostr-wot/wot/react (WoT provider + WoT hooks)
// and @nostr-wot/data/react (data hooks + NostrDataProvider) into one
// entry. New code can import from the scoped packages directly.
export * from '@nostr-wot/wot/react';
export * from '@nostr-wot/data/react';

// The unified provider lives in this meta-package — data-only apps
// don't need to install @nostr-wot/wot just to get a configuration
// provider; they use <NostrDataProvider> from @nostr-wot/data/react.
export { NostrSdkProvider, type NostrSdkProviderProps } from './nostr-sdk-provider';
