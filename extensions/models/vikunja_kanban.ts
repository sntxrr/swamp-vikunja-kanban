/**
 * Vikunja Kanban — create and list tasks in a Vikunja project via its REST
 * API (https://vikunja.io/docs/), for homelab backlog automation.
 *
 * A Vikunja instance authenticates with a personal API token (JWT) sent as
 * `Authorization: Bearer <token>`. The token is generated from the user's
 * Settings > API Tokens page inside Vikunja and should be stored in a swamp
 * vault, never inline.
 *
 * This is a homelab-native replacement for @webframp/hermes-kanban-orchestrator:
 * instead of shelling out to `hermes kanban create`, it talks to Vikunja's
 * REST API directly with fetch. It creates tasks in a project (a configured
 * default, overridable per call), can attach an existing label by name, and
 * places each new task into a named kanban bucket (default "Backlog") so
 * automation-created tasks land in a backlog column rather than wherever
 * Vikunja's view default points — which, for a view with no default bucket
 * set, is the lowest-positioned column (typically "Doing").
 *
 * The project's kanban view is discovered automatically via
 * GET /projects/{id}/views (view_kind == "kanban"); no view id needs to be
 * configured. The bucket is resolved *before* the task is created, so a
 * misspelled bucket name fails fast with nothing created.
 *
 * @module
 */
import { z } from "npm:zod@4";

// ============================================================================
// Global arguments
// ============================================================================

const GlobalArgsSchema = z.object({
  baseUrl: z.string().min(1).describe(
    "Base URL of the Vikunja instance, e.g. https://vikunja.example.com " +
      "(no trailing slash, no /api/v1 suffix \u2014 that's added automatically).",
  ),
  apiToken: z.string().min(1).describe(
    "Vikunja personal API token (Bearer). Supply via a swamp vault " +
      "reference in the model definition's globalArguments — see README " +
      "for the exact vault-get syntax; never inline the raw token here.",
  ),
  projectId: z.number().int().positive().describe(
    "Default Vikunja project id tasks are created in and listed from (e.g. " +
      "the homelab backlog project). Override per call with the projectId " +
      "method argument.",
  ),
  viewId: z.number().int().positive().optional().describe(
    "Optional explicit kanban view id for the default projectId. Normally " +
      "leave unset: the kanban view is discovered automatically via " +
      "GET /projects/{id}/views. Only consulted when a call targets the " +
      "default project; per-call projectId overrides always auto-discover.",
  ),
  defaultBucketName: z.string().default("Backlog").describe(
    "Bucket title (case-insensitive) that new_task places tasks into by " +
      "default, so automation-created tasks land in a backlog column " +
      "instead of the view's default (typically a working/doing column). " +
      "Override per call with the bucketName method argument. Set to an " +
      "empty string to disable bucket placement entirely.",
  ),
  timeoutMs: z.number().int().positive().default(15_000).describe(
    "Per-request fetch timeout in milliseconds.",
  ),
  maxRetries: z.number().int().min(0).max(10).default(5).describe(
    "How many times to retry a request after an HTTP 429 rate-limit response.",
  ),
  userAgent: z.string().default(
    "swamp-vikunja-kanban/1.0 (+https://swamp-club.com)",
  ).describe("User-Agent header sent on all outbound requests."),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// ============================================================================
// Resource schemas
// ============================================================================

const LabelRefSchema = z.object({
  id: z.number(),
  title: z.string(),
  hex_color: z.string().nullable().optional(),
}).passthrough();

const VikunjaTaskSchema = z.object({
  id: z.number().describe("Vikunja task id."),
  title: z.string().describe("Task title."),
  description: z.string().nullable().optional().describe(
    "Task description/body.",
  ),
  done: z.boolean().nullable().optional().describe(
    "Whether the task is marked done.",
  ),
  priority: z.number().nullable().optional().describe(
    "Vikunja numeric priority (0-5).",
  ),
  labels: z.array(LabelRefSchema).nullable().optional().describe(
    "Labels currently attached to the task.",
  ),
  due_date: z.string().nullable().optional().describe(
    "ISO 8601 due date, if set.",
  ),
  project_id: z.number().nullable().optional().describe("Owning project id."),
  bucket_id: z.number().nullable().optional().describe(
    "Bucket id the task currently sits in, scoped to whichever view last " +
      "placed it.",
  ),
  placement: z.object({
    viewId: z.number(),
    bucketId: z.number(),
    bucketTitle: z.string(),
  }).optional().describe(
    "Kanban bucket this run placed the task into (absent when placement " +
      "was disabled or the task already existed).",
  ),
  created: z.string().nullable().optional().describe(
    "Creation timestamp from Vikunja.",
  ),
  updated: z.string().nullable().optional().describe(
    "Last-update timestamp from Vikunja.",
  ),
  fetchedAt: z.string().describe(
    "ISO 8601 timestamp when this record was written.",
  ),
  collectedBy: z.string().optional().describe(
    "Extension that collected this data.",
  ),
}).passthrough();

const SummarySchema = z.object({
  scope: z.string().describe(
    'Which listing produced this summary, e.g. "recent".',
  ),
  endpoint: z.string().describe("Resolved request path the items came from."),
  total: z.number().describe("Number of items written by this run."),
  ids: z.array(z.number()).default([]),
  fetchedAt: z.string(),
}).passthrough();

// ============================================================================
// Method argument schemas
// ============================================================================

const PriorityLabel = z.enum(["Urgent", "High", "Medium"]).describe(
  "Label name to attach to the task, resolved via GET /labels. Must " +
    "already exist on the Vikunja instance — this model never creates labels.",
);

const ProjectIdOverride = z.number().int().positive().optional().describe(
  "Target a different Vikunja project than the configured default projectId.",
);

const NewTaskArgsSchema = z.object({
  title: z.string().min(1, "title must not be empty").describe("Task title."),
  projectId: ProjectIdOverride,
  description: z.string().optional().describe(
    "Optional task description/body.",
  ),
  label: PriorityLabel.optional(),
  dueDate: z.string().optional().describe(
    "Optional ISO 8601 due date, e.g. 2026-09-20T00:00:00Z.",
  ),
  priority: z.number().int().min(0).max(5).optional().describe(
    "Optional Vikunja numeric priority override (0=unset .. 5=DO NOW).",
  ),
  bucketName: z.string().optional().describe(
    "Kanban bucket title (case-insensitive) to place the task into, " +
      "overriding the configured defaultBucketName. Must exist in the " +
      "target project's kanban view — resolved before the task is created, " +
      "so an unknown name fails with nothing created. Empty string " +
      "disables placement for this call.",
  ),
  skipIfTitleExists: z.boolean().default(true).describe(
    "If true (default), checks for a non-done task with the exact same " +
      "title in the project first and skips creation (idempotency without " +
      "a dedicated dedup key — Vikunja has no idempotency-key concept).",
  ),
});
type NewTaskArgs = z.infer<typeof NewTaskArgsSchema>;

const ListRecentArgsSchema = z.object({
  projectId: ProjectIdOverride,
  limit: z.number().int().min(1).max(50).default(10).describe(
    "Max results to return.",
  ),
  includeDone: z.boolean().default(false).describe(
    "Include tasks already marked done.",
  ),
});

// ============================================================================
// Execution context
// ============================================================================

interface ExecCtx {
  globalArgs: Record<string, unknown>;
  writeResource: (
    specName: string,
    instanceName: string,
    payload: unknown,
  ) => Promise<unknown>;
  logger?: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

// ============================================================================
// Helpers
// ============================================================================

/** Resolve the API base (no trailing slash) from the configured baseUrl. */
export function resolveBase(g: GlobalArgs): string {
  const trimmed = g.baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("Vikunja `baseUrl` resolves to an empty string.");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `Invalid Vikunja baseUrl "${g.baseUrl}": must start with http:// or https://.`,
    );
  }
  return `${trimmed}/api/v1`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute how long to back off (ms) from rate-limit headers, capped at 60s. */
export function backoffMs(res: Response): number {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.min(secs * 1000, 60_000);
    }
  }
  return 1_000;
}

/**
 * Perform an authenticated Vikunja API request and return parsed JSON.
 * Retries transparently on HTTP 429 up to `maxRetries`. Throws a redacted
 * error (never echoing the token) on any other non-2xx response.
 */
async function vreq(
  g: GlobalArgs,
  method: "GET" | "PUT" | "POST",
  path: string,
  opts?: { search?: Record<string, string>; body?: unknown },
): Promise<unknown> {
  const base = resolveBase(g);
  const url = new URL(base + path);
  if (opts?.search) {
    for (const [k, v] of Object.entries(opts.search)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, v);
    }
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
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 429 && attempt < g.maxRetries) {
      await res.body?.cancel().catch(() => {});
      await sleep(backoffMs(res));
      continue;
    }

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(
        `Vikunja ${method} ${path} failed: ${res.status} ${res.statusText}` +
          (bodyText ? ` \u2014 ${bodyText.slice(0, 300)}` : ""),
      );
    }

    if (res.status === 204) return null;
    return await res.json();
  }
}

function asArray(json: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(json)) return json as Array<Record<string, unknown>>;
  return [];
}

/** Resolve a label name to its Vikunja label id via GET /labels. */
async function resolveLabelId(
  g: GlobalArgs,
  labelName: string,
): Promise<number | null> {
  const labels = asArray(
    await vreq(g, "GET", "/labels", { search: { per_page: "100" } }),
  );
  const match = labels.find((l) =>
    typeof l.title === "string" &&
    l.title.toLowerCase() === labelName.toLowerCase()
  );
  return match && typeof match.id === "number" ? match.id : null;
}

/**
 * Find the kanban view of a project via GET /projects/{projectId}/views.
 * Honors the configured viewId override for the default project only.
 * Returns null when the project has no kanban view.
 */
async function resolveKanbanViewId(
  g: GlobalArgs,
  projectId: number,
): Promise<number | null> {
  if (g.viewId !== undefined && projectId === g.projectId) return g.viewId;
  const views = asArray(await vreq(g, "GET", `/projects/${projectId}/views`));
  const kanban = views.find((v) => v.view_kind === "kanban");
  return kanban && typeof kanban.id === "number" ? kanban.id : null;
}

/**
 * Resolve a bucket name (case-insensitive) to its id within a view via
 * GET /projects/{projectId}/views/{viewId}/buckets. Throws listing the
 * available bucket titles when there is no match, so a typo is actionable.
 */
async function resolveBucket(
  g: GlobalArgs,
  projectId: number,
  viewId: number,
  bucketName: string,
): Promise<{ id: number; title: string }> {
  const buckets = asArray(
    await vreq(g, "GET", `/projects/${projectId}/views/${viewId}/buckets`),
  );
  const match = buckets.find((b) =>
    typeof b.title === "string" &&
    b.title.toLowerCase() === bucketName.toLowerCase()
  );
  if (
    match && typeof match.id === "number" && typeof match.title === "string"
  ) {
    return { id: match.id, title: match.title };
  }
  const available = buckets
    .map((b) => (typeof b.title === "string" ? `"${b.title}"` : null))
    .filter((t): t is string => t !== null)
    .join(", ");
  throw new Error(
    `Bucket "${bucketName}" not found in project ${projectId} view ${viewId}` +
      (available ? `; available: ${available}` : "; the view has no buckets"),
  );
}

/**
 * Move a task into a bucket within a view via
 * POST /projects/{projectId}/views/{viewId}/buckets/{bucketId}/tasks
 * (the "Update a task bucket" endpoint; Vikunja >= 0.24 / v2.x).
 */
async function moveTaskToBucket(
  g: GlobalArgs,
  projectId: number,
  viewId: number,
  bucketId: number,
  taskId: number,
): Promise<void> {
  await vreq(
    g,
    "POST",
    `/projects/${projectId}/views/${viewId}/buckets/${bucketId}/tasks`,
    { body: { task_id: taskId, bucket_id: bucketId, project_view_id: viewId } },
  );
}

function toVikunjaTask(
  raw: Record<string, unknown>,
  fetchedAt: string,
): z.infer<typeof VikunjaTaskSchema> {
  return VikunjaTaskSchema.parse({
    ...raw,
    fetchedAt,
    collectedBy: "@sntxrr/vikunja-kanban",
  });
}

// ============================================================================
// Methods
// ============================================================================

async function newTask(
  args: NewTaskArgs,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;

  if (args.skipIfTitleExists) {
    const existing = asArray(
      await vreq(g, "GET", `/projects/${projectId}/tasks`, {
        search: { s: args.title, per_page: "50" },
      }),
    );
    const dup = existing.find((t) =>
      typeof t.title === "string" &&
      t.title === args.title &&
      t.done !== true
    );
    if (dup && typeof dup.id === "number") {
      ctx.logger?.info(
        "Task with matching title already exists \u2014 skipping create",
        { title: args.title, existingId: dup.id, projectId },
      );
      const handle = await ctx.writeResource(
        "vikunjaTask",
        `task-${dup.id}`,
        toVikunjaTask(dup, fetchedAt),
      );
      return { dataHandles: [handle] };
    }
  }

  // Resolve the destination bucket up front: an unknown bucket name must
  // fail here, before anything is created, rather than leave a task sitting
  // in the view's default column.
  const bucketName = args.bucketName ?? g.defaultBucketName;
  let target: { viewId: number; bucketId: number; bucketTitle: string } | null =
    null;
  if (bucketName) {
    const viewId = await resolveKanbanViewId(g, projectId);
    if (viewId === null) {
      ctx.logger?.warning(
        "Project has no kanban view \u2014 skipping bucket placement",
        { projectId, bucketName },
      );
    } else {
      const bucket = await resolveBucket(g, projectId, viewId, bucketName);
      target = { viewId, bucketId: bucket.id, bucketTitle: bucket.title };
    }
  }

  const body: Record<string, unknown> = { title: args.title };
  if (args.description) body.description = args.description;
  if (args.dueDate) body.due_date = args.dueDate;
  if (args.priority !== undefined) body.priority = args.priority;

  const created = await vreq(
    g,
    "PUT",
    `/projects/${projectId}/tasks`,
    { body },
  ) as Record<string, unknown>;

  const taskId = typeof created.id === "number" ? created.id : null;
  if (taskId === null) {
    throw new Error(
      `Vikunja task creation for "${args.title}" returned no numeric id.`,
    );
  }

  if (args.label) {
    const labelId = await resolveLabelId(g, args.label);
    if (labelId === null) {
      ctx.logger?.warning(
        "Requested label not found on this Vikunja instance \u2014 task created without it",
        { label: args.label, taskId },
      );
    } else {
      try {
        await vreq(g, "PUT", `/tasks/${taskId}/labels`, {
          body: { label_id: labelId },
        });
      } catch (e) {
        ctx.logger?.warning("Failed to attach label to task", {
          taskId,
          label: args.label,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }

  if (target) {
    try {
      await moveTaskToBucket(
        g,
        projectId,
        target.viewId,
        target.bucketId,
        taskId,
      );
    } catch (e) {
      // The task exists but sits in the view's default column — surface
      // that loudly rather than report success for a misplaced task.
      throw new Error(
        `Task ${taskId} was created in project ${projectId} but could not ` +
          `be moved into bucket "${target.bucketTitle}" ` +
          `(view ${target.viewId}, bucket ${target.bucketId}): ` +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    ctx.logger?.info(
      `Placed task ${taskId} into bucket "${target.bucketTitle}"`,
      { projectId, viewId: target.viewId, bucketId: target.bucketId },
    );
  }

  const final = await vreq(g, "GET", `/tasks/${taskId}`) as Record<
    string,
    unknown
  >;

  const handle = await ctx.writeResource(
    "vikunjaTask",
    `task-${taskId}`,
    toVikunjaTask(
      target ? { ...final, placement: target } : final,
      fetchedAt,
    ),
  );
  ctx.logger?.info(`Vikunja task created: ${taskId}`, {
    title: args.title,
    projectId,
    bucket: target?.bucketTitle ?? null,
  });
  return { dataHandles: [handle] };
}

async function listRecent(
  args: z.infer<typeof ListRecentArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;
  const endpoint = `/projects/${projectId}/tasks`;

  const tasks = asArray(
    await vreq(g, "GET", endpoint, {
      search: {
        sort_by: "created",
        order_by: "desc",
        per_page: String(args.limit),
        ...(args.includeDone
          ? {}
          : { filter_by: "done", filter_value: "false" }),
      },
    }),
  ).slice(0, args.limit);

  const handles: unknown[] = [];
  const ids: number[] = [];
  for (const t of tasks) {
    const id = typeof t.id === "number" ? t.id : null;
    if (id === null) continue;
    handles.push(
      await ctx.writeResource(
        "vikunjaTask",
        `list-${id}`,
        toVikunjaTask(t, fetchedAt),
      ),
    );
    ids.push(id);
  }
  handles.push(
    await ctx.writeResource("summary", "summary-recent", {
      scope: "recent",
      endpoint,
      total: ids.length,
      ids,
      fetchedAt,
    }),
  );
  ctx.logger?.info(`Fetched ${ids.length} recent Vikunja tasks`);
  return { dataHandles: handles };
}

// ============================================================================
// Model
// ============================================================================

/** Vikunja kanban orchestrator: create and list tasks via the Vikunja REST API. */
export const model = {
  type: "@sntxrr/vikunja-kanban" as const,
  version: "2026.09.14.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.09.13.2",
      description:
        "Added defaultBucketName global arg and bucketName method arg for " +
        "placing new tasks into a named bucket (e.g. Review) within a " +
        "configured view, so automation-created tasks land in a human " +
        "triage column instead of a working column. Added bucket_id to the " +
        "vikunjaTask resource schema. No breaking changes — both new fields " +
        "are optional/defaulted.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.14.1",
      description:
        "Bucket placement now works without a configured viewId: the " +
        "project's kanban view is auto-discovered, the bucket is resolved " +
        "before the task is created (unknown name = error, nothing " +
        "created), the move uses the POST endpoint Vikunja v2.x serves " +
        "(the previous PUT silently failed), and a failed move is an error " +
        "instead of a warning. defaultBucketName default changed from " +
        '"Review" to "Backlog". Added optional projectId argument to ' +
        "new_task and list_recent to target another project per call, " +
        "and a placement field on the vikunjaTask resource. Existing " +
        "model attributes carry over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    vikunjaTask: {
      description:
        "A Vikunja task with id, title, labels, priority, bucket, and status.",
      schema: VikunjaTaskSchema,
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    summary: {
      description: "Per-listing summary: scope, endpoint, count, and item ids.",
      schema: SummarySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    new_task: {
      description:
        "Create a task in a Vikunja project (the configured default, or a " +
        "per-call projectId) and place it into a named kanban bucket " +
        '(default "Backlog", override with bucketName) so it lands in a ' +
        "backlog column rather than the view's default working column. " +
        "Optionally attaches an existing label by name (Urgent/High/Medium) " +
        "and skips creation if a non-done task with the same title already " +
        "exists.",
      arguments: NewTaskArgsSchema,
      execute: newTask,
    },
    list_recent: {
      description:
        "List the most recently created tasks in a Vikunja project (the " +
        "configured default, or a per-call projectId) and record each as " +
        "swamp data.",
      arguments: ListRecentArgsSchema,
      execute: listRecent,
    },
  },
};
