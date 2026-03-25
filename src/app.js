const express = require("express");
const { registerFeedRoutes } = require("./routes/feed");

function createApp({ pool }) {
  const app = express();
  app.use(express.json());

  registerFeedRoutes(app, { pool });

  return app;
}

module.exports = { createApp };

