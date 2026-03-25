require("dotenv").config();
const { createPool } = require("./db");
const { createApp } = require("./app");

async function main() {
  const pool = createPool();
  const app = createApp({ pool });

  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`Server listening on port ${port}`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

