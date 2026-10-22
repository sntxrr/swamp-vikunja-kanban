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
 * default, overridable per call), can attach existing labels by name, and
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
 * It also edits existing cards (update_task, set_labels, move_task,
 * close_task) under the rules the board has taught: POST /tasks/{id} is a
 * full replace, so read, merge and write the whole task; labels use their own
 * endpoints and never go in the task body; every write is read back and
 * asserted, because HTTP 200 proves nothing.
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
    waiting: z.string().default("Waiting"),
    review: z.string().default("Review"),
    done: z.string().default("Done"),
  }).prefault({}).describe(
    "Which bucket title (case-insensitive) plays which role on the board. " +
      "audit and reorder scope their rules by role: the ready column must " +
      "pass the full Definition of Ready, doing/review/blocked have " +
      "staleness thresholds, waiting cards must carry a due date and are " +
      "stale once it has passed (and sort by due date, soonest first), " +
      "done is never reordered.",
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
    recentEditMinutes: z.number().int().min(0).default(60).describe(
      "Write methods (update_task, set_labels, move_task, set_due_date, " +
        "and their apply_plan ops) refuse a card " +
        "updated within this many minutes unless the last update was this " +
        "model's own recorded write, or force: true is passed. It keeps " +
        "automation from overwriting a card someone is editing. 0 disables.",
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
//
// Unknown keys: the schemas this model builds itself (summary, boardAudit,
// reorderPlan, dueReport, boardSnapshot, planResult, label) are plain
// z.object, which strips: a stored resource holds exactly the documented
// fields, and a Vikunja upgrade cannot change its shape. Only LabelRefSchema
// and VikunjaTaskSchema pass unknown keys through, on purpose: a vikunjaTask
// record is the task exactly as Vikunja read it back (index, identifier,
// percent_done, position, ...), and readers of task-<id> / get-<id> use
// fields this schema does not list. Stripping them would silently drop data
// those readers depend on.

const LabelRefSchema = z.object({
  id: z.number(),
  title: z.string(),
  hex_color: z.string().nullable().optional(),
  // passthrough on purpose: see the note above the resource schemas.
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
  bucket: z.object({ title: z.string(), role: z.string() }).nullable()
    .optional().describe(
      "Bucket the card sat in when get_task read it (null: not on the " +
        "kanban view).",
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
  // passthrough on purpose: the record is the task as Vikunja returned it.
}).passthrough();

const SummarySchema = z.object({
  scope: z.string().describe(
    'Which listing produced this summary, e.g. "recent".',
  ),
  endpoint: z.string().describe("Resolved request path the items came from."),
  total: z.number().describe("Number of items written by this run."),
  ids: z.array(z.number()).default([]),
  fetchedAt: z.string(),
});

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
  truncated: z.boolean().default(false).describe(
    "True when the board read stopped at the page cap with pages still " +
      "growing: the audit covers only part of the board.",
  ),
});

const ReorderPlanSchema = z.object({
  projectId: z.number(),
  viewId: z.number(),
  plannedAt: z.string(),
  applied: z.boolean(),
  converged: z.boolean().describe(
    "True when the final re-read of every bucket matched the intended " +
      "order (always false on a dry run that still has pending moves).",
  ),
  iterations: z.number().describe("Single-card moves made, all buckets."),
  movesByBucket: z.record(z.string(), z.number()).default({}).describe(
    "Moves made per bucket title; each bucket has its own budget.",
  ),
  repeatedMoves: z.array(z.object({
    taskId: z.number(),
    bucket: z.string(),
    moves: z.number(),
  })).default([]).describe(
    "Cards moved more than once in this run: a card that keeps moving is " +
      "the sign of a move that does not stick.",
  ),
  error: z.string().nullable().default(null).describe(
    "Why an apply run stopped, or null. The plan is written before the " +
      "method throws, so a failed run still leaves its evidence.",
  ),
  recalculations: z.number().default(0).describe(
    "Full position recalculations the run triggered (a cramped gap or a " +
      "Vikunja 4028); 0 on a dry run.",
  ),
  moves: z.array(z.object({
    taskId: z.number(),
    title: z.string(),
    bucket: z.string(),
    from: z.number().describe("0-based index before."),
    to: z.number().describe("0-based index after."),
  })),
});

const LabelSchema = z.object({
  id: z.number().describe("Vikunja label id."),
  title: z.string().describe("Label title as stored."),
  hexColor: z.string().nullable().describe(
    "Colour as Vikunja stores it (six hex digits, no #), or null.",
  ),
  description: z.string().nullable(),
  status: z.enum(["created", "exists"]).describe(
    "created: this run made the label. exists: a label with this title " +
      "(case-insensitive) was already there, and nothing was written.",
  ),
  fetchedAt: z.string(),
});
/** The `label` resource written by create_label. */
export type LabelRecord = z.infer<typeof LabelSchema>;

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
});
/** The `dueReport` resource written by due_report. */
export type DueReport = z.infer<typeof DueReportSchema>;

const BoardCardSchema = z.object({
  id: z.number(),
  title: z.string(),
  description: z.string().describe("Description HTML as stored."),
  bucket: z.string().describe("Title of the bucket the card sits in."),
  role: z.string().describe("That bucket's role (bucketRoles), or other."),
  labels: z.array(z.string()),
  priority: z.number(),
  dueDate: z.string().nullable().describe("ISO 8601, or null when unset."),
  updated: z.string(),
  created: z.string(),
  position: z.number().describe("Position within the bucket (view order)."),
});

const BoardSnapshotSchema = z.object({
  projectId: z.number(),
  viewId: z.number(),
  fetchedAt: z.string(),
  buckets: z.array(z.object({
    id: z.number(),
    title: z.string(),
    role: z.string(),
    count: z.number().describe("Cards of this bucket in `cards`."),
  })).describe("Every bucket in view order, the done bucket included."),
  cards: z.array(BoardCardSchema).describe(
    "Every card that is not done and not in the done bucket, bucket by " +
      "bucket in view order.",
  ),
  total: z.number(),
  truncated: z.boolean().default(false).describe(
    "True when the board read stopped at the page cap with pages still " +
      "growing: some cards are missing from `cards`.",
  ),
});
/** The `boardSnapshot` resource written by board. */
export type BoardSnapshot = z.infer<typeof BoardSnapshotSchema>;

const PlanOpResultSchema = z.object({
  index: z.number().describe("0-based position in ops."),
  op: z.string(),
  taskId: z.number().nullable().describe(
    "The card the op targets; for a create, the id it got (or the " +
      "existing card a skip found).",
  ),
  title: z.string().nullable(),
  status: z.enum(["ok", "invalid", "skip", "done", "failed", "not-run"])
    .describe(
      "ok: valid, not run (dry run, or refused plan). invalid: has " +
        "problems. skip: a create whose title exists (duplicateTitle " +
        "skip). done / failed / not-run: what apply did.",
    ),
  problems: z.array(z.string()),
  error: z.string().optional().describe("Why a failed op failed."),
});

const PlanResultSchema = z.object({
  projectId: z.number(),
  viewId: z.number(),
  plannedAt: z.string(),
  outcome: z.enum(["dry-run", "refused", "applied", "failed"]).describe(
    "dry-run: nothing written. refused: apply was asked but at least one " +
      "problem was found, so nothing was written. applied: every op ran " +
      "and read back. failed: stopped at the first failing op.",
  ),
  valid: z.boolean().describe("True when validation found no problems."),
  counts: z.object({
    ops: z.number(),
    problems: z.number(),
    done: z.number(),
    failed: z.number(),
    notRun: z.number(),
    skipped: z.number(),
  }),
  problems: z.array(z.object({
    index: z.number().nullable().describe("null: a plan-level problem."),
    op: z.string().nullable(),
    taskId: z.number().nullable(),
    problem: z.string(),
  })).describe("Every validation problem, in op order."),
  ops: z.array(PlanOpResultSchema),
});
/** The `planResult` resource written by apply_plan. */
export type PlanResult = z.infer<typeof PlanResultSchema>;

// ============================================================================
// Method argument schemas
// ============================================================================

const LabelName = z.string().min(1).describe(
  "Label title to attach to the task (case-insensitive), resolved via " +
    "GET /labels. Must already exist on the Vikunja instance: only " +
    "create_label creates labels, never as a side effect of another write.",
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
  labels: z.array(z.string().min(1)).optional().describe(
    "Label titles to attach (case-insensitive), in addition to `label`. " +
      "Every name is resolved before the task is created, so an unknown " +
      "label fails with nothing created. Labels must already exist.",
  ),
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
  duplicateTitle: z.enum(["refuse", "skip", "allow"]).optional().describe(
    "What to do when a non-done task in the project already has this title " +
      "(trimmed, case-insensitive): refuse = fail with nothing created; " +
      "skip = create nothing and record the existing task as the result " +
      "(idempotency — Vikunja has no idempotency key); allow = create " +
      "anyway. Default: skip, or allow when skipIfTitleExists is false.",
  ),
  skipIfTitleExists: z.boolean().optional().describe(
    "Deprecated alias kept for existing callers: true (the old default) = " +
      'duplicateTitle "skip", false = "allow". duplicateTitle wins when ' +
      "both are given.",
  ),
  requireReady: z.boolean().default(false).describe(
    "Apply the full Definition of Ready (as audit checks it in the ready " +
      "column) whatever the target bucket. Creating into the ready bucket " +
      "always applies it.",
  ),
});
type NewTaskArgs = z.infer<typeof NewTaskArgsSchema>;

const AuditArgsSchema = z.object({
  projectId: ProjectIdOverride,
});

const BoardArgsSchema = z.object({
  projectId: ProjectIdOverride,
});

const GetTaskArgsSchema = z.object({
  taskId: z.number().int().positive().describe("Vikunja task id."),
  projectId: ProjectIdOverride.describe(
    "Project whose kanban view is read for the card's bucket. Defaults to " +
      "the configured projectId.",
  ),
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

const SetDueDateArgsSchema = z.object({
  taskId: z.number().int().positive().describe("Vikunja task id."),
  dueDate: z.string().describe(
    "ISO 8601 instant to set as the due date (the day to look at the card " +
      "again), e.g. 2026-11-04T17:00:00Z. An empty string clears it.",
  ),
  projectId: ProjectIdOverride.describe(
    "Project whose kanban view is read to assert the card's bucket did not " +
      "change. Defaults to the configured projectId.",
  ),
  force: z.boolean().default(false).describe(
    "Write even though the card was updated within " +
      "policy.recentEditMinutes by something other than this model, or " +
      "clear the due date of a card in the waiting bucket.",
  ),
});

const TaskId = z.number().int().positive().describe("Vikunja task id.");

const Force = z.boolean().default(false).describe(
  "Write even though the card was updated within policy.recentEditMinutes " +
    "by something other than this model.",
);

const BoardProject = ProjectIdOverride.describe(
  "Project whose kanban view is read for the card's bucket. Defaults to " +
    "the configured projectId.",
);

const UpdateTaskArgsSchema = z.object({
  taskId: TaskId,
  title: z.string().trim().min(1, "title must not be empty").optional()
    .describe("New title."),
  description: z.string().optional().describe(
    "New description (HTML), replacing the old one. An empty or " +
      "whitespace-only value is refused.",
  ),
  priority: z.number().int().min(0).max(5).optional().describe(
    "New priority (0=unset .. 5=DO NOW).",
  ),
  projectId: BoardProject,
  force: Force,
}).refine(
  (a) =>
    a.title !== undefined || a.description !== undefined ||
    a.priority !== undefined,
  { message: "pass at least one of title, description, priority" },
);

const SetLabelsArgsSchema = z.object({
  taskId: TaskId,
  add: z.array(z.string().min(1)).default([]).describe(
    "Label titles to attach (case-insensitive). Must already exist.",
  ),
  remove: z.array(z.string().min(1)).default([]).describe(
    "Label titles to detach (case-insensitive). Must exist on the " +
      "instance, so a typo fails instead of reading as removed.",
  ),
  force: Force,
}).refine((a) => a.add.length + a.remove.length > 0, {
  message: "pass at least one label in add or remove",
}).refine(
  (a) => {
    const add = new Set(a.add.map((n) => n.toLowerCase()));
    return !a.remove.some((n) => add.has(n.toLowerCase()));
  },
  { message: "a label cannot be in both add and remove" },
);

const MoveTaskArgsSchema = z.object({
  taskId: TaskId,
  bucketName: z.string().min(1).describe(
    "Bucket title (case-insensitive) to move the card into. The done " +
      "bucket is refused; use close_task. Moving into the ready bucket " +
      "needs the full Definition of Ready, and into waiting a due date.",
  ),
  projectId: BoardProject,
  force: Force.describe(
    "Write even though the card was updated within " +
      "policy.recentEditMinutes by something other than this model, or " +
      "does not meet the target bucket's readiness rules.",
  ),
});

const CloseTaskArgsSchema = z.object({
  taskId: TaskId,
  humanInstructed: z.boolean().default(false).describe(
    "Must be true. Closing a card is a person's decision, so a caller has " +
      "to state that a person asked for it.",
  ),
  projectId: BoardProject,
});

const CreateLabelArgsSchema = z.object({
  title: z.string().trim().min(1, "title must not be empty").describe(
    "Label title. An existing label with this title (case-insensitive) is " +
      "returned instead of creating a duplicate.",
  ),
  hexColor: z.string().trim().regex(
    /^#?[0-9a-fA-F]{6}$/,
    "hexColor must be six hex digits, with or without a leading #",
  ).optional().describe("Optional colour, e.g. 1973ff or #1973ff."),
  description: z.string().optional().describe("Optional label description."),
  humanInstructed: z.boolean().default(false).describe(
    "Must be true. Labels are the board's shared vocabulary, so a caller " +
      "has to state that a person asked for this one; unattended runs (the " +
      "groomer) never create labels.",
  ),
});

const ReorderArgsSchema = z.object({
  projectId: ProjectIdOverride,
  apply: z.boolean().default(false).describe(
    "false (default) only reports the moves that would be made. true " +
      "performs them one at a time — read the bucket, move the first card " +
      "that is out of place to the midpoint of its intended neighbours, " +
      "re-read, repeat — and fails if the board has not converged. When a " +
      "gap is too small to halve (or Vikunja answers 4028), it first makes " +
      "Vikunja respace the whole view, once per stuck move.",
  ),
  buckets: z.array(z.string()).optional().describe(
    "Bucket titles (case-insensitive) to reorder. Default: every bucket " +
      "except the done role.",
  ),
  maxIterations: z.number().int().min(1).max(500).default(100).describe(
    "Move budget PER BUCKET: reorder gives up on a bucket after " +
      "max(maxIterations, 2 x its card count) single-card moves in it. One " +
      "long bucket no longer spends the budget of the buckets after it.",
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

const PlanForce = z.boolean().default(false).describe(
  "Per-op override, as on the single methods: write despite the " +
    "recent-edit guard (and, for move, the target bucket's readiness " +
    "rules; for due, clearing a waiting card's date).",
);

const PlanOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    title: z.string().min(1),
    description: z.string().optional(),
    labels: z.array(z.string().min(1)).default([]),
    priority: z.number().int().min(0).max(5).optional(),
    dueDate: z.string().optional(),
    bucketName: z.string().optional().describe(
      "Default: the defaultBucketName global argument.",
    ),
    duplicateTitle: z.enum(["refuse", "skip", "allow"]).default("refuse")
      .describe(
        "As new_task, but refuse by default inside a plan. skip leaves " +
          "the op out of the run and reports the existing card.",
      ),
    requireReady: z.boolean().optional().describe(
      "Overrides the plan's requireReady for this create.",
    ),
  }),
  z.object({
    op: z.literal("update"),
    taskId: z.number().int().positive(),
    title: z.string().optional(),
    description: z.string().optional(),
    priority: z.number().int().min(0).max(5).optional(),
    force: PlanForce,
  }),
  z.object({
    op: z.literal("labels"),
    taskId: z.number().int().positive(),
    add: z.array(z.string().min(1)).default([]),
    remove: z.array(z.string().min(1)).default([]),
    force: PlanForce,
  }),
  z.object({
    op: z.literal("move"),
    taskId: z.number().int().positive(),
    bucketName: z.string().min(1),
    force: PlanForce,
  }),
  z.object({
    op: z.literal("due"),
    taskId: z.number().int().positive(),
    dueDate: z.string().nullable().describe('ISO 8601; null or "" clears.'),
    force: PlanForce,
  }),
  z.object({
    op: z.literal("close"),
    taskId: z.number().int().positive(),
    humanInstructed: z.boolean().default(false).describe(
      "Must be true on every close op: a person asked for it.",
    ),
  }),
]);
/** One operation of an apply_plan batch. */
export type PlanOp = z.infer<typeof PlanOpSchema>;

const ApplyPlanArgsSchema = z.object({
  ops: z.array(PlanOpSchema).min(1).describe(
    "Operations, run in this order. Discriminated on `op`: create " +
      "(new_task fields), update (taskId + title/description/priority), " +
      "labels (taskId + add/remove), move (taskId + bucketName), due " +
      "(taskId + dueDate, null clears), close (taskId + humanInstructed: " +
      "true).",
  ),
  apply: z.boolean().default(false).describe(
    "false (default): validate every op against the live board and write " +
      "only the planResult resource. true: validate, and write NOTHING " +
      "unless every op is valid; then run the ops in order, stopping at " +
      "the first failure.",
  ),
  requireReady: z.boolean().default(true).describe(
    "Apply the full Definition of Ready to every create, whatever its " +
      "bucket (a create op's own requireReady overrides it).",
  ),
  maxOps: z.number().int().min(1).max(500).default(60).describe(
    "Refuse a plan with more ops than this.",
  ),
  projectId: ProjectIdOverride,
});
type ApplyPlanArgs = z.infer<typeof ApplyPlanArgsSchema>;

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
  readResource?: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
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
  method: "GET" | "PUT" | "POST" | "DELETE",
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

interface LabelRef {
  id: number;
  title: string;
}

/**
 * The server's page size from GET /info (`max_items_per_page`), or null when
 * /info is unreadable. Vikunja clamps any larger `per_page` to this value.
 */
async function serverPageSize(g: GlobalArgs): Promise<number | null> {
  const info = await vreq(g, "GET", "/info").catch(() => null) as
    | Record<string, unknown>
    | null;
  return info && typeof info.max_items_per_page === "number" &&
      info.max_items_per_page > 0
    ? info.max_items_per_page
    : null;
}

/** Most pages any paged read fetches before it reports `truncated`. */
export const MAX_PAGES = 100;

/**
 * GET every page of a paginated list endpoint, de-duplicated by numeric id.
 * Vikunja clamps `per_page` to `max_items_per_page` (50 by default), so one
 * request silently truncates any longer list. Stops on a page that adds no
 * new id (an empty page, or a server that ignores `page`), on a short page
 * when the page size is known from /info, or after MAX_PAGES pages, in
 * which case `truncated` is true and the list is incomplete.
 */
async function fetchAllPages(
  g: GlobalArgs,
  path: string,
  search: Record<string, string> = {},
): Promise<{ items: Array<Record<string, unknown>>; truncated: boolean }> {
  const known = await serverPageSize(g);
  const perPage = known ?? 50;
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<number>();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const raw = asArray(
      await vreq(g, "GET", path, {
        search: { ...search, page: String(page), per_page: String(perPage) },
      }),
    );
    let grew = false;
    for (const item of raw) {
      if (typeof item.id !== "number" || seen.has(item.id)) continue;
      seen.add(item.id);
      out.push(item);
      grew = true;
    }
    // A short page ends the list only when the page size is trusted: with
    // the fallback, a server capped below 50 would look short on page 1.
    if (!grew || (known !== null && raw.length < perPage)) {
      return { items: out, truncated: false };
    }
  }
  return { items: out, truncated: true };
}

/**
 * Every label visible to the token, keyed by lower-cased title. Throws when
 * the list is truncated: resolving (or, in create_label, de-duplicating)
 * against part of the labels would be wrong without saying so.
 */
async function fetchAllLabels(g: GlobalArgs): Promise<Map<string, LabelRef>> {
  const known = new Map<string, LabelRef>();
  const { items, truncated } = await fetchAllPages(g, "/labels");
  if (truncated) {
    throw new Error(
      `GET /labels still had more after ${MAX_PAGES} pages; refusing to ` +
        "resolve or create labels against a truncated list.",
    );
  }
  for (const l of items) {
    if (typeof l.id === "number" && typeof l.title === "string") {
      known.set(l.title.toLowerCase(), { id: l.id, title: l.title });
    }
  }
  return known;
}

/**
 * Resolve label titles (case-insensitive) to their ids against `known`
 * (from fetchAllLabels, which reads every page of GET /labels),
 * de-duplicated. Throws naming every unknown title and listing the known
 * ones. Only create_label creates labels; no other write does it implicitly.
 */
function resolveLabels(
  known: Map<string, LabelRef>,
  names: string[],
): LabelRef[] {
  const out: LabelRef[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const hit = known.get(name.toLowerCase());
    if (!hit) unknown.push(name);
    else if (!out.some((l) => l.id === hit.id)) out.push(hit);
  }
  if (unknown.length) {
    throw new Error(
      `Label(s) not found on this Vikunja instance: ${unknown.join(", ")} ` +
        `(create them with create_label first); known: ` +
        [...known.values()].map((l) => l.title).sort().join(", "),
    );
  }
  return out;
}

/** Lower-cased titles of the labels on a raw task. */
function labelTitlesOf(raw: Record<string, unknown>): Set<string> {
  return new Set(
    asArray(raw.labels).map((l) => l.title).filter((t): t is string =>
      typeof t === "string"
    ).map((t) => t.toLowerCase()),
  );
}

async function readTask(
  g: GlobalArgs,
  taskId: number,
): Promise<Record<string, unknown>> {
  return await vreq(g, "GET", `/tasks/${taskId}`) as Record<string, unknown>;
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
  const duplicates = duplicateModeOf(args);

  // Resolve the destination bucket up front: an unknown bucket name must
  // fail here, before anything is created, rather than leave a task sitting
  // in the view's default column.
  const bucketName = args.bucketName ?? g.defaultBucketName;
  let target: { viewId: number; bucketId: number; bucketTitle: string } | null =
    null;
  const viewId = bucketName || duplicates !== "allow"
    ? await resolveKanbanViewId(g, projectId)
    : null;
  if (bucketName) {
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
  // Labels too: a typo must not leave a half-labelled task behind.
  const labelNames = [
    ...(args.label ? [args.label] : []),
    ...(args.labels ?? []),
  ];
  const labels = labelNames.length
    ? resolveLabels(await fetchAllLabels(g), labelNames)
    : [];

  // Readiness, keyed by the destination bucket's role. With placement
  // disabled there is no role, so only the title is required (unless
  // requireReady).
  const wantedDue = args.dueDate?.trim() ? args.dueDate.trim() : null;
  if (wantedDue !== null && !Number.isFinite(Date.parse(wantedDue))) {
    throw new Error(`dueDate is not a parseable instant: ${args.dueDate}`);
  }
  const role: Role = target
    ? roleOf(target.bucketTitle, g.bucketRoles)
    : "other";
  const problems = readinessProblems(
    {
      title: args.title,
      description: args.description ?? "",
      labels: labels.map((l) => l.title),
      priority: args.priority ?? 0,
      dueDate: wantedDue,
    },
    role,
    g.policy,
    { intent: "create", requireReady: args.requireReady },
  );
  if (problems.length) {
    throw new Error(
      `Refusing to create "${args.title}" in ` +
        `"${target?.bucketTitle ?? "(no bucket)"}": ` +
        `${formatProblems(problems)}. Nothing was created.`,
    );
  }

  if (duplicates !== "allow") {
    const dup = await findOpenTitle(g, projectId, viewId, args.title);
    if (dup !== null) {
      if (duplicates === "refuse") {
        throw new Error(
          `Refusing to create "${args.title}": open task ${dup} already has ` +
            `that title (case-insensitive). Nothing was created; pass ` +
            `duplicateTitle: "allow" to create it anyway.`,
        );
      }
      ctx.logger?.info(
        "Task with matching title already exists \u2014 skipping create",
        { title: args.title, existingId: dup, projectId },
      );
      // get-<id>, not task-<id>: this model did not write the card, and
      // task-<id> is what guardWrite trusts as our own last write.
      const handle = await ctx.writeResource(
        "vikunjaTask",
        `get-${dup}`,
        toVikunjaTask(await readTask(g, dup), fetchedAt),
      );
      return { dataHandles: [handle] };
    }
  }

  const body: Record<string, unknown> = { title: args.title };
  if (args.description) body.description = args.description;
  if (wantedDue !== null) body.due_date = wantedDue;
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

  // A create can ignore due_date (and priority): fix them with a
  // full-replace write now, before labels and the bucket move.
  const fresh = await readTask(g, taskId);
  const fix: Record<string, unknown> = {};
  if (args.priority !== undefined && fresh.priority !== args.priority) {
    fix.priority = args.priority;
  }
  if (
    wantedDue !== null && !sameInstant(dueDateOf(fresh.due_date), wantedDue)
  ) {
    fix.due_date = wantedDue;
  }
  if (Object.keys(fix).length) {
    await vreq(g, "POST", `/tasks/${taskId}`, { body: { ...fresh, ...fix } });
  }

  for (const label of labels) {
    try {
      await vreq(g, "PUT", `/tasks/${taskId}/labels`, {
        body: { label_id: label.id },
      });
    } catch (e) {
      throw new Error(
        `Task ${taskId} was created but label "${label.title}" could not be ` +
          `attached: ` + (e instanceof Error ? e.message : String(e)),
      );
    }
  }

  // Bucket move LAST: a later full-replace task write can un-bucket a card.
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
    ctx.logger?.info("Placed task {taskId} into bucket {bucket}", {
      taskId,
      bucket: target.bucketTitle,
      projectId,
      viewId: target.viewId,
      bucketId: target.bucketId,
    });
  }

  // Full read-back: HTTP 200 proves nothing.
  const final = await readTask(g, taskId);
  const errors = createReadBackErrors(final, {
    title: args.title,
    description: args.description || undefined,
    priority: args.priority,
    dueDate: wantedDue,
    labels: labels.map((l) => l.title),
  });
  if (target) {
    const bucket = await bucketTitleOf(g, projectId, target.viewId, taskId);
    if (bucket !== target.bucketTitle) {
      errors.push(
        `bucket read back as "${bucket}", not "${target.bucketTitle}"`,
      );
    }
  }

  // Record it even on a mismatch, so a follow-up edit is recognised as ours.
  const handle = await ctx.writeResource(
    "vikunjaTask",
    `task-${taskId}`,
    toVikunjaTask(
      target ? { ...final, placement: target } : final,
      fetchedAt,
    ),
  );
  if (errors.length) {
    throw new Error(
      `Task ${taskId} was created but did not read back as sent: ` +
        `${errors.join("; ")}.`,
    );
  }
  ctx.logger?.info("Vikunja task created: {taskId}", {
    taskId,
    title: args.title,
    projectId,
    bucket: target?.bucketTitle ?? null,
  });
  return { dataHandles: [handle] };
}

/** new_task's duplicate policy, honouring the deprecated skipIfTitleExists. */
function duplicateModeOf(
  args: Pick<NewTaskArgs, "duplicateTitle" | "skipIfTitleExists">,
): "refuse" | "skip" | "allow" {
  if (args.duplicateTitle) return args.duplicateTitle;
  return args.skipIfTitleExists === false ? "allow" : "skip";
}

/** Both unset, or the same instant however it is written. */
function sameInstant(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return Date.parse(a) === Date.parse(b);
}

/**
 * The id of a not-done task in the project whose title matches (trimmed,
 * case-insensitive), or null. Reads the kanban board when there is one —
 * every task sits in a bucket, and the match cannot depend on how the
 * server's `s` search treats case — else the paged title search.
 */
async function findOpenTitle(
  g: GlobalArgs,
  projectId: number,
  viewId: number | null,
  title: string,
): Promise<number | null> {
  const open: Array<{ id: number; title: string }> = [];
  if (viewId !== null) {
    for (const b of await fetchBoard(g, projectId, viewId)) {
      if (roleOf(b.title, g.bucketRoles) === "done") continue;
      open.push(...b.tasks.filter((t) => !t.done));
    }
  } else {
    const { items, truncated } = await fetchAllPages(
      g,
      `/projects/${projectId}/tasks`,
      { s: title.trim() },
    );
    if (truncated) {
      throw new Error(
        `The title search for a duplicate still had more after ${MAX_PAGES} ` +
          "pages; refusing to decide the title is new.",
      );
    }
    for (const t of items) {
      if (
        typeof t.id === "number" && typeof t.title === "string" &&
        t.done !== true
      ) open.push({ id: t.id, title: t.title });
    }
  }
  return open.find((t) => sameTitle(t.title, title))?.id ?? null;
}

/**
 * Compare a created task, as read back, with what was asked for. Fields
 * that were not given are not checked. Returns one line per mismatch.
 */
export function createReadBackErrors(
  got: Record<string, unknown>,
  want: {
    title: string;
    description?: string;
    priority?: number;
    dueDate: string | null;
    labels: string[];
  },
): string[] {
  const errors: string[] = [];
  if (got.title !== want.title) {
    errors.push(`title read back as ${JSON.stringify(got.title)}`);
  }
  if (want.description !== undefined && got.description !== want.description) {
    const len = typeof got.description === "string"
      ? textLength(got.description)
      : 0;
    errors.push(`description read back differs (${len} visible chars)`);
  }
  if (want.priority !== undefined && got.priority !== want.priority) {
    errors.push(`priority read back as ${got.priority}`);
  }
  if (!sameInstant(dueDateOf(got.due_date), want.dueDate)) {
    errors.push(`due date read back as ${dueDateOf(got.due_date)}`);
  }
  const have = labelTitlesOf(got);
  const missing = want.labels.filter((l) => !have.has(l.toLowerCase()));
  if (missing.length) errors.push(`label(s) ${missing.join(", ")} missing`);
  return errors;
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
  ctx.logger?.info("Fetched {count} recent Vikunja tasks", {
    count: ids.length,
    projectId,
  });
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
 * `truncated` is true when MAX_PAGES pages were read and the last one still
 * added cards.
 */
async function readBoard(
  g: GlobalArgs,
  projectId: number,
  viewId: number,
): Promise<{ buckets: BoardBucket[]; truncated: boolean }> {
  const info = await vreq(g, "GET", "/info").catch(() => null) as
    | Record<string, unknown>
    | null;
  const perPage = info && typeof info.max_items_per_page === "number"
    ? info.max_items_per_page
    : 50;

  const buckets = new Map<number, BoardBucket>();
  let truncated = true;
  for (let page = 1; page <= MAX_PAGES; page++) {
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
    if (!grew) {
      truncated = false;
      break;
    }
  }
  const out = [...buckets.values()].sort((a, b) => a.position - b.position);
  for (const b of out) b.tasks.sort((a, c) => a.position - c.position);
  return { buckets: out, truncated };
}

/**
 * readBoard for everything that acts on the board (writes, reorder, due
 * report, duplicate checks): a truncated read throws, because a card that
 * was not read looks like a card that is not there. board and audit call
 * readBoard and report `truncated` instead.
 */
async function fetchBoard(
  g: GlobalArgs,
  projectId: number,
  viewId: number,
): Promise<BoardBucket[]> {
  const { buckets, truncated } = await readBoard(g, projectId, viewId);
  if (truncated) {
    throw new Error(
      `Project ${projectId} view ${viewId} still had more cards after ` +
        `${MAX_PAGES} pages; refusing to act on a truncated board.`,
    );
  }
  return buckets;
}

/**
 * The order a bucket should be in: priority descending (5 = DO NOW first,
 * 0 = unset last), then by age. Stable, so already-ordered input is
 * returned unchanged.
 */
export function intendedOrder(
  tasks: BoardTask[],
  tieBreak: Policy["tieBreak"],
  role: Role = "other",
): BoardTask[] {
  return [...tasks].sort((a, b) => {
    if (role === "waiting") {
      // A waiting column is a calendar: soonest due *day* on top, undated
      // (which audit reports as an error) at the bottom. The due date means
      // "look at it again on this day", so two cards due the same UTC day
      // are equal here whatever their time of day, and priority decides.
      const da = a.dueDate === null ? Infinity : utcDay(Date.parse(a.dueDate));
      const db = b.dueDate === null ? Infinity : utcDay(Date.parse(b.dueDate));
      if (da !== db) return da - db;
    }
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

// ============================================================================
// Readiness rules — shared by audit and every write path
// ============================================================================

/** The fields of a card the Definition-of-Ready rules look at. */
export interface CardState {
  title: string;
  description: string;
  labels: string[];
  priority: number;
  dueDate: string | null;
}

/**
 * One Definition-of-Ready check that failed. `weight` is how hard the rule
 * is outside the ready column: `always` is an error everywhere, `must` an
 * error in executable columns and a warning elsewhere, `marker` an error in
 * executable columns and info elsewhere. Writes that enforce readiness treat
 * every weight as a refusal.
 */
export interface DorCheck {
  rule: string;
  detail: string;
  weight: "always" | "must" | "marker";
}

/**
 * The Definition-of-Ready content rules, in the order audit reports them:
 * description length, label groups, priority, then the verdict / acceptance
 * / source-link markers (only checked when the description has text).
 *
 * Marker matching: verdict markers are case-SENSITIVE (a verdict is a
 * shouted word, and "confirmed" in prose is not one); acceptance markers
 * are case-INSENSITIVE ("Acceptance:", "acceptance criteria", "verify
 * with" all count). The source link is a case-sensitive prefix match.
 */
export function dorChecks(
  card: Pick<CardState, "description" | "labels" | "priority">,
  policy: Policy,
): DorCheck[] {
  const out: DorCheck[] = [];
  const add = (rule: string, weight: DorCheck["weight"], detail: string) =>
    out.push({ rule, detail, weight });

  const len = textLength(card.description);
  if (len === 0) add("empty-description", "always", "description is empty");
  else if (len < policy.minDescriptionChars) {
    add(
      "short-description",
      "must",
      `${len} chars < ${policy.minDescriptionChars}`,
    );
  }

  if (card.labels.length === 0) add("no-labels", "must", "no labels at all");
  else {
    for (const prefix of policy.requiredLabelPrefixes) {
      if (
        !card.labels.some((l) =>
          l.toLowerCase().startsWith(prefix.toLowerCase())
        )
      ) {
        add(
          "missing-label-group",
          "must",
          `no label starting with "${prefix}"`,
        );
      }
    }
    const isGroup = (l: string) =>
      policy.requiredLabelPrefixes.some((p) =>
        l.toLowerCase().startsWith(p.toLowerCase())
      );
    if (!card.labels.some((l) => !isGroup(l))) {
      add("missing-area-label", "must", "only group labels, no area label");
    }
  }

  if (card.priority < 1 || card.priority > 5) {
    add(
      "priority-unset",
      "must",
      card.priority === 0
        ? "priority is 0 (unset)"
        : `priority ${card.priority} is outside 1-5`,
    );
  }

  if (len > 0) {
    const desc = card.description;
    if (!policy.verdictMarkers.some((m) => desc.includes(m))) {
      add(
        "missing-verdict",
        "marker",
        `no premise-check verdict (${policy.verdictMarkers.join("/")})`,
      );
    }
    const lower = desc.toLowerCase();
    if (
      !policy.acceptanceMarkers.some((m) => lower.includes(m.toLowerCase()))
    ) {
      add(
        "missing-acceptance",
        "marker",
        `no acceptance marker (${policy.acceptanceMarkers.join("/")})`,
      );
    }
    if (
      policy.requiredLinkPrefix && !desc.includes(policy.requiredLinkPrefix)
    ) {
      add(
        "missing-link",
        "must",
        `no ${policy.requiredLinkPrefix} link to the source note`,
      );
    }
  }
  return out;
}

/** A reason a write is refused by the readiness rules. */
export interface ReadinessProblem {
  rule: string;
  detail: string;
}

/**
 * What a card must satisfy to be created in, or moved into, a bucket of
 * `role` — the write-side counterpart of audit, built on the same checks:
 *
 * - every card: a non-empty title;
 * - create into doing / review / done: refused (people start and finish
 *   work); move into done: refused (close_task);
 * - ready: the full Definition of Ready (dorChecks, every weight) — which
 *   includes a label matching each requiredLabelPrefixes group, at least
 *   one label outside them (the area), and priority 1-5;
 * - waiting: a due date;
 * - backlog / blocked / other: nothing more, so automation can file stubs.
 *
 * `requireReady` applies the full Definition of Ready whatever the role.
 */
export function readinessProblems(
  card: CardState,
  role: Role,
  policy: Policy,
  opts: { intent: "create" | "move"; requireReady?: boolean },
): ReadinessProblem[] {
  const out: ReadinessProblem[] = [];
  if (card.title.trim() === "") {
    out.push({ rule: "empty-title", detail: "title is empty" });
  }
  const refused = opts.intent === "create"
    ? role === "doing" || role === "review" || role === "done"
    : role === "done";
  if (refused) {
    out.push({
      rule: "refused-bucket",
      detail: opts.intent === "create"
        ? `new cards are never created in the ${role} column`
        : "moving into the done column is close_task's job",
    });
  }
  if (role === "ready" || opts.requireReady) {
    for (const c of dorChecks(card, policy)) {
      out.push({ rule: c.rule, detail: c.detail });
    }
  }
  if (role === "waiting" && card.dueDate === null) {
    out.push({
      rule: "missing-due-date",
      detail: "a waiting card needs a due date — the day to look at it again",
    });
  }
  return out;
}

/** One line per problem, for error messages. */
export function formatProblems(ps: ReadinessProblem[]): string {
  return ps.map((p) => `${p.rule} (${p.detail})`).join("; ");
}

/** The readiness view of a raw Vikunja task object. */
function cardStateOf(raw: Record<string, unknown>): CardState {
  return {
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    labels: asArray(raw.labels).map((l) => l.title).filter((
      t,
    ): t is string => typeof t === "string"),
    priority: typeof raw.priority === "number" ? raw.priority : 0,
    dueDate: dueDateOf(raw.due_date),
  };
}

/** Title comparison used for duplicate detection: trimmed, case-insensitive. */
export function sameTitle(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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

  // A waiting card is parked until a date, so the date IS the reason it is
  // there: none is an error, and one that has passed means the wait is over
  // and nobody acted — stale by definition, however recently it was edited.
  if (role === "waiting") {
    if (task.dueDate === null) {
      add(
        "missing-due-date",
        "error",
        "waiting with no due date — set the day to look at it again",
      );
    } else {
      const overBy = utcDay(now.getTime()) - utcDay(Date.parse(task.dueDate));
      if (overBy > 0) {
        add(
          "stale",
          "warn",
          `due date passed ${overBy} d ago — act on it or re-date it`,
        );
      }
    }
  }

  // The content rules are shared with the write paths (readinessProblems);
  // only the severity depends on where the card sits.
  for (const c of dorChecks(task, policy)) {
    add(
      c.rule,
      c.weight === "always"
        ? "error"
        : c.weight === "must"
        ? must
        : executable
        ? "error"
        : "info",
      c.detail,
    );
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
    sameOrder(
      bucket.tasks,
      intendedOrder(bucket.tasks, policy.tieBreak, role),
    );
  if (!inOrder) {
    findings.push({
      taskId: null,
      title: null,
      bucket: bucket.title,
      role,
      rule: "out-of-order",
      severity: "warn",
      detail: role === "waiting"
        ? "not sorted by due day, then priority — run reorder"
        : "not sorted by priority desc, then age — run reorder",
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
 * Vikunja v2.6's MinPositionSpacing (pkg/models/task_position.go). A position
 * POST that collides with another card's position and has less room than
 * this to spread them fails with 500 code 4028 ("Position repair requires
 * full view recalculation"); one below it makes Vikunja respace the view.
 */
export const MIN_POSITION_SPACING = 0.01;

/**
 * The single move that brings a bucket one step closer to `intended`: the
 * first slot whose occupant is wrong gets the card that belongs there,
 * positioned at the midpoint of its new neighbours. Returns null when the
 * bucket is already in order. `cramped` means the midpoint would sit closer
 * than MIN_POSITION_SPACING to a neighbour: repeated halving has used up the
 * gap, and the view needs respacing before the move can land reliably.
 */
export function nextMove(
  current: BoardTask[],
  intended: BoardTask[],
): {
  task: BoardTask;
  index: number;
  position: number;
  cramped: boolean;
} | null {
  for (let i = 0; i < intended.length; i++) {
    if (current[i]?.id === intended[i].id) continue;
    const task = intended[i];
    const lo = i > 0 ? current[i - 1].position : 0;
    const hi = current[i]?.position ?? lo + 65_536;
    // Vikunja re-derives positions on write, so a collapsed gap is not
    // fatal — nudge past `lo` and let the re-read decide.
    const position = hi > lo ? (lo + hi) / 2 : lo + 1;
    const cramped = !(hi - lo >= 2 * MIN_POSITION_SPACING);
    return { task, index: i, position, cramped };
  }
  return null;
}

/** How many entries per bucket, in first-seen order. */
function countBy(
  made: Array<{ bucket: string }>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of made) out[m.bucket] = (out[m.bucket] ?? 0) + 1;
  return out;
}

function formatCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([k, n]) => `${k} ${n}`);
  return parts.length ? parts.join(", ") : "none";
}

/** Whether an error is Vikunja's 4028 "needs full view recalculation". */
function isNeedsRecalculation(err: unknown): boolean {
  return err instanceof Error && /"code":\s*4028\b/.test(err.message);
}

/**
 * Make Vikunja respace every position in the view. v2.6 has no endpoint for
 * this, but its position update runs a full RecalculateTaskPositions when the
 * new position is below MIN_POSITION_SPACING. Sending `taskId` (the card that
 * belongs first in its bucket) to 0 triggers that and leaves it first, where
 * it belongs anyway; every other card keeps its relative order.
 */
async function recalculatePositions(
  g: GlobalArgs,
  viewId: number,
  taskId: number,
): Promise<void> {
  await vreq(g, "POST", `/tasks/${taskId}/position`, {
    body: { project_view_id: viewId, task_id: taskId, position: 0 },
  });
}

function warnTruncated(ctx: ExecCtx, method: string, projectId: number) {
  ctx.logger?.warning(
    "{method}: board read stopped at the page cap with cards still coming; " +
      "the result is truncated",
    { method, projectId, maxPages: MAX_PAGES },
  );
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
  const { buckets: board, truncated } = await readBoard(g, projectId, viewId);
  if (board.length === 0) {
    throw new Error(`Project ${projectId} view ${viewId} returned no buckets.`);
  }
  if (truncated) warnTruncated(ctx, "audit", projectId);

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
    truncated,
  });
  const handle = await ctx.writeResource(
    "boardAudit",
    `audit-${projectId}`,
    report,
  );
  ctx.logger?.info(
    "Audited project {projectId}: {cards} cards, {findings} findings, " +
      "ready {readyPassing}/{readyTotal}",
    {
      projectId,
      cards: buckets.reduce((n, b) => n + b.count, 0),
      findings: findings.length,
      readyPassing: ready.passing,
      readyTotal: ready.total,
      bySeverity,
      byRule,
    },
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
    "Due report for project {projectId}: {overdue} overdue, {dueToday} due " +
      "today, {upcoming} upcoming",
    {
      projectId,
      overdue: report.counts.overdue,
      dueToday: report.counts.dueToday,
      upcoming: report.counts.upcoming,
      asOf: report.asOf,
      lookaheadDays: args.lookaheadDays,
    },
  );
  return { dataHandles: [handle] };
}

/**
 * The not-done cards of a board as one flat, bucket-ordered list, with the
 * fields a planner needs (the whole description included).
 */
export function snapshotBoard(
  board: BoardBucket[],
  roles: Roles,
): Pick<BoardSnapshot, "buckets" | "cards" | "total"> {
  const buckets: BoardSnapshot["buckets"] = [];
  const cards: BoardSnapshot["cards"] = [];
  for (const b of board) {
    const role = roleOf(b.title, roles);
    const open = role === "done" ? [] : b.tasks.filter((t) => !t.done);
    buckets.push({ id: b.id, title: b.title, role, count: open.length });
    for (const t of open) {
      cards.push({
        id: t.id,
        title: t.title,
        description: t.description,
        bucket: b.title,
        role,
        labels: t.labels,
        priority: t.priority,
        dueDate: t.dueDate,
        updated: t.updated,
        created: t.created,
        position: t.position,
      });
    }
  }
  return { buckets, cards, total: cards.length };
}

/**
 * Read-only: write every not-done card on the board, with its bucket,
 * role, labels, priority, due date and full description, as one
 * boardSnapshot resource, so a caller can plan a batch from one read.
 */
async function boardMethod(
  args: z.infer<typeof BoardArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;
  const viewId = await requireKanbanView(g, projectId);
  const { buckets: board, truncated } = await readBoard(g, projectId, viewId);
  if (board.length === 0) {
    throw new Error(`Project ${projectId} view ${viewId} returned no buckets.`);
  }
  if (truncated) warnTruncated(ctx, "board", projectId);
  const snapshot = BoardSnapshotSchema.parse({
    projectId,
    viewId,
    fetchedAt,
    ...snapshotBoard(board, g.bucketRoles),
    truncated,
  });
  const handle = await ctx.writeResource(
    "boardSnapshot",
    `board-${projectId}`,
    snapshot,
  );
  ctx.logger?.info(
    "Board of project {projectId}: {cards} open cards in {buckets} buckets",
    {
      projectId,
      cards: snapshot.total,
      buckets: snapshot.buckets.length,
    },
  );
  return { dataHandles: [handle] };
}

/**
 * Read-only: one card and the bucket it sits in, written as a vikunjaTask
 * resource named `get-<id>`. Not `task-<id>`: that name records this
 * model's own last write, which the recent-edit guard trusts, and a read
 * must never make someone else's edit look like ours.
 */
async function getTask(
  args: z.infer<typeof GetTaskArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;
  const viewId = await requireKanbanView(g, projectId);
  const task = await readTask(g, args.taskId);
  const title = await bucketTitleOf(g, projectId, viewId, args.taskId);
  const handle = await ctx.writeResource(
    "vikunjaTask",
    `get-${args.taskId}`,
    toVikunjaTask({
      ...task,
      bucket: title === null
        ? null
        : { title, role: roleOf(title, g.bucketRoles) },
    }, fetchedAt),
  );
  ctx.logger?.info("Task {taskId}: in {bucket}", {
    taskId: args.taskId,
    bucket: title,
  });
  return { dataHandles: [handle] };
}

/** Bucket title a task currently sits in on the project's kanban view. */
async function bucketTitleOf(
  g: GlobalArgs,
  projectId: number,
  viewId: number,
  taskId: number,
): Promise<string | null> {
  const board = await fetchBoard(g, projectId, viewId);
  for (const b of board) {
    if (b.tasks.some((t) => t.id === taskId)) return b.title;
  }
  return null;
}

/**
 * Set (or clear) a task's due date. POST /tasks/{id} is a FULL REPLACE in
 * Vikunja, so this reads the whole task, changes one field, writes the whole
 * task back, then reads it again and asserts both the date and the card's
 * bucket are what they should be — HTTP 200 proves nothing on its own.
 * Refuses done cards.
 */
async function setDueDate(
  args: z.infer<typeof SetDueDateArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;
  const wanted = args.dueDate.trim() === "" ? null : args.dueDate.trim();
  if (wanted !== null && !Number.isFinite(Date.parse(wanted))) {
    throw new Error(`dueDate is not a parseable instant: ${args.dueDate}`);
  }

  // Pre-flight, in order: the card is on the view, the done/recent-edit
  // guard, and the waiting-card rule. Nothing is written before all pass.
  const viewId = await requireKanbanView(g, projectId);
  const bucketBefore = await requireBucketOf(g, projectId, viewId, args.taskId);
  const full = await readTask(g, args.taskId);
  await guardWrite(g, ctx, full, args.force);
  const clearing = clearWaitingDueProblem(
    args.taskId,
    bucketBefore,
    wanted,
    args.force,
    g.bucketRoles,
  );
  if (clearing !== null) {
    throw new Error(`${clearing}. Move it first, or pass force: true.`);
  }
  const before = dueDateOf(full.due_date);
  if (
    (before === null && wanted === null) ||
    (before !== null && wanted !== null &&
      Date.parse(before) === Date.parse(wanted))
  ) {
    ctx.logger?.info("Task {taskId}: due date already {dueDate}", {
      taskId: args.taskId,
      dueDate: wanted,
    });
  } else {
    await vreq(g, "POST", `/tasks/${args.taskId}`, {
      body: { ...full, due_date: wanted },
    });
  }

  const after = await vreq(g, "GET", `/tasks/${args.taskId}`) as Record<
    string,
    unknown
  >;
  const got = dueDateOf(after.due_date);
  const matches = wanted === null
    ? got === null
    : got !== null && Date.parse(got) === Date.parse(wanted);
  if (!matches) {
    throw new Error(
      `Task ${args.taskId}: due date read back as ${got}, wanted ${wanted}.`,
    );
  }
  await restoreBucket(
    g,
    ctx,
    projectId,
    viewId,
    args.taskId,
    bucketBefore,
    "the due date is set",
  );

  // Re-read: a move back changes `updated`, and task-<id> must hold the
  // latest one for the recent-edit guard to recognise our own write.
  const final = await readTask(g, args.taskId);
  const handle = await ctx.writeResource(
    "vikunjaTask",
    `task-${args.taskId}`,
    toVikunjaTask(final, fetchedAt),
  );
  ctx.logger?.info("Task {taskId}: due date {before} -> {after}", {
    taskId: args.taskId,
    before,
    after: got,
    bucket: bucketBefore,
  });
  return { dataHandles: [handle] };
}

/**
 * Refuse to write to a done card, or to one updated within
 * policy.recentEditMinutes by anything other than this model. "This model"
 * means the card's `updated` equals the one recorded in its `task-<id>`
 * resource by our last write, so a card this model just created or edited
 * can be edited again straight away.
 */
async function guardWrite(
  g: GlobalArgs,
  ctx: ExecCtx,
  task: Record<string, unknown>,
  force: boolean,
): Promise<void> {
  const problem = await guardProblem(g, ctx, task, force);
  if (problem !== null) throw new Error(problem);
}

/** guardWrite's check without the throw: the refusal message, or null. */
async function guardProblem(
  g: GlobalArgs,
  ctx: ExecCtx,
  task: { id?: unknown; done?: unknown; updated?: unknown },
  force: boolean,
): Promise<string | null> {
  const id = task.id;
  if (task.done === true) {
    return `Task ${id} is done; not touching a done card.`;
  }
  const minutes = g.policy.recentEditMinutes;
  if (force || minutes === 0 || typeof task.updated !== "string") return null;
  const age = Date.now() - Date.parse(task.updated);
  if (!Number.isFinite(age) || age >= minutes * 60_000) return null;
  const ours = await ctx.readResource?.(`task-${id}`).catch(() => null);
  if (ours && ours.updated === task.updated) return null;
  return `Task ${id} was updated ${task.updated} (less than ${minutes} min ago) ` +
    `by something other than this model; someone may be editing it. ` +
    `Pass force: true to write anyway.`;
}

/**
 * Pre-flight rule shared by set_due_date and apply_plan's due op: a card in
 * the waiting bucket must keep a due date, so clearing it is refused unless
 * forced. Returns the refusal, or null.
 */
function clearWaitingDueProblem(
  taskId: number,
  bucket: string,
  wanted: string | null,
  force: boolean,
  roles: Roles,
): string | null {
  if (wanted !== null || force || roleOf(bucket, roles) !== "waiting") {
    return null;
  }
  return `refusing to clear the due date of task ${taskId} while it is in ` +
    `"${bucket}": a waiting card needs one`;
}

/**
 * After a full-replace POST /tasks/{id}: Vikunja can drop the card out of
 * its bucket. If it is no longer in `bucketBefore`, move it back and verify
 * that landed. Throws only when the move back did not stick, so a write that
 * un-buckets a card never leaves it out of its column silently.
 */
async function restoreBucket(
  g: GlobalArgs,
  ctx: ExecCtx,
  projectId: number,
  viewId: number,
  taskId: number,
  bucketBefore: string,
  what: string,
): Promise<void> {
  const bucketAfter = await bucketTitleOf(g, projectId, viewId, taskId);
  if (bucketAfter === bucketBefore) return;
  const back = await resolveBucket(g, projectId, viewId, bucketBefore);
  await moveTaskToBucket(g, projectId, viewId, back.id, taskId);
  const restored = await bucketTitleOf(g, projectId, viewId, taskId);
  if (restored !== bucketBefore) {
    throw new Error(
      `Task ${taskId}: ${what}, but the write moved the card from ` +
        `"${bucketBefore}" to "${bucketAfter}" and moving it back left it ` +
        `in "${restored}".`,
    );
  }
  ctx.logger?.warning(
    "Task {taskId}: the write moved the card out of {bucket}; moved it back",
    { taskId, bucket: bucketBefore, movedTo: bucketAfter },
  );
}

/** Where a card sits now; throws when it is not on the view at all. */
async function requireBucketOf(
  g: GlobalArgs,
  projectId: number,
  viewId: number,
  taskId: number,
): Promise<string> {
  const bucket = await bucketTitleOf(g, projectId, viewId, taskId);
  if (bucket === null) {
    throw new Error(
      `Task ${taskId} is not on project ${projectId}'s kanban view.`,
    );
  }
  return bucket;
}

/**
 * Change a card's title, description and/or priority. POST /tasks/{id} is a
 * FULL REPLACE, so this reads the whole task, changes only the requested
 * fields, writes it back, re-reads, and asserts every field took. A
 * full-replace write can drop the card out of its bucket; if the bucket
 * changed, the card is moved back and that is verified too.
 */
async function updateTask(
  args: z.infer<typeof UpdateTaskArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;
  if (args.description !== undefined && textLength(args.description) === 0) {
    throw new Error("Refusing to write an empty description.");
  }

  const viewId = await requireKanbanView(g, projectId);
  const bucketBefore = await requireBucketOf(g, projectId, viewId, args.taskId);
  const full = await readTask(g, args.taskId);
  await guardWrite(g, ctx, full, args.force);

  const wanted: Record<string, unknown> = {};
  if (args.title !== undefined) wanted.title = args.title;
  if (args.description !== undefined) wanted.description = args.description;
  if (args.priority !== undefined) wanted.priority = args.priority;
  const changed = Object.keys(wanted).filter((k) => full[k] !== wanted[k]);

  if (changed.length === 0) {
    ctx.logger?.info("Task {taskId}: no change", { taskId: args.taskId });
  } else {
    await vreq(g, "POST", `/tasks/${args.taskId}`, {
      body: { ...full, ...wanted },
    });
  }

  const after = await readTask(g, args.taskId);
  const wrong = Object.keys(wanted).filter((k) => after[k] !== wanted[k]);
  if (wrong.length) {
    throw new Error(
      `Task ${args.taskId}: ${wrong.join(", ")} did not read back as sent.`,
    );
  }
  await restoreBucket(
    g,
    ctx,
    projectId,
    viewId,
    args.taskId,
    bucketBefore,
    "fields are set",
  );

  const final = await readTask(g, args.taskId);
  const handle = await ctx.writeResource(
    "vikunjaTask",
    `task-${args.taskId}`,
    toVikunjaTask(final, fetchedAt),
  );
  ctx.logger?.info("Task {taskId}: updated {fields}", {
    taskId: args.taskId,
    fields: changed.join(", ") || "nothing",
    bucket: bucketBefore,
  });
  return { dataHandles: [handle] };
}

/**
 * Attach and detach existing labels by title. Labels have their own
 * endpoints (PUT/DELETE /tasks/{id}/labels), so the task body is never
 * rewritten. Every name is resolved before anything changes, and the
 * result is read back.
 */
async function setLabels(
  args: z.infer<typeof SetLabelsArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  // One read of every label page resolves both lists.
  const known = await fetchAllLabels(g);
  const add = resolveLabels(known, args.add);
  const remove = resolveLabels(known, args.remove);

  const task = await readTask(g, args.taskId);
  await guardWrite(g, ctx, task, args.force);
  const have = labelTitlesOf(task);

  for (const l of add) {
    if (have.has(l.title.toLowerCase())) continue;
    await vreq(g, "PUT", `/tasks/${args.taskId}/labels`, {
      body: { label_id: l.id },
    });
  }
  for (const l of remove) {
    if (!have.has(l.title.toLowerCase())) continue;
    await vreq(g, "DELETE", `/tasks/${args.taskId}/labels/${l.id}`);
  }

  const after = await readTask(g, args.taskId);
  const now = labelTitlesOf(after);
  const missing = add.filter((l) => !now.has(l.title.toLowerCase()));
  const lingering = remove.filter((l) => now.has(l.title.toLowerCase()));
  if (missing.length || lingering.length) {
    throw new Error(
      `Task ${args.taskId}: labels did not read back as intended` +
        (missing.length
          ? `; still missing ${missing.map((l) => l.title).join(", ")}`
          : "") +
        (lingering.length
          ? `; still attached ${lingering.map((l) => l.title).join(", ")}`
          : ""),
    );
  }

  const handle = await ctx.writeResource(
    "vikunjaTask",
    `task-${args.taskId}`,
    toVikunjaTask(after, fetchedAt),
  );
  ctx.logger?.info("Task {taskId}: labels = {labels}", {
    taskId: args.taskId,
    labels: [...now].sort().join(", "),
  });
  return { dataHandles: [handle] };
}

/**
 * Move a card into a named bucket and read the placement back from the
 * view. The done bucket is refused: closing is close_task's job, and it
 * needs a person's instruction.
 */
async function moveTask(
  args: z.infer<typeof MoveTaskArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;
  const viewId = await requireKanbanView(g, projectId);
  const target = await resolveBucket(g, projectId, viewId, args.bucketName);
  if (roleOf(target.title, g.bucketRoles) === "done") {
    throw new Error(
      `Refusing to move task ${args.taskId} into "${target.title}": use ` +
        `close_task, which needs humanInstructed: true.`,
    );
  }

  const task = await readTask(g, args.taskId);
  await guardWrite(g, ctx, task, args.force);
  const from = await requireBucketOf(g, projectId, viewId, args.taskId);
  if (from.toLowerCase() === target.title.toLowerCase()) {
    ctx.logger?.info("Task {taskId}: already in {bucket}", {
      taskId: args.taskId,
      bucket: from,
    });
  } else {
    // The same rules audit applies to the column: a card is only promoted
    // into the ready column when it passes the Definition of Ready, and
    // only parked in waiting with a due date.
    const problems = readinessProblems(
      cardStateOf(task),
      roleOf(target.title, g.bucketRoles),
      g.policy,
      { intent: "move" },
    );
    if (problems.length && !args.force) {
      throw new Error(
        `Refusing to move task ${args.taskId} into "${target.title}": ` +
          `${formatProblems(problems)}. Fix the card first, or pass ` +
          `force: true.`,
      );
    }
    await moveTaskToBucket(g, projectId, viewId, target.id, args.taskId);
    const now = await bucketTitleOf(g, projectId, viewId, args.taskId);
    if (now !== target.title) {
      throw new Error(
        `Task ${args.taskId}: still in "${now}" after moving it to ` +
          `"${target.title}".`,
      );
    }
    ctx.logger?.info("Task {taskId}: {from} -> {to}", {
      taskId: args.taskId,
      from,
      to: target.title,
    });
  }

  const final = await readTask(g, args.taskId);
  const handle = await ctx.writeResource(
    "vikunjaTask",
    `task-${args.taskId}`,
    toVikunjaTask({
      ...final,
      placement: { viewId, bucketId: target.id, bucketTitle: target.title },
    }, fetchedAt),
  );
  return { dataHandles: [handle] };
}

/**
 * Close a card: done=true through a full-replace write, then into the done
 * bucket, both read back. Only runs with humanInstructed: true. It skips
 * the recent-edit guard: the person who asked for it is the editor.
 */
async function closeTask(
  args: z.infer<typeof CloseTaskArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  if (!args.humanInstructed) {
    throw new Error(
      "close_task is never automatic: pass humanInstructed: true when a " +
        "person asked for this card to be closed.",
    );
  }
  const projectId = args.projectId ?? g.projectId;
  const viewId = await requireKanbanView(g, projectId);
  const doneBucket = await resolveBucket(
    g,
    projectId,
    viewId,
    g.bucketRoles.done,
  );

  const full = await readTask(g, args.taskId);
  if (full.done === true) {
    ctx.logger?.info("Task {taskId}: already done", { taskId: args.taskId });
  } else {
    await vreq(g, "POST", `/tasks/${args.taskId}`, {
      body: { ...full, done: true },
    });
    const after = await readTask(g, args.taskId);
    if (after.done !== true) {
      throw new Error(`Task ${args.taskId}: done did not stick.`);
    }
  }
  if (
    (await bucketTitleOf(g, projectId, viewId, args.taskId)) !==
      doneBucket.title
  ) {
    await moveTaskToBucket(g, projectId, viewId, doneBucket.id, args.taskId);
  }
  const bucket = await bucketTitleOf(g, projectId, viewId, args.taskId);
  const final = await readTask(g, args.taskId);
  if (bucket !== doneBucket.title || final.done !== true) {
    throw new Error(
      `Task ${args.taskId}: close did not complete (done=${final.done}, ` +
        `bucket "${bucket}").`,
    );
  }

  const handle = await ctx.writeResource(
    "vikunjaTask",
    `task-${args.taskId}`,
    toVikunjaTask({
      ...final,
      placement: {
        viewId,
        bucketId: doneBucket.id,
        bucketTitle: doneBucket.title,
      },
    }, fetchedAt),
  );
  ctx.logger?.info("Task {taskId}: closed (done, {bucket})", {
    taskId: args.taskId,
    bucket: doneBucket.title,
  });
  return { dataHandles: [handle] };
}

/**
 * Create one label, idempotently: every page of GET /labels is read first,
 * and a label whose title matches (case-insensitive) is returned as
 * `exists` instead of being duplicated. A new label is read back by id and
 * its title (and colour, when given) asserted. Only runs with
 * humanInstructed: true.
 */
async function createLabel(
  args: z.infer<typeof CreateLabelArgsSchema>,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = new Date().toISOString();
  if (!args.humanInstructed) {
    throw new Error(
      "create_label is never automatic: pass humanInstructed: true when a " +
        "person asked for this label.",
    );
  }
  const title = args.title;
  const hexColor = args.hexColor?.replace(/^#/, "").toLowerCase();

  const known = await fetchAllLabels(g);
  const hit = known.get(title.toLowerCase());
  let raw: Record<string, unknown>;
  let status: LabelRecord["status"];
  if (hit) {
    raw = await vreq(g, "GET", `/labels/${hit.id}`) as Record<string, unknown>;
    status = "exists";
  } else {
    const made = await vreq(g, "PUT", "/labels", {
      body: {
        title,
        ...(hexColor !== undefined ? { hex_color: hexColor } : {}),
        ...(args.description !== undefined
          ? { description: args.description }
          : {}),
      },
    }) as Record<string, unknown> | null;
    if (!made || typeof made.id !== "number") {
      throw new Error(
        `Vikunja PUT /labels returned no label id for "${title}"; check ` +
          "GET /labels before retrying.",
      );
    }
    raw = await vreq(g, "GET", `/labels/${made.id}`) as Record<
      string,
      unknown
    >;
    const wrong: string[] = [];
    if (raw.title !== title) wrong.push(`title ${JSON.stringify(raw.title)}`);
    if (
      hexColor !== undefined &&
      String(raw.hex_color ?? "").replace(/^#/, "").toLowerCase() !== hexColor
    ) wrong.push(`hex_color ${JSON.stringify(raw.hex_color)}`);
    if (
      args.description !== undefined && raw.description !== args.description
    ) wrong.push("description");
    if (wrong.length) {
      throw new Error(
        `Label ${made.id} was created but read back with ${wrong.join(", ")}.`,
      );
    }
    status = "created";
  }

  const record = LabelSchema.parse({
    id: raw.id,
    title: raw.title,
    hexColor: typeof raw.hex_color === "string" && raw.hex_color !== ""
      ? raw.hex_color
      : null,
    description: typeof raw.description === "string" ? raw.description : null,
    status,
    fetchedAt,
  });
  const handle = await ctx.writeResource("label", `label-${record.id}`, record);
  if (status === "exists") {
    ctx.logger?.info("Label {labelId} {title} already exists; not created", {
      labelId: record.id,
      title: record.title,
      requested: title,
    });
  } else {
    ctx.logger?.info("Created label {labelId} {title}", {
      labelId: record.id,
      title: record.title,
    });
  }
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
  const orderOf = (b: BoardBucket) =>
    intendedOrder(b.tasks, g.policy.tieBreak, roleOf(b.title, g.bucketRoles));

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
    const intended = orderOf(b);
    b.tasks.forEach((t, from) => {
      const to = intended.findIndex((x) => x.id === t.id);
      if (to !== from) {
        moves.push({ taskId: t.id, title: t.title, bucket: b.title, from, to });
      }
    });
  }

  let iterations = 0;
  let recalculations = 0;
  let converged = moves.length === 0;
  let error: string | null = null;
  // Every move made, in order, for the per-bucket counts and the repeats.
  const made: Array<{ taskId: number; bucket: string }> = [];
  const movesIn = (bucket: string) =>
    made.filter((m) => m.bucket === bucket).length;
  const repeatedMoves = () => {
    const counts = new Map<
      string,
      { taskId: number; bucket: string; moves: number }
    >();
    for (const m of made) {
      const k = `${m.bucket}\u0000${m.taskId}`;
      const c = counts.get(k) ?? { ...m, moves: 0 };
      c.moves++;
      counts.set(k, c);
    }
    return [...counts.values()].filter((c) => c.moves > 1)
      .sort((a, b) => b.moves - a.moves || a.taskId - b.taskId);
  };
  if (args.apply && moves.length > 0) {
    try {
      // True between a recalculation and the next successful move: a second
      // cramped gap or 4028 in that window means respacing did not help.
      let justRecalculated = false;
      const recalculate = async (b: BoardBucket, reason: string) => {
        if (justRecalculated) {
          throw new Error(
            `reorder: ${reason} in bucket "${b.title}" straight after a ` +
              "full position recalculation; giving up.",
          );
        }
        const first = orderOf(b)[0];
        await recalculatePositions(g, viewId, first.id);
        recalculations++;
        justRecalculated = true;
        ctx.logger?.info(
          "Recalculated view {viewId} positions ({reason}, via #{taskId})",
          { viewId, reason, taskId: first.id, bucket: b.title },
        );
        board = await fetchBoard(g, projectId, viewId);
      };
      for (
        const bucketTitle of board.filter((b) => inScope(b.title)).map((b) =>
          b.title
        )
      ) {
        // Each bucket gets its own budget, scaled to its size: a sort of n
        // cards needs at most n - 1 moves when every move sticks.
        const start = board.find((x) => x.title === bucketTitle);
        const budget = Math.max(
          args.maxIterations,
          2 * (start?.tasks.length ?? 0),
        );
        for (;;) {
          const b = board.find((x) => x.title === bucketTitle);
          if (!b) {
            throw new Error(`Bucket "${bucketTitle}" vanished mid-reorder.`);
          }
          const move = nextMove(b.tasks, orderOf(b));
          if (!move) break;
          if (move.cramped) {
            await recalculate(b, "gap below minimum spacing");
            continue;
          }
          if (movesIn(bucketTitle) >= budget) {
            const repeats = repeatedMoves().filter((r) =>
              r.bucket === bucketTitle
            );
            throw new Error(
              `reorder did not converge in bucket "${bucketTitle}" after ` +
                `${movesIn(bucketTitle)} moves there (budget ${budget}). ` +
                `Moves per bucket: ${formatCounts(countBy(made))}. ` +
                (repeats.length
                  ? `Cards moved more than once in "${bucketTitle}": ` +
                    repeats.slice(0, 10).map((r) => `#${r.taskId} x${r.moves}`)
                      .join(", ") +
                    "."
                  : `No card in "${bucketTitle}" moved twice.`),
            );
          }
          iterations++;
          try {
            await vreq(g, "POST", `/tasks/${move.task.id}/position`, {
              body: {
                project_view_id: viewId,
                task_id: move.task.id,
                position: move.position,
              },
            });
          } catch (err) {
            iterations--;
            if (!isNeedsRecalculation(err)) throw err;
            await recalculate(b, "Vikunja 4028");
            continue;
          }
          made.push({ taskId: move.task.id, bucket: bucketTitle });
          justRecalculated = false;
          ctx.logger?.info("Moved #{taskId} to slot {slot} in {bucket}", {
            taskId: move.task.id,
            slot: move.index,
            bucket: bucketTitle,
            position: move.position,
          });
          // Vikunja may not store the exact number sent — always re-read.
          board = await fetchBoard(g, projectId, viewId);
        }
      }
      converged = board.filter((b) => inScope(b.title)).every((b) =>
        sameOrder(b.tasks, orderOf(b))
      );
      if (!converged) {
        throw new Error(
          "reorder finished its moves but a final re-read is still out of " +
            "order.",
        );
      }
    } catch (err) {
      converged = false;
      error = err instanceof Error ? err.message : String(err);
    }
  }

  const plan = ReorderPlanSchema.parse({
    projectId,
    viewId,
    plannedAt,
    applied: args.apply,
    converged,
    iterations,
    movesByBucket: countBy(made),
    repeatedMoves: repeatedMoves(),
    error,
    recalculations,
    moves,
  });
  // Written before any throw: a run that gave up still leaves the moves it
  // made, per bucket, for triage.
  const handle = await ctx.writeResource(
    "reorderPlan",
    `reorder-${projectId}`,
    plan,
  );
  if (error !== null) throw new Error(error);
  if (args.apply) {
    ctx.logger?.info(
      "Reordered project {projectId}: {moves} moves, {recalculations} " +
        "recalculation(s), converged={converged}",
      { projectId, moves: iterations, recalculations, converged },
    );
  } else {
    ctx.logger?.info(
      "Dry run for project {projectId}: {outOfPlace} card(s) out of place " +
        "(apply: true to fix)",
      { projectId, outOfPlace: moves.length },
    );
  }
  return { dataHandles: [handle] };
}

// ============================================================================
// apply_plan — validate a batch against the live board, then run it
// ============================================================================

/** A card as the plan will have left it after the ops before this one. */
interface ProjectedCard extends CardState {
  id: number;
  bucket: string;
  done: boolean;
  updated: string;
  /** Index of the op that closes it, once one has. */
  closedBy: number | null;
  /** Whether the recent-edit guard has already been checked in this plan. */
  guarded: boolean;
}

interface ValidatedOp {
  index: number;
  op: PlanOp;
  taskId: number | null;
  title: string | null;
  problems: string[];
  /** A create skipped because its title exists (duplicateTitle: skip). */
  skip: boolean;
}

/**
 * Phase 1: check every op against one read of the board (and, when any op
 * names labels, one read of the labels), simulating the ops in order so
 * that each is judged on the state the earlier ones leave. Collects every
 * problem rather than stopping at the first. Reads only.
 */
async function validatePlan(
  g: GlobalArgs,
  ctx: ExecCtx,
  args: ApplyPlanArgs,
  board: BoardBucket[],
): Promise<{ ops: ValidatedOp[]; planProblems: string[] }> {
  const planProblems: string[] = [];
  if (args.ops.length > args.maxOps) {
    planProblems.push(
      `plan has ${args.ops.length} ops, more than maxOps ${args.maxOps}`,
    );
  }

  const bucketsByName = new Map(
    board.map((b) => [b.title.toLowerCase(), b.title]),
  );
  const bucketList = board.map((b) => `"${b.title}"`).join(", ");
  const cards = new Map<number, ProjectedCard>();
  for (const b of board) {
    const inDone = roleOf(b.title, g.bucketRoles) === "done";
    for (const t of b.tasks) {
      cards.set(t.id, {
        id: t.id,
        title: t.title,
        description: t.description,
        labels: [...t.labels],
        priority: t.priority,
        dueDate: t.dueDate,
        bucket: b.title,
        done: t.done || inDone,
        updated: t.updated,
        closedBy: null,
        guarded: false,
      });
    }
  }
  const needsLabels = args.ops.some((o) =>
    (o.op === "create" && o.labels.length > 0) || o.op === "labels"
  );
  const known = needsLabels ? await fetchAllLabels(g) : new Map();
  const unknownLabels = (names: string[]) =>
    names.filter((n) => !known.has(n.toLowerCase()));
  const plannedTitles: Array<{ index: number; title: string }> = [];

  const out: ValidatedOp[] = [];
  for (const [index, op] of args.ops.entries()) {
    const problems: string[] = [];
    const v: ValidatedOp = {
      index,
      op,
      taskId: op.op === "create" ? null : op.taskId,
      title: op.op === "create" ? op.title : null,
      problems,
      skip: false,
    };
    out.push(v);

    if (op.op === "create") {
      const bucketName = op.bucketName ?? g.defaultBucketName;
      let bucket: string | null = null;
      if (bucketName) {
        bucket = bucketsByName.get(bucketName.toLowerCase()) ?? null;
        if (bucket === null) {
          problems.push(
            `unknown bucket "${bucketName}"; available: ${bucketList}`,
          );
        }
      }
      const missing = unknownLabels(op.labels);
      if (missing.length) {
        problems.push(`unknown label(s): ${missing.join(", ")}`);
      }
      const due = op.dueDate?.trim() ? op.dueDate.trim() : null;
      if (due !== null && !Number.isFinite(Date.parse(due))) {
        problems.push(`dueDate is not a parseable instant: ${op.dueDate}`);
      }
      const labels = op.labels.map((n) =>
        known.get(n.toLowerCase())?.title ?? n
      );
      for (
        const p of readinessProblems(
          {
            title: op.title,
            description: op.description ?? "",
            labels,
            priority: op.priority ?? 0,
            dueDate: due,
          },
          bucket ? roleOf(bucket, g.bucketRoles) : "other",
          g.policy,
          {
            intent: "create",
            requireReady: op.requireReady ?? args.requireReady,
          },
        )
      ) problems.push(`${p.rule} (${p.detail})`);
      if (op.duplicateTitle !== "allow") {
        const open = [...cards.values()].find((c) =>
          !c.done && c.closedBy === null && sameTitle(c.title, op.title)
        );
        const earlier = plannedTitles.find((t) => sameTitle(t.title, op.title));
        if (earlier) {
          problems.push(
            `duplicates the title of op #${earlier.index} in this plan`,
          );
        } else if (open && op.duplicateTitle === "refuse") {
          problems.push(`open task ${open.id} already has this title`);
        } else if (open) {
          v.skip = true;
          v.taskId = open.id;
        }
      }
      if (!v.skip) plannedTitles.push({ index, title: op.title });
      continue;
    }

    // Every other op targets an existing card.
    const card = cards.get(op.taskId);
    if (!card) {
      problems.push(`task ${op.taskId} is not on the board`);
      continue;
    }
    v.title = card.title;
    if (card.closedBy !== null) {
      problems.push(`task ${card.id} is closed by op #${card.closedBy} first`);
      continue;
    }

    if (op.op === "close") {
      if (!op.humanInstructed) {
        problems.push("close needs humanInstructed: true on the op");
      }
      card.closedBy = index;
      continue;
    }

    // update / labels / move / due: the same guard as the single methods,
    // checked against the board once per card (later ops on the same card
    // run after this plan's own write, which the guard exempts).
    if (card.done) {
      problems.push(`task ${card.id} is done; not touching a done card`);
      continue;
    }
    if (!card.guarded) {
      const guard = await guardProblem(g, ctx, card, op.force);
      if (guard !== null) problems.push(guard);
      card.guarded = true;
    }

    if (op.op === "update") {
      if (
        op.title === undefined && op.description === undefined &&
        op.priority === undefined
      ) {
        problems.push(
          "update needs at least one of title, description, priority",
        );
      }
      if (op.title !== undefined && op.title.trim() === "") {
        problems.push("title must not be empty");
      }
      if (op.description !== undefined && textLength(op.description) === 0) {
        problems.push("refusing to write an empty description");
      }
      if (op.title !== undefined) card.title = op.title;
      if (op.description !== undefined) card.description = op.description;
      if (op.priority !== undefined) card.priority = op.priority;
    } else if (op.op === "labels") {
      if (op.add.length + op.remove.length === 0) {
        problems.push("labels needs at least one label in add or remove");
      }
      const adding = new Set(op.add.map((n) => n.toLowerCase()));
      const both = op.remove.filter((n) => adding.has(n.toLowerCase()));
      if (both.length) {
        problems.push(`label(s) in both add and remove: ${both.join(", ")}`);
      }
      const missing = unknownLabels([...op.add, ...op.remove]);
      if (missing.length) {
        problems.push(`unknown label(s): ${missing.join(", ")}`);
      }
      const removing = new Set(op.remove.map((n) => n.toLowerCase()));
      const kept = card.labels.filter((l) => !removing.has(l.toLowerCase()));
      for (const n of op.add) {
        const t = known.get(n.toLowerCase())?.title ?? n;
        if (!kept.some((l) => l.toLowerCase() === t.toLowerCase())) {
          kept.push(t);
        }
      }
      card.labels = kept;
    } else if (op.op === "move") {
      const target = bucketsByName.get(op.bucketName.toLowerCase());
      if (target === undefined) {
        problems.push(
          `unknown bucket "${op.bucketName}"; available: ${bucketList}`,
        );
        continue;
      }
      const role = roleOf(target, g.bucketRoles);
      if (role === "done") {
        problems.push(
          `refusing to move into "${target}": use a close op, which needs ` +
            `humanInstructed: true`,
        );
        continue;
      }
      if (target !== card.bucket && !op.force) {
        const ps = readinessProblems(card, role, g.policy, { intent: "move" });
        if (ps.length) {
          const later = args.ops.slice(index + 1).findIndex((o) =>
            o.op !== "create" && o.op !== "close" && o.taskId === card.id
          );
          problems.push(
            `task ${card.id} is not ready for "${target}": ` +
              formatProblems(ps) +
              (later >= 0
                ? ` (op #${index + 1 + later} changes this card later; ` +
                  `put the move after it)`
                : ""),
          );
        }
      }
      card.bucket = target;
    } else if (op.op === "due") {
      const due = op.dueDate?.trim() ? op.dueDate.trim() : null;
      if (due !== null && !Number.isFinite(Date.parse(due))) {
        problems.push(`dueDate is not a parseable instant: ${op.dueDate}`);
      }
      const clearing = clearWaitingDueProblem(
        card.id,
        card.bucket,
        due,
        op.force,
        g.bucketRoles,
      );
      if (clearing !== null) problems.push(clearing);
      card.dueDate = due;
    }
  }
  return { ops: out, planProblems };
}

/**
 * Validate a batch of card operations against the live board and, with
 * apply: true and no problems at all, run them in order through the same
 * internals as the single methods (so every write is read back and
 * recorded as task-<id>, and the recent-edit guard sees them as ours).
 * Always records the outcome as the planResult resource `plan-<project>`.
 */
async function applyPlan(
  args: ApplyPlanArgs,
  ctx: ExecCtx,
): Promise<{ dataHandles: unknown[] }> {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const plannedAt = new Date().toISOString();
  const projectId = args.projectId ?? g.projectId;
  const viewId = await requireKanbanView(g, projectId);
  const board = await fetchBoard(g, projectId, viewId);
  if (board.length === 0) {
    throw new Error(`Project ${projectId} view ${viewId} returned no buckets.`);
  }

  const { ops, planProblems } = await validatePlan(g, ctx, args, board);
  const problems: PlanResult["problems"] = [
    ...planProblems.map((problem) => ({
      index: null,
      op: null,
      taskId: null,
      problem,
    })),
    ...ops.flatMap((v) =>
      v.problems.map((problem) => ({
        index: v.index,
        op: v.op.op,
        taskId: v.taskId,
        problem,
      }))
    ),
  ];
  const valid = problems.length === 0;
  const results: PlanResult["ops"] = ops.map((v) => ({
    index: v.index,
    op: v.op.op,
    taskId: v.taskId,
    title: v.title,
    status: v.problems.length ? "invalid" : v.skip ? "skip" : "ok",
    problems: v.problems,
  }));

  const handles: unknown[] = [];
  let outcome: PlanResult["outcome"] = args.apply
    ? (valid ? "applied" : "refused")
    : "dry-run";
  let failure: string | null = null;

  // Records the single methods write, held back so each instance name is
  // written once: swamp fails a run that writes one name twice, and a plan
  // often has several ops on one card. The last write wins — it is the
  // card's final state, which is what the recent-edit guard must see.
  const pending = new Map<string, { spec: string; payload: unknown }>();
  if (args.apply && valid) {
    // Capture what each single-method run records, to learn created ids.
    let lastTask: Record<string, unknown> | null = null;
    const runCtx: ExecCtx = {
      ...ctx,
      writeResource: (spec, name, payload) => {
        if (spec === "vikunjaTask") {
          lastTask = payload as Record<string, unknown>;
        }
        pending.delete(name); // re-insert: keep write order for the flush
        pending.set(name, { spec, payload });
        return Promise.resolve({ pending: name });
      },
      // Within the run, the guard must see this plan's own earlier writes.
      readResource: (name) => {
        const p = pending.get(name);
        if (p) return Promise.resolve(p.payload as Record<string, unknown>);
        return ctx.readResource?.(name) ?? Promise.resolve(null);
      },
    };
    for (const [i, v] of ops.entries()) {
      if (v.skip) continue;
      const op = v.op;
      lastTask = null;
      try {
        await runOp(op, projectId, args, runCtx);
        results[i].status = "done";
        const got = lastTask as Record<string, unknown> | null;
        if (op.op === "create" && got && typeof got.id === "number") {
          results[i].taskId = got.id;
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        results[i].status = "failed";
        results[i].error = failure;
        for (const later of results.slice(i + 1)) {
          if (later.status !== "skip") later.status = "not-run";
        }
        outcome = "failed";
        break;
      }
    }
  }

  // Flush on success and on a mid-run stop alike: every write that landed
  // is recorded, so a follow-up edit to those cards counts as ours.
  for (const [name, { spec, payload }] of pending) {
    handles.push(await ctx.writeResource(spec, name, payload));
  }

  const count = (st: PlanResult["ops"][number]["status"]) =>
    results.filter((r) => r.status === st).length;
  const result = PlanResultSchema.parse({
    projectId,
    viewId,
    plannedAt,
    outcome,
    valid,
    counts: {
      ops: results.length,
      problems: problems.length,
      done: count("done"),
      failed: count("failed"),
      notRun: count("not-run"),
      skipped: count("skip"),
    },
    problems,
    ops: results,
  });
  handles.push(
    await ctx.writeResource("planResult", `plan-${projectId}`, result),
  );

  const listed = problems.map((p) =>
    `${p.index === null ? "plan" : `op #${p.index} (${p.op}`}` +
    `${p.taskId !== null ? ` task ${p.taskId}` : ""}` +
    `${p.index === null ? "" : ")"}: ${p.problem}`
  );
  if (outcome === "refused") {
    throw new Error(
      `apply_plan wrote nothing: ${problems.length} problem(s) —\n` +
        listed.join("\n"),
    );
  }
  if (outcome === "failed") {
    const ids = (st: string) =>
      results.filter((r) => r.status === st).map((r) => `#${r.index}`)
        .join(", ") || "none";
    const at = results.find((r) => r.status === "failed")!;
    throw new Error(
      `apply_plan stopped at op #${at.index} (${at.op}): ${failure}\n` +
        `done: ${ids("done")}; failed: #${at.index}; not run: ` +
        `${ids("not-run")}`,
    );
  }
  if (!valid) {
    for (const p of problems) {
      ctx.logger?.warning("Plan problem at {where}: {problem}", {
        where: p.index === null ? "plan" : `op #${p.index} (${p.op})`,
        op: p.op,
        index: p.index,
        taskId: p.taskId,
        problem: p.problem,
      });
    }
  }
  ctx.logger?.info(
    "apply_plan {outcome}: {ops} op(s), {problems} problem(s), {done} " +
      "done, {skipped} skipped",
    {
      outcome,
      ops: results.length,
      problems: problems.length,
      done: count("done"),
      skipped: count("skip"),
    },
  );
  return { dataHandles: handles };
}

/** Run one plan op through the matching single method. */
async function runOp(
  op: PlanOp,
  projectId: number,
  args: ApplyPlanArgs,
  ctx: ExecCtx,
): Promise<void> {
  switch (op.op) {
    case "create":
      await newTask(
        NewTaskArgsSchema.parse({
          title: op.title,
          projectId,
          description: op.description,
          labels: op.labels,
          priority: op.priority,
          dueDate: op.dueDate,
          bucketName: op.bucketName,
          duplicateTitle: op.duplicateTitle,
          requireReady: op.requireReady ?? args.requireReady,
        }),
        ctx,
      );
      return;
    case "update":
      await updateTask(
        UpdateTaskArgsSchema.parse({
          taskId: op.taskId,
          title: op.title,
          description: op.description,
          priority: op.priority,
          projectId,
          force: op.force,
        }),
        ctx,
      );
      return;
    case "labels":
      await setLabels(
        SetLabelsArgsSchema.parse({
          taskId: op.taskId,
          add: op.add,
          remove: op.remove,
          force: op.force,
        }),
        ctx,
      );
      return;
    case "move":
      await moveTask(
        MoveTaskArgsSchema.parse({
          taskId: op.taskId,
          bucketName: op.bucketName,
          projectId,
          force: op.force,
        }),
        ctx,
      );
      return;
    case "due":
      await setDueDate(
        SetDueDateArgsSchema.parse({
          taskId: op.taskId,
          dueDate: op.dueDate ?? "",
          projectId,
          force: op.force,
        }),
        ctx,
      );
      return;
    case "close":
      await closeTask(
        CloseTaskArgsSchema.parse({
          taskId: op.taskId,
          humanInstructed: op.humanInstructed,
          projectId,
        }),
        ctx,
      );
      return;
  }
}

// ============================================================================
// Model
// ============================================================================

/**
 * Wrap a method so it logs one start line: the method name plus the ids
 * that say what it is about to touch. Never the arguments wholesale — a
 * description can be long, and nothing here needs it in a log line.
 */
function logged<A>(
  method: string,
  execute: (args: A, ctx: ExecCtx) => Promise<{ dataHandles: unknown[] }>,
): (args: A, ctx: ExecCtx) => Promise<{ dataHandles: unknown[] }> {
  return (args, ctx) => {
    const a = args as Record<string, unknown>;
    const props: Record<string, unknown> = { method };
    for (const k of ["taskId", "projectId", "bucketName", "apply"]) {
      if (a[k] !== undefined) props[k] = a[k];
    }
    if (Array.isArray(a.ops)) props.ops = a.ops.length;
    ctx.logger?.info("{method}: starting", props);
    return execute(args, ctx);
  };
}

/** Vikunja kanban orchestrator: create, edit and list tasks via the Vikunja REST API. */
export const model = {
  type: "@sntxrr/vikunja-kanban" as const,
  version: "2026.10.22.1",
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
    {
      toVersion: "2026.09.19.2",
      description:
        "Added set_due_date: set or clear one card's due date via a " +
        "read-modify-write of the full task (POST /tasks/{id} is a full " +
        "replace), refusing done cards and asserting on read-back that " +
        "the date took and the card's bucket did not change. Existing " +
        "model attributes carry over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.26.1",
      description:
        "Added update_task (title/description/priority, full-replace " +
        "read-modify-write, bucket restored if the write drops it), " +
        "set_labels (attach/detach existing labels by title), move_task " +
        "(any bucket except done) and close_task (done + done bucket, only " +
        "with humanInstructed: true); every write is read back. The first " +
        "three refuse done cards and cards someone else updated within the " +
        "new policy.recentEditMinutes (default 60) unless force: true. " +
        "new_task gains labels (array); an unknown label now fails before " +
        "the task is created instead of being skipped with a warning, and " +
        "labels missing after the write are an error. Existing model " +
        "attributes carry over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.27.1",
      description:
        "Label lookup now reads every page of GET /labels: the server caps " +
        "a page at max_items_per_page (50 by default), so with more labels " +
        "than that, new_task and set_labels reported labels beyond the " +
        "first page as not found. set_labels reads the labels once for " +
        "both add and remove. new_task's skipIfTitleExists lookup is paged " +
        "the same way. Existing model attributes carry over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.27.2",
      description:
        "Added apply_plan (validate a batch of create/update/labels/move/" +
        "due/close ops against one read of the board, dry run by default; " +
        "apply: true writes nothing unless every op is valid, then runs " +
        "them in order and records a planResult resource), board (every " +
        "open card as a boardSnapshot resource) and get_task (one card and " +
        "its bucket as get-<id>). The Definition-of-Ready rules are shared " +
        "by audit and the writes: new_task refuses a card that does not " +
        "meet its target bucket's rules (ready: full DoR; waiting: a due " +
        "date; doing/review/done: never), gains requireReady and " +
        "duplicateTitle (refuse/skip/allow, case-insensitive; default skip " +
        "as before, skipIfTitleExists kept as an alias), and reads back " +
        "every field; move_task enforces the same rules for ready and " +
        "waiting; set_due_date gains the recent-edit guard and force. " +
        "Existing model attributes carry over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.27.3",
      description:
        "Logging only: every log line is a constant message template with " +
        'its values passed as structured properties (e.g. "Task {taskId}: ' +
        'no change" with { taskId }), and every method logs one start ' +
        "line naming the method and the task/project it targets. No " +
        "behaviour, argument or resource changes; existing model " +
        "attributes carry over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.27.4",
      description:
        "apply_plan writes each vikunjaTask record once per run, with the " +
        "card's final state, instead of once per op: swamp rejects a run " +
        "that writes one instance name twice, so a plan with two ops on one " +
        "card (update then move/close) exited 1 after every op had already " +
        "landed. Records are also written when a run stops mid-way. No " +
        "argument or resource changes; existing model attributes carry " +
        "over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.1",
      description:
        "reorder no longer fails on Vikunja 500 code 4028 (position repair " +
        "needs a full view recalculation). Before a move into a gap smaller " +
        "than Vikunja's minimum spacing, or after a 4028, it makes Vikunja " +
        "respace the view (a position below 0.01 triggers that), re-reads, " +
        "and carries on; a second stall straight after a recalculation " +
        "still fails. The reorderPlan resource gains recalculations " +
        "(default 0). Existing model attributes carry over unchanged.",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.22.1",
      description:
        "Added create_label (title, optional hexColor/description; " +
        "idempotent on a case-insensitive title across every label page; " +
        "read back; humanInstructed: true required) and the label resource. " +
        "No other method creates labels. reorder's maxIterations is now a " +
        "per-bucket budget (max(maxIterations, 2 x cards)); a give-up names " +
        "the bucket, moves per bucket and repeated cards, and the " +
        "reorderPlan (new movesByBucket, repeatedMoves, error) is written " +
        "before the throw. set_due_date moves a card back (verified) when " +
        "the write drops its bucket, instead of failing. board and audit " +
        "carry truncated; writes refuse a truncated board or label read. " +
        "This model's own resource schemas strip unknown keys (vikunjaTask " +
        "still keeps Vikunja's fields). Global arguments are unchanged, so " +
        "existing model attributes carry over unchanged.",
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
    label: {
      description: "One create_label run: the label's id, title, colour and " +
        "description, and whether it was created or already existed.",
      schema: LabelSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    dueReport: {
      description:
        "One due-date pass over a board: overdue, due-today and upcoming " +
        "cards with counts and a Markdown message ready to send.",
      schema: DueReportSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    planResult: {
      description:
        "One apply_plan run: the outcome (dry-run / refused / applied / " +
        "failed), every validation problem, and each op's status.",
      schema: PlanResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    boardSnapshot: {
      description:
        "Every not-done card on a board with its bucket, role, labels, " +
        "priority, due date, timestamps and full description.",
      schema: BoardSnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
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
      execute: logged("audit", audit),
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
      execute: logged("reorder", reorder),
    },
    due_report: {
      description:
        "Read-only: list the not-done cards on a project's board that are " +
        "overdue, due today, or due within lookaheadDays, each with a link, " +
        "and write a dueReport resource whose `message` is ready to send. " +
        "Treat a card's due date as the day to look at it again; a daily " +
        "workflow gated on counts.actionable > 0 turns that into a nudge.",
      arguments: DueReportArgsSchema,
      execute: logged("due_report", dueReport),
    },
    set_due_date: {
      description:
        "Set or clear one card's due date — the day to look at it again. " +
        "Reads the full task, writes it back with only due_date changed " +
        "(Vikunja's POST /tasks/{id} is a full replace), re-reads and " +
        "asserts the date took, and moves the card back (verified) if the " +
        "write dropped it out of its bucket. " +
        "Refuses done cards, cards someone else updated within " +
        "policy.recentEditMinutes, and clearing the date of a waiting card, " +
        "unless force: true. Records the task as a vikunjaTask resource.",
      arguments: SetDueDateArgsSchema,
      execute: logged("set_due_date", setDueDate),
    },
    new_task: {
      description:
        "Create a task in a Vikunja project (the configured default, or a " +
        "per-call projectId) and place it into a named kanban bucket " +
        '(default "Backlog", override with bucketName) so it lands in a ' +
        "backlog column rather than the view's default working column. " +
        "Optionally attaches existing labels by title (label and/or " +
        "labels; all resolved before anything is created). Refuses, with " +
        "nothing created, a card that does not meet the readiness rules of " +
        "its target bucket (ready: full Definition of Ready; waiting: a due " +
        "date; doing/review/done: never) or of requireReady. duplicateTitle " +
        "(refuse/skip/allow, default skip) handles an open card with the " +
        "same title, case-insensitively. Reads back title, description, " +
        "priority, due date, labels and bucket; a mismatch is an error " +
        "naming the task id.",
      arguments: NewTaskArgsSchema,
      execute: logged("new_task", newTask),
    },
    update_task: {
      description:
        "Change one card's title, description and/or priority. Reads the " +
        "full task, writes it back with only those fields changed " +
        "(Vikunja's POST /tasks/{id} is a full replace), re-reads and " +
        "asserts each field took, and moves the card back if the write " +
        "dropped it out of its bucket. Refuses done cards, empty " +
        "descriptions, and cards someone else updated within " +
        "policy.recentEditMinutes unless force: true.",
      arguments: UpdateTaskArgsSchema,
      execute: logged("update_task", updateTask),
    },
    set_labels: {
      description:
        "Attach (add) and detach (remove) existing labels on one card by " +
        "title, case-insensitive. Every title is resolved first, so an " +
        "unknown one fails with nothing changed; labels are never created. " +
        "Reads the card back and asserts the result. Same done-card and " +
        "recent-edit guards as update_task.",
      arguments: SetLabelsArgsSchema,
      execute: logged("set_labels", setLabels),
    },
    move_task: {
      description:
        "Move one card into a named bucket and read its placement back " +
        "from the kanban view. Moving into the ready bucket requires the " +
        "full Definition of Ready, and into waiting a due date (refusal " +
        "lists the findings; force: true overrides). Refuses the done " +
        "bucket (use close_task), " +
        "done cards, and cards someone else updated within " +
        "policy.recentEditMinutes unless force: true. Run it after any " +
        "field edits: a full-replace write can drop a card out of its " +
        "bucket.",
      arguments: MoveTaskArgsSchema,
      execute: logged("move_task", moveTask),
    },
    close_task: {
      description:
        "Close one card: set done=true, move it into the done bucket, and " +
        "read both back. Only runs with humanInstructed: true, because " +
        "closing a card is a person's decision.",
      arguments: CloseTaskArgsSchema,
      execute: logged("close_task", closeTask),
    },
    create_label: {
      description:
        "Create one label (title, optional hexColor and description). " +
        "Idempotent: every page of labels is read first, and an existing " +
        "label with the same title (case-insensitive) is returned with " +
        "status exists instead of a duplicate. A new label is read back by " +
        "id. Only runs with humanInstructed: true; no other method creates " +
        "labels (apply_plan, new_task and set_labels still refuse unknown " +
        "ones). Writes a label resource named label-<id>.",
      arguments: CreateLabelArgsSchema,
      execute: logged("create_label", createLabel),
    },
    apply_plan: {
      description:
        "Batch card writes in one run. Validates EVERY op (create, update, " +
        "labels, move, due, close) against one read of the board and the " +
        "labels — unknown or done cards, the recent-edit guard, unknown " +
        "labels or buckets, readiness for creates and moves (judged on the " +
        "state earlier ops leave), duplicate titles on the board or within " +
        "the plan, ops after a close, close without humanInstructed — and " +
        "collects every problem. Dry run by default: writes only the " +
        "planResult resource. With apply: true it writes nothing unless " +
        "there are no problems, then runs the ops in order through the " +
        "single methods (each read back), stopping at the first failure.",
      arguments: ApplyPlanArgsSchema,
      execute: logged("apply_plan", applyPlan),
    },
    board: {
      description:
        "Read-only: write every not-done card on the project's kanban " +
        "board (id, title, full description, bucket and its role, labels, " +
        "priority, due date, updated) as one boardSnapshot resource, read " +
        "page by page so no bucket is truncated; `truncated` is true (and " +
        "a warning logged) if the page cap was reached with cards still " +
        "coming.",
      arguments: BoardArgsSchema,
      execute: logged("board", boardMethod),
    },
    get_task: {
      description:
        "Read-only: one card plus the bucket (and role) it sits in, " +
        "written as the vikunjaTask resource get-<id>.",
      arguments: GetTaskArgsSchema,
      execute: logged("get_task", getTask),
    },
    list_recent: {
      description:
        "List the most recently created tasks in a Vikunja project (the " +
        "configured default, or a per-call projectId) and record each as " +
        "swamp data.",
      arguments: ListRecentArgsSchema,
      execute: logged("list_recent", listRecent),
    },
  },
};
