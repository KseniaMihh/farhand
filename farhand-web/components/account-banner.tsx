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
 *
 * The two tints are classes, not utilities: each is a background and an ink
 * that were checked against each other, and splitting them into
 * `bg-warning-tint text-warning-ink` is how half a pair gets changed.
 */
const ROW =
  "mx-auto flex max-w-column flex-wrap items-center gap-x-4 gap-y-2.5 px-4 py-3.5";
const MARK =
  "inline-flex h-7 w-7 flex-none items-center justify-center rounded-full border-[1.5px] border-current text-button";

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
      <div className="tint-paused border-b border-line">
        <div className={ROW}>
          <span className={MARK} aria-hidden="true">
            ❚❚
          </span>
          <p className="m-0 flex-[1_1_320px]">
            {/* `null` is not "not suspended" — the status already said it is.
                It means no end date was set, so say that rather than printing
                "null" or quietly showing nothing. */}
            <strong className="font-bold">
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
    <div className="tint-warning border-b border-line">
      <div className={ROW}>
        <span className={MARK} aria-hidden="true">
          @
        </span>

        <p className="m-0 flex-[1_1_320px]">
          {said ?? (
            <>
              <strong className="font-bold">
                Confirm your email to start posting.
              </strong>{" "}
              You can browse, but needs, offers and messages wait until you
              enter the code we sent to {me.email}.
            </>
          )}
        </p>

        <span className="flex items-center gap-4">
          {/* Dark enough for white at 14/600, and it is the Warning ink
              rather than a new colour, so the strip stays one thing. */}
          <Link
            className="btn btn-primary bg-warning-ink text-white"
            href="/verify"
          >
            Enter code
          </Link>
          <button
            type="button"
            className="btn btn-quiet text-inherit"
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
