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
  webBaseUrl: z.string().optional().describe(
    "Base URL the web UI is reached at, used only to build task links in " +
      "due_report (e.g. https://vikunja.example.com). Defaults to baseUrl; " +
      "set it when the API is called on an internal address but links " +
      "should open the public one.",
  ),
  apiToken: z.string().min(1).meta({ sensitive: true }).describe(
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
  bucketRoles: z.object({
    backlog: z.string().default("Backlog"),
    ready: z.string().default("Next"),
    doing: z.string().default("Doing"),
    blocked: z.string().default("Blocked"),
    review: z.string().default("Review"),
    done: z.string().default("Done"),
  }).prefault({}).describe(
    "Which bucket title (case-insensitive) plays which role on the board. " +
      "audit and reorder scope their rules by role: the ready column must " +
      "pass the full Definition of Ready, doing/review/blocked have " +
      "staleness thresholds, done is never reordered.",
  ),
  policy: z.object({
    wipLimit: z.number().int().min(1).default(3).describe(
      "Maximum cards in the doing bucket before audit reports wip-exceeded.",
    ),
    staleDays: z.object({
      ready: z.number().default(14),
      doing: z.number().default(7),
      blocked: z.number().default(1),
      review: z.number().default(3),
    }).prefault({}).describe(
      "Days since `updated` after which a card in that role is reported stale.",
    ),
    minDescriptionChars: z.number().int().min(0).default(400).describe(
      "Descriptions shorter than this (HTML stripped) are reported as stubs.",
    ),
    verdictMarkers: z.array(z.string()).default([
      "CONFIRMED",
      "DISSOLVED",
      "MISSTATED",
    ]).describe(
      "A ready card's description must contain one of these premise-check " +
        "verdicts (case-sensitive substring match).",
    ),
    acceptanceMarkers: z.array(z.string()).default([
      "Acceptance",
      "Proof",
      "Done when",
      "Verify",
    ]).describe(
      "A ready card's description must contain one of these (case-insensitive) " +
        "— the marker of an acceptance criterion with a command and expected output.",
    ),
    requiredLinkPrefix: z.string().default("obsidian://").describe(
      "Every non-done card should link back to its source note with a URL " +
        "starting with this prefix. Empty string disables the check.",
    ),
    requiredLabelPrefixes: z.array(z.string()).default(["tier-"]).describe(
      "Label-group prefixes every non-done card must carry one of (e.g. " +
        "tier-A/B/C). Any label NOT matching a prefix counts as the area label.",
    ),
    tieBreak: z.enum(["oldest", "newest"]).default("oldest").describe(
      "Within equal priority, whether older or newer cards sort first.",
    ),
  }).prefault({}).describe(
    "Definition-of-Ready thresholds used by audit and the sort order used " +
      "by reorder. Every field has a default; override only what differs.",
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

const FindingSchema = z.object({
  taskId: z.number().nullable().describe(
    "Task the finding is about; null for bucket-level findings.",
  ),
  title: z.string().nullable(),
  bucket: z.string(),
  role: z.string().describe(
    "Bucket role (backlog/ready/doing/blocked/review/done/other).",
  ),
  rule: z.string().describe(
    "Rule id, e.g. empty-description, stale, wip-exceeded.",
  ),
  severity: z.enum(["error", "warn", "info"]),
  detail: z.string(),
});
type Finding = z.infer<typeof FindingSchema>;

const BoardAuditSchema = z.object({
  projectId: z.number(),
  viewId: z.number(),
  auditedAt: z.string(),
  buckets: z.array(z.object({
    title: z.string(),
    role: z.string(),
    count: z.number(),
    inOrder: z.boolean(),
  })),
  findings: z.array(FindingSchema),
  counts: z.object({
    findings: z.number(),
    bySeverity: z.record(z.string(), z.number()),
    byRule: z.record(z.string(), z.number()),
  }),
  ready: z.object({
    bucket: z.string(),
    total: z.number(),
    passing: z.number(),
    failingIds: z.array(z.number()),
  }).describe(
    "Definition-of-Ready roll-up for the ready column: a card passes when " +
      "it has no error-level findings.",
  ),
}).passthrough();

const ReorderPlanSchema = z.object({
  projectId: z.number(),
  viewId: z.number(),
  plannedAt: z.string(),
  applied: z.boolean(),
  converged: z.boolean().describe(
    "True when the final re-read of every bucket matched the intended " +
      "order (always false on a dry run that still has pending moves).",
  ),
  iterations: z.number(),
  moves: z.array(z.object({
    taskId: z.number(),
    title: z.string(),
    bucket: z.string(),
    from: z.number().describe("0-based index before."),
    to: z.number().describe("0-based index after."),
  })),
}).passthrough();

const DueItemSchema = z.object({
  id: z.number(),
  title: z.string(),
  bucket: z.string(),
  dueDate: z.string().describe("ISO 8601 due date as Vikunja stores it."),
  daysUntil: z.number().int().describe(
    "Whole UTC days from the report's `asOf` date to the due date: " +
      "negative = overdue, 0 = due today.",
  ),
  url: z.string().describe("Task link, built from webBaseUrl (or baseUrl)."),
});
/** One dated card as due_report reports it. */
export type DueItem = z.infer<typeof DueItemSchema>;

const DueReportSchema = z.object({
  projectId: z.number(),
  viewId: z.number(),
  asOf: z.string().describe("ISO 8601 instant the board was read at."),
  lookaheadDays: z.number().int(),
  counts: z.object({
    overdue: z.number(),
    dueToday: z.number(),
    upcoming: z.number(),
    actionable: z.number().describe(
      "overdue + dueToday — what the nudge fires on.",
    ),
  }),
  overdue: z.array(DueItemSchema),
  dueToday: z.array(DueItemSchema),
  upcoming: z.array(DueItemSchema).describe(
    "Due after today and within lookaheadDays, soonest first.",
  ),
  message: z.string().describe(
    "Ready-to-send Markdown body listing every section that is non-empty.",
  ),
  boardUrl: z.string(),
}).passthrough();
/** The `dueReport` resource written by due_report. */
export type DueReport = z.infer<typeof DueReportSchema>;

// ============================================================================
// Method argument schemas
// ============================================================================

const LabelName = z.string().min(1).describe(
  "Label title to attach to the task (case-insensitive), resolved via " +
    "GET /labels. Must already exist on the Vikunja instance — this model " +
    "never creates labels.",
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
  label: LabelName.optional(),
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

const AuditArgsSchema = z.object({
  projectId: ProjectIdOverride,
});

const DueReportArgsSchema = z.object({
  projectId: ProjectIdOverride,
  lookaheadDays: z.number().int().min(0).max(365).default(7).describe(
    "Cards due within this many days after today are listed as upcoming. " +
      "0 lists only overdue and due-today cards.",
  ),
  now: z.string().optional().describe(
    "ISO 8601 instant to evaluate against instead of the clock (for tests " +
      "and dry runs).",
  ),
});

const ReorderArgsSchema = z.object({
  projectId: ProjectIdOverride,
  apply: z.boolean().default(false).describe(
    "false (default) only reports the moves that would be made. true " +
      "performs them one at a time — read the bucket, move the first card " +
      "that is out of place to the midpoint of its intended neighbours, " +
      "re-read, repeat — and fails if the board has not converged.",
  ),
  buckets: z.array(z.string()).optional().describe(
    "Bucket titles (case-insensitive) to reorder. Default: every bucket " +
      "except the done role.",
  ),
  maxIterations: z.number().int().min(1).max(500).default(100).describe(
    "Upper bound on single-card moves before reorder gives up.",
  ),
});
type ReorderArgs = z.infer<typeof ReorderArgsSchema>;

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
// Board reading and Definition-of-Ready rules
// ============================================================================

/** The subset of a Vikunja task the audit/reorder rules look at. */
export interface BoardTask {
  id: number;
  title: string;
  description: string;
  done: boolean;
  priority: number;
  position: number;
  created: string;
  updated: string;
  labels: string[];
  /** ISO 8601 due date, or null when unset (Vikunja's zero time `0001-01-01…`). */
  dueDate: string | null;
}

/** One kanban column with its tasks in view order. */
export interface BoardBucket {
  id: number;
  title: string;
  position: number;
  tasks: BoardTask[];
}

type Roles = GlobalArgs["bucketRoles"];
type Policy = GlobalArgs["policy"];
export type Role = keyof Roles | "other";

/** Map a bucket title to its configured role (case-insensitive). */
export function roleOf(title: string, roles: Roles): Role {
  const t = title.toLowerCase();
  for (const [role, name] of Object.entries(roles)) {
    if (name.toLowerCase() === t) return role as Role;
  }
  return "other";
}

/** Visible text length of a description: HTML tags stripped, whitespace trimmed. */
export function textLength(html: string): number {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").trim()
    .replace(/\s+/g, " ").length;
}

function toBoardTask(raw: Record<string, unknown>): BoardTask | null {
  if (typeof raw.id !== "number") return null;
  return {
    id: raw.id,
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    done: raw.done === true,
    priority: typeof raw.priority === "number" ? raw.priority : 0,
    position: typeof raw.position === "number" ? raw.position : 0,
    created: typeof raw.created === "string" ? raw.created : "",
    updated: typeof raw.updated === "string" ? raw.updated : "",
    labels: asArray(raw.labels).map((l) => l.title).filter((t): t is string =>
      typeof t === "string"
    ),
    dueDate: dueDateOf(raw.due_date),
  };
}

/**
 * Vikunja has no "unset" for a timestamp: it returns Go's zero time,
 * `0001-01-01T00:00:00Z`, which is a perfectly parseable date 2000 years
 * overdue. Anything before year 1970 is treated as unset.
 */
export function dueDateOf(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t) || t < 0) return null;
  return raw;
}

/**
 * Read a whole kanban board via GET /projects/{p}/views/{v}/tasks. The
 * endpoint paginates *per bucket* (page size from /info), so a single page
 * silently truncates any bucket longer than that limit. Keep fetching pages
 * until no bucket gains a task; tasks are ordered by their view position.
 */
async function fetchBoard(
  g: GlobalArgs,
  projectId: number,
  viewId: number,
): Promise<BoardBucket[]> {
  const info = await vreq(g, "GET", "/info").catch(() => null) as
    | Record<string, unknown>
    | null;
  const perPage = info && typeof info.max_items_per_page === "number"
    ? info.max_items_per_page
    : 50;

  const buckets = new Map<number, BoardBucket>();
  for (let page = 1; page <= 100; page++) {
    const raw = asArray(
      await vreq(g, "GET", `/projects/${projectId}/views/${viewId}/tasks`, {
        search: { page: String(page), per_page: String(perPage) },
      }),
    );
    let grew = false;
    for (const b of raw) {
      if (typeof b.id !== "number") continue;
      const bucket = buckets.get(b.id) ?? {
        id: b.id,
        title: typeof b.title === "string" ? b.title : String(b.id),
        position: typeof b.position === "number" ? b.position : 0,
        tasks: [],
      };
      const seen = new Set(bucket.tasks.map((t) => t.id));
      for (const t of asArray(b.tasks)) {
        const task = toBoardTask(t);
        if (task && !seen.has(task.id)) {
          bucket.tasks.push(task);
          seen.add(task.id);
          grew = true;
        }
      }
      buckets.set(b.id, bucket);
    }
    if (!grew) break;
  }
  const out = [...buckets.values()].sort((a, b) => a.position - b.position);
  for (const b of out) b.tasks.sort((a, c) => a.position - c.position);
  return out;
}

/**
 * The order a bucket should be in: priority descending (5 = DO NOW first,
 * 0 = unset last), then by age. Stable, so already-ordered input is
 * returned unchanged.
 */
export function intendedOrder(
  tasks: BoardTask[],
  tieBreak: Policy["tieBreak"],
): BoardTask[] {
  return [...tasks].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    const cmp = a.created.localeCompare(b.created);
    return tieBreak === "oldest" ? cmp : -cmp;
  });
}

function sameOrder(a: BoardTask[], b: BoardTask[]): boolean {
  return a.length === b.length && a.every((t, i) => t.id === b[i].id);
}

function daysBetween(fromIso: string, now: Date): number | null {
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / 86_400_000;
}

/**
 * Findings for one card, scoped by the role of the bucket it sits in. The
 * full Definition of Ready is only *required* (error) in the ready column
 * and in doing/review — anywhere a card is meant to be executed from —
 * and reported as warn/info elsewhere so the backlog can be groomed toward it.
 */
export function auditCard(
  task: BoardTask,
  bucket: string,
  role: Role,
  policy: Policy,
  now: Date,
): Finding[] {
  const out: Finding[] = [];
  const add = (rule: string, severity: Finding["severity"], detail: string) =>
    out.push({
      taskId: task.id,
      title: task.title,
      bucket,
      role,
      rule,
      severity,
      detail,
    });

  if (role === "done") {
    if (!task.done) {
      add("done-flag-mismatch", "warn", "in the done bucket but done=false");
    }
    return out;
  }
  if (task.done) {
    add("done-flag-mismatch", "warn", "done=true outside the done bucket");
  }

  const executable = role === "ready" || role === "doing" || role === "review";
  const must: Finding["severity"] = executable ? "error" : "warn";

  const len = textLength(task.description);
  if (len === 0) add("empty-description", "error", "description is empty");
  else if (len < policy.minDescriptionChars) {
    add(
      "short-description",
      must,
      `${len} chars < ${policy.minDescriptionChars}`,
    );
  }

  if (task.labels.length === 0) add("no-labels", must, "no labels at all");
  else {
    for (const prefix of policy.requiredLabelPrefixes) {
      if (
        !task.labels.some((l) =>
          l.toLowerCase().startsWith(prefix.toLowerCase())
        )
      ) {
        add("missing-label-group", must, `no label starting with "${prefix}"`);
      }
    }
    const isGroup = (l: string) =>
      policy.requiredLabelPrefixes.some((p) =>
        l.toLowerCase().startsWith(p.toLowerCase())
      );
    if (!task.labels.some((l) => !isGroup(l))) {
      add("missing-area-label", must, "only group labels, no area label");
    }
  }

  if (task.priority === 0) add("priority-unset", must, "priority is 0 (unset)");

  if (len > 0) {
    const desc = task.description;
    if (!policy.verdictMarkers.some((m) => desc.includes(m))) {
      add(
        "missing-verdict",
        executable ? "error" : "info",
        `no premise-check verdict (${policy.verdictMarkers.join("/")})`,
      );
    }
    const lower = desc.toLowerCase();
    if (
      !policy.acceptanceMarkers.some((m) => lower.includes(m.toLowerCase()))
    ) {
      add(
        "missing-acceptance",
        executable ? "error" : "info",
        `no acceptance marker (${policy.acceptanceMarkers.join("/")})`,
      );
    }
    if (
      policy.requiredLinkPrefix && !desc.includes(policy.requiredLinkPrefix)
    ) {
      add(
        "missing-link",
        must,
        `no ${policy.requiredLinkPrefix} link to the source note`,
      );
    }
  }

  const staleAfter =
    (policy.staleDays as Record<string, number | undefined>)[role];
  if (staleAfter !== undefined) {
    const age = daysBetween(task.updated, now);
    if (age !== null && age > staleAfter) {
      add(
        "stale",
        "warn",
        `untouched for ${
          age.toFixed(1)
        } d (limit ${staleAfter} d in ${bucket})`,
      );
    }
  }
  return out;
}

/** Bucket-level findings: WIP limit and ordering. */
export function auditBucket(
  bucket: BoardBucket,
  role: Role,
  policy: Policy,
): { findings: Finding[]; inOrder: boolean } {
  const findings: Finding[] = [];
  const inOrder = role === "done" ||
    sameOrder(bucket.tasks, intendedOrder(bucket.tasks, policy.tieBreak));
  if (!inOrder) {
    findings.push({
      taskId: null,
      title: null,
      bucket: bucket.title,
      role,
      rule: "out-of-order",
      severity: "warn",
      detail: "not sorted by priority desc, then age — run reorder",
    });
  }
  if (role === "doing" && bucket.tasks.length > policy.wipLimit) {
    findings.push({
      taskId: null,
      title: null,
      bucket: bucket.title,
      role,
      rule: "wip-exceeded",
      severity: "warn",
      detail: `${bucket.tasks.length} cards > wipLimit ${policy.wipLimit}`,
    });
  }
  return { findings, inOrder };
}

/**
 * The single move that brings a bucket one step closer to `intended`: the
 * first slot whose occupant is wrong gets the card that belongs there,
 * positioned at the midpoint of its new neighbours. Returns null when the
 * bucket is already in order.
 */
export function nextMove(
  current: BoardTask[],
  intended: BoardTask[],
): { task: BoardTask; index: number; position: number } | null {
  for (let i = 0; i < intended.length; i++) {
    if (current[i]?.id === intended[i].id) continue;
    const task = intended[i];
    const lo = i > 0 ? current[i - 1].position : 0;
    const hi = current[i]?.position ?? lo + 65_536;
    // Vikunja re-derives positions on write, so a collapsed gap is not
    // fatal — nudge past `lo` and let the re-read decide.
    const position = hi > lo ? (lo + hi) / 2 : lo + 1;
    return { task, index: i, position };
  }
  return null;
}

async function requireKanbanView(
  g: GlobalArgs,
  projectId: number,
): Promise<number> {
  const viewId = await resolveKanbanViewId(g, projectId);
  if (viewId === null) {
    throw new Error(`Project ${projectId} has no kanban view.`);
  }
  return viewId;
}

async function audit(
  args: z.infer<typeof AuditArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const now = new Date();
  const projectId = args.projectId ?? g.projectId;
  const viewId = await requireKanbanView(g, projectId);
  const board = await fetchBoard(g, projectId, viewId);
  if (board.length === 0) {
    throw new Error(`Project ${projectId} view ${viewId} returned no buckets.`);
  }

  const findings: Finding[] = [];
  const buckets: z.infer<typeof BoardAuditSchema>["buckets"] = [];
  const ready = {
    bucket: g.bucketRoles.ready,
    total: 0,
    passing: 0,
    failingIds: [] as number[],
  };

  for (const b of board) {
    const role = roleOf(b.title, g.bucketRoles);
    const { findings: bf, inOrder } = auditBucket(b, role, g.policy);
    findings.push(...bf);
    buckets.push({ title: b.title, role, count: b.tasks.length, inOrder });
    for (const t of b.tasks) {
      const cf = auditCard(t, b.title, role, g.policy, now);
      findings.push(...cf);
      if (role === "ready") {
        ready.total++;
        if (cf.some((f) => f.severity === "error")) ready.failingIds.push(t.id);
        else ready.passing++;
      }
    }
  }

  const bySeverity: Record<string, number> = {};
  const byRule: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  }

  const report = BoardAuditSchema.parse({
    projectId,
    viewId,
    auditedAt: now.toISOString(),
    buckets,
    findings,
    counts: { findings: findings.length, bySeverity, byRule },
    ready,
  });
  const handle = await ctx.writeResource(
    "boardAudit",
    `audit-${projectId}`,
    report,
  );
  ctx.logger?.info(
    `Audited project ${projectId}: ${
      buckets.reduce((n, b) => n + b.count, 0)
    } cards, ` +
      `${findings.length} findings, ready ${ready.passing}/${ready.total}`,
    { bySeverity, byRule },
  );
  return { dataHandles: [handle] };
}

// ============================================================================
// Due-date report
// ============================================================================

/** UTC calendar day of an instant, as days since the epoch. */
function utcDay(ms: number): number {
  return Math.floor(ms / 86_400_000);
}

/**
 * Split the board's dated, not-done cards into overdue / due today /
 * upcoming (within lookaheadDays), by whole UTC calendar days so that a card
 * due at 09:00 is "today" all day rather than flipping to overdue at 09:01.
 * Each list is soonest-first; overdue is most-overdue-first.
 */
export function classifyDue(
  board: BoardBucket[],
  roles: Roles,
  now: Date,
  lookaheadDays: number,
  webBase: string,
): { overdue: DueItem[]; dueToday: DueItem[]; upcoming: DueItem[] } {
  const today = utcDay(now.getTime());
  const overdue: DueItem[] = [];
  const dueToday: DueItem[] = [];
  const upcoming: DueItem[] = [];
  for (const b of board) {
    if (roleOf(b.title, roles) === "done") continue;
    for (const t of b.tasks) {
      if (t.done || t.dueDate === null) continue;
      const due = Date.parse(t.dueDate);
      if (!Number.isFinite(due)) continue;
      const daysUntil = utcDay(due) - today;
      const item: DueItem = {
        id: t.id,
        title: t.title,
        bucket: b.title,
        dueDate: t.dueDate,
        daysUntil,
        url: `${webBase}/tasks/${t.id}`,
      };
      if (daysUntil < 0) overdue.push(item);
      else if (daysUntil === 0) dueToday.push(item);
      else if (daysUntil <= lookaheadDays) upcoming.push(item);
    }
  }
  const soonest = (a: DueItem, b: DueItem) =>
    a.daysUntil - b.daysUntil || a.id - b.id;
  overdue.sort(soonest);
  dueToday.sort(soonest);
  upcoming.sort(soonest);
  return { overdue, dueToday, upcoming };
}

function dueLine(i: DueItem): string {
  const when = i.daysUntil < 0
    ? `${-i.daysUntil}d overdue`
    : i.daysUntil === 0
    ? "today"
    : `in ${i.daysUntil}d`;
  return `- [#${i.id}](${i.url}) ${i.title} — ${i.dueDate.slice(0, 10)} ` +
    `(${when}, ${i.bucket})`;
}

/** Markdown body: one section per non-empty list, nothing for empty ones. */
export function renderDueMessage(
  r: { overdue: DueItem[]; dueToday: DueItem[]; upcoming: DueItem[] },
  lookaheadDays: number,
  boardUrl: string,
): string {
  const parts: string[] = [];
  if (r.overdue.length > 0) {
    parts.push(
      `**Overdue (${r.overdue.length})**\n` +
        r.overdue.map(dueLine).join("\n"),
    );
  }
  if (r.dueToday.length > 0) {
    parts.push(
      `**Due today (${r.dueToday.length})**\n` +
        r.dueToday.map(dueLine).join("\n"),
    );
  }
  if (r.upcoming.length > 0) {
    parts.push(
      `**Next ${lookaheadDays} days (${r.upcoming.length})**\n` +
        r.upcoming.map(dueLine).join("\n"),
    );
  }
  if (parts.length === 0) parts.push("Nothing due.");
  parts.push(`Board: ${boardUrl}`);
  return parts.join("\n\n");
}

async function dueReport(
  args: z.infer<typeof DueReportArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const now = args.now ? new Date(args.now) : new Date();
  if (!Number.isFinite(now.getTime())) {
    throw new Error(`now is not a parseable instant: ${args.now}`);
  }
  const projectId = args.projectId ?? g.projectId;
  const viewId = await requireKanbanView(g, projectId);
  const board = await fetchBoard(g, projectId, viewId);
  if (board.length === 0) {
    throw new Error(`Project ${projectId} view ${viewId} returned no buckets.`);
  }
  const webBase = (g.webBaseUrl ?? g.baseUrl).replace(/\/+$/, "");
  const boardUrl = `${webBase}/projects/${projectId}`;
  const lists = classifyDue(
    board,
    g.bucketRoles,
    now,
    args.lookaheadDays,
    webBase,
  );
  const report = DueReportSchema.parse({
    projectId,
    viewId,
    asOf: now.toISOString(),
    lookaheadDays: args.lookaheadDays,
    counts: {
      overdue: lists.overdue.length,
      dueToday: lists.dueToday.length,
      upcoming: lists.upcoming.length,
      actionable: lists.overdue.length + lists.dueToday.length,
    },
    ...lists,
    message: renderDueMessage(lists, args.lookaheadDays, boardUrl),
    boardUrl,
  });
  const handle = await ctx.writeResource(
    "dueReport",
    `due-${projectId}`,
    report,
  );
  ctx.logger?.info(
    `Due report for project ${projectId}: ${report.counts.overdue} overdue, ` +
      `${report.counts.dueToday} due today, ${report.counts.upcoming} upcoming`,
    { asOf: report.asOf, lookaheadDays: args.lookaheadDays },
  );
  return { dataHandles: [handle] };
}

async function reorder(
  args: ReorderArgs,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const plannedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;
  const viewId = await requireKanbanView(g, projectId);

  const wanted = args.buckets?.map((b) => b.toLowerCase());
  const inScope = (title: string) =>
    wanted
      ? wanted.includes(title.toLowerCase())
      : roleOf(title, g.bucketRoles) !== "done";

  let board = await fetchBoard(g, projectId, viewId);
  if (board.length === 0) {
    throw new Error(`Project ${projectId} view ${viewId} returned no buckets.`);
  }
  if (wanted) {
    const titles = board.map((b) => b.title.toLowerCase());
    const missing = wanted.filter((w) => !titles.includes(w));
    if (missing.length) {
      throw new Error(`Unknown bucket(s): ${missing.join(", ")}`);
    }
  }

  // Dry-run plan: where each out-of-place card sits now vs. where it belongs.
  const moves: z.infer<typeof ReorderPlanSchema>["moves"] = [];
  for (const b of board) {
    if (!inScope(b.title)) continue;
    const intended = intendedOrder(b.tasks, g.policy.tieBreak);
    b.tasks.forEach((t, from) => {
      const to = intended.findIndex((x) => x.id === t.id);
      if (to !== from) {
        moves.push({ taskId: t.id, title: t.title, bucket: b.title, from, to });
      }
    });
  }

  let iterations = 0;
  let converged = moves.length === 0;
  if (args.apply && moves.length > 0) {
    for (
      const bucketTitle of board.filter((b) => inScope(b.title)).map((b) =>
        b.title
      )
    ) {
      for (;;) {
        const b = board.find((x) => x.title === bucketTitle);
        if (!b) {
          throw new Error(`Bucket "${bucketTitle}" vanished mid-reorder.`);
        }
        const move = nextMove(
          b.tasks,
          intendedOrder(b.tasks, g.policy.tieBreak),
        );
        if (!move) break;
        if (iterations >= args.maxIterations) {
          throw new Error(
            `reorder did not converge after ${iterations} moves (bucket "${bucketTitle}" still out of order).`,
          );
        }
        iterations++;
        await vreq(g, "POST", `/tasks/${move.task.id}/position`, {
          body: {
            project_view_id: viewId,
            task_id: move.task.id,
            position: move.position,
          },
        });
        ctx.logger?.info(
          `Moved #${move.task.id} to slot ${move.index} in "${bucketTitle}"`,
          { position: move.position },
        );
        // Vikunja may not store the exact number sent — always re-read.
        board = await fetchBoard(g, projectId, viewId);
      }
    }
    converged = board.filter((b) => inScope(b.title)).every((b) =>
      sameOrder(b.tasks, intendedOrder(b.tasks, g.policy.tieBreak))
    );
    if (!converged) {
      throw new Error(
        "reorder finished its moves but a final re-read is still out of order.",
      );
    }
  }

  const plan = ReorderPlanSchema.parse({
    projectId,
    viewId,
    plannedAt,
    applied: args.apply,
    converged,
    iterations,
    moves,
  });
  const handle = await ctx.writeResource(
    "reorderPlan",
    `reorder-${projectId}`,
    plan,
  );
  ctx.logger?.info(
    args.apply
      ? `Reordered project ${projectId}: ${iterations} moves, converged=${converged}`
      : `Dry run for project ${projectId}: ${moves.length} card(s) out of place (apply: true to fix)`,
  );
  return { dataHandles: [handle] };
}

// ============================================================================
// Model
// ============================================================================

/** Vikunja kanban orchestrator: create and list tasks via the Vikunja REST API. */
export const model = {
  type: "@sntxrr/vikunja-kanban" as const,
  version: "2026.09.19.1",
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
    {
      toVersion: "2026.09.15.1",
      description:
        "Added audit (read-only Definition-of-Ready findings per card and " +
        "bucket, written as a boardAudit resource) and reorder (sorts every " +
        "non-done bucket by priority desc then age; dry-run by default, " +
        "apply: true moves one card at a time and re-reads until the board " +
        "converges), plus bucketRoles and policy global args with defaults " +
        "for both. new_task's label argument now accepts any existing label " +
        "title instead of the Urgent/High/Medium enum. Existing model " +
        "attributes carry over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.19.1",
      description:
        "Added due_report: reads the board and writes a dueReport resource " +
        "splitting dated, not-done cards into overdue / due today / upcoming " +
        "(lookaheadDays, default 7) with a ready-to-send Markdown message, " +
        "so a scheduled workflow can nudge on a card's due date. Added " +
        "optional webBaseUrl global arg for task links when the API is " +
        "called on a different address than the web UI. Existing model " +
        "attributes carry over unchanged.",
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
    boardAudit: {
      description: "One audit run of a kanban board: per-card and per-bucket " +
        "Definition-of-Ready findings, counts by rule and severity, and the " +
        "ready-column pass/fail roll-up.",
      schema: BoardAuditSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    reorderPlan: {
      description:
        "One reorder run: the moves planned (dry run) or performed " +
        "(apply), and whether the board converged to the intended order.",
      schema: ReorderPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    dueReport: {
      description:
        "One due-date pass over a board: overdue, due-today and upcoming " +
        "cards with counts and a Markdown message ready to send.",
      schema: DueReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
  },
  methods: {
    audit: {
      description:
        "Read-only Definition-of-Ready audit of a project's kanban board: " +
        "empty/short descriptions, missing labels or label groups, unset " +
        "priority, missing verdict/acceptance/source-link markers, stale " +
        "cards per role, WIP over the limit, and buckets out of order. " +
        "Writes a boardAudit resource; changes nothing.",
      arguments: AuditArgsSchema,
      execute: audit,
    },
    reorder: {
      description:
        "Sort each non-done bucket by priority (desc) then age. Dry run by " +
        "default — reports the cards out of place. With apply: true, moves " +
        "one card at a time to the midpoint of its intended neighbours and " +
        "re-reads the board after every move (Vikunja re-derives positions " +
        "on write, so batch-assigned positions drift), failing loudly if " +
        "the board does not converge.",
      arguments: ReorderArgsSchema,
      execute: reorder,
    },
    due_report: {
      description:
        "Read-only: list the not-done cards on a project's board that are " +
        "overdue, due today, or due within lookaheadDays, each with a link, " +
        "and write a dueReport resource whose `message` is ready to send. " +
        "Treat a card's due date as the day to look at it again; a daily " +
        "workflow gated on counts.actionable > 0 turns that into a nudge.",
      arguments: DueReportArgsSchema,
      execute: dueReport,
    },
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
