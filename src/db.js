const { Pool } = require("pg");
const { encodeCursor, decodeCursor } = require("./cursor");

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  return new Pool({
    connectionString,
    // Avoid hanging connections in evaluation environments.
    connectionTimeoutMillis: 5000,
  });
}

async function existsNewerThan(client, { userId, ts, id }) {
  const res = await client.query(
    `
    SELECT 1
    FROM posts
    WHERE user_id = $1
      AND (created_at, id) > ($2::timestamptz, $3::bigint)
    LIMIT 1
    `,
    [userId, ts, id]
  );
  return res.rowCount > 0;
}

async function getFeedV2(client, { userId, afterCursor, beforeCursor, limit }) {
  const decodedAfter = afterCursor ? decodeCursor(afterCursor) : null;
  const decodedBefore = beforeCursor ? decodeCursor(beforeCursor) : null;

  const limitPlusOne = limit + 1;

  let rows = [];
  let hasNextPage = false;
  let hasPreviousPage = false;

  if (!decodedAfter && !decodedBefore) {
    // First load: newest-first page.
    const res = await client.query(
      `
      SELECT id, user_id, created_at, body
      FROM posts
      WHERE user_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT $2
      `,
      [userId, limitPlusOne]
    );
    rows = res.rows;
    hasNextPage = rows.length > limit;
    rows = rows.slice(0, limit);
    hasPreviousPage = false;
  } else if (decodedAfter) {
    // Scroll DOWN (older posts).
    const res = await client.query(
      `
      SELECT id, user_id, created_at, body
      FROM posts
      WHERE user_id = $1
        AND (created_at, id) < ($2::timestamptz, $3::bigint)
      ORDER BY created_at DESC, id DESC
      LIMIT $4
      `,
      [userId, decodedAfter.ts, BigInt(decodedAfter.id), limitPlusOne]
    );
    rows = res.rows;
    hasNextPage = rows.length > limit;
    rows = rows.slice(0, limit);

    const start = rows[0];
    if (start) {
      hasPreviousPage = await existsNewerThan(client, {
        userId,
        ts: start.created_at,
        id: BigInt(start.id),
      });
    }
  } else {
    // Scroll UP (newer posts).
    const res = await client.query(
      `
      SELECT id, user_id, created_at, body
      FROM posts
      WHERE user_id = $1
        AND (created_at, id) > ($2::timestamptz, $3::bigint)
      ORDER BY created_at ASC, id ASC
      LIMIT $4
      `,
      [userId, decodedBefore.ts, BigInt(decodedBefore.id), limitPlusOne]
    );
    const ascRows = res.rows;
    hasNextPage = ascRows.length > limit;
    rows = ascRows.slice(0, limit).reverse(); // newest-first for response

    const start = rows[0];
    if (start) {
      hasPreviousPage = await existsNewerThan(client, {
        userId,
        ts: start.created_at,
        id: BigInt(start.id),
      });
    }
  }

  if (rows.length === 0) {
    return {
      posts: [],
      page_info: {
        has_next_page: false,
        has_previous_page: false,
        start_cursor: null,
        end_cursor: null,
      },
    };
  }

  const startCursor = encodeCursor({ ts: rows[0].created_at, id: rows[0].id });
  const endCursor = encodeCursor({
    ts: rows[rows.length - 1].created_at,
    id: rows[rows.length - 1].id,
  });

  // If we were paginating "up" (before=...), has_next_page is derived from the LIMIT+1 row.
  // For "down" (after=...) the same approach works for has_next_page.
  // has_previous_page is derived by checking existence of newer posts than the start row.
  return {
    posts: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      created_at: r.created_at.toISOString(),
      body: r.body,
    })),
    page_info: {
      has_next_page: Boolean(hasNextPage),
      has_previous_page: Boolean(hasPreviousPage),
      start_cursor: startCursor,
      end_cursor: endCursor,
    },
  };
}

async function getFeedV1Adapter(client, { userId, page, limit }) {
  // Offset/LIMIT is only used for very small pages as a transition adapter.
  if (page < 0) page = 0;

  if (page >= 50) {
    return {
      status: 400,
      body: {
        error:
          "Deep OFFSET pagination is disabled. Please migrate to GET /v2/feed with cursor-based pagination.",
      },
    };
  }

  const offset = page * limit; // v1 is assumed 0-based page index
  if (offset === 0) {
    return { status: 200, body: await getFeedV2(client, { userId, limit }) };
  }

  // Anchor is the last row from the previous page (exclude it via cursor query).
  const anchorRes = await client.query(
    `
    SELECT created_at, id
    FROM posts
    WHERE user_id = $1
    ORDER BY created_at DESC, id DESC
    OFFSET $2
    LIMIT 1
    `,
    [userId, offset - 1]
  );

  if (anchorRes.rowCount === 0) {
    return {
      status: 200,
      body: {
        posts: [],
        page_info: {
          has_next_page: false,
          has_previous_page: false,
          start_cursor: null,
          end_cursor: null,
        },
      },
    };
  }

  const anchor = anchorRes.rows[0];
  const afterCursor = encodeCursor({ ts: anchor.created_at, id: anchor.id });
  return { status: 200, body: await getFeedV2(client, { userId, afterCursor, limit }) };
}

module.exports = {
  createPool,
  getFeedV2,
  getFeedV1Adapter,
};

