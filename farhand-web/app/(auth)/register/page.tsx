"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState, type SyntheticEvent } from "react";
import { AuthPanel } from "@/components/auth-panel";
import { Field, PasswordField, SelectField } from "@/components/field";
import { apiSend, ApiFailure } from "@/lib/api";
import { countries } from "@/lib/countries";
import { fieldErrorsIn, type FieldErrors } from "@/lib/field-errors";
import { rememberPendingEmail } from "@/lib/pending-email";

/**
 * Screen 3.1 — create an account.
 *
 * THE ERROR STATE THE DESIGN HAS AND THIS CANNOT: 3.1a draws "An account with
 * this email already exists. Sign in instead." `POST /auth/register` answers
 * `201` with the same body either way, on purpose — telling the two apart
 * would let anybody test whether an address is on Farhand. So a successful
 * registration always lands on /verify, and that second error state has no
 * code behind it.
 */
export default function Register() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [countryCode, setCountryCode] = useState("EE");
  const [fields, setFields] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // 249 codes named and collated. Once per mount, not once per keystroke.
  const list = useMemo(() => countries(), []);

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    setSending(true);
    setFields({});
    setFailure(null);

    apiSend("POST", "/auth/register", {
      email,
      password,
      displayName,
      countryCode,
    })
      .then(() => {
        // The address, not the token: /verify needs it so "send a new code"
        // survives a reload. In sessionStorage rather than the URL — see
        // lib/pending-email.ts.
        rememberPendingEmail(email);
        router.push("/verify");
      })
      .catch((error: unknown) => {
        const blamed = fieldErrorsIn(error);

        setFields(blamed);

        // The top-level sentence only when no field was named. Showing both
        // is how a screen says "3 things to fix" and then marks one.
        if (Object.keys(blamed).length === 0) {
          setFailure(
            error instanceof ApiFailure
              ? error.message
              : "Something went wrong. Try again.",
          );
        }

        setSending(false);
      });
  }

  return (
    <>
      <AuthPanel>Ask someone abroad for what you can’t get at home.</AuthPanel>

      <div className="auth-form">
        <div className="auth-form-inner">
          <h1 className="auth-title">Create your account</h1>
          <p className="auth-lead">
            Post what you need, or offer to buy where you live.
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
              autoComplete="new-password"
              value={password}
              // The API allows 8–72. The cap is real, server-side, and not
              // worth a sentence a reader has to carry around.
              hint="At least 8 characters"
              error={fields.password}
              onChange={(e) => {
                setPassword(e.target.value);
              }}
            />

            <Field
              label="Display name"
              name="displayName"
              autoComplete="nickname"
              value={displayName}
              hint="Shown on your needs, offers and reviews"
              error={fields.displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
              }}
            />

            <SelectField
              label="Country you live in"
              name="countryCode"
              autoComplete="country"
              value={countryCode}
              error={fields.countryCode}
              onChange={(e) => {
                setCountryCode(e.target.value);
              }}
            >
              {list.map((country) => (
                <option key={country.code} value={country.code}>
                  {country.name}
                </option>
              ))}
            </SelectField>

            <div className="auth-actions">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending}
              >
                {sending ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Creating account…
                  </>
                ) : (
                  "Create account"
                )}
              </button>
            </div>
          </form>

          <p className="auth-alt">
            Already have an account? <Link href="/sign-in">Sign in</Link>
          </p>
        </div>
      </div>
    </>
  );
}
