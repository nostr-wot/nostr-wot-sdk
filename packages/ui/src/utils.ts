import type { CSSProperties } from "react";

/** Merge multiple class names; null/undefined/false drop out. */
export function cx(
  ...parts: Array<string | null | undefined | false>
): string {
  return parts.filter(Boolean).join(" ");
}

/** Merge inline-style objects with later wins. */
export function ms(
  ...parts: Array<CSSProperties | undefined>
): CSSProperties | undefined {
  const merged = parts.reduce<CSSProperties | undefined>((acc, x) => {
    if (!x) return acc;
    return { ...(acc ?? {}), ...x };
  }, undefined);
  return merged;
}
