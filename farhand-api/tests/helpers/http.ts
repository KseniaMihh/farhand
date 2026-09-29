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
