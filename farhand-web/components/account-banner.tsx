"use client";

import Link from "next/link";
import { useState } from "react";
import { apiSend } from "@/lib/api";
import { useSession } from "@/lib/session";

/**
 * Screen 3.6 — the strip under the header, in both the states it has.
 *
 * SUSPENDED, which `GET /auth/me` really does answer. `status` and
 * `suspendedUntil` are in that reply for this exact purpose, and
 * farhand-api/src/routes/auth.ts says so in as many words: "so the frontend
 * can show 'your account is suspended until …'". (The fields kept thin on
 * purpose belong to the PUBLIC profile, `GET /users/:id`. Different
 * endpoint, different rule.)
 *
 * UNVERIFIED, which is reachable and otherwise silent: `POST /auth/login`
 * succeeds for an unverified account on purpose — `requireVerified` guards
 * posting, not existing — so somebody can register, sign in, browse, and have
 * nowhere the app tells them what is missing.
 */
export function AccountBanner() {
  const { session } = useSession();
  const [said, setSaid] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  if (session.status !== "signed-in") return null;

  const { me } = session;

  // SUSPENSION WINS when both are true. A suspended account cannot post
  // either way, so "confirm your email to start posting" would be a promise
  // the API will not keep.
  if (me.status === "SUSPENDED") {
    const until =
      me.suspendedUntil === null
        ? null
        : new Date(me.suspendedUntil).toLocaleDateString(undefined, {
            day: "numeric",
            month: "long",
            year: "numeric",
          });

    return (
      <div className="banner banner-suspended">
        <div className="banner-row">
          <span className="banner-mark" aria-hidden="true">
            ❚❚
          </span>
          <p className="banner-text">
            {/* `null` is not "not suspended" — the status already said it is.
                It means no end date was set, so say that rather than printing
                "null" or quietly showing nothing. */}
            <strong>
              {until === null
                ? "Your account is suspended until a moderator lifts it."
                : `Your account is suspended until ${until}.`}
            </strong>{" "}
            You can read, but not post, propose or message.
          </p>
        </div>
      </div>
    );
  }

  if (me.emailVerified) return null;

  return (
    <div className="banner banner-unverified">
      <div className="banner-row">
        <span className="banner-mark" aria-hidden="true">
          @
        </span>

        <p className="banner-text">
          {said ?? (
            <>
              <strong>Confirm your email to start posting.</strong> You can
              browse, but needs, offers and messages wait until you enter the
              code we sent to {me.email}.
            </>
          )}
        </p>

        <span className="banner-actions">
          <Link className="btn btn-primary" href="/verify">
            Enter code
          </Link>
          <button
            type="button"
            className="btn btn-quiet"
            disabled={sending}
            onClick={() => {
              setSending(true);

              apiSend("POST", "/auth/resend-verification", { email: me.email })
                .then(() => {
                  // The API answers identically whether or not it did
                  // anything (#41), so this cannot say "sent". Claiming
                  // knowledge the response withholds is how a page becomes a
                  // way to test which addresses exist.
                  setSaid(
                    "If that address still needs confirming, a new code is on its way. Older codes stop working.",
                  );
                })
                .catch((error: unknown) => {
                  // Including the 429. There is no countdown to show — the
                  // real limit is five an hour per account — so show what the
                  // API said and nothing invented.
                  setSaid(
                    error instanceof Error
                      ? error.message
                      : "That did not work. Try again in a little while.",
                  );
                })
                .finally(() => {
                  setSending(false);
                });
            }}
          >
            {sending ? "Sending…" : "Send a new code"}
          </button>
        </span>
      </div>
    </div>
  );
}
