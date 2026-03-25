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
    // Setup: no rows exist in `posts` for `user_id=1` (handled by beforeEach TRUNCATE).
    // Expectation: API returns an empty `posts` array and both page flags are false.
    const res = await request(app).get("/v2/feed").query({ user_id: 1, limit: 20 });
    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.page_info.has_next_page).toBe(false);
    expect(res.body.page_info.has_previous_page).toBe(false);
    expect(res.body.page_info.start_cursor).toBeNull();
    expect(res.body.page_info.end_cursor).toBeNull();
  });

  test("single page has_next_page=false", async () => {
    // Setup:
    // - insert 7 posts with increasing created_at
    // - request limit=20, so everything fits in one page
    // Expectation:
    // - all 7 posts returned
    // - has_next_page=false (no older posts after end_cursor)
    // - has_previous_page=false (no newer posts before start_cursor)
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const createdAts = Array.from({ length: 7 }, (_v, i) => iso(t0 + i * 1000));
    await insertPosts(1, createdAts);

    const res = await request(app).get("/v2/feed").query({ user_id: 1, limit: 20 });
    expect(res.status).toBe(200);
    expect(res.body.posts.length).toBe(7);
    // Returned order should be newest-first.
    const createdOrder = res.body.posts.map((p) => Date.parse(p.created_at));
    const sortedDesc = [...createdOrder].sort((a, b) => b - a);
    expect(createdOrder).toEqual(sortedDesc);
    expect(res.body.page_info.has_next_page).toBe(false);
    expect(res.body.page_info.has_previous_page).toBe(false);
    expect(res.body.page_info.start_cursor).not.toBeNull();
    expect(res.body.page_info.end_cursor).not.toBeNull();
  });

  test("cursor to deleted post does not break pagination", async () => {
    // Setup:
    // - insert 15 posts (newest-first when queried)
    // - fetch page1 with limit=5; store `end_cursor` which points at the oldest post on page1
    // - delete that exact post
    //
    // Expectation:
    // - subsequent `after=end_cursor` query returns posts older than the deleted cursor coordinate
    // - the deleted post id is not present
    // - we also sanity-check tuple ordering relative to the cursor boundary
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const createdAts = Array.from({ length: 15 }, (_v, i) => iso(t0 + i * 1000));
    await insertPosts(1, createdAts);

    const page1 = await request(app).get("/v2/feed").query({ user_id: 1, limit: 5 });
    const endCursor = page1.body.page_info.end_cursor;
    expect(endCursor).toBeTruthy();

    const { id: deletedId } = decodeCursor(endCursor);
    const { ts: boundaryTs } = decodeCursor(endCursor);
    const boundaryTimeMs = Date.parse(boundaryTs);
    const deletedIdBig = BigInt(deletedId);

    await pool.query("DELETE FROM posts WHERE id = $1", [BigInt(deletedId)]);

    const page2 = await request(app)
      .get("/v2/feed")
      .query({ user_id: 1, limit: 5, after: endCursor });

    expect(page2.status).toBe(200);
    const returnedIds = page2.body.posts.map((p) => p.id.toString());
    expect(returnedIds).not.toContain(deletedId);

    // Tuple sanity check: for after/cursor-down, all returned tuples must be < boundary tuple.
    function tupleLessThan(tsMs, idBig) {
      if (tsMs < boundaryTimeMs) return true;
      if (tsMs > boundaryTimeMs) return false;
      return idBig < deletedIdBig;
    }

    for (const p of page2.body.posts) {
      const tsMs = Date.parse(p.created_at);
      const idBig = BigInt(p.id);
      expect(tupleLessThan(tsMs, idBig)).toBe(true);
    }
  });

  test("identical timestamps paginate correctly using (created_at, id) tie-breaker", async () => {
    // Setup:
    // - insert 12 posts with the same created_at (all identical timestamp)
    // - query in two pages of size=5
    //
    // Expectation:
    // - pagination must not duplicate posts across pages
    // - we use `id` as a deterministic tie-breaker when `(created_at)` is identical
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

    // Also verify within-page order is newest-first:
    // with identical timestamps, newest-first becomes higher `id` first.
    const ids1Big = page1.body.posts.map((p) => BigInt(p.id));
    const sorted1 = [...ids1Big].sort((a, b) => (a > b ? -1 : 1));
    expect(ids1Big).toEqual(sorted1);

    expect(idsPage1.length + idsPage2.length).toBe(10);
  });

  test("backdated insert appears on the next cursor page boundary (no skip)", async () => {
    // Setup:
    // - insert 30 posts with monotonically increasing created_at (oldest -> newest)
    // - fetch page1 with limit=10 (newest-first); boundary is page1's end_cursor
    // - insert a "backdated" post with created_at:
    //   - older than boundary (so it belongs after end_cursor)
    //   - but newer than some of page2's rows
    //
    // Expectation:
    // - the backdated post appears in page2 (meaning we did not skip it at boundary)
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

  test("before cursor scroll-up returns the expected newer slice", async () => {
    // Setup:
    // - 12 posts with distinct created_at
    // - fetch page1 (newest-first) with limit=5
    // - fetch page2 (older) using after=end_cursor of page1 with limit=5
    // - then scroll back up using before=page2.start_cursor
    //
    // Expectation:
    // - the "scroll up" result should match page1 exactly (same coordinate boundaries)
    // - has_next_page/has_previous_page flags should be consistent
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const createdAts = Array.from({ length: 12 }, (_v, i) => iso(t0 + i * 1000));
    await insertPosts(1, createdAts);

    const page1 = await request(app).get("/v2/feed").query({ user_id: 1, limit: 5 });
    expect(page1.status).toBe(200);
    const page1Ids = page1.body.posts.map((p) => p.id.toString());

    const page2 = await request(app)
      .get("/v2/feed")
      .query({ user_id: 1, limit: 5, after: page1.body.page_info.end_cursor });
    expect(page2.status).toBe(200);
    const page2StartCursor = page2.body.page_info.start_cursor;

    const pageUp = await request(app)
      .get("/v2/feed")
      .query({ user_id: 1, limit: 5, before: page2StartCursor });
    expect(pageUp.status).toBe(200);

    const pageUpIds = pageUp.body.posts.map((p) => p.id.toString());
    expect(pageUpIds).toEqual(page1Ids);

    // Flag semantics for newest-first response:
    // - page1 is at the top, so has_previous_page should be false
    // - page1 still has older posts, so has_next_page should be true
    expect(page1.body.page_info.has_previous_page).toBe(false);
    expect(page1.body.page_info.has_next_page).toBe(true);
    expect(pageUp.body.page_info.has_previous_page).toBe(false);
    expect(pageUp.body.page_info.has_next_page).toBe(true);
  });

  test("before cursor at the newest boundary returns empty", async () => {
    // Setup:
    // - 6 posts
    // - first request returns the newest boundary as `start_cursor`
    //
    // Expectation:
    // - calling /v2/feed with before=start_cursor returns posts newer than global newest => empty
    const t0 = Date.parse("2026-01-01T00:00:00.000Z");
    const createdAts = Array.from({ length: 6 }, (_v, i) => iso(t0 + i * 1000));
    await insertPosts(1, createdAts);

    const first = await request(app).get("/v2/feed").query({ user_id: 1, limit: 10 });
    expect(first.status).toBe(200);

    const startCursor = first.body.page_info.start_cursor;
    const res = await request(app).get("/v2/feed").query({
      user_id: 1,
      limit: 10,
      before: startCursor,
    });

    expect(res.status).toBe(200);
    expect(res.body.posts).toEqual([]);
    expect(res.body.page_info.has_next_page).toBe(false);
    expect(res.body.page_info.has_previous_page).toBe(false);
    expect(res.body.page_info.start_cursor).toBeNull();
    expect(res.body.page_info.end_cursor).toBeNull();
  });
});

