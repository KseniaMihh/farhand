import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import {
  declineProposal,
  listMyProposals,
  proposeAsHelper,
  proposeAsRequester,
  withdrawProposal,
} from "../services/proposals.js";
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../services/shared.js";

export const proposalsRouter: Router = Router();

/**
 * Proposals: getting in touch about a need.
 *
 * Contract: docs/06-api-contract.md. Two ways in, because people find each
 * other both ways round (docs/03-user-journeys.md):
 *
 *   POST /needs/:id/proposals   a helper answers a need
 *   POST /helps/:id/proposals   a requester approaches a helper about their
 *                               own need
 *
 * Each has one rule about ownership, and they are opposites: the first refuses
 * the need's owner, the second insists on it. Keeping them apart is why there
 * are two paths rather than one that branches on who is asking.
 *
 * Accepting a proposal is #20 — it is a transaction that also closes the need
 * and opens a deal, so it does not belong beside these.
 */

/** Both ways in allow a short note. */
const messageSchema = z.object({
  message: z.string().trim().min(1).max(1000).nullable().default(null),
});

/** Approaching a helper also has to say which of your needs it is about. */
const approachSchema = messageSchema.extend({
  needId: z.string().trim().min(1),
});

const idParams = z.object({ id: z.string().min(1) });

const listQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

proposalsRouter.post(
  "/needs/:id/proposals",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const input = messageSchema.parse(req.body);
    const proposal = await proposeAsHelper(getAuth(req).user, id, input);

    res.status(201).json({ proposal });
  },
);

proposalsRouter.post(
  "/helps/:id/proposals",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { needId, ...input } = approachSchema.parse(req.body);
    const proposal = await proposeAsRequester(
      getAuth(req).user,
      id,
      needId,
      input,
    );

    res.status(201).json({ proposal });
  },
);

proposalsRouter.post(
  "/proposals/:id/decline",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const proposal = await declineProposal(getAuth(req).user, id);

    res.json({ proposal });
  },
);

proposalsRouter.post(
  "/proposals/:id/withdraw",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const proposal = await withdrawProposal(getAuth(req).user, id);

    res.json({ proposal });
  },
);

/**
 * SESSION, not AUTH: seeing what you have already sent should not depend on
 * having confirmed your email, the same reasoning as GET /me/needs.
 */
proposalsRouter.get("/me/proposals", requireAuth, async (req, res) => {
  const { cursor, limit } = listQuerySchema.parse(req.query);
  const page = await listMyProposals(
    getAuth(req).user,
    cursor === undefined ? undefined : decodeCursor(cursor),
    limit,
  );

  res.json(page);
});
