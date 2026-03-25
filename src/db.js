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

async function existsOlderThan(client, { userId, ts, id }) {
  const res = await client.query(
    `
    SELECT 1
    FROM posts
    WHERE user_id = $1
      AND (created_at, id) < ($2::timestamptz, $3::bigint)
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
    rows = rows.slice(0, limit);
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
    rows = rows.slice(0, limit);
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
    rows = ascRows.slice(0, limit).reverse(); // newest-first for response
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

  // Consistent semantics across both modes:
  // - `has_next_page`: exists older than the end_cursor coordinate (scroll down)
  // - `has_previous_page`: exists newer than the start_cursor coordinate (scroll up)
  const start = rows[0];
  const end = rows[rows.length - 1];
  const [olderExists, newerExists] = await Promise.all([
    existsOlderThan(client, { userId, ts: end.created_at, id: BigInt(end.id) }),
    existsNewerThan(client, { userId, ts: start.created_at, id: BigInt(start.id) }),
  ]);

  return {
    posts: rows.map((r) => ({
      id: r.id,
      user_id: r.user_id,
      created_at: r.created_at.toISOString(),
      body: r.body,
    })),
    page_info: {
      has_next_page: olderExists,
      has_previous_page: newerExists,
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

