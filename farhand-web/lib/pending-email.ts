/**
 * The address a just-registered person is waiting on a code for (#156).
 *
 * /register knows it; /verify needs it, so that "send a new code" works after
 * a reload. Between them is a redirect, and the question is where to put it.
 *
 * NOT THE URL. A querystring lives in browser history, in the `Referer` of
 * every link clicked from that page, and in whatever logs the address passes
 * through on the way. An email address belongs in none of them.
 *
 * `sessionStorage` dies with the tab, which is exactly the lifetime of a
 * value whose whole job is to bridge one redirect. It is also per-tab, so
 * registering in two tabs does not cross the wires.
 *
 * Every access is wrapped: in a private window, with site data blocked, or
 * inside some embedded browsers, reading `sessionStorage` THROWS rather than
 * returning nothing. A missing address means /verify shows its fallback
 * field, which is a worse page and a working one.
 */

const KEY = "farhand.pending-email";

export function rememberPendingEmail(email: string): void {
  try {
    sessionStorage.setItem(KEY, email);
  } catch {
    // Nothing to do and nothing to say: /verify asks for the address instead.
  }
}

export function pendingEmail(): string | null {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function forgetPendingEmail(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // Same again. The tab closing clears it anyway.
  }
}
