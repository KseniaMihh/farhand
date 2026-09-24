import { Router } from "express";
import { z } from "zod";
import {
  getAuth,
  requireActive,
  requireAuth,
  requireVerified,
} from "../middleware/auth.js";
import { limiters } from "../middleware/rate-limit.js";
import {
  listInbox,
  listMessages,
  markRead,
  sendMessage,
} from "../services/conversations.js";
import {
  decodeCursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from "../services/shared.js";

export const conversationsRouter: Router = Router();

/**
 * Messages: the conversation attached to a proposal.
 *
 * Contract: docs/06-api-contract.md.
 *
 *   POST /proposals/:id/messages        send — creates the thread if needed
 *   GET  /conversations                 the inbox
 *   GET  /conversations/:id/messages    one thread, a page at a time
 *   POST /conversations/:id/read        "I have read this"
 *
 * Sending is addressed by the PROPOSAL and everything else by the
 * CONVERSATION, because a thread does not exist until the first message: you
 * cannot post to an id that has not been created yet. The contract used to
 * list POST /conversations/:id/messages and now says this instead.
 */

const idParams = z.object({ id: z.string().min(1) });

/** VarChar(4000) in the schema, and the schema is authoritative. */
const messageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

const pageQuerySchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

/**
 * Rate limited per signed-in user, not by address: two people in one office
 * share an address, and a message costs nothing to send but attention to
 * receive. The limiter comes after the guards, so it knows who is asking.
 */
conversationsRouter.post(
  "/proposals/:id/messages",
  requireAuth,
  requireVerified,
  requireActive,
  limiters.messageByUser,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { body } = messageSchema.parse(req.body);
    const message = await sendMessage(getAuth(req).user, id, body);

    res.status(201).json({ message });
  },
);

/**
 * SESSION would be wrong here: unlike reading your own needs, a conversation
 * has somebody else in it.
 */
conversationsRouter.get(
  "/conversations",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { cursor, limit } = pageQuerySchema.parse(req.query);
    const page = await listInbox(
      getAuth(req).user,
      cursor === undefined ? undefined : decodeCursor(cursor),
      limit,
    );

    res.json(page);
  },
);

conversationsRouter.get(
  "/conversations/:id/messages",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const { cursor, limit } = pageQuerySchema.parse(req.query);
    const page = await listMessages(
      getAuth(req).user,
      id,
      cursor === undefined ? undefined : decodeCursor(cursor),
      limit,
    );

    res.json(page);
  },
);

conversationsRouter.post(
  "/conversations/:id/read",
  requireAuth,
  requireVerified,
  requireActive,
  async (req, res) => {
    const { id } = idParams.parse(req.params);
    const conversation = await markRead(getAuth(req).user, id);

    res.json({ conversation });
  },
);
