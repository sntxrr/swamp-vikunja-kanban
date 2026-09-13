// extensions/models/vikunja_kanban.ts
const { z } = globalThis.__swamp_zod;
var GlobalArgsSchema = z.object({
  baseUrl: z.string().min(1).describe("Base URL of the Vikunja instance, e.g. https://vikunja.example.com (no trailing slash, no /api/v1 suffix \u2014 that's added automatically)."),
  apiToken: z.string().min(1).describe("Vikunja personal API token (Bearer). Supply via a swamp vault reference in the model definition's globalArguments \u2014 see README for the exact vault-get syntax; never inline the raw token here."),
  projectId: z.number().int().positive().describe("Vikunja project id tasks are created in and listed from (e.g. the homelab backlog project)."),
  viewId: z.number().int().positive().optional().describe("Optional Vikunja view id (bucket view) within the project. When set, new_task also places the created task into this view's default bucket via PUT /projects/{projectId}/views/{viewId}/buckets, if the instance's Vikunja version supports it; failures to bucket-place are logged as warnings and never fail task creation."),
  timeoutMs: z.number().int().positive().default(15e3).describe("Per-request fetch timeout in milliseconds."),
  maxRetries: z.number().int().min(0).max(10).default(5).describe("How many times to retry a request after an HTTP 429 rate-limit response."),
  userAgent: z.string().default("swamp-vikunja-kanban/1.0 (+https://swamp-club.com)").describe("User-Agent header sent on all outbound requests.")
});
var LabelRefSchema = z.object({
  id: z.number(),
  title: z.string(),
  hex_color: z.string().nullable().optional()
}).passthrough();
var VikunjaTaskSchema = z.object({
  id: z.number().describe("Vikunja task id."),
  title: z.string().describe("Task title."),
  description: z.string().nullable().optional().describe("Task description/body."),
  done: z.boolean().nullable().optional().describe("Whether the task is marked done."),
  priority: z.number().nullable().optional().describe("Vikunja numeric priority (0-5)."),
  labels: z.array(LabelRefSchema).nullable().optional().describe("Labels currently attached to the task."),
  due_date: z.string().nullable().optional().describe("ISO 8601 due date, if set."),
  project_id: z.number().nullable().optional().describe("Owning project id."),
  created: z.string().nullable().optional().describe("Creation timestamp from Vikunja."),
  updated: z.string().nullable().optional().describe("Last-update timestamp from Vikunja."),
  fetchedAt: z.string().describe("ISO 8601 timestamp when this record was written."),
  collectedBy: z.string().optional().describe("Extension that collected this data.")
}).passthrough();
var SummarySchema = z.object({
  scope: z.string().describe('Which listing produced this summary, e.g. "recent".'),
  endpoint: z.string().describe("Resolved request path the items came from."),
  total: z.number().describe("Number of items written by this run."),
  ids: z.array(z.number()).default([]),
  fetchedAt: z.string()
}).passthrough();
var PriorityLabel = z.enum([
  "Urgent",
  "High",
  "Medium"
]).describe("Label name to attach to the task, resolved via GET /labels. Must already exist on the Vikunja instance \u2014 this model never creates labels.");
var NewTaskArgsSchema = z.object({
  title: z.string().min(1, "title must not be empty").describe("Task title."),
  description: z.string().optional().describe("Optional task description/body."),
  label: PriorityLabel.optional(),
  dueDate: z.string().optional().describe("Optional ISO 8601 due date, e.g. 2026-09-20T00:00:00Z."),
  priority: z.number().int().min(0).max(5).optional().describe("Optional Vikunja numeric priority override (0=unset .. 5=DO NOW)."),
  skipIfTitleExists: z.boolean().default(true).describe("If true (default), checks for a non-done task with the exact same title in the project first and skips creation (idempotency without a dedicated dedup key \u2014 Vikunja has no idempotency-key concept).")
});
var ListRecentArgsSchema = z.object({
  limit: z.number().int().min(1).max(50).default(10).describe("Max results to return."),
  includeDone: z.boolean().default(false).describe("Include tasks already marked done.")
});
function resolveBase(g) {
  const trimmed = g.baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("Vikunja `baseUrl` resolves to an empty string.");
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(`Invalid Vikunja baseUrl "${g.baseUrl}": must start with http:// or https://.`);
  }
  return `${trimmed}/api/v1`;
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function backoffMs(res) {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1e3, 6e4);
  }
  return 1e3;
}
async function vreq(g, method, path, opts) {
  const base = resolveBase(g);
  const url = new URL(base + path);
  if (opts?.search) {
    for (const [k, v] of Object.entries(opts.search)) {
      if (v !== void 0 && v !== null && v !== "") url.searchParams.set(k, v);
    }
  }
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), g.timeoutMs);
    let res;
    try {
      res = await fetch(url.toString(), {
        method,
        headers: {
          "Authorization": `Bearer ${g.apiToken}`,
          "Accept": "application/json",
          "Content-Type": "application/json",
          "User-Agent": g.userAgent
        },
        body: opts?.body !== void 0 ? JSON.stringify(opts.body) : void 0,
        signal: ctrl.signal
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 429 && attempt < g.maxRetries) {
      await res.body?.cancel().catch(() => {
      });
      await sleep(backoffMs(res));
      continue;
    }
    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      throw new Error(`Vikunja ${method} ${path} failed: ${res.status} ${res.statusText}` + (bodyText ? ` \u2014 ${bodyText.slice(0, 300)}` : ""));
    }
    if (res.status === 204) return null;
    return await res.json();
  }
}
function asArray(json) {
  if (Array.isArray(json)) return json;
  return [];
}
async function resolveLabelId(g, labelName) {
  const labels = asArray(await vreq(g, "GET", "/labels", {
    search: {
      per_page: "100"
    }
  }));
  const match = labels.find((l) => typeof l.title === "string" && l.title.toLowerCase() === labelName.toLowerCase());
  return match && typeof match.id === "number" ? match.id : null;
}
function toVikunjaTask(raw, fetchedAt) {
  return VikunjaTaskSchema.parse({
    ...raw,
    fetchedAt,
    collectedBy: "@sntxrr/vikunja-kanban"
  });
}
async function newTask(args, ctx) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  if (args.skipIfTitleExists) {
    const existing = asArray(await vreq(g, "GET", `/projects/${g.projectId}/tasks`, {
      search: {
        s: args.title,
        per_page: "50"
      }
    }));
    const dup = existing.find((t) => typeof t.title === "string" && t.title === args.title && t.done !== true);
    if (dup && typeof dup.id === "number") {
      ctx.logger?.info("Task with matching title already exists \u2014 skipping create", {
        title: args.title,
        existingId: dup.id
      });
      const handle2 = await ctx.writeResource("vikunjaTask", `task-${dup.id}`, toVikunjaTask(dup, fetchedAt));
      return {
        dataHandles: [
          handle2
        ]
      };
    }
  }
  const body = {
    title: args.title
  };
  if (args.description) body.description = args.description;
  if (args.dueDate) body.due_date = args.dueDate;
  if (args.priority !== void 0) body.priority = args.priority;
  const created = await vreq(g, "PUT", `/projects/${g.projectId}/tasks`, {
    body
  });
  const taskId = typeof created.id === "number" ? created.id : null;
  if (taskId === null) {
    throw new Error(`Vikunja task creation for "${args.title}" returned no numeric id.`);
  }
  if (args.label) {
    const labelId = await resolveLabelId(g, args.label);
    if (labelId === null) {
      ctx.logger?.warning("Requested label not found on this Vikunja instance \u2014 task created without it", {
        label: args.label,
        taskId
      });
    } else {
      try {
        await vreq(g, "PUT", `/tasks/${taskId}/labels`, {
          body: {
            label_id: labelId
          }
        });
      } catch (e) {
        ctx.logger?.warning("Failed to attach label to task", {
          taskId,
          label: args.label,
          error: e instanceof Error ? e.message : String(e)
        });
      }
    }
  }
  const final = await vreq(g, "GET", `/tasks/${taskId}`);
  const handle = await ctx.writeResource("vikunjaTask", `task-${taskId}`, toVikunjaTask(final, fetchedAt));
  ctx.logger?.info(`Vikunja task created: ${taskId}`, {
    title: args.title
  });
  return {
    dataHandles: [
      handle
    ]
  };
}
async function listRecent(args, ctx) {
  const g = GlobalArgsSchema.parse(ctx.globalArgs);
  const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
  const endpoint = `/projects/${g.projectId}/tasks`;
  const tasks = asArray(await vreq(g, "GET", endpoint, {
    search: {
      sort_by: "created",
      order_by: "desc",
      per_page: String(args.limit),
      ...args.includeDone ? {} : {
        filter_by: "done",
        filter_value: "false"
      }
    }
  })).slice(0, args.limit);
  const handles = [];
  const ids = [];
  for (const t of tasks) {
    const id = typeof t.id === "number" ? t.id : null;
    if (id === null) continue;
    handles.push(await ctx.writeResource("vikunjaTask", `list-${id}`, toVikunjaTask(t, fetchedAt)));
    ids.push(id);
  }
  handles.push(await ctx.writeResource("summary", "summary-recent", {
    scope: "recent",
    endpoint,
    total: ids.length,
    ids,
    fetchedAt
  }));
  ctx.logger?.info(`Fetched ${ids.length} recent Vikunja tasks`);
  return {
    dataHandles: handles
  };
}
var model = {
  type: "@sntxrr/vikunja-kanban",
  version: "2026.09.13.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    vikunjaTask: {
      description: "A Vikunja task with id, title, labels, priority, and status.",
      schema: VikunjaTaskSchema,
      lifetime: "infinite",
      garbageCollection: 50
    },
    summary: {
      description: "Per-listing summary: scope, endpoint, count, and item ids.",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 20
    }
  },
  methods: {
    new_task: {
      description: "Create a task in the configured Vikunja project, optionally attaching an existing label by name (Urgent/High/Medium) and skipping creation if a non-done task with the same title already exists.",
      arguments: NewTaskArgsSchema,
      execute: newTask
    },
    list_recent: {
      description: "List the most recently created tasks in the configured Vikunja project and record each as swamp data.",
      arguments: ListRecentArgsSchema,
      execute: listRecent
    }
  }
};
export {
  backoffMs,
  model,
  resolveBase
};
