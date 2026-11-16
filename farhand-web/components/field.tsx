"use client";

import { useId, type InputHTMLAttributes, type ReactNode } from "react";

/**
 * One labelled input, with room for what the API said about it.
 *
 * Three forms in this issue and a dozen after it draw the same thing: a
 * label, a control, an optional hint under it, and an error that replaces the
 * hint when there is one. Written once so that the thing nobody checks by
 * eye — that the label, the hint and the error are actually *announced* with
 * the input — is right everywhere or wrong everywhere.
 *
 * TODO(#156): wire it up properly, which is the whole point of the component:
 *   - `htmlFor`/`id` from `useId`, so two instances never collide
 *   - `aria-describedby` pointing at the hint, the error, or both
 *   - `aria-invalid` when there is an error
 *   - the error carries the design's ⓘ mark, `role="alert"` so it is read
 *     when it appears, and the Error tint (#F6DCDD on #9A2530) — never
 *     Terracotta, which is the Offers colour and means something else
 */
export interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  /** Standing help, e.g. "Shown on your needs, offers and reviews". */
  hint?: ReactNode;
  /** From `fieldErrorsIn`. Replaces the hint while it is set. */
  error?: string | undefined;
}

export function Field({
  label,
  hint: _hint,
  error: _error,
  ...input
}: FieldProps) {
  const id = useId();

  // TODO(#156): the underscores come off when the hint and the error are drawn.

  return (
    <p className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} {...input} />
    </p>
  );
}
