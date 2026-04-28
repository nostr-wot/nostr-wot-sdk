// Provider + auth hooks (re-exports from @nostr-wot/data/react)
export {
  useSession,
  useSigner,
  usePubkey,
  useLogin,
  useLogout,
  type SessionSigner,
  type SessionState,
} from "@nostr-wot/data/react";

// UI shell with auto-restore + theming attributes
export {
  NostrSessionProvider,
  type NostrSessionProviderProps,
} from "./session-shell";

// Login UI
export { LoginWidget, type LoginWidgetProps } from "./login/LoginWidget";
export { LoginModal, type LoginModalProps } from "./login/LoginModal";
export { LoginButton, type LoginButtonProps } from "./login/LoginButton";

// Persistence helpers (use to wipe the saved bunker URI / nsec)
export {
  clearPersistedNip46,
  readPersistedNip46,
  tryRestoreNip46,
} from "./login/methods/Nip46Method";
export {
  clearPersistedNsec,
  tryRestoreGeneratedOrImported,
} from "./login/methods/GenerateMethod";

// Primitives + types for advanced consumers
export { Modal, type ModalProps } from "./primitives/Modal";
export type {
  ClassSlots,
  StyleSlots,
  LoginMethodId,
  LoginMethodConfig,
  LoginWidgetSlot,
  ModalSlot,
  LoginButtonSlot,
} from "./types";
