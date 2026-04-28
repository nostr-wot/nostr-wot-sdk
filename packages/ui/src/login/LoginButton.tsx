"use client";

import { useState, type ReactNode } from "react";
import { useSession } from "@nostr-wot/data/react";
import { cx } from "../utils";
import { LoginModal, type LoginModalProps } from "./LoginModal";
import type { ClassSlots, LoginButtonSlot, StyleSlots } from "../types";

export interface LoginButtonProps {
  /** Button label when logged out. Default "Sign in". */
  signInLabel?: ReactNode;
  /**
   * Renderer for the logged-in state. Receives the pubkey + a `logout`
   * callback. Default: nothing (component renders null when logged in).
   */
  renderLoggedIn?: (args: { pubkey: string; logout: () => Promise<void> }) => ReactNode;
  /** Pass through to the inner LoginModal. */
  modalProps?: Omit<LoginModalProps, "open" | "onClose">;
  classes?: ClassSlots<LoginButtonSlot>;
  styles?: StyleSlots<LoginButtonSlot>;
}

/**
 * One-stop button: click to open `<LoginModal>`. Renders nothing (or a
 * custom node via `renderLoggedIn`) once the user is signed in.
 */
export function LoginButton({
  signInLabel = "Sign in",
  renderLoggedIn,
  modalProps,
  classes,
  styles,
}: LoginButtonProps) {
  const { pubkey, isLoading, logout } = useSession();
  const [open, setOpen] = useState(false);

  if (pubkey) {
    return renderLoggedIn ? <>{renderLoggedIn({ pubkey, logout })}</> : null;
  }

  return (
    <>
      <button
        type="button"
        className={cx("nui-login-button", classes?.button)}
        style={styles?.button}
        disabled={isLoading}
        onClick={() => setOpen(true)}
      >
        {isLoading ? (
          <>
            <span className={cx("nui-spinner", classes?.spinner)} />
            <span>Loading…</span>
          </>
        ) : (
          signInLabel
        )}
      </button>
      <LoginModal
        open={open}
        onClose={() => setOpen(false)}
        {...modalProps}
      />
    </>
  );
}
