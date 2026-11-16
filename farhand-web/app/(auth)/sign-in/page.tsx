"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type SyntheticEvent } from "react";
import { AuthPanel } from "@/components/auth-panel";
import { Field, PasswordField } from "@/components/field";
import { apiSend, ApiFailure } from "@/lib/api";
import { fieldErrorsIn, type FieldErrors } from "@/lib/field-errors";
import { safeNext } from "@/lib/safe-next";
import { useSession } from "@/lib/session";

/**
 * Screen 3.3 — sign in.
 *
 * The screen the whole issue exists for: `POST /auth/login` sets the
 * `httpOnly`, `sameSite: "lax"` session cookie, and because the request went
 * to this app's own `/api/...` the browser treats it as same-site and keeps
 * it. Reload, still signed in — the first real proof of decision 0031.
 */
function SignInForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useSession();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fields, setFields] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    setSending(true);
    setFields({});
    setFailure(null);

    apiSend("POST", "/auth/login", { email, password })
      .then(async () => {
        await refresh();

        // Checked, never trusted. lib/safe-next.ts says why a character test
        // is not enough.
        router.replace(safeNext(params.get("next"), window.location.origin));
      })
      .catch((error: unknown) => {
        if (error instanceof ApiFailure) {
          // 422 — an empty field. The API names it, so the inputs can.
          const blamed = fieldErrorsIn(error);

          if (Object.keys(blamed).length > 0) {
            setFields(blamed);
            setSending(false);
            return;
          }

          // 401 is "email or password is incorrect" and 403 is "this account
          // has been banned", which the API checks only AFTER the password so
          // that nobody but the owner can learn it. Both are the API's own
          // sentence, above the form rather than against a field: marking
          // only the password on a wrong password would confirm the email
          // exists.
          setFailure(error.message);
          setSending(false);
          return;
        }

        setFailure("Something went wrong. Try again.");
        setSending(false);
      });
  }

  return (
    <>
      <AuthPanel>Welcome back.</AuthPanel>

      <div className="auth-form">
        <div className="auth-form-inner">
          <h1 className="auth-title">Sign in</h1>
          <p className="auth-lead">
            Pick up where you left off — your needs, offers and deals.
          </p>

          {failure === null ? null : (
            <p className="form-note form-note-error" role="alert">
              {failure}
            </p>
          )}

          <form onSubmit={submit} noValidate>
            <Field
              label="Email"
              type="email"
              name="email"
              autoComplete="email"
              value={email}
              error={fields.email}
              onChange={(e) => {
                setEmail(e.target.value);
              }}
            />

            <PasswordField
              label="Password"
              name="password"
              autoComplete="current-password"
              value={password}
              error={fields.password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />

            <div className="auth-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending}
              >
                {sending ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Signing in…
                  </>
                ) : (
                  "Sign in"
                )}
              </button>
            </div>
          </form>

          <p className="auth-alt">
            New to Farhand? <Link href="/register">Create an account</Link>
          </p>
        </div>
      </div>
    </>
  );
}

/**
 * `useSearchParams` reads something only the browser knows, so Next asks for
 * a boundary around it rather than pre-rendering a page that would be wrong.
 */
export default function SignIn() {
  return (
    <Suspense fallback={null}>
      <SignInForm />
    </Suspense>
  );
}
