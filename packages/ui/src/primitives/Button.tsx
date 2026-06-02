"use client";

import {
  forwardRef,
  type AnchorHTMLAttributes,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { cx } from "../utils";

/**
 * Visual variants. Match the CSS classes in `styles.css` (`.nui-btn-*`).
 *
 *   - `primary`   — accent fill, used for the affirmative action of a flow
 *                   (Connect, Continue, Save…). One per screen.
 *   - `secondary` — outline / bordered surface for non-destructive
 *                   alternates (Back, Cancel, secondary CTAs).
 *   - `ghost`     — text-only, blends into the background. Used for
 *                   tertiary affordances inside list rows or chips.
 *   - `link`      — looks like an `<a>`. For inline navigations that aren't
 *                   really buttons but need keyboard activation.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "link";

/** Vertical sizing. `md` is the default and matches `.nui-login-button`. */
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonBaseProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /**
   * Stretch to fill the available width. Mirrors the dominant default in
   * forms / modals — when a single CTA owns the row, full-width feels
   * intentional, even on desktop.
   */
  fullWidth?: boolean;
  /** Optional node rendered before children — typically an icon. */
  leadingIcon?: ReactNode;
  /** Optional node rendered after children — typically an arrow / chevron. */
  trailingIcon?: ReactNode;
  /**
   * `true` while an async action is in flight. The button becomes
   * non-interactive and renders a `.nui-spinner` in the leading slot,
   * replacing whatever icon would normally be there.
   */
  loading?: boolean;
  children?: ReactNode;
}

export type ButtonProps =
  & ButtonBaseProps
  & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "type">
  & {
    /** Default `"button"` so `<form>`-nested instances don't submit by accident. */
    type?: "button" | "submit" | "reset";
  };

export type AnchorButtonProps =
  & ButtonBaseProps
  & AnchorHTMLAttributes<HTMLAnchorElement>;

function variantClass(variant: ButtonVariant): string {
  // `primary` shares the existing `.nui-login-button` shape so consumers
  // already using it keep the same look. Other variants get their own.
  switch (variant) {
    case "primary": return "nui-btn-primary";
    case "secondary": return "nui-btn-secondary";
    case "ghost": return "nui-btn-ghost";
    case "link": return "nui-btn-link";
  }
}

function sizeClass(size: ButtonSize): string {
  return `nui-btn-${size}`;
}

function renderContent(
  { leadingIcon, trailingIcon, loading, children }: ButtonBaseProps,
): ReactNode {
  return (
    <>
      {loading
        ? <span className="nui-spinner nui-btn-spinner" aria-hidden />
        : leadingIcon
          ? <span className="nui-btn-icon" aria-hidden>{leadingIcon}</span>
          : null}
      {children != null && <span className="nui-btn-label">{children}</span>}
      {!loading && trailingIcon
        ? <span className="nui-btn-icon" aria-hidden>{trailingIcon}</span>
        : null}
    </>
  );
}

/**
 * Shared button primitive. Used internally by the SDK's login methods
 * (`Nip46Method`, etc.) and re-exported for apps that want the same look in
 * their own modals — Obelisk's `<LoginModal>` wrapper, for example, can
 * drop its hand-rolled `lc-pill` rules in favor of this.
 *
 * The component is a thin wrapper around a native `<button>`; styling is
 * fully driven by CSS classes so consumers can theme via CSS variables
 * (`--nui-primary`, `--nui-fg`, etc.) without prop drilling.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    fullWidth = false,
    leadingIcon,
    trailingIcon,
    loading = false,
    disabled,
    className,
    type = "button",
    children,
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      className={cx(
        "nui-btn",
        variantClass(variant),
        sizeClass(size),
        fullWidth ? "nui-btn-full" : null,
        className,
      )}
      {...rest}
    >
      {renderContent({ leadingIcon, trailingIcon, loading, children })}
    </button>
  );
});

/**
 * Same visual contract as {@link Button} but rendered as an `<a>`.
 * Used for buttons that are semantically navigation — e.g. the
 * "Open in signer app" deep link in the NIP-46 QR view, which fires the
 * `nostrconnect://` URL handler rather than running JS.
 */
export const AnchorButton = forwardRef<HTMLAnchorElement, AnchorButtonProps>(
  function AnchorButton(
    {
      variant = "primary",
      size = "md",
      fullWidth = false,
      leadingIcon,
      trailingIcon,
      loading = false,
      className,
      children,
      ...rest
    },
    ref,
  ) {
    return (
      <a
        ref={ref}
        className={cx(
          "nui-btn",
          variantClass(variant),
          sizeClass(size),
          fullWidth ? "nui-btn-full" : null,
          className,
        )}
        {...rest}
      >
        {renderContent({ leadingIcon, trailingIcon, loading, children })}
      </a>
    );
  },
);
