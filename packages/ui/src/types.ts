import type { CSSProperties, ReactNode } from "react";

/**
 * Per-element class slot — every component accepts a `classes` prop with
 * one entry per styleable region. Use it to override or extend the
 * default `.nui-*` classes per instance.
 *
 * Each slot also has a matching `styles` slot for inline-style overrides.
 */
export type ClassSlots<K extends string> = Partial<Record<K, string>>;
export type StyleSlots<K extends string> = Partial<Record<K, CSSProperties>>;

/** Available login methods. */
export type LoginMethodId = "nip07" | "nip46" | "generate" | "import";

export interface LoginMethodConfig {
  /** Method id — one of the four built-ins, or a custom id you handle. */
  id: LoginMethodId;
  /** User-facing label, e.g. "Browser extension". */
  label?: string;
  /** Subtitle / hint shown under the label. */
  hint?: string;
  /** Custom icon node (replaces the default emoji). */
  icon?: ReactNode;
  /** Force this method to render disabled (e.g. NIP-07 when no extension). */
  disabled?: boolean;
}

export type LoginWidgetSlot =
  | "root"
  | "title"
  | "subtitle"
  | "methods"
  | "method"
  | "methodIcon"
  | "methodText"
  | "methodLabel"
  | "methodHint"
  | "divider"
  | "input"
  | "inputRow"
  | "primaryButton"
  | "back"
  | "error"
  | "warning"
  | "keyDisplay";

export type ModalSlot = "overlay" | "modal" | "close";

export type LoginButtonSlot = "button" | "spinner";
