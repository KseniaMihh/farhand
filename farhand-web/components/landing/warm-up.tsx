"use client";

import { useEffect } from "react";
import { apiGet } from "@/lib/api";

/**
 * One request that wakes the API while somebody reads the front door (#177).
 *
 * DO NOT DELETE THIS AS AN UNUSED REQUEST. It throws the answer away on
 * purpose, and that is the design rather than an oversight: nothing on this
 * page needs to know anything from the API. What it needs is for the API to
 * be AWAKE by the time somebody clicks through, because `/needs` is the
 * screen that genuinely blocks on it, and Render's free instance sleeps after
 * fifteen quiet minutes and takes most of a minute to get back up.
 *
 * `/health/ready` rather than `/health`, because readiness is the one that
 * touches the database (`farhand-api/src/routes/health.ts`), so this wakes
 * the whole path and not just the web process. Neither endpoint needs auth.
 *
 * ON MOUNT, NOT ON HOVER. Firing when somebody hovers a link sounds thriftier
 * and defeats the point. The gap between hovering a link and clicking it is
 * about half a second, against a wake that can take fifty: the benefit comes
 * entirely from the twenty or thirty seconds somebody spends reading the
 * page, and only mounting captures that. Phones have no hover at all, so the
 * thrifty version would never fire where a first visit is most likely to
 * happen. The cost of this version is one small request from people who read
 * and leave, which is nothing on the free plan.
 *
 * It also replaces a request that was already being made. The session
 * provider used to wrap this page from the root layout and ask
 * `GET /auth/me`, which woke the API by accident while asking a question
 * whose answer here is always "signed out". Removing that without replacing
 * it would have made the first real click slower for exactly the visitor this
 * page exists for.
 *
 * warm-up: see docs/10-decisions/0036-the-front-door-wakes-the-api.md
 */
export function WarmUp() {
  useEffect(() => {
    // Nothing to read, nothing to draw, and nothing to abort on the way out:
    // a request already in flight is one the API is already waking for, and
    // cancelling it would throw away the only thing it was for. A failure is
    // not a failure of anything either — the API being asleep is the case
    // this exists for, and the next screen says so in its own words.
    void apiGet<unknown>("/health/ready").catch(() => undefined);
  }, []);

  return null;
}
