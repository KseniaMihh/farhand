"use client";

import {
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

/**
 * One labelled control, with room for what the API said about it.
 *
 * Three forms in this issue and a dozen after it draw the same thing: a
 * label, a control, an optional hint under it, and an error that REPLACES the
 * hint when there is one. Written once so that the part nobody checks by eye
 * — that the label, the hint and the error are actually announced with the
 * control — is right everywhere or wrong everywhere.
 */

/**
 * `| undefined` on every one of these, not just `?`. With
 * `exactOptionalPropertyTypes` the two are different: `?` alone means "you
 * may leave it out", while these are passed on explicitly as `undefined` by
 * the wrappers below — which is also how a caller says "no error" after one
 * has been cleared.
 */
interface Shared {
  label: string;
  /** Standing help, e.g. "Shown on your needs, offers and reviews". */
  hint?: ReactNode | undefined;
  /** From `fieldErrorsIn`. Replaces the hint while it is set. */
  error?: string | undefined;
  /** The design's grey "(optional)" beside a label. */
  note?: string | undefined;
}

/** The label, the help and the announcing, around whatever control is given. */
function Labelled({
  id,
  label,
  hint,
  error,
  note,
  children,
}: Shared & {
  id: string;
  children: (described: string | undefined) => ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;

  // One or the other, never both: the error has taken the hint's place on the
  // screen, so pointing at the hint as well would read out help for a field
  // that is currently wrong.
  const described =
    error === undefined ? (hint === undefined ? undefined : hintId) : errorId;

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {note === undefined ? null : (
          <span className="field-label-note"> {note}</span>
        )}
      </label>

      {children(described)}

      {error === undefined ? (
        hint === undefined ? null : (
          <p className="field-hint" id={hintId}>
            {hint}
          </p>
        )
      ) : (
        // `role="alert"` because this appears after a request comes back,
        // which a screen reader is otherwise given no reason to revisit.
        <p className="field-error" id={errorId} role="alert">
          <span aria-hidden="true">!</span>
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export type FieldProps = Shared &
  Omit<InputHTMLAttributes<HTMLInputElement>, "id">;

export function Field({ label, hint, error, note, ...input }: FieldProps) {
  const id = useId();

  return (
    <Labelled id={id} label={label} hint={hint} error={error} note={note}>
      {(described) => (
        <div className="input-wrap">
          <input
            id={id}
            className="input"
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={described}
            {...input}
          />
        </div>
      )}
    </Labelled>
  );
}

export type SelectFieldProps = Shared &
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "id">;

export function SelectField({
  label,
  hint,
  error,
  note,
  children,
  ...select
}: SelectFieldProps) {
  const id = useId();

  return (
    <Labelled id={id} label={label} hint={hint} error={error} note={note}>
      {(described) => (
        <div className="input-wrap">
          <select
            id={id}
            className="input"
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={described}
            {...select}
          >
            {children}
          </select>
        </div>
      )}
    </Labelled>
  );
}

/**
 * A password, with the design's "Show".
 *
 * A button rather than a checkbox: it changes what you can see, not what will
 * be sent. `aria-pressed` is what says which it currently is — swapping the
 * word between "Show" and "Hide" alone leaves somebody who cannot see the
 * dots guessing which state the word describes.
 */
export function PasswordField({
  label,
  hint,
  error,
  note,
  ...input
}: FieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);

  return (
    <Labelled id={id} label={label} hint={hint} error={error} note={note}>
      {(described) => (
        <div className="input-wrap">
          <input
            id={id}
            className="input"
            type={shown ? "text" : "password"}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={described}
            {...input}
          />
          <button
            type="button"
            className="input-trailing"
            aria-pressed={shown}
            aria-controls={id}
            onClick={() => {
              setShown((was) => !was);
            }}
          >
            {shown ? "Hide" : "Show"}
          </button>
        </div>
      )}
    </Labelled>
  );
}
