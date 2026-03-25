const express = require("express");
const { z } = require("zod");
const { getFeedV2, getFeedV1Adapter } = require("../db");
const { decodeCursor } = require("../cursor");

function registerFeedRoutes(app, { pool }) {
  app.get("/health", (_req, res) => res.json({ ok: true }));

  app.get("/v2/feed", async (req, res) => {
    const schema = z
      .object({
        // PRD didn't spell out multi-user scoping; default to a single-user feed for simplicity.
        user_id: z.coerce.number().int().positive().optional().default(1),
        after: z.string().optional(),
        before: z.string().optional(),
        limit: z.coerce.number().int().positive().max(100).default(20),
      })
      .refine((v) => !(v.after && v.before), {
        message: "Use either 'after' or 'before' (not both).",
        path: ["after"],
      });

    let parsed;
    try {
      parsed = schema.parse(req.query);
    } catch (err) {
      return res.status(400).json({ error: "Invalid query parameters", details: err.errors });
    }

    try {
      // Ensure cursor is valid early to return a clean 400.
      if (parsed.after) decodeCursor(parsed.after);
      if (parsed.before) decodeCursor(parsed.before);

      const result = await getFeedV2(pool, {
        userId: parsed.user_id,
        afterCursor: parsed.after,
        beforeCursor: parsed.before,
        limit: parsed.limit,
      });
      return res.json(result);
    } catch (err) {
      return res.status(400).json({ error: err.message || "Bad request" });
    }
  });

  app.get("/v1/feed", async (req, res) => {
    const schema = z.object({
      user_id: z.coerce.number().int().positive().optional().default(1),
      page: z.coerce.number().int().nonnegative().optional().default(0),
      limit: z.coerce.number().int().positive().max(100).default(20),
    });

    let parsed;
    try {
      parsed = schema.parse(req.query);
    } catch (err) {
      return res.status(400).json({ error: "Invalid query parameters", details: err.errors });
    }

    try {
      const result = await getFeedV1Adapter(pool, {
        userId: parsed.user_id,
        page: parsed.page,
        limit: parsed.limit,
      });

      if (result.status && result.status >= 400) {
        return res.status(result.status).json(result.body);
      }

      return res.json(result.body);
    } catch (err) {
      return res.status(500).json({ error: err.message || "Internal server error" });
    }
  });
}

module.exports = { registerFeedRoutes };

