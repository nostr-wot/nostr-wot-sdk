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

// Method components (use these to compose a custom modal instead of
// reaching for `<LoginWidget>`). Each component renders only its own
// panel — the picker / chrome is the consumer's responsibility.
export {
  Nip07Method,
  type Nip07MethodExtras,
} from "./login/methods/Nip07Method";
export {
  Nip46Method,
  type Nip46MethodProps,
  type Nip46MethodExtras,
  clearPersistedNip46,
  readPersistedNip46,
  tryRestoreNip46,
} from "./login/methods/Nip46Method";
export {
  GenerateMethod,
  type GenerateMethodProps,
  type GenerateMethodExtras,
  clearPersistedNsec,
  tryRestoreGeneratedOrImported,
} from "./login/methods/GenerateMethod";
export {
  ImportMethod,
  type ImportMethodExtras,
} from "./login/methods/ImportMethod";

// Pluggable signer storage — apps with stronger at-rest requirements
// (encrypted IDB, WebAuthn-pinned KEK, etc.) implement this interface.
export {
  localStorageSignerStorage,
  SIGNER_STORAGE_KEY_NIP46,
  SIGNER_STORAGE_KEY_NSEC,
  type SignerStorage,
} from "./signer-storage";
export { useSignerStorage } from "./signer-storage-context";

// Primitives + types for advanced consumers
export { Modal, type ModalProps } from "./primitives/Modal";
export {
  Button,
  AnchorButton,
  type ButtonProps,
  type AnchorButtonProps,
  type ButtonVariant,
  type ButtonSize,
} from "./primitives/Button";
export type {
  ClassSlots,
  StyleSlots,
  LoginMethodId,
  LoginMethodConfig,
  LoginWidgetSlot,
  ModalSlot,
  LoginButtonSlot,
} from "./types";
