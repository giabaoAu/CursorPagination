function base64UrlEncode(str) {
  // Base64URL avoids '+' '/' '=' which can be annoying in query strings.
  return Buffer.from(str, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlDecode(b64url) {
  const normalized = b64url.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64").toString("utf8");
}

function encodeCursor({ ts, id }) {
  // Cursor is opaque to clients; do not document internal structure as a contract.
  // "id" is the stable post ID (tie-breaker for identical timestamps).
  const payload = {
    ts: new Date(ts).toISOString(),
    id: String(id),
  };
  return base64UrlEncode(JSON.stringify(payload));
}

function decodeCursor(cursor) {
  if (typeof cursor !== "string" || cursor.length === 0) {
    throw new Error("Invalid cursor");
  }

  let raw;
  try {
    raw = base64UrlDecode(cursor);
  } catch {
    throw new Error("Invalid cursor encoding");
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid cursor JSON");
  }

  if (!parsed || typeof parsed.ts !== "string" || typeof parsed.id !== "string") {
    throw new Error("Invalid cursor payload");
  }

  const ts = new Date(parsed.ts);
  if (Number.isNaN(ts.getTime())) {
    throw new Error("Invalid cursor ts");
  }

  // Keep as string; pg can cast it to bigint via $param::bigint.
  if (!/^-?\d+$/.test(parsed.id)) {
    throw new Error("Invalid cursor id");
  }

  return { ts, id: parsed.id };
}

module.exports = {
  encodeCursor,
  decodeCursor,
};

