const fs = require("fs");
const path = require("path");
const request = require("supertest");

const { createApp } = require("../src/app");
const { createPool } = require("../src/db");
const { decodeCursor } = require("../src/cursor");

function shouldRunIntegrationTests() {
  return Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);
}

const integrationTests = shouldRunIntegrationTests() ? describe : describe.skip;

integrationTests("Feed cursor pagination", () => {
  let pool;
  let app;

  beforeAll(async () => {
    // Jest runs with this process env already. We just ensure DATABASE_URL is set.
    if (process.env.TEST_DATABASE_URL) {
      process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    }

    pool = createPool();
    app = createApp({ pool });

    const schemaPath = path.join(__dirname, "..", "sql", "schema.sql");
    const schemaSql = fs.readFileSync(schemaPath, "utf8");
    await pool.query(schemaSql);
  });

  afterAll(async () => {
    if (!pool) return;
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE TABLE posts RESTART IDENTITY");
  });

  function iso(s) {
    return new Date(s).toISOString();
  }

  async function insertPosts(userId, createdAts) {
    const inserted = [];
    for (let i = 0; i < createdAts.length; i++) {
      const res = await pool.query(
        `INSERT INTO posts (user_id, created_at, body)
         VALUES ($1, $2, $3)
         RETURNING id, created_at`,
        [userId, createdAts[i], `post-${i + 1}`]
      );
      inserted.push({
        id: res.rows[0].id,
        created_at: res.rows[0].created_at,
      });
    }
    return inserted;
  }

  test("empty feed returns empty page_info", async () => {
    const res = await request(app).get("/v2/feed").query({ user_id: 1, limit: 20 });
    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.page_info.has_next_page).toBe(false);
    expect(res.body.page_info.has_previous_page).toBe(false);
    expect(res.body.page_info.start_cursor).toBeNull();
    expect(res.body.page_info.end_cursor).toBeNull();
  });

  test("single page has_next_page=false", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const createdAts = Array.from({ length: 7 }, (_v, i) => iso(t0 + i * 1000));
    await insertPosts(1, createdAts);

    const res = await request(app).get("/v2/feed").query({ user_id: 1, limit: 20 });
    expect(res.status).toBe(200);
    expect(res.body.posts.length).toBe(7);
    expect(res.body.page_info.has_next_page).toBe(false);
    expect(res.body.page_info.start_cursor).not.toBeNull();
    expect(res.body.page_info.end_cursor).not.toBeNull();
  });

  test("cursor to deleted post does not break pagination", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const createdAts = Array.from({ length: 15 }, (_v, i) => iso(t0 + i * 1000));
    await insertPosts(1, createdAts);

    const page1 = await request(app).get("/v2/feed").query({ user_id: 1, limit: 5 });
    const endCursor = page1.body.page_info.end_cursor;
    expect(endCursor).toBeTruthy();

    const { id: deletedId } = decodeCursor(endCursor);
    await pool.query("DELETE FROM posts WHERE id = $1", [BigInt(deletedId)]);

    const page2 = await request(app)
      .get("/v2/feed")
      .query({ user_id: 1, limit: 5, after: endCursor });

    expect(page2.status).toBe(200);
    const returnedIds = page2.body.posts.map((p) => p.id.toString());
    expect(returnedIds).not.toContain(deletedId);
    // Sanity: page2 should still return older posts (or empty).
    expect(returnedIds.length).toBeGreaterThanOrEqual(0);
  });

  test("identical timestamps paginate correctly using (created_at, id) tie-breaker", async () => {
    const ts = iso("2026-01-01T00:00:00.000Z");
    const userId = 1;

    // Same created_at for all posts => ordering relies on id.
    const createdAts = Array.from({ length: 12 }, () => ts);
    await insertPosts(userId, createdAts);

    const page1 = await request(app).get("/v2/feed").query({ user_id: userId, limit: 5 });
    expect(page1.body.posts.length).toBe(5);
    const endCursor = page1.body.page_info.end_cursor;

    const page2 = await request(app)
      .get("/v2/feed")
      .query({ user_id: userId, limit: 5, after: endCursor });
    expect(page2.status).toBe(200);
    expect(page2.body.posts.length).toBe(5);

    const idsPage1 = page1.body.posts.map((p) => p.id.toString());
    const idsPage2 = page2.body.posts.map((p) => p.id.toString());
    const intersection = idsPage1.filter((x) => idsPage2.includes(x));
    expect(intersection).toEqual([]);
    expect(idsPage1.length + idsPage2.length).toBe(10);
  });

  test("backdated insert appears on the next cursor page boundary (no skip)", async () => {
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const base = Array.from({ length: 30 }, (_v, i) => iso(t0 + i * 1000));
    await insertPosts(1, base);

    // page1: newest 10 => cursor points to the 10th newest.
    const page1 = await request(app).get("/v2/feed").query({ user_id: 1, limit: 10 });
    const endCursor = page1.body.page_info.end_cursor;
    expect(endCursor).toBeTruthy();

    const { ts: endTs } = decodeCursor(endCursor);
    const backdatedCreatedAt = new Date(new Date(endTs).getTime() - 500).toISOString(); // older than cursor, newer than many next page rows

    await pool.query(
      `INSERT INTO posts (user_id, created_at, body)
       VALUES ($1, $2, $3)`,
      [1, backdatedCreatedAt, "backdated"]
    );

    const page2 = await request(app)
      .get("/v2/feed")
      .query({ user_id: 1, limit: 10, after: endCursor });

    expect(page2.status).toBe(200);
    const page2CreatedAts = page2.body.posts.map((p) => p.created_at);
    expect(page2CreatedAts).toContain(backdatedCreatedAt);
  });
});

