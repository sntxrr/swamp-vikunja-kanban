# @sntxrr/vikunja-kanban

A Swamp model for creating and listing tasks in a self-hosted [Vikunja](https://vikunja.io/) instance via its REST API.

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

Creates a task in the configured project. Optionally attaches an existing label by name (`Urgent`, `High`, or `Medium` — must already exist on the Vikunja instance; this model never creates labels). By default, skips creation if a non-done task with the exact same title already exists in the project (best-effort idempotency; Vikunja has no native idempotency-key concept).

```sh
swamp model method run homelab-backlog new_task \
  --arg title="Replace failing UPS battery" \
  --arg label=Urgent
```

### `list_recent`

Lists the most recently created tasks in the configured project (excludes done tasks by default).

```sh
swamp model method run homelab-backlog list_recent --arg limit=10
```

## Resources

- `vikunjaTask` — one record per task: id, title, description, done, priority, labels, due date, timestamps.
- `summary` — per-listing summary: scope, endpoint, total count, item ids.

## Notes

- Auth: `Authorization: Bearer <token>`.
- Rate limiting: retries transparently on HTTP 429 (`maxRetries`, default 5), honoring `Retry-After`.
- Label resolution: `new_task` calls `GET /labels` to map a label name to its numeric id before attaching it via `PUT /tasks/{id}/labels`. If the label doesn't exist, the task is still created — a warning is logged, not an error.
