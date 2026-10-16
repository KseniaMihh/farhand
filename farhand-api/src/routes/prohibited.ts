import { Router } from "express";
import { publishedList } from "../services/prohibited.js";

export const prohibitedRouter: Router = Router();

/**
 * The list, and the version to tick against (#87).
 *
 * `—`: no session is read at all. Somebody deciding whether Farhand is any
 * use to them should be able to read what it refuses to carry before they
 * have an account, and a client has to fetch the version before it can show
 * the form that sends it back.
 *
 * It is a short, rarely changing list, so there is no paging and no cursor:
 * the whole thing is the answer.
 */
prohibitedRouter.get("/prohibited-items", async (_req, res) => {
  const list = await publishedList();

  res.json(list);
});
