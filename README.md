# CursorPage Take-Home

This project implements a feed API for a large `posts` table (PostgreSQL) using cursor-based pagination instead of `OFFSET/LIMIT`.

## Part I - Why OFFSET degrades (PostgreSQL mechanics)

With PostgreSQL, `OFFSET N LIMIT 20` does not “jump” to row `N`. It effectively:

1. scans/materializes the first `N` rows,
2. discards them,
3. then returns the next `20` rows.

Even with a supporting index, those skipped rows still cost work (index lookups, possible heap fetches, buffer loads, etc.). As `N` grows, each page becomes slower than the last, producing the classic `O(offset)` degradation curve.

In addition to performance, `OFFSET` is position-based:

- Inserts shift every subsequent page boundary (can lead to duplicates or to “skips” when clients resume).
- Deletes shift subsequent rows (can lead to duplicates too).

This project fixes both by using cursor/keyset pagination based on a deterministic logical coordinate (`created_at` + `id`).

## Cursor design

Cursor is an opaque string:

- base64url-encoded JSON payload
- clients must treat the cursor as a black box (store and pass it back)

Payload shape:

- `ts`: ISO-8601 timestamp of the cursor post’s `created_at`
- `id`: stable unique post id (tie-breaker)

We encode it as:
`base64url({ "ts": "<ISO8601>", "id": "<id-as-string>" })`

### SQL ordering + tuple comparisons

We order by:

- `ORDER BY created_at DESC, id DESC` (newest-first for responses)

And use deterministic tuple predicates:

- Scroll DOWN (older posts): `WHERE (created_at, id) < (cursor_ts, cursor_id)`
- Scroll UP (newer posts): `WHERE (created_at, id) > (cursor_ts, cursor_id)`

To support “before” efficiently, we query `ORDER BY created_at ASC, id ASC` with a limit, then reverse the returned rows before sending them to the client.

## Design Architecture & Flows

### High-level request flow

```mermaid
flowchart LR
  C[Client] -->|GET /v2/feed| API[Express route]
  API --> VAL[Validate query params (zod)]
  VAL -->|after/before present?| BR{Cursor mode?}
  BR -->|after| DECA[Decode cursor (base64url JSON)]
  BR -->|before| DECB[Decode cursor (base64url JSON)]
  BR -->|none| Q0[First load query: newest-first]
  DECA --> QD[Query older posts\nWHERE (created_at,id) < (ts,id)\nORDER BY created_at DESC, id DESC\nLIMIT (limit+1)]
  DECB --> QN[Query newer posts\nWHERE (created_at,id) > (ts,id)\nORDER BY created_at ASC, id ASC\nLIMIT (limit+1)\n(reverse rows for response)]
  Q0 --> ENC[Encode start/end cursors]
  QD --> ENC
  QN --> ENC
  ENC --> RESP[Return posts + page_info\nhas_next_page / has_previous_page]
```

### Pagination decision logic

```mermaid
flowchart TD
  A[Request to /v2/feed] --> B{after provided?}
  B -->|yes| C[Scroll DOWN: older posts]
  B -->|no| D{before provided?}
  D -->|yes| E[Scroll UP: newer posts]
  D -->|no| F[First load: newest posts]

  C --> G[Predicate: (created_at,id) < (cursor_ts,cursor_id)]
  E --> H[Predicate: (created_at,id) > (cursor_ts,cursor_id)]
  F --> I[No predicate]

  G --> J[ORDER BY created_at DESC, id DESC]
  H --> K[ORDER BY created_at ASC, id ASC then reverse result]
  I --> L[ORDER BY created_at DESC, id DESC]
```

### Cursor tuple semantics (backdated insert + deletion)

```mermaid
flowchart LR
  subgraph LogicalOrder[Logical feed order (newest -> oldest)]
    X1[(created_at,id)=P0] --> X2[(created_at,id)=P1] --> X3[(created_at,id)=P2]
  end

  CUR[Cursor points to (ts,id) = P1] --> OLDP[after => fetch "older": tuples < P1]
  CUR --> NEWP[before => fetch "newer": tuples > P1]

  del[If P1 is deleted]:::warn --> still[Boundary remains valid:\nquery still runs,\nP1 just isn't returned]
  backdated[If a backdated post inserts\nbetween already-fetched pages]:::info --> next[Next page includes it\n(no skip at boundary)]

  classDef warn fill:#fff0f0,stroke:#cc0000;
  classDef info fill:#f0f7ff,stroke:#0066cc;
  CUR -.-> del
  CUR -.-> backdated
```

## API

### `GET /v2/feed` (cursor pagination)

Query params:

- `user_id` (optional, defaults to `1`)
- `after` (optional, cursor string; fetch older posts)
- `before` (optional, cursor string; fetch newer posts)
- `limit` (optional, default `20`, max `100`)

Rules:

- `after` and `before` are mutually exclusive.

Response:

```json
{
  "posts": [
    {
      "id": "123",
      "user_id": 1,
      "created_at": "2026-01-01T00:00:00.000Z",
      "body": "..."
    }
  ],
  "page_info": {
    "has_next_page": true,
    "has_previous_page": false,
    "start_cursor": "opaque...",
    "end_cursor": "opaque..."
  }
}
```

Empty feed:

- `posts: []`
- cursors are `null`
- both `has_next_page` and `has_previous_page` are `false`

Edge cases handled:
- Deleted post for a cursor boundary: the query still executes (cursor is a logical `(created_at, id)` coordinate), and the deleted post is simply absent from results.
- Identical `created_at` timestamps: pagination remains deterministic because the composite predicate always includes the `id` tie-breaker.
- Backdated inserts: if a new post is inserted “between” already-rendered pages, cursor boundaries ensure it is not silently skipped at the page boundary.
- Invalid cursors / invalid query shape: `400` with an error message (cursor is treated as opaque; clients must not parse it).

### `GET /v1/feed` (migration adapter)

Query params:

- `user_id` (optional, defaults to `1`)
- `page` (integer, default `0`)
- `limit` (optional, default `20`, max `100`)

Behavior:

- `page >= 50` returns `400` with an error message directing clients to `/v2/feed`.
- For `page < 50`, the adapter converts the page number into a cursor by:
  1. using small `OFFSET` to find the “anchor” row for the previous boundary,
  2. encoding that anchor as a cursor,
  3. executing the cursor engine (keyset pagination).

Note on page indexing:

- This adapter assumes `page=0` means the first page (OFFSET=0). If your existing mobile app is 1-based, change the adapter mapping accordingly.

## Migration Plan (v1 `?page=N` -> v2 cursors)

Goal: keep old clients working during rollout, without reintroducing the deep-OFFSET performance bug.

Phase 1 (now): ship the new cursor API
- Deploy `GET /v2/feed` (cursor-based pagination).
- Keep `GET /v1/feed` untouched.

Phase 2 (week 2-4): add an adapter under `/v1/feed`
- Update `GET /v1/feed?page=N` to internally route small pages through the cursor engine:
  - `page < 50`: translate `page` into a cursor anchor and execute the keyset query.
  - `page >= 50`: return `400` with an upgrade message (deep OFFSET is the bug we're fixing).

Phase 3 (month 2): migrate new clients to `/v2/feed`
- Web/mobile v2 uses `after`/`before` with `start_cursor`/`end_cursor`.
- Monitor adoption and scrolling behavior.

Phase 4 (month 3+): sunset `/v1/feed`
- After old traffic drops below a threshold (example: `<5%`), return `410 Gone` with an upgrade message.

Why the `page >= 50` guard?
- Perfect backward compatibility for very deep pages would require using deep OFFSET to “recreate” a cursor boundary.
- The assignment explicitly prioritizes fixing the performance/mechanics issue, so deep `OFFSET` is intentionally blocked.

## PostgreSQL schema

Run migrations:

- `sql/schema.sql` creates:
  - `posts(id, user_id, created_at, body)`
  - composite index `(user_id, created_at DESC, id DESC)`

The composite index is the key to making the tuple predicates and the cursor order fast.

## Focus Questions (required by PRD)

### Q1: What does the cursor encode and why is that right given backdated inserts?

The cursor encodes a composite coordinate `(created_at, id)`.

Timestamp alone is insufficient because multiple posts can share the same `created_at`. The `id` tie-breaker ensures the tuple ordering is unique and deterministic, including across pages when new rows arrive (including backdated inserts that are inserted after the user started scrolling).

### Q2: How do you prevent the cursor breaking on mid-session deletion?

The cursor encodes a logical coordinate (timestamp + id), not a physical row offset.

If the row corresponding to the cursor is deleted, the WHERE predicate still defines a consistent logical boundary:

- the deleted row simply isn’t returned
- pagination continues without producing an error or a broken “cursor chain”

### Q3: What consistency guarantees does your pagination provide?

Provided guarantees:

- No duplicates across pages.
- No boundary skips caused by inserts/deletes between requests.

Not guaranteed (by design / trade-off):

- A stable snapshot across the entire scroll session.
- Retroactive insertion behavior inside pages the client already fetched.
- Accurate total counts.

### Q4: Why is total-count hard, and how would you approach it?

`COUNT(*)` on a 120M-row table is expensive (typically requires scanning a large portion of the table, even with indexes), and it becomes stale immediately on a live feed because inserts/deletes keep happening.

Approach:

- return `has_next_page` / `has_previous_page` booleans only
- if UI needs an approximate total, maintain a counter table updated asynchronously (triggers or a background job), never counting per-request.

## Implementation notes

Main files:

- `src/cursor.js`: cursor encode/decode (base64url(JSON))
- `src/db.js`: keyset/cursor feed queries and the v1 adapter
- `src/routes/feed.js`: REST parsing/validation and response formatting

## Running locally

1. Install dependencies
   - `npm install`
2. Start Postgres
   - `docker compose up -d`
3. Configure environment
   - copy content of `.env.example` to `.env` (then adjust `DATABASE_URL` if needed)
   * We are currently using 'postgresql://app:app@localhost'
4. Migrate + seed
   - `npm run migrate`
   - `npm run seed`
5. Run API
   - `npm run dev`
6. Test by either using browser or Postman:
   - First Request: http://localhost:3000/v2/feed?user_id=1&limit=10
   - Second Request (scroll older): http://localhost:3000/v2/feed?user_id=1&limit=10&after=`end_cursor`
   - Second Request (scroll newer): http://localhost:3000/v2/feed?user_id=1&limit=10&before=`start_cursor`

## Tests

Integration tests are included (Jest) and exercise:

- empty feed
- single page
- deleted post cursor does not break pagination
- identical `created_at` timestamps paginate correctly via the `id` tie-breaker
- backdated inserts appear on the next page boundary (no skip)

Run:
1. For Mac/Linux:
- `TEST_DATABASE_URL=postgresql://app:app@localhost:5432/cursorpage npm test`

2. For window:
- `$env:TEST_DATABASE_URL="postgresql://app:app@localhost:5432/cursorpage"; npm test`