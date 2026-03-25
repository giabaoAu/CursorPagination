require("dotenv").config();
const { createPool } = require("./db");

function makeBody(i) {
  return `Post ${i}`;
}

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("TRUNCATE TABLE posts RESTART IDENTITY");

    const userId = 1;
    const now = Date.now();
    const total = 200;
    const intervalMs = 60 * 1000; // 1 minute

    // Insert oldest -> newest so ids roughly align with created_at.
    for (let i = 0; i < total; i++) {
      const createdAt = new Date(now - (total - 1 - i) * intervalMs);
      await client.query(
        `INSERT INTO posts (user_id, created_at, body)
         VALUES ($1, $2, $3)`,
        [userId, createdAt.toISOString(), makeBody(i + 1)]
      );
    }

    await client.query("COMMIT");
    // eslint-disable-next-line no-console
    console.log(`Seeded ${total} posts for user_id=${userId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    // eslint-disable-next-line no-console
    console.error("Seed failed:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main();

