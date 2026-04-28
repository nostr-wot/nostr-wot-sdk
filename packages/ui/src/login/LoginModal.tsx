"use client";

import { Modal } from "../primitives/Modal";
import { LoginWidget, type LoginWidgetProps } from "./LoginWidget";
import type { ClassSlots, LoginWidgetSlot, ModalSlot, StyleSlots } from "../types";

export interface LoginModalProps extends LoginWidgetProps {
  open: boolean;
  onClose: () => void;
  /** Auto-close on success. Default true. */
  closeOnSuccess?: boolean;
  /** Class slots for the modal chrome (overlay, modal, close button). */
  modalClasses?: ClassSlots<ModalSlot>;
  modalStyles?: StyleSlots<ModalSlot>;
}

/**
 * Modal wrapper around `<LoginWidget>`. Renders a centered, portal-based
 * dialog with backdrop + ESC-to-close + scroll lock.
 */
export function LoginModal({
  open,
  onClose,
  closeOnSuccess = true,
  modalClasses,
  modalStyles,
  classes,
  styles,
  onSuccess,
  ...rest
}: LoginModalProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      aria-label="Sign in to Nostr"
      classes={modalClasses}
      styles={modalStyles}
    >
      <LoginWidget
        {...rest}
        classes={classes as ClassSlots<LoginWidgetSlot>}
        styles={styles as StyleSlots<LoginWidgetSlot>}
        onSuccess={() => {
          onSuccess?.();
          if (closeOnSuccess) onClose();
        }}
      />
    </Modal>
  );
}
