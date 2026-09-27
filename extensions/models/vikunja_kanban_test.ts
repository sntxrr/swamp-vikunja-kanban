import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import {
  auditBucket,
  auditCard,
  type BoardBucket,
  type BoardTask,
  classifyDue,
  dueDateOf,
  intendedOrder,
  nextMove,
  readinessProblems,
  renderDueMessage,
  type Role,
  roleOf,
  sameTitle,
  textLength,
} from "./vikunja_kanban.ts";

const roles = {
  backlog: "Backlog",
  ready: "Next",
  doing: "Doing",
  blocked: "Blocked",
  waiting: "Waiting",
  review: "Review",
  done: "Done",
};

const policy = {
  wipLimit: 3,
  staleDays: { ready: 14, doing: 7, blocked: 1, review: 3 },
  minDescriptionChars: 400,
  verdictMarkers: ["CONFIRMED", "DISSOLVED", "MISSTATED"],
  acceptanceMarkers: ["Acceptance", "Proof", "Done when", "Verify"],
  requiredLinkPrefix: "obsidian://",
  requiredLabelPrefixes: ["tier-"],
  tieBreak: "oldest" as const,
  recentEditMinutes: 60,
};

const now = new Date("2026-09-15T12:00:00Z");

function task(over: Partial<BoardTask> & { id: number }): BoardTask {
  return {
    title: `Task ${over.id}`,
    description: "",
    done: false,
    priority: 0,
    position: over.id * 1000,
    created: "2026-09-01T00:00:00Z",
    updated: "2026-09-15T00:00:00Z",
    labels: [],
    dueDate: null,
    ...over,
  };
}

const readyCard = task({
  id: 1,
  priority: 3,
  labels: ["backups", "tier-B"],
  description: "<p>" + "Verified 2026-09-15: <b>CONFIRMED</b>. " +
    "Acceptance: `ssh host 'grep -c KEY ~/.ssh/authorized_keys'` prints 0. " +
    '<a href="obsidian://open?vault=remote-vault&file=x">note</a> ' +
    "x".repeat(400) + "</p>",
});

Deno.test("roleOf is case-insensitive and falls back to other", () => {
  assertStrictEquals(roleOf("waiting", roles), "waiting");
  assertStrictEquals(roleOf("next", roles), "ready");
  assertStrictEquals(roleOf("DONE", roles), "done");
  assertStrictEquals(roleOf("Icebox", roles), "other");
});

Deno.test("textLength strips tags and collapses whitespace", () => {
  assertStrictEquals(textLength("<p>a&nbsp; b</p>\n<ul><li>c</li></ul>"), 5);
  assertStrictEquals(textLength("<p></p>"), 0);
});

Deno.test("a fully formed ready card has no findings", () => {
  const f = auditCard(readyCard, "Next", "ready", policy, now);
  assertEquals(f, []);
});

Deno.test("the same gaps are errors in Next but warn/info in Backlog", () => {
  const stub = task({ id: 2, description: "<p>short</p>" });
  const inNext = auditCard(stub, "Next", "ready", policy, now);
  const inBacklog = auditCard(stub, "Backlog", "backlog", policy, now);
  const rules = (fs: typeof inNext) => fs.map((f) => f.rule).sort();
  assertEquals(rules(inNext), [
    "missing-acceptance",
    "missing-link",
    "missing-verdict",
    "no-labels",
    "priority-unset",
    "short-description",
  ]);
  assertEquals(rules(inBacklog), rules(inNext));
  assertEquals(inNext.every((f) => f.severity === "error"), true);
  assertEquals(inBacklog.some((f) => f.severity === "error"), false);
});

Deno.test("empty description is an error everywhere and suppresses marker rules", () => {
  const f = auditCard(task({ id: 3 }), "Backlog", "backlog", policy, now);
  assertEquals(
    f.filter((x) => x.rule === "empty-description")[0].severity,
    "error",
  );
  assertEquals(f.some((x) => x.rule === "missing-verdict"), false);
});

Deno.test("label groups: tier missing vs area missing", () => {
  const onlyArea = auditCard(
    { ...readyCard, labels: ["backups"] },
    "Next",
    "ready",
    policy,
    now,
  );
  assertEquals(onlyArea.map((f) => f.rule), ["missing-label-group"]);
  const onlyTier = auditCard(
    { ...readyCard, labels: ["tier-B"] },
    "Next",
    "ready",
    policy,
    now,
  );
  assertEquals(onlyTier.map((f) => f.rule), ["missing-area-label"]);
});

Deno.test("staleness uses the per-role threshold", () => {
  const old = { ...readyCard, updated: "2026-09-01T00:00:00Z" };
  assertEquals(
    auditCard(old, "Doing", "doing", policy, now).map((f) => f.rule),
    ["stale"],
  );
  assertEquals(auditCard(old, "Backlog", "backlog", policy, now), []);
});

Deno.test("waiting: the due date is the rule, not the edit age", () => {
  // Untouched for two weeks but due in three weeks: nothing to report.
  const parked = { ...readyCard, updated: "2026-09-01T00:00:00Z" };
  assertEquals(
    auditCard(
      { ...parked, dueDate: "2026-10-10T17:00:00Z" },
      "Waiting",
      "waiting",
      policy,
      now,
    ),
    [],
  );
  // No due date at all is an error even on an otherwise perfect card.
  const undated = auditCard(parked, "Waiting", "waiting", policy, now);
  assertEquals(undated.map((f) => [f.rule, f.severity]), [[
    "missing-due-date",
    "error",
  ]]);
  // Due yesterday (any hour) → stale by one day; edited today changes nothing.
  const passed = auditCard(
    {
      ...readyCard,
      updated: now.toISOString(),
      dueDate: "2026-09-14T23:59:00Z",
    },
    "Waiting",
    "waiting",
    policy,
    now,
  );
  assertEquals(passed.map((f) => f.rule), ["stale"]);
  assertEquals(passed[0].detail.startsWith("due date passed 1 d ago"), true);
  // Due later today is not passed.
  assertEquals(
    auditCard(
      { ...readyCard, dueDate: "2026-09-15T01:00:00Z" },
      "Waiting",
      "waiting",
      policy,
      now,
    ),
    [],
  );
});

Deno.test("intendedOrder: waiting sorts by due day, undated last", () => {
  const ts = [
    task({ id: 1, priority: 5, dueDate: "2026-11-04T17:00:00Z" }),
    task({ id: 2, priority: 0 }),
    // Same day, earlier hour, lower priority: the day ties, priority wins.
    task({ id: 3, priority: 1, dueDate: "2026-09-26T15:00:00Z" }),
    task({ id: 4, priority: 3, dueDate: "2026-09-26T17:00:00Z" }),
  ];
  assertEquals(intendedOrder(ts, "oldest", "waiting").map((t) => t.id), [
    4,
    3,
    1,
    2,
  ]);
  // Every other role ignores the due date entirely.
  assertEquals(intendedOrder(ts, "oldest", "ready").map((t) => t.id), [
    1,
    4,
    3,
    2,
  ]);
});

Deno.test("done flag must match the done bucket", () => {
  const inDone = auditCard(readyCard, "Done", "done", policy, now);
  assertEquals(inDone.map((f) => f.rule), ["done-flag-mismatch"]);
  const doneInNext = auditCard(
    { ...readyCard, done: true },
    "Next",
    "ready",
    policy,
    now,
  );
  assertEquals(doneInNext.map((f) => f.rule), ["done-flag-mismatch"]);
});

Deno.test("intendedOrder: priority desc, then oldest first, unset last", () => {
  const ts = [
    task({ id: 1, priority: 2, created: "2026-09-03" }),
    task({ id: 2, priority: 0 }),
    task({ id: 3, priority: 4 }),
    task({ id: 4, priority: 2, created: "2026-09-01" }),
  ];
  assertEquals(intendedOrder(ts, "oldest").map((t) => t.id), [3, 4, 1, 2]);
  assertEquals(intendedOrder(ts, "newest").map((t) => t.id), [3, 1, 4, 2]);
});

Deno.test("auditBucket reports out-of-order and WIP", () => {
  const b = {
    id: 1,
    title: "Doing",
    position: 0,
    tasks: [
      task({ id: 1, priority: 1, position: 10 }),
      task({ id: 2, priority: 3, position: 20 }),
      task({ id: 3, priority: 3, position: 30 }),
      task({ id: 4, priority: 3, position: 40 }),
    ],
  };
  const { findings, inOrder } = auditBucket(b, "doing", policy);
  assertEquals(inOrder, false);
  assertEquals(findings.map((f) => f.rule).sort(), [
    "out-of-order",
    "wip-exceeded",
  ]);
  const done = auditBucket({ ...b, title: "Done" }, "done", policy);
  assertEquals(done.inOrder, true);
  assertEquals(done.findings, []);
});

Deno.test("nextMove targets the first wrong slot at the neighbour midpoint", () => {
  const current = [
    task({ id: 1, priority: 1, position: 100 }),
    task({ id: 2, priority: 3, position: 200 }),
    task({ id: 3, priority: 2, position: 300 }),
  ];
  const intended = intendedOrder(current, "oldest"); // 2, 3, 1
  const m = nextMove(current, intended)!;
  assertEquals(m.task.id, 2);
  assertEquals(m.index, 0);
  assertEquals(m.position, 50); // between 0 and 100
  assertStrictEquals(nextMove(intended, intended), null);
});

Deno.test("nextMove nudges past a collapsed gap instead of dividing by nothing", () => {
  const current = [
    task({ id: 1, priority: 1, position: 0 }),
    task({ id: 2, priority: 3, position: 0 }),
  ];
  const m = nextMove(current, intendedOrder(current, "oldest"))!;
  assertEquals(m.task.id, 2);
  assertEquals(m.position, 1);
});

// ----------------------------------------------------------------------------
// due_report
// ----------------------------------------------------------------------------

function bucket(title: string, tasks: BoardTask[]): BoardBucket {
  return { id: title.length, title, position: 0, tasks };
}

Deno.test("dueDateOf treats Vikunja's zero time and junk as unset", () => {
  assertStrictEquals(dueDateOf("0001-01-01T00:00:00Z"), null);
  assertStrictEquals(dueDateOf(""), null);
  assertStrictEquals(dueDateOf(undefined), null);
  assertStrictEquals(dueDateOf("not a date"), null);
  assertStrictEquals(dueDateOf("2026-09-26T00:00:00Z"), "2026-09-26T00:00:00Z");
});

Deno.test("classifyDue splits by whole UTC day and honours the lookahead", () => {
  // now is 2026-09-15T12:00Z; a card due earlier that same day is still today.
  const board = [
    bucket("Backlog", [
      task({ id: 1, dueDate: "2026-09-13T23:59:00Z" }), // 2 days overdue
      task({ id: 2, dueDate: "2026-09-15T09:00:00Z" }), // today, already past
      task({ id: 3, dueDate: "2026-09-22T00:00:00Z" }), // +7, last day inside
      task({ id: 4, dueDate: "2026-09-23T00:00:00Z" }), // +8, outside
      task({ id: 5, dueDate: null }),
      task({ id: 6, dueDate: "2026-09-15T20:00:00Z", done: true }),
    ]),
    bucket("Blocked", [task({ id: 7, dueDate: "2026-09-14T00:00:00Z" })]),
    bucket("Done", [task({ id: 8, dueDate: "2026-09-01T00:00:00Z" })]),
  ];
  const r = classifyDue(board, roles, now, 7, "https://v.example");
  assertEquals(r.overdue.map((i) => [i.id, i.daysUntil]), [[1, -2], [7, -1]]);
  assertEquals(r.dueToday.map((i) => i.id), [2]);
  assertEquals(r.upcoming.map((i) => [i.id, i.daysUntil]), [[3, 7]]);
  assertEquals(r.overdue[1].bucket, "Blocked");
  assertEquals(r.dueToday[0].url, "https://v.example/tasks/2");
  // lookahead 0: only overdue and today remain.
  assertEquals(classifyDue(board, roles, now, 0, "x").upcoming, []);
});

Deno.test("renderDueMessage lists only non-empty sections", () => {
  const item = {
    id: 42,
    title: "Drop the snapshot",
    bucket: "Blocked",
    dueDate: "2026-09-26T00:00:00Z",
    daysUntil: 0,
    url: "https://v.example/tasks/42",
  };
  const msg = renderDueMessage(
    { overdue: [], dueToday: [item], upcoming: [] },
    7,
    "https://v.example/projects/5",
  );
  assertEquals(
    msg,
    "**Due today (1)**\n" +
      "- [#42](https://v.example/tasks/42) Drop the snapshot — 2026-09-26 " +
      "(today, Blocked)\n\n" +
      "Board: https://v.example/projects/5",
  );
  const empty = renderDueMessage(
    { overdue: [], dueToday: [], upcoming: [] },
    7,
    "https://v.example/projects/5",
  );
  assertEquals(empty, "Nothing due.\n\nBoard: https://v.example/projects/5");
  const over = renderDueMessage(
    { overdue: [{ ...item, daysUntil: -3 }], dueToday: [], upcoming: [] },
    7,
    "b",
  );
  assertEquals(over.split("\n")[1].includes("(3d overdue, Blocked)"), true);
});

// ----------------------------------------------------------------------------
// Regression: audit output is unchanged by the shared readiness module.
// AUDIT_EXPECTED was generated by running main's (2026.09.27.1) auditCard
// over these fixtures; every card x role pair not listed produced nothing.
// ----------------------------------------------------------------------------

const auditLong = "x".repeat(400);
const auditFull = "<p>CONFIRMED. Acceptance: run it. obsidian://open?x " +
  auditLong + "</p>";
const auditBase = {
  id: 1,
  title: "t",
  description: auditFull,
  done: false,
  priority: 3,
  position: 0,
  created: "2026-09-01T00:00:00Z",
  updated: "2026-09-15T00:00:00Z",
  labels: ["homelab-area", "tier-a"],
  dueDate: null as string | null,
};
const auditCards: Record<string, typeof auditBase> = {
  ready: auditBase,
  stub: { ...auditBase, description: "<p>short</p>", labels: [], priority: 0 },
  empty: { ...auditBase, description: "" },
  onlyArea: { ...auditBase, labels: ["homelab-area"] },
  onlyTier: { ...auditBase, labels: ["tier-a"] },
  lowerAcceptance: {
    ...auditBase,
    description: auditFull.replace("Acceptance", "verify with"),
  },
  lowerVerdict: {
    ...auditBase,
    description: auditFull.replace("CONFIRMED", "confirmed"),
  },
  noLink: {
    ...auditBase,
    description: auditFull.replace("obsidian://", "https://"),
  },
  noMarkers: { ...auditBase, description: "<p>" + auditLong + "</p>" },
  stale: { ...auditBase, updated: "2026-08-01T00:00:00Z" },
  dated: { ...auditBase, dueDate: "2026-10-01T00:00:00Z" },
  duePassed: { ...auditBase, dueDate: "2026-09-10T00:00:00Z" },
  doneFlag: { ...auditBase, done: true },
  prio0: { ...auditBase, priority: 0 },
};
const auditBuckets: Array<[string, string]> = [
  ["Backlog", "backlog"],
  ["Next", "ready"],
  ["Doing", "doing"],
  ["Blocked", "blocked"],
  ["Waiting", "waiting"],
  ["Review", "review"],
  ["Done", "done"],
  ["Icebox", "other"],
];

const AUDIT_EXPECTED: Record<string, string[]> = {
  "ready@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
  ],
  "ready@done": ["done-flag-mismatch:warn:in the done bucket but done=false"],
  "stub@backlog": [
    "short-description:warn:5 chars < 400",
    "no-labels:warn:no labels at all",
    "priority-unset:warn:priority is 0 (unset)",
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:info:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "stub@ready": [
    "short-description:error:5 chars < 400",
    "no-labels:error:no labels at all",
    "priority-unset:error:priority is 0 (unset)",
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:error:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:error:no obsidian:// link to the source note",
  ],
  "stub@doing": [
    "short-description:error:5 chars < 400",
    "no-labels:error:no labels at all",
    "priority-unset:error:priority is 0 (unset)",
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:error:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:error:no obsidian:// link to the source note",
  ],
  "stub@blocked": [
    "short-description:warn:5 chars < 400",
    "no-labels:warn:no labels at all",
    "priority-unset:warn:priority is 0 (unset)",
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:info:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "stub@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
    "short-description:warn:5 chars < 400",
    "no-labels:warn:no labels at all",
    "priority-unset:warn:priority is 0 (unset)",
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:info:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "stub@review": [
    "short-description:error:5 chars < 400",
    "no-labels:error:no labels at all",
    "priority-unset:error:priority is 0 (unset)",
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:error:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:error:no obsidian:// link to the source note",
  ],
  "stub@done": ["done-flag-mismatch:warn:in the done bucket but done=false"],
  "stub@other": [
    "short-description:warn:5 chars < 400",
    "no-labels:warn:no labels at all",
    "priority-unset:warn:priority is 0 (unset)",
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:info:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "empty@backlog": ["empty-description:error:description is empty"],
  "empty@ready": ["empty-description:error:description is empty"],
  "empty@doing": ["empty-description:error:description is empty"],
  "empty@blocked": ["empty-description:error:description is empty"],
  "empty@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
    "empty-description:error:description is empty",
  ],
  "empty@review": ["empty-description:error:description is empty"],
  "empty@done": ["done-flag-mismatch:warn:in the done bucket but done=false"],
  "empty@other": ["empty-description:error:description is empty"],
  "onlyArea@backlog": [
    'missing-label-group:warn:no label starting with "tier-"',
  ],
  "onlyArea@ready": [
    'missing-label-group:error:no label starting with "tier-"',
  ],
  "onlyArea@doing": [
    'missing-label-group:error:no label starting with "tier-"',
  ],
  "onlyArea@blocked": [
    'missing-label-group:warn:no label starting with "tier-"',
  ],
  "onlyArea@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
    'missing-label-group:warn:no label starting with "tier-"',
  ],
  "onlyArea@review": [
    'missing-label-group:error:no label starting with "tier-"',
  ],
  "onlyArea@done": [
    "done-flag-mismatch:warn:in the done bucket but done=false",
  ],
  "onlyArea@other": ['missing-label-group:warn:no label starting with "tier-"'],
  "onlyTier@backlog": [
    "missing-area-label:warn:only group labels, no area label",
  ],
  "onlyTier@ready": [
    "missing-area-label:error:only group labels, no area label",
  ],
  "onlyTier@doing": [
    "missing-area-label:error:only group labels, no area label",
  ],
  "onlyTier@blocked": [
    "missing-area-label:warn:only group labels, no area label",
  ],
  "onlyTier@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
    "missing-area-label:warn:only group labels, no area label",
  ],
  "onlyTier@review": [
    "missing-area-label:error:only group labels, no area label",
  ],
  "onlyTier@done": [
    "done-flag-mismatch:warn:in the done bucket but done=false",
  ],
  "onlyTier@other": [
    "missing-area-label:warn:only group labels, no area label",
  ],
  "lowerAcceptance@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
  ],
  "lowerAcceptance@done": [
    "done-flag-mismatch:warn:in the done bucket but done=false",
  ],
  "lowerVerdict@backlog": [
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
  ],
  "lowerVerdict@ready": [
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
  ],
  "lowerVerdict@doing": [
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
  ],
  "lowerVerdict@blocked": [
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
  ],
  "lowerVerdict@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
  ],
  "lowerVerdict@review": [
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
  ],
  "lowerVerdict@done": [
    "done-flag-mismatch:warn:in the done bucket but done=false",
  ],
  "lowerVerdict@other": [
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
  ],
  "noLink@backlog": [
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "noLink@ready": ["missing-link:error:no obsidian:// link to the source note"],
  "noLink@doing": ["missing-link:error:no obsidian:// link to the source note"],
  "noLink@blocked": [
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "noLink@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "noLink@review": [
    "missing-link:error:no obsidian:// link to the source note",
  ],
  "noLink@done": ["done-flag-mismatch:warn:in the done bucket but done=false"],
  "noLink@other": ["missing-link:warn:no obsidian:// link to the source note"],
  "noMarkers@backlog": [
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:info:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "noMarkers@ready": [
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:error:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:error:no obsidian:// link to the source note",
  ],
  "noMarkers@doing": [
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:error:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:error:no obsidian:// link to the source note",
  ],
  "noMarkers@blocked": [
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:info:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "noMarkers@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:info:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "noMarkers@review": [
    "missing-verdict:error:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:error:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:error:no obsidian:// link to the source note",
  ],
  "noMarkers@done": [
    "done-flag-mismatch:warn:in the done bucket but done=false",
  ],
  "noMarkers@other": [
    "missing-verdict:info:no premise-check verdict (CONFIRMED/DISSOLVED/MISSTATED)",
    "missing-acceptance:info:no acceptance marker (Acceptance/Proof/Done when/Verify)",
    "missing-link:warn:no obsidian:// link to the source note",
  ],
  "stale@ready": ["stale:warn:untouched for 45.5 d (limit 14 d in Next)"],
  "stale@doing": ["stale:warn:untouched for 45.5 d (limit 7 d in Doing)"],
  "stale@blocked": ["stale:warn:untouched for 45.5 d (limit 1 d in Blocked)"],
  "stale@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
  ],
  "stale@review": ["stale:warn:untouched for 45.5 d (limit 3 d in Review)"],
  "stale@done": ["done-flag-mismatch:warn:in the done bucket but done=false"],
  "dated@done": ["done-flag-mismatch:warn:in the done bucket but done=false"],
  "duePassed@waiting": [
    "stale:warn:due date passed 5 d ago \u2014 act on it or re-date it",
  ],
  "duePassed@done": [
    "done-flag-mismatch:warn:in the done bucket but done=false",
  ],
  "doneFlag@backlog": [
    "done-flag-mismatch:warn:done=true outside the done bucket",
  ],
  "doneFlag@ready": [
    "done-flag-mismatch:warn:done=true outside the done bucket",
  ],
  "doneFlag@doing": [
    "done-flag-mismatch:warn:done=true outside the done bucket",
  ],
  "doneFlag@blocked": [
    "done-flag-mismatch:warn:done=true outside the done bucket",
  ],
  "doneFlag@waiting": [
    "done-flag-mismatch:warn:done=true outside the done bucket",
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
  ],
  "doneFlag@review": [
    "done-flag-mismatch:warn:done=true outside the done bucket",
  ],
  "doneFlag@other": [
    "done-flag-mismatch:warn:done=true outside the done bucket",
  ],
  "prio0@backlog": ["priority-unset:warn:priority is 0 (unset)"],
  "prio0@ready": ["priority-unset:error:priority is 0 (unset)"],
  "prio0@doing": ["priority-unset:error:priority is 0 (unset)"],
  "prio0@blocked": ["priority-unset:warn:priority is 0 (unset)"],
  "prio0@waiting": [
    "missing-due-date:error:waiting with no due date \u2014 set the day to look at it again",
    "priority-unset:warn:priority is 0 (unset)",
  ],
  "prio0@review": ["priority-unset:error:priority is 0 (unset)"],
  "prio0@done": ["done-flag-mismatch:warn:in the done bucket but done=false"],
  "prio0@other": ["priority-unset:warn:priority is 0 (unset)"],
};

Deno.test("audit findings are identical to 2026.09.27.1 for every fixture x role", () => {
  let pairs = 0;
  for (const [name, c] of Object.entries(auditCards)) {
    for (const [title, role] of auditBuckets) {
      const got = auditCard(c, title, role as Role, policy, now).map((f) =>
        `${f.rule}:${f.severity}:${f.detail}`
      );
      assertEquals(
        got,
        AUDIT_EXPECTED[`${name}@${role}`] ?? [],
        `${name}@${role}`,
      );
      pairs++;
    }
  }
  assertStrictEquals(pairs, 112);
});

// ----------------------------------------------------------------------------
// readinessProblems: the write-side rules, keyed by the target bucket role
// ----------------------------------------------------------------------------

const readyState = {
  title: "Rotate the example key",
  description: readyCard.description,
  labels: ["homelab-area", "tier-a"],
  priority: 3,
  dueDate: null,
};
const stubState = {
  title: "stub",
  description: "<p>short</p>",
  labels: [],
  priority: 0,
  dueDate: null,
};
const rulesOf = (ps: { rule: string }[]) => ps.map((p) => p.rule);

Deno.test("readiness: a stub is fine in backlog, refused in ready or with requireReady", () => {
  const create = { intent: "create" as const };
  assertEquals(readinessProblems(stubState, "backlog", policy, create), []);
  assertEquals(readinessProblems(stubState, "blocked", policy, create), []);
  const inReady = rulesOf(
    readinessProblems(stubState, "ready", policy, create),
  );
  assertEquals(inReady, [
    "short-description",
    "no-labels",
    "priority-unset",
    "missing-verdict",
    "missing-acceptance",
    "missing-link",
  ]);
  assertEquals(
    rulesOf(
      readinessProblems(stubState, "backlog", policy, {
        ...create,
        requireReady: true,
      }),
    ),
    inReady,
  );
  // The positive control: a full card passes everywhere it may be created.
  for (const role of ["backlog", "ready", "blocked", "other"] as Role[]) {
    assertEquals(readinessProblems(readyState, role, policy, create), [], role);
  }
});

Deno.test("readiness: ready needs a tier label AND an area label", () => {
  const create = { intent: "create" as const };
  assertEquals(
    rulesOf(
      readinessProblems(
        { ...readyState, labels: ["homelab-area"] },
        "ready",
        policy,
        create,
      ),
    ),
    ["missing-label-group"],
  );
  assertEquals(
    rulesOf(
      readinessProblems(
        { ...readyState, labels: ["tier-a"] },
        "ready",
        policy,
        create,
      ),
    ),
    ["missing-area-label"],
  );
});

Deno.test("readiness: waiting needs a due date; doing/review/done refuse creates", () => {
  const create = { intent: "create" as const };
  assertEquals(
    rulesOf(readinessProblems(stubState, "waiting", policy, create)),
    ["missing-due-date"],
  );
  assertEquals(
    readinessProblems(
      { ...stubState, dueDate: "2026-10-01T00:00:00Z" },
      "waiting",
      policy,
      create,
    ),
    [],
  );
  for (const role of ["doing", "review", "done"] as Role[]) {
    assertEquals(
      rulesOf(readinessProblems(readyState, role, policy, create)),
      ["refused-bucket"],
      role,
    );
  }
  // Moves: doing/review are allowed (a person pulls work), done is not.
  const move = { intent: "move" as const };
  assertEquals(readinessProblems(readyState, "doing", policy, move), []);
  assertEquals(
    rulesOf(readinessProblems(readyState, "done", policy, move)),
    ["refused-bucket"],
  );
  assertEquals(
    rulesOf(
      readinessProblems(
        { ...readyState, title: " " },
        "backlog",
        policy,
        create,
      ),
    ),
    ["empty-title"],
  );
});

Deno.test("readiness: acceptance markers are case-insensitive, verdicts are not", () => {
  const create = { intent: "create" as const };
  const lowerAcc = {
    ...readyState,
    description: readyState.description.replace("Acceptance", "acceptance"),
  };
  assertEquals(readinessProblems(lowerAcc, "ready", policy, create), []);
  const lowerVerdict = {
    ...readyState,
    description: readyState.description.replace("CONFIRMED", "confirmed"),
  };
  assertEquals(
    rulesOf(readinessProblems(lowerVerdict, "ready", policy, create)),
    ["missing-verdict"],
  );
});

Deno.test("sameTitle trims and ignores case", () => {
  assertEquals(sameTitle("  Rotate The Key ", "rotate the key"), true);
  assertEquals(sameTitle("Rotate the key", "Rotate the keys"), false);
});
