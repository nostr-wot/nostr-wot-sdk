"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { cx, ms } from "../utils";
import type { ClassSlots, ModalSlot, StyleSlots } from "../types";

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Show the X close button. Default true. */
  showClose?: boolean;
  /** Close on overlay click. Default true. */
  closeOnOverlay?: boolean;
  /** Close on Escape. Default true. */
  closeOnEscape?: boolean;
  /** ARIA label for the dialog (announced by screen readers). */
  "aria-label"?: string;
  classes?: ClassSlots<ModalSlot>;
  styles?: StyleSlots<ModalSlot>;
}

/**
 * Portal-based modal. Renders into `document.body` so the overlay
 * always sits above the page. Handles ESC + overlay click + scroll
 * lock + focus restoration.
 */
export function Modal({
  open,
  onClose,
  children,
  showClose = true,
  closeOnOverlay = true,
  closeOnEscape = true,
  "aria-label": ariaLabel,
  classes,
  styles,
}: ModalProps) {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const onKey = (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus?.();
    };
  }, [open, closeOnEscape, onClose]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  const overlay = (
    <div
      className={cx("nui-modal-overlay", classes?.overlay)}
      style={styles?.overlay}
      onClick={(e) => {
        if (!closeOnOverlay) return;
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        className={cx("nui-modal", classes?.modal)}
        style={ms({ position: "relative" }, styles?.modal)}
      >
        {showClose && (
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className={cx("nui-modal-close", classes?.close)}
            style={styles?.close}
          >
            ×
          </button>
        )}
        {children}
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
