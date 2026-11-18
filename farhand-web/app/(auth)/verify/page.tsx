"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState, type SyntheticEvent } from "react";
import { AuthPanel } from "@/components/auth-panel";
import { Field } from "@/components/field";
import { apiSend, ApiFailure } from "@/lib/api";
import { forgetPendingEmail, pendingEmail } from "@/lib/pending-email";
import { useSession } from "@/lib/session";

/**
 * Screen 3.2 — confirm an email.
 *
 * THE SCREEN THAT CHANGES SHAPE. The design draws six single-character boxes
 * and says "We sent a 6-digit code… It works for 30 minutes". The API sends
 * 32 random bytes as base64url — a 43-character string — and it lasts 24
 * hours (farhand-api/src/tokens.ts). Six boxes cannot hold it, so this is one
 * field you paste into.
 *
 * It also reads `?token=` from the URL. `APP_ORIGIN` still points at the API,
 * so no email contains a link yet; #152 gives the app an address and changes
 * `src/mailer.ts`, and when it does, this page is already where the link
 * lands.
 *
 * A LINK MUST NOT VERIFY BY ARRIVING. The field is filled from the query and
 * then waits to be submitted: a `GET` that verified would be spent by the
 * first link prefetcher, scanner or inbox preview that saw it, and the token
 * is single use. The same reasoning is in docs/06-api-contract.md under this
 * endpoint.
 */
function VerifyForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { session, refresh } = useSession();

  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // Filled, not submitted.
  useEffect(() => {
    const fromLink = params.get("token");

    if (fromLink !== null && fromLink !== "") setToken(fromLink);
  }, [params]);

  // The address, in the order it can be known: the session, then what
  // /register left for this tab, then the field below.
  const known =
    session.status === "signed-in" ? session.me.email : (pendingEmail() ?? "");

  function submit(event: SyntheticEvent) {
    event.preventDefault();
    setSending(true);
    setFailure(null);
    setNote(null);

    apiSend("POST", "/auth/verify-email", { token })
      .then(async () => {
        forgetPendingEmail();

        // VERIFYING DOES NOT SIGN ANYBODY IN. It sets `emailVerifiedAt` and
        // nothing else; the session is whatever it already was. Somebody who
        // opened the link on another device has none at all.
        if (session.status === "signed-in") {
          await refresh();
          router.replace("/");
          return;
        }

        router.replace("/sign-in");
      })
      .catch((error: unknown) => {
        // Unknown, already used, expired and wrong-kind all answer the same,
        // because telling them apart helps nobody who legitimately holds a
        // code. Say what the API said; do not guess which of the four it was.
        // A 429 arrives here too — this endpoint is limited to 30 an hour per
        // address, keyed by IP because a token has no account to key on.
        setFailure(
          error instanceof ApiFailure
            ? error.message
            : "Something went wrong. Try again.",
        );
        setSending(false);
      });
  }

  function resend() {
    const address = known === "" ? email : known;

    if (address === "") {
      setFailure(
        "Enter the address you signed up with, and we'll send a code.",
      );
      return;
    }

    apiSend("POST", "/auth/resend-verification", { email: address })
      .then(() => {
        // Answers identically whether or not it did anything (#41), so this
        // cannot say "sent". Claiming knowledge the response withholds turns
        // the page into a way to test which addresses exist.
        setNote(
          "If that address still needs confirming, a new code is on its way. Older codes stop working.",
        );
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof ApiFailure
            ? error.message
            : "Something went wrong. Try again.",
        );
      });
  }

  return (
    <>
      <AuthPanel>One last step before you can post.</AuthPanel>

      <div className="flex items-center px-4 py-7 md:px-4 md:py-10">
        <div className="mx-auto w-full max-w-[380px]">
          <h1 className="mb-2 font-serif text-page-title">Check your email</h1>
          <p className="mb-7 text-muted">
            {known === ""
              ? "We sent a code to the address you signed up with. It works for 24 hours."
              : `We sent a code to ${known}. It works for 24 hours.`}
          </p>

          {failure === null ? null : (
            <p
              className="tint-error mb-5 rounded-control px-3.5 py-3"
              role="alert"
            >
              {failure}
            </p>
          )}

          {note === null ? null : (
            <p
              className="tint-success mb-5 rounded-control px-3.5 py-3"
              role="status"
            >
              {note}
            </p>
          )}

          <form onSubmit={submit} noValidate>
            <Field
              label="Code from the email"
              name="token"
              autoComplete="one-time-code"
              spellCheck={false}
              value={token}
              hint="It is long. Paste the whole thing."
              onChange={(e) => {
                setToken(e.target.value.trim());
              }}
            />

            {known === "" && (
              <Field
                label="Your email"
                type="email"
                name="email"
                autoComplete="email"
                value={email}
                hint="Only needed if you want a new code sent."
                onChange={(e) => {
                  setEmail(e.target.value);
                }}
              />
            )}

            <div className="mt-6 [&>.btn]:w-full">
              <button
                type="submit"
                className="btn btn-primary"
                disabled={sending || token === ""}
              >
                {sending ? (
                  <>
                    <span className="btn-spinner" aria-hidden="true" />
                    Confirming…
                  </>
                ) : (
                  "Confirm email"
                )}
              </button>
            </div>
          </form>

          <p className="mt-4.5 text-center text-caption">
            Didn’t get it? Check spam, or{" "}
            <button type="button" className="btn btn-quiet" onClick={resend}>
              send a new code
            </button>
          </p>

          <p className="mt-7 text-center text-caption text-muted">
            You can browse while you wait.
          </p>
        </div>
      </div>
    </>
  );
}

export default function Verify() {
  return (
    <Suspense fallback={null}>
      <VerifyForm />
    </Suspense>
  );
}
