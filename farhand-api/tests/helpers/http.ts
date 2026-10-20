/**
 * An answer with the one part that is meant to differ taken out.
 *
 * Several tests assert that two responses are byte-identical — an unknown
 * email must look exactly like a wrong password, or the endpoint becomes a way
 * of asking who has an account (#11, #13). Since #29 every error body also
 * carries a `requestId`, which is different on every request BY DESIGN and
 * says nothing about the account behind it.
 *
 * So the comparison drops it. What must still match exactly is the status, the
 * code, the message and everything else in the body.
 */
export function withoutRequestId(body: unknown): unknown {
  if (typeof body !== "object" || body === null) return body;

  const { error, ...rest } = body as { error?: Record<string, unknown> };
  if (!error) return body;

  const { requestId: _ignored, ...sameness } = error;

  return { ...rest, error: sameness };
}

/**
 * Every key name anywhere in a response, deduplicated and sorted.
 *
 * For pinning the shape of a reply that is a database row rather than a
 * hand-written view (#95): a moderator's report target. `Need`, `Help` and
 * `Message` hold no secrets today, and the one that did — `User.passwordHash`
 * — reached a moderator because nothing anywhere said what that response
 * contained. A column added to any of those tables now fails the test that
 * calls this instead of quietly arriving in somebody's reply.
 *
 * Every depth, because a message target brings its conversation, its proposal
 * and the need behind it. Names collapse across levels, which costs nothing:
 * the question is which columns can appear at all.
 */
export function keysWithin(value: unknown): string[] {
  const found = new Set<string>();

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      found.add(key);
      walk(child);
    }
  };

  walk(value);
  return [...found].sort();
}
