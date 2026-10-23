/**
 * Vikunja tracker for @swamp/stagecraft — lets a stagecraft factory publish
 * its work items to a Vikunja project as cards: it files and reads cards,
 * comments on them, moves them between kanban buckets, relates them and
 * assigns them.
 *
 * It is written against stagecraft's tracker contract, version 1 (the
 * writing-a-tracker guide, TRACKERS.md, shipped in @swamp/stagecraft), and
 * shares no code with stagecraft. Like every such tracker it has two
 * methods:
 *
 * - describe records what the tracker is (`vikunja`, contract 1, which
 *   optional operations it offers), for stagecraft's publisher to bind to.
 * - operate makes one operation and writes its answer under the name it is
 *   given. An answer that succeeded is never made again, and every failure
 *   is an answer (auth / not_found / rate_limited / invalid / upstream),
 *   never a throw.
 *
 * How Vikunja carries the contract:
 *
 * - A ticket is a task in the configured project. Its stable id is the task
 *   id ("515"); its display id is the task's identifier ("#493", or "ST-3"
 *   when the project has an identifier), resolved through
 *   GET /projects/{id}/tasks/by-index/{index}. A task in another project is
 *   not_found, so a tracker bound to a test project cannot touch any other.
 * - A status is a bucket of the project's kanban view, by title. Moving into
 *   the view's done bucket marks the task done, as Vikunja does itself.
 * - A type is a label, by title; create attaches it.
 * - Relations map onto Vikunja's relation kinds, which Vikunja keeps on both
 *   tasks: parent_of = subtask/parenttask, blocked_by = blocked/blocking,
 *   duplicate_of = duplicateof/duplicates. Vikunja's `related` is symmetric,
 *   so the tracker records which side related_to was written from; one made
 *   by hand in the UI reads as outgoing from the lower task id. The
 *   contract's relation rules (one parent, no cycles, no duplicate chains)
 *   are checked here, because Vikunja checks none of them.
 * - Comments and descriptions are stored as given (stagecraft writes
 *   markdown) and read back unchanged.
 *
 * The API token is a sensitive global argument, wired from a vault, and
 * never appears in a request record, an answer or a log line.
 *
 * @module
 */
import { z } from "npm:zod@4";

const TRACKER = "vikunja";

// ============================================================================
// Global arguments
// ============================================================================

const GlobalArgsSchema = z.object({
  baseUrl: z.string().min(1).describe(
    "Base URL of the Vikunja instance (no trailing slash, no /api/v1).",
  ),
  webBaseUrl: z.string().optional().describe(
    "Base URL the web UI is reached at, used only for ticket links. " +
      "Defaults to baseUrl.",
  ),
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
    "Vikunja API token (Bearer), wired from a vault. Needs the tasks, " +
      "tasks_comments, tasks_labels, tasks_relations, tasks_assignees and " +
      "projects (tasks_by_index, views_buckets_tasks, projectusers) groups.",
  ),
  projectId: z.number().int().positive().describe(
    "The Vikunja project this tracker files and reads tickets in. Tasks in " +
      "any other project are not_found.",
  ),
  assignee: z.string().optional().describe(
    "Username publish assigns a ticket to when work on it starts. Leave " +
      "unset to assign no one.",
  ),
  timeoutMs: z.number().int().positive().default(15_000).describe(
    "Per-request fetch timeout in milliseconds.",
  ),
  maxRetries: z.number().int().min(0).max(10).default(3).describe(
    "How many times to retry a request after an HTTP 429 response before " +
      "answering rate_limited.",
  ),
  userAgent: z.string().default(
    "swamp-vikunja-kanban-tracker/1.0 (+https://swamp-club.com)",
  ).describe("User-Agent header sent on all outbound requests."),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ============================================================================
// Failures
// ============================================================================

export type FailureKind =
  | "auth"
  | "not_found"
  | "rate_limited"
  | "invalid"
  | "upstream";

/** A failure as the contract reports it: one of five kinds and a detail. */
export class Failure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly detail: string,
    readonly reason?: "unreachable",
  ) {
    super(detail);
  }
}

/** The failure kind an HTTP status maps to. */
export function kindOfStatus(status: number): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 409 || status === 412 || status === 422) {
    return "invalid";
  }
  return "upstream";
}

// ============================================================================
// HTTP
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One authenticated Vikunja request, returning parsed JSON. Retries HTTP 429
 * up to maxRetries; any other non-2xx, a timeout or a network error is a
 * Failure of the matching kind. The detail names the method, path and
 * status, plus Vikunja's own message, and never the token.
 */
async function vk(
  g: GlobalArgs,
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  opts: { search?: Record<string, string>; body?: unknown } = {},
): Promise<unknown> {
  const base = g.baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Failure("invalid", "baseUrl must start with http:// or https://");
  }
  const url = new URL(`${base}/api/v1${path}`);
  for (const [k, v] of Object.entries(opts.search ?? {})) {
    url.searchParams.set(k, v);
  }
  for (let attempt = 0;; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), g.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          "Authorization": `Bearer ${g.apiToken}`,
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": g.userAgent,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new Failure(
        "upstream",
        `${method} ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 && attempt < g.maxRetries) {
      await res.body?.cancel().catch(() => {});
      const secs = Number(res.headers.get("Retry-After"));
      await sleep(Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let message = "";
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.message === "string") message = parsed.message;
      } catch {
        message = text.slice(0, 200);
      }
      throw new Failure(
        kindOfStatus(res.status),
        `${method} ${path}: ${res.status} ${res.statusText}` +
          (message ? ` — ${message.slice(0, 200)}` : ""),
      );
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text === "" ? null : JSON.parse(text);
  }
}

type Raw = Record<string, unknown>;

function asArray(json: unknown): Raw[] {
  return Array.isArray(json) ? json as Raw[] : [];
}

/** Every page of a paged list (Vikunja caps a page at 50 by default). */
async function allPages(
  g: GlobalArgs,
  path: string,
  search: Record<string, string> = {},
): Promise<Raw[]> {
  const out: Raw[] = [];
  const seen = new Set<unknown>();
  for (let page = 1; page <= 50; page++) {
    const items = asArray(
      await vk(g, "GET", path, {
        search: { ...search, page: String(page), per_page: "50" },
      }),
    );
    const fresh = items.filter((i) => !seen.has(i.id));
    for (const i of fresh) seen.add(i.id);
    out.push(...fresh);
    if (fresh.length === 0 || items.length < 50) return out;
  }
  return out;
}

// ============================================================================
// Tickets
// ============================================================================

/** A ticket reference, as stagecraft passes one: stable id or display id. */
export function parseRef(
  ref: string,
): { taskId: number } | { index: number } | null {
  const trimmed = ref.trim();
  if (/^\d+$/.test(trimmed)) return { taskId: Number(trimmed) };
  const display = /^(?:#|[A-Za-z0-9]+-)(\d+)$/.exec(trimmed);
  return display === null ? null : { index: Number(display[1]) };
}

export function displayOf(task: Raw): string {
  return typeof task.identifier === "string" && task.identifier !== ""
    ? task.identifier
    : `#${task.index}`;
}

const RELATION_TYPES = [
  "parent_of",
  "blocked_by",
  "related_to",
  "duplicate_of",
] as const;
type RelationType = typeof RELATION_TYPES[number];

export interface Relation {
  type: RelationType;
  direction: "outgoing" | "incoming";
  issue: string;
  display: string;
}

/** The Vikunja kind a relation is written as, from the side it starts on. */
const KIND_OF: Record<RelationType, string> = {
  parent_of: "subtask",
  blocked_by: "blocked",
  related_to: "related",
  duplicate_of: "duplicateof",
};

/** How each Vikunja kind on a task reads as a contract relation. */
const READ_AS: Record<string, [RelationType, Relation["direction"]]> = {
  subtask: ["parent_of", "outgoing"],
  parenttask: ["parent_of", "incoming"],
  blocked: ["blocked_by", "outgoing"],
  blocking: ["blocked_by", "incoming"],
  duplicateof: ["duplicate_of", "outgoing"],
  duplicates: ["duplicate_of", "incoming"],
};

/** Where a related_to was written from, as the tracker recorded it. */
export interface RelatedRecord {
  from: number;
  to: number;
}

export function relatedName(a: number, b: number): string {
  return `related-${Math.min(a, b)}-${Math.max(a, b)}`;
}

/**
 * A task's relations in the contract's terms. Kinds the contract has no
 * word for (precedes, follows, copiedfrom, copiedto) are not read.
 */
export function relationsOf(
  task: Raw,
  related: (other: number) => RelatedRecord | null,
): Relation[] {
  const self = task.id as number;
  const map = (task.related_tasks ?? {}) as Record<string, unknown>;
  const out: Relation[] = [];
  for (const [kind, others] of Object.entries(map)) {
    for (const other of asArray(others)) {
      const id = other.id as number;
      let read: [RelationType, Relation["direction"]] | undefined;
      if (kind === "related") {
        const rec = related(id);
        const outgoing = rec === null ? self < id : rec.from === self;
        read = ["related_to", outgoing ? "outgoing" : "incoming"];
      } else {
        read = READ_AS[kind];
      }
      if (read === undefined) continue;
      out.push({
        type: read[0],
        direction: read[1],
        issue: String(id),
        display: displayOf(other),
      });
    }
  }
  return out.sort((a, b) =>
    `${a.type} ${a.direction} ${a.issue}`.localeCompare(
      `${b.type} ${b.direction} ${b.issue}`,
    )
  );
}

interface Bucket {
  id: number;
  title: string;
}

interface Ctx {
  globalArgs: Record<string, unknown>;
  readResource(name: string): Promise<Raw | null>;
  writeResource(spec: string, name: string, data: Raw): Promise<unknown>;
  logger?: { info(message: string, props?: Record<string, unknown>): void };
}

/** One operation's view of the tracker: its project, view and buckets. */
class Board {
  private view?: { id: number; buckets: Bucket[] };

  constructor(readonly g: GlobalArgs, readonly ctx: Ctx) {}

  async kanban(): Promise<{ id: number; buckets: Bucket[] }> {
    if (this.view !== undefined) return this.view;
    const p = this.g.projectId;
    const views = asArray(await vk(this.g, "GET", `/projects/${p}/views`));
    const kanban = views.find((v) => v.view_kind === "kanban");
    if (kanban === undefined || typeof kanban.id !== "number") {
      throw new Failure("invalid", `project ${p} has no kanban view`);
    }
    const buckets = asArray(
      await vk(this.g, "GET", `/projects/${p}/views/${kanban.id}/buckets`),
    ).filter((b) => typeof b.id === "number" && typeof b.title === "string")
      .map((b) => ({ id: b.id as number, title: b.title as string }));
    this.view = { id: kanban.id, buckets };
    return this.view;
  }

  /** The task a reference names, in this tracker's project. */
  async task(ref: string): Promise<Raw> {
    const parsed = parseRef(ref);
    if (parsed === null) {
      throw new Failure("not_found", `'${ref}' is not a Vikunja task id`);
    }
    const p = this.g.projectId;
    const raw = "taskId" in parsed
      ? await vk(this.g, "GET", `/tasks/${parsed.taskId}`, {
        search: { expand: "buckets" },
      })
      : await vk(
        this.g,
        "GET",
        `/projects/${p}/tasks/by-index/${parsed.index}`,
        { search: { expand: "buckets" } },
      );
    const task = raw as Raw;
    if (task?.project_id !== p) {
      throw new Failure("not_found", `no task ${ref} in project ${p}`);
    }
    return task;
  }

  async status(task: Raw): Promise<{ id: string; name: string }> {
    const view = await this.kanban();
    const here = asArray(task.buckets).find((b) =>
      b.project_view_id === view.id
    );
    const bucket = view.buckets.find((b) => b.id === here?.id);
    return bucket === undefined
      ? { id: "", name: "" }
      : { id: String(bucket.id), name: bucket.title };
  }

  async related(self: number, other: number): Promise<RelatedRecord | null> {
    const rec = await this.ctx.readResource(relatedName(self, other));
    return rec !== null && typeof rec.from === "number" &&
        typeof rec.to === "number"
      ? { from: rec.from, to: rec.to }
      : null;
  }

  async relations(task: Raw): Promise<Relation[]> {
    const records = new Map<number, RelatedRecord | null>();
    for (const other of asArray((task.related_tasks as Raw)?.related)) {
      const id = other.id as number;
      records.set(id, await this.related(task.id as number, id));
    }
    return relationsOf(task, (id) => records.get(id) ?? null);
  }

  /** The contract's ticket for a task. */
  async ticket(task: Raw): Promise<Raw> {
    const id = task.id as number;
    const comments = await allPages(this.g, `/tasks/${id}/comments`);
    const web = (this.g.webBaseUrl ?? this.g.baseUrl).replace(/\/+$/, "");
    return {
      id: String(id),
      display: displayOf(task),
      title: task.title,
      url: `${web}/tasks/${id}`,
      status: await this.status(task),
      relations: await this.relations(task),
      description: typeof task.description === "string" ? task.description : "",
      labels: asArray(task.labels).map((l) => l.title).filter((t) =>
        typeof t === "string"
      ),
      assignees: asArray(task.assignees).map((u) => u.username).filter((u) =>
        typeof u === "string"
      ),
      createdAt: task.created,
      updatedAt: task.updated,
      activity: comments
        .map((c) => ({
          kind: "comment",
          id: String(c.id),
          ...(typeof (c.author as Raw)?.username === "string"
            ? { author: (c.author as Raw).username }
            : {}),
          body: c.comment,
          at: c.created,
        }))
        .sort((a, b) =>
          Date.parse(a.at as string) - Date.parse(b.at as string) ||
          Number(a.id) - Number(b.id)
        ),
    };
  }
}

// ============================================================================
// Operations
// ============================================================================

function text(request: Raw, operation: string, name: string): string {
  const value = request[name];
  if (typeof value !== "string" || value === "") {
    throw new Failure("invalid", `${operation} needs ${name}`);
  }
  return value;
}

/**
 * The contract's relation rules, checked before anything is written.
 * Returns true when the relation is already there (nothing to write).
 */
async function checkRelate(
  board: Board,
  from: Raw,
  type: RelationType,
  to: Raw,
): Promise<boolean> {
  const fromId = String(from.id);
  const toId = String(to.id);
  if (fromId === toId) {
    throw new Failure("invalid", `${displayOf(from)} cannot relate to itself`);
  }
  const fromRel = await board.relations(from);
  const toRel = await board.relations(to);
  if (type === "related_to") {
    // Vikunja keeps one symmetric link: either direction is "related".
    if (fromRel.some((r) => r.type === type && r.issue === toId)) return true;
  } else if (
    fromRel.some((r) =>
      r.type === type && r.direction === "outgoing" && r.issue === toId
    )
  ) {
    return true;
  }
  const parentOf = (rels: Relation[]) =>
    rels.find((r) => r.type === "parent_of" && r.direction === "incoming");
  if (type === "parent_of") {
    const existing = parentOf(toRel);
    if (existing !== undefined) {
      throw new Failure(
        "invalid",
        `${displayOf(to)} already has a parent, ${existing.display}`,
      );
    }
    // Walk up from the new parent, 10 deep: meeting the child is a cycle.
    let up = parentOf(fromRel);
    for (let depth = 0; up !== undefined && depth < 10; depth++) {
      if (up.issue === toId) {
        throw new Failure("invalid", "that would form a circular parent chain");
      }
      up = parentOf(await board.relations(await board.task(up.issue)));
    }
  }
  if (type === "duplicate_of") {
    const dupOut = (rels: Relation[]) =>
      rels.some((r) => r.type === "duplicate_of" && r.direction === "outgoing");
    if (dupOut(fromRel)) {
      throw new Failure("invalid", `${displayOf(from)} is already a duplicate`);
    }
    if (dupOut(toRel)) {
      throw new Failure("invalid", `${displayOf(to)} is itself a duplicate`);
    }
    if (
      fromRel.some((r) =>
        r.type === "duplicate_of" && r.direction === "incoming"
      )
    ) {
      throw new Failure(
        "invalid",
        `${displayOf(from)} has duplicates of its own`,
      );
    }
  }
  return false;
}

async function perform(
  board: Board,
  operation: string,
  request: Raw,
): Promise<Raw> {
  const g = board.g;
  const need = (name: string) => text(request, operation, name);
  switch (operation) {
    case "fetch_issue":
      return await board.ticket(await board.task(need("issue")));

    case "create": {
      const type = need("type");
      const labels = await allPages(g, "/labels");
      const label = labels.find((l) =>
        typeof l.title === "string" &&
        l.title.toLowerCase() === type.toLowerCase()
      );
      if (label === undefined) {
        throw new Failure(
          "invalid",
          `no type '${type}': ${labels.map((l) => l.title).sort().join(", ")}`,
        );
      }
      const created = await vk(g, "PUT", `/projects/${g.projectId}/tasks`, {
        body: {
          title: need("title"),
          description: typeof request.body === "string" ? request.body : "",
        },
      }) as Raw;
      if (typeof created?.id !== "number") {
        throw new Failure("upstream", "task create returned no id");
      }
      try {
        await vk(g, "PUT", `/tasks/${created.id}/labels`, {
          body: { label_id: label.id },
        });
      } catch (e) {
        throw new Failure(
          "upstream",
          `task ${created.id} was created but its type label could not be ` +
            `attached: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      return await board.ticket(await board.task(String(created.id)));
    }

    case "comment": {
      const task = await board.task(need("issue"));
      const made = await vk(g, "PUT", `/tasks/${task.id}/comments`, {
        body: { comment: need("body") },
      }) as Raw;
      if (made?.id === undefined) {
        throw new Failure("upstream", "comment create returned no id");
      }
      return { id: String(made.id) };
    }

    case "set_status": {
      const name = need("status");
      const view = await board.kanban();
      const bucket = view.buckets.find((b) =>
        b.title.toLowerCase() === name.toLowerCase()
      );
      if (bucket === undefined) {
        throw new Failure(
          "invalid",
          `no status '${name}': ${view.buckets.map((b) => b.title).join(", ")}`,
        );
      }
      const task = await board.task(need("issue"));
      const target = { id: String(bucket.id), name: bucket.title };
      if ((await board.status(task)).id === target.id) {
        return { changed: false, status: target };
      }
      await vk(
        g,
        "POST",
        `/projects/${g.projectId}/views/${view.id}/buckets/${bucket.id}/tasks`,
        {
          body: {
            task_id: task.id,
            bucket_id: bucket.id,
            project_view_id: view.id,
          },
        },
      );
      const after = await board.status(await board.task(String(task.id)));
      if (after.id !== target.id) {
        throw new Failure(
          "upstream",
          `moved task ${task.id} to '${bucket.title}' but it reads back in ` +
            `'${after.name}'`,
        );
      }
      return { changed: true, status: target };
    }

    case "relate":
    case "unrelate": {
      const parsed = z.enum(RELATION_TYPES).safeParse(request.type);
      if (!parsed.success) {
        throw new Failure(
          "invalid",
          `no relation type '${String(request.type)}': ${
            RELATION_TYPES.join(", ")
          }`,
        );
      }
      const type = parsed.data;
      const from = await board.task(need("issue"));
      const to = await board.task(need("to"));
      const kind = KIND_OF[type];
      if (operation === "relate") {
        if (await checkRelate(board, from, type, to)) {
          return { changed: false };
        }
        await vk(g, "PUT", `/tasks/${from.id}/relations`, {
          body: { other_task_id: to.id, relation_kind: kind },
        });
        if (type === "related_to") {
          await board.ctx.writeResource(
            "relation",
            relatedName(from.id as number, to.id as number),
            { from: from.id, to: to.id },
          );
        }
        return { changed: true };
      }
      const has = (await board.relations(from)).some((r) =>
        r.type === type && r.direction === "outgoing" &&
        r.issue === String(to.id)
      );
      if (!has) return { changed: false };
      await vk(g, "DELETE", `/tasks/${from.id}/relations/${kind}/${to.id}`);
      return { changed: true };
    }

    case "assign": {
      const user = need("user");
      const task = await board.task(need("issue"));
      const status = (await board.status(task)).name;
      const already = asArray(task.assignees).some((u) =>
        typeof u.username === "string" &&
        u.username.toLowerCase() === user.toLowerCase()
      );
      if (already) return { changed: false, user, status, dropped: [] };
      const found = asArray(
        await vk(g, "GET", `/projects/${g.projectId}/projectusers`, {
          search: { s: user },
        }),
      ).find((u) =>
        typeof u.username === "string" &&
        u.username.toLowerCase() === user.toLowerCase()
      );
      if (found === undefined || typeof found.id !== "number") {
        throw new Failure(
          "invalid",
          `no user '${user}' with access to project ${g.projectId}`,
        );
      }
      await vk(g, "PUT", `/tasks/${task.id}/assignees`, {
        body: { user_id: found.id },
      });
      return { changed: true, user, status, dropped: [] };
    }

    default:
      throw new Failure(
        "invalid",
        `the vikunja tracker does not offer '${operation}'`,
      );
  }
}

// ============================================================================
// Model
// ============================================================================

const OPERATIONS = [
  "fetch_issue",
  "create",
  "comment",
  "set_status",
  "relate",
  "unrelate",
  "post_entry",
  "set_type",
  "assign",
  "link_pr",
] as const;

const AnswerSchema = z.object({ ok: z.boolean() }).passthrough();

/** The answer operate writes for one operation: its result or its failure. */
export async function answerFor(
  ctx: Ctx,
  operation: string,
  request: Raw | string,
  run: string | undefined,
): Promise<Raw> {
  const runField = run === undefined ? {} : { run };
  try {
    let parsed: Raw;
    try {
      parsed = typeof request === "string" ? JSON.parse(request) : request;
    } catch {
      throw new Failure("invalid", "the request is not a JSON object");
    }
    if (
      parsed === null || typeof parsed !== "object" || Array.isArray(parsed)
    ) {
      throw new Failure("invalid", "the request is not a JSON object");
    }
    const board = new Board(GlobalArgsSchema.parse(ctx.globalArgs), ctx);
    const result = await perform(board, operation, parsed);
    return { operation, ...runField, ok: true, result };
  } catch (error) {
    const failure = error instanceof Failure
      ? error
      : new Failure("upstream", String(error));
    return {
      operation,
      ...runField,
      ok: false,
      kind: failure.kind,
      ...(failure.reason === undefined ? {} : { reason: failure.reason }),
      detail: failure.detail,
    };
  }
}

export const model = {
  type: "@sntxrr/vikunja-kanban/tracker" as const,
  version: "2026.10.23.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    answer: {
      description: "operate's answers, under the names stagecraft gave them",
      schema: AnswerSchema,
      lifetime: "infinite" as const,
      garbageCollection: "30d",
    },
    description: {
      description: "What this tracker says of itself, for stagecraft to bind",
      schema: z.object({ tracker: z.string() }).passthrough(),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    relation: {
      description:
        "Which side a related_to was written from (Vikunja's related is " +
        "symmetric)",
      schema: z.object({ from: z.number().int(), to: z.number().int() }),
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    describe: {
      description: "Record what this tracker is, for stagecraft to bind to",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Ctx) => {
        const g = GlobalArgsSchema.parse(ctx.globalArgs);
        const handle = await ctx.writeResource("description", "description", {
          tracker: TRACKER,
          contract: 1,
          origin: "snapshot",
          capabilities: { history: false, assign: true, pullRequests: false },
          closesDuplicates: false,
          ...(g.assignee === undefined ? {} : { assignee: g.assignee }),
        });
        return { dataHandles: [handle] };
      },
    },
    operate: {
      description:
        "Make one tracker operation and write its answer under the given " +
        "name; an answer that succeeded is never made again",
      arguments: z.object({
        operation: z.enum(OPERATIONS),
        request: z.union([z.record(z.string(), z.unknown()), z.string()]),
        answer: z.string().regex(/^answer-[A-Za-z0-9._-]+$/),
        run: z.string().optional(),
      }),
      execute: async (
        args: {
          operation: string;
          request: Raw | string;
          answer: string;
          run?: string;
        },
        ctx: Ctx,
      ) => {
        const prior = await ctx.readResource(args.answer);
        if (prior?.ok === true) return { dataHandles: [] };
        const answer = await answerFor(
          ctx,
          args.operation,
          args.request,
          args.run,
        );
        ctx.logger?.info("operate {operation}: {outcome}", {
          operation: args.operation,
          outcome: answer.ok ? "ok" : answer.kind,
        });
        const handle = await ctx.writeResource("answer", args.answer, answer);
        return { dataHandles: [handle] };
      },
    },
  },
};
