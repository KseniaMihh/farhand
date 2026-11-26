/**
 * Which address the API should count this request against, and the proof that
 * we are the ones saying so (#164).
 *
 * In `lib/` and not in `proxy.ts` for the reason `safe-next.ts` is here: this
 * is a rule, the rule is the part worth pinning, and a rule in a file with no
 * Next runtime in it can be tested directly. `proxy.ts` keeps the part that
 * is genuinely about Next — the rewrite — and calls this.
 *
 * vouched caller: see docs/10-decisions/0035-the-frontend-states-the-caller.md
 */

/** The address we state. Must match `CALLER_HEADER` in the API. */
export const CALLER_HEADER = "x-farhand-caller";

/** The proof that we stated it. Must match `VOUCH_HEADER` in the API. */
export const VOUCH_HEADER = "x-farhand-vouch";

/**
 * The visitor's address, from the end of the chain Vercel itself wrote.
 *
 * THE RIGHTMOST non-empty entry, and this is the whole argument for it:
 *
 *   - A browser sends no `x-forwarded-for`, yet exactly one entry arrives
 *     here and it holds the visitor's address. So Vercel's edge WRITES this
 *     header; it does not pass one through.
 *   - If it replaces, there is one entry and it is the visitor's.
 *   - If it appends, the visitor's is the entry Vercel added — last — and
 *     anything a caller invented for themselves sits to its left.
 *
 * Either way the rightmost entry is the one the nearest proxy stands behind,
 * which is the same rule, and the same reason, as the hop count the API uses
 * on its own direct path.
 *
 * NOT `x-real-ip`, which also arrives and also holds the right value today:
 * it is not a reserved name, so trusting it would need a measurement of its
 * own to show a caller cannot write it. The rule above needs none.
 *
 * NOT `x-vercel-forwarded-for`, which would have been the strongest of the
 * three — a reserved name a client cannot write, carrying one address rather
 * than a chain to pick an end of. **It does not arrive.** The probe deployed
 * to production for exactly this question answered `vercel-ffor=n`, so the
 * version of this proxy that read it could never have worked at any hop
 * count.
 */
export function visitorAddress(forwardedFor: string | null): string | null {
  if (forwardedFor === null) return null;

  const entries = forwardedFor
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  return entries.length === 0 ? null : (entries[entries.length - 1] ?? null);
}

/**
 * States the address on an outgoing request, or states nothing at all.
 *
 * Mutates the `Headers` it is given, which is what the proxy has to hand.
 *
 * BOTH OR NEITHER, and the "neither" half is not tidiness. A request arriving
 * at this proxy can carry any header a stranger chose, including these
 * two names. Without the delete, whatever they wrote is forwarded verbatim —
 * the API would refuse it, because the secret is the entire point, but a
 * proxy that passes a forgery along and trusts the far end to catch it is one
 * audit away from being wrong.
 *
 * Whether the value IS an address is checked at the API and not here. The
 * reason given until #178 was that `node:net` does not exist, the edge
 * runtime not being Node — and a `proxy.ts` runs on Node, so it does exist
 * now. The reason that survives the rename is the one that always carried the
 * weight: the check has to live at the far end regardless, because the far
 * end is what would otherwise turn a hostname into a rate-limit key, and
 * because a request forged straight at the API never passes through here to
 * be checked at all.
 */
export function applyVouch(
  headers: Headers,
  forwardedFor: string | null,
  secret: string | undefined,
): void {
  const address = visitorAddress(forwardedFor);

  if (address !== null && secret !== undefined && secret !== "") {
    headers.set(CALLER_HEADER, address);
    headers.set(VOUCH_HEADER, secret);
    return;
  }

  // Not `set(name, "")` and certainly not the string "undefined", which is
  // what an unset variable becomes the moment it is put in a template.
  headers.delete(CALLER_HEADER);
  headers.delete(VOUCH_HEADER);
}
