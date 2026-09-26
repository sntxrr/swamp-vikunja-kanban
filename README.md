# @sntxrr/vikunja-kanban

A Swamp model for creating, listing, auditing and ordering tasks in a self-hosted [Vikunja](https://vikunja.io/) instance via its REST API — the deterministic half of keeping a kanban backlog **agent-ready**.

Built as a homelab-native replacement for `@webframp/hermes-kanban-orchestrator` (which shells out to the `hermes` CLI and only runs on Linux). This model talks to Vikunja directly over HTTP with `fetch`, runs on any platform Deno supports (including macOS/darwin-aarch64), and has no dependency on a Hermes binary being present.

## Setup

1. Generate a personal API token in Vikunja: **Settings > API Tokens**.
2. Store it in a Swamp vault (never inline it in a model definition):

   ```sh
   swamp vault create <type> vikunja
   swamp vault put vikunja API_TOKEN
   ```

3. Pull the extension and create a model instance. Reference the vaulted
   token using Swamp's vault-get expression syntax in the model's
   `apiToken` global argument (see `swamp vault --help` for the exact
   expression form supported by your Swamp version) rather than pasting
   the token in plain text:

   ```sh
   swamp extension pull @sntxrr/vikunja-kanban
   swamp model create @sntxrr/vikunja-kanban homelab-backlog \
     --global-arg baseUrl=https://vikunja.example.com \
     --global-arg apiToken=REPLACE_WITH_VAULT_EXPRESSION_FOR_vikunja_API_TOKEN \
     --global-arg projectId=5
   ```

## Methods

### `new_task`

Creates a task in the configured project (or in `projectId` if given) and places it into a named kanban bucket. Optionally attaches existing labels by title: `label` (one) and/or `labels` (a list), case-insensitive. Every label must already exist on the Vikunja instance (this model never creates labels), and all of them are resolved **before** the task is created, so an unknown label fails with nothing created. By default, skips creation if a non-done task with the exact same title already exists in the project (best-effort idempotency; Vikunja has no native idempotency-key concept).

```sh
swamp model method run homelab-backlog new_task \
  --arg title="Replace failing UPS battery" \
  --arg label=security

# land it in a specific column instead of the default bucket
swamp model method run homelab-backlog new_task \
  --arg title="Investigate flaky switch uplink" \
  --arg bucketName=Next

# target a different project for this call only
swamp model method run homelab-backlog new_task \
  --arg title="Renew domain" \
  --arg projectId=7 \
  --arg bucketName=Backlog

# several labels: pass the arguments as a JSON (or YAML) file
echo '{"title":"Rotate the B2 key","labels":["backups","tier-B"],"bucketName":"Next","priority":3}' > t.json
swamp model method run homelab-backlog new_task --input-file t.json
```

#### Bucket placement

Vikunja puts a newly created task into the kanban view's default bucket, and when a view has no default configured that is the lowest-positioned column — often a "Doing" column, which is the wrong place for automation-created work. `new_task` therefore always moves the task into a named bucket:

- `defaultBucketName` (global, default `Backlog`) — bucket every task goes to unless overridden.
- `bucketName` (per call) — override for one call. Set either to an empty string to disable placement.
- The project's kanban view is discovered automatically via `GET /projects/{id}/views`; `viewId` is only an optional override for the default project.
- The bucket is resolved (case-insensitive) **before** the task is created. An unknown bucket name is an error listing the available buckets, and nothing is created. If the move itself fails after creation, that is also an error (naming the task id) — never a silent fallback to the default column.
- A project with no kanban view logs a warning and skips placement.

### `list_recent`

Lists the most recently created tasks in the configured project, or in `projectId` if given (excludes done tasks by default).

```sh
swamp model method run homelab-backlog list_recent --arg limit=10
```

### `audit`

Read-only. Reads the whole kanban board (paginated per bucket — the view endpoint silently truncates any bucket longer than the server's `max_items_per_page` if you read one page) and reports **Definition-of-Ready findings** per card and per bucket, then writes them as a `boardAudit` resource. It changes nothing.

```sh
swamp model method run homelab-backlog audit
```

Rules, scoped by the **role** of the bucket the card sits in (`bucketRoles`, below):

| Rule | What it means | Severity in ready/doing/review | elsewhere |
|---|---|---|---|
| `empty-description` | no visible text | error | error |
| `short-description` | fewer than `policy.minDescriptionChars` visible chars | error | warn |
| `no-labels` / `missing-label-group` / `missing-area-label` | no labels; no label matching one of `requiredLabelPrefixes` (e.g. `tier-`); no label outside those groups | error | warn |
| `priority-unset` | priority 0 | error | warn |
| `missing-verdict` | none of `verdictMarkers` (default `CONFIRMED`/`DISSOLVED`/`MISSTATED`) in the description — the premise-check verdict | error | info |
| `missing-acceptance` | none of `acceptanceMarkers` (default `Acceptance`/`Proof`/`Done when`/`Verify`) | error | info |
| `missing-link` | no URL starting with `requiredLinkPrefix` (default `obsidian://`) | error | warn |
| `stale` | `updated` older than `policy.staleDays.<role>` (ready 14 d, doing 7 d, blocked 1 d, review 3 d); in the **waiting** column, the due date has passed (however recently the card was edited) | warn | — |
| `missing-due-date` | a card in the **waiting** column has no due date — the date is the only reason it is parked there | — | error (waiting) |
| `done-flag-mismatch` | `done` disagrees with the bucket | warn | warn |
| `out-of-order` (bucket) | not sorted by priority desc then age (waiting: by due day, then priority) — run `reorder` | warn | warn |
| `wip-exceeded` (bucket) | doing bucket holds more than `policy.wipLimit` (default 3) | warn | — |

The `ready` roll-up counts how many cards in the ready column have **zero error-level findings** — the number an executor agent can safely pull from.

### `reorder`

Sorts each non-done bucket by **priority descending** (5 = DO NOW first, 0 = unset last), then by age (`policy.tieBreak`, default oldest first). The **waiting** bucket is a calendar instead: soonest due **day** (UTC) on top — cards due the same day fall back to priority — and undated cards last. **Dry run by default** — it reports every card that is out of place and moves nothing.

```sh
swamp model method run homelab-backlog reorder                    # plan only
swamp model method run homelab-backlog reorder --arg apply=true   # do it
swamp model method run homelab-backlog reorder --arg apply=true --arg 'buckets=["Backlog"]'
```

With `apply=true` it moves **one card at a time** — read the bucket, move the first card that is out of place to the midpoint of its intended neighbours (`POST /tasks/{id}/position`), re-read, repeat — and fails if the board has not converged within `maxIterations`. It works this way because Vikunja re-derives positions on write, so a batch of absolute positions drifts (measured: 2 of 39 cards landed in the wrong slot with HTTP 200 on every call). A run that converges ends with a re-read that matches the intended order; a second dry run then reports 0 moves.

### `due_report`

Read-only. Treats a card's **due date as the day to look at it again**: reads the board and splits every dated, not-done card into *overdue*, *due today* and *upcoming* (due within `lookaheadDays`, default 7), by whole UTC calendar day. Writes a `dueReport` resource whose `message` is a ready-to-send Markdown list with a link per card, and `counts.actionable` (overdue + due today) is what a scheduled nudge should gate on.

```sh
swamp model method run homelab-backlog due_report
swamp model method run homelab-backlog due_report --arg lookaheadDays=14
swamp model method run homelab-backlog due_report --arg now=2026-09-26T15:30:00Z   # what would fire on that day
```

Cards in the done bucket, cards with `done: true`, and cards whose due date is Vikunja's zero time (`0001-01-01…`, which is how it reports "unset") are ignored. Links use `webBaseUrl` when set, else `baseUrl` — set it when the API is called on an internal address but links should open the public one.

### `set_due_date`

Sets (or clears, with an empty string) one card's due date — the day to look at it again.

```sh
swamp model method run homelab-backlog set_due_date --arg taskId=62 --arg dueDate=2026-11-04T17:00:00Z
swamp model method run homelab-backlog set_due_date --arg taskId=62 --arg dueDate=""     # clear
```

`POST /tasks/{id}` is a **full replace** in Vikunja, so this reads the whole task, changes only `due_date`, writes the whole task back, then re-reads and asserts that the date took **and** that the card is still in the same kanban bucket. Done cards are refused. The result is recorded as a `vikunjaTask` resource.

### Editing existing cards: `update_task`, `set_labels`, `move_task`, `close_task`

```sh
swamp model method run homelab-backlog update_task --arg taskId=62 --arg priority=4
swamp model method run homelab-backlog update_task --input-file desc.json   # {"taskId":62,"description":"<p>…</p>"}
swamp model method run homelab-backlog set_labels  --input-file l.json      # {"taskId":62,"add":["tier-B"],"remove":["tier-C"]}
swamp model method run homelab-backlog move_task   --arg taskId=62 --arg bucketName=Next
swamp model method run homelab-backlog close_task  --arg taskId=62 --arg humanInstructed=true
```

- **`update_task`** changes `title`, `description` and/or `priority`. It reads the full task, writes it back with only those fields changed, re-reads, and asserts every field took. If the write dropped the card out of its bucket, it moves the card back and verifies that too. An empty description is refused.
- **`set_labels`** attaches (`add`) and detaches (`remove`) labels by title through the label endpoints, so the task body is never rewritten. Every title in either list must exist on the instance, so a typo fails instead of reading as "removed". A title in both lists is refused.
- **`move_task`** moves a card into a named bucket and reads the placement back from the view. The done bucket is refused. Run it **after** field edits: a full-replace write can drop a card out of its bucket.
- **`close_task`** sets `done: true`, moves the card into the done bucket, and reads both back. It refuses to run unless `humanInstructed: true`: closing a card is a person's decision. It is safe to re-run on a card that is already closed.

**Guards.** `update_task`, `set_labels` and `move_task` refuse done cards, and cards updated within `policy.recentEditMinutes` (default 60) by anything other than this model. A card counts as this model's own when its `updated` matches the one recorded in its `task-<id>` resource by the model's last write, so a card the model just created or edited can be edited again straight away. Pass `force: true` to override; set the policy to `0` to turn the guard off.

### Board shape and thresholds

Two global arguments describe the board; every field has a default, so set only what differs.

```yaml
globalArguments:
  bucketRoles: { backlog: Backlog, ready: Next, doing: Doing, blocked: Blocked, waiting: Waiting, review: Review, done: Done }
  policy:
    wipLimit: 3
    staleDays: { ready: 14, doing: 7, blocked: 1, review: 3 }
    minDescriptionChars: 400
    verdictMarkers: [CONFIRMED, DISSOLVED, MISSTATED]
    acceptanceMarkers: [Acceptance, Proof, "Done when", Verify]
    requiredLinkPrefix: "obsidian://"
    requiredLabelPrefixes: [tier-]
    tieBreak: oldest
    recentEditMinutes: 60
```

`waiting` is the column for cards whose only remaining step is a **date** — a scheduled run to observe, a snapshot-drop window, an expiry. Its due date means "look at it again on this day" (what `due_report` posts); the card is never stale before that day and always stale after it, and a waiting card with no due date is an error. Blocked is for cards, people and decisions, never for time.

## Resources

- `vikunjaTask` — one record per task: id, title, description, done, priority, labels, due date, timestamps, and (for `new_task`, `move_task` and `close_task`) the `placement` it was moved to (`viewId`, `bucketId`, `bucketTitle`).
- `summary` — per-listing summary: scope, endpoint, total count, item ids.
- `boardAudit` — one audit run: per-bucket counts and order state, every finding (`taskId`, `bucket`, `role`, `rule`, `severity`, `detail`), counts by rule and severity, and the ready-column roll-up.
- `reorderPlan` — one reorder run: the moves planned or performed (`taskId`, `bucket`, `from`, `to`), `applied`, `iterations`, `converged`.
- `dueReport` — one due-date pass: `overdue`, `dueToday`, `upcoming` (each `id`, `title`, `bucket`, `dueDate`, `daysUntil`, `url`), `counts` (incl. `actionable`), the Markdown `message`, and `boardUrl`.

## Notes

- Auth: `Authorization: Bearer <token>`.
- Rate limiting: retries transparently on HTTP 429 (`maxRetries`, default 5), honoring `Retry-After`.
- `POST /tasks/{id}` is a **full replace** in Vikunja. Every method that writes a task body (`update_task`, `set_due_date`, `close_task`) reads the whole task, merges, writes the whole object back, and re-reads.
- Bucket moves use `POST /projects/{project}/views/{view}/buckets/{bucket}/tasks` (Vikunja ≥ 0.24 / v2.x).
- Labels: titles are mapped to ids with `GET /labels`, then attached with `PUT /tasks/{id}/labels` and detached with `DELETE /tasks/{id}/labels/{label}`; labels never go in the task body. An unknown title is always an error, raised before anything is written.
