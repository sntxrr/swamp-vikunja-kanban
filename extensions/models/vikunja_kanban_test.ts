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
  renderDueMessage,
  roleOf,
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
