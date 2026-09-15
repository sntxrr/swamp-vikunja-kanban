import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1";
import {
  auditBucket,
  auditCard,
  type BoardTask,
  intendedOrder,
  nextMove,
  roleOf,
  textLength,
} from "./vikunja_kanban.ts";

const roles = {
  backlog: "Backlog",
  ready: "Next",
  doing: "Doing",
  blocked: "Blocked",
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
