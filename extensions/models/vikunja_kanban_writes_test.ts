import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "jsr:@std/assert@1";
import { model } from "./vikunja_kanban.ts";

// An in-memory Vikunja that behaves like v2.6 where these methods depend on
// it: POST /tasks/{id} is a full replace that ignores `labels` in the body,
// done=true lands the card in the done bucket, labels have their own
// endpoints, and the kanban view reports bucket membership.

type Task = Record<string, unknown> & { id: number };
interface Label {
  id: number;
  title: string;
}

const OLD = "2026-09-01T00:00:00Z";

class FakeVikunja {
  // 120 labels, so GET /labels spans three pages of 50: the three named
  // ones on page 1, "filler-004".."filler-120" after them.
  labels: Label[] = [
    { id: 1, title: "automation" },
    { id: 2, title: "tier-B" },
    { id: 3, title: "storage" },
    ...Array.from({ length: 117 }, (_, i) => ({
      id: i + 4,
      title: `filler-${String(i + 4).padStart(3, "0")}`,
    })),
  ];
  /** Simulate a server that ignores `page` and always returns page 1. */
  ignorePage = false;
  /** Every GET, as "path?query", for asserting how lists were paged. */
  reads: string[] = [];
  buckets = [
    { id: 10, title: "Backlog", position: 1 },
    { id: 11, title: "Next", position: 2 },
    { id: 12, title: "Doing", position: 3 },
    { id: 13, title: "Done", position: 4 },
    { id: 14, title: "Waiting", position: 5 },
  ];
  doneBucket = 13;
  tasks = new Map<number, Task>();
  taskLabels = new Map<number, Set<number>>();
  bucketOf = new Map<number, number>();
  nextId = 100;
  /** Simulate a full-replace write dropping the card into the first bucket. */
  unbucketOnWrite = false;
  /** Fields a POST /tasks/{id} silently ignores (a write that "succeeds"). */
  ignoreOnWrite: string[] = [];
  /** Fields a PUT /projects/{id}/tasks (create) silently drops. */
  dropOnCreate: string[] = [];
  writes: string[] = [];
  /** Every log call a method made, for the structured-logging test. */
  logs: Array<{ level: string; msg: string; props: Record<string, unknown> }> =
    [];

  seed(over: Partial<Task> & { bucket?: number; labelIds?: number[] } = {}) {
    const id = this.nextId++;
    const { bucket, labelIds, ...rest } = over;
    this.tasks.set(id, {
      id,
      title: `Task ${id}`,
      description: "<p>body</p>",
      done: false,
      priority: 2,
      due_date: "0001-01-01T00:00:00Z",
      created: OLD,
      updated: OLD,
      ...rest,
    });
    this.taskLabels.set(id, new Set(labelIds ?? []));
    this.bucketOf.set(id, bucket ?? 10);
    return id;
  }

  view(id: number): Task {
    const t = this.tasks.get(id)!;
    const labels = [...this.taskLabels.get(id)!].map((l) =>
      this.labels.find((x) => x.id === l)!
    );
    return { ...t, labels: labels.length ? labels : null };
  }

  touch(id: number) {
    const t = this.tasks.get(id)!;
    // Strictly increasing, so "our last write" and "a later edit" differ.
    t.updated = new Date(Date.now() + this.writes.length).toISOString();
  }

  /** Vikunja-style paging: per_page clamped to max_items_per_page (50). */
  page<T>(url: URL, items: T[]): T[] {
    const per = Math.min(Number(url.searchParams.get("per_page") ?? 50), 50);
    const page = this.ignorePage
      ? 1
      : Math.max(Number(url.searchParams.get("page") ?? 1), 1);
    return items.slice((page - 1) * per, page * per);
  }

  handle(method: string, url: URL, body: unknown): [number, unknown] {
    const path = url.pathname.replace(/^\/api\/v1/, "");
    let m: RegExpMatchArray | null;
    if (method !== "GET") this.writes.push(`${method} ${path}`);
    else this.reads.push(`${path}${url.search}`);

    if (method === "GET" && path === "/info") {
      return [200, { max_items_per_page: 50 }];
    }
    if (method === "GET" && path === "/labels") {
      return [200, this.page(url, this.labels)];
    }
    if (method === "GET" && path === "/projects/5/views") {
      return [200, [{ id: 20, view_kind: "kanban" }]];
    }
    if (method === "GET" && path === "/projects/5/views/20/buckets") {
      return [200, this.buckets];
    }
    if (method === "GET" && path === "/projects/5/views/20/tasks") {
      return [
        200,
        this.buckets.map((b) => ({
          ...b,
          tasks: [...this.bucketOf].filter(([, bid]) => bid === b.id)
            .map(([tid]) => ({ ...this.view(tid), position: tid })),
        })),
      ];
    }
    if (
      method === "POST" &&
      (m = path.match(/^\/projects\/5\/views\/20\/buckets\/(\d+)\/tasks$/))
    ) {
      const b = Number(m[1]);
      const tid = (body as { task_id: number }).task_id;
      this.bucketOf.set(tid, b);
      if (b === this.doneBucket) this.tasks.get(tid)!.done = true;
      this.touch(tid);
      return [200, {}];
    }
    if (method === "PUT" && path === "/projects/5/tasks") {
      const fields = { ...(body as Partial<Task>) };
      for (const f of this.dropOnCreate) delete fields[f];
      const id = this.seed(fields);
      this.touch(id);
      return [201, this.view(id)];
    }
    if (method === "GET" && path === "/projects/5/tasks") {
      const s = url.searchParams.get("s") ?? "";
      return [
        200,
        this.page(
          url,
          [...this.tasks.keys()].map((id) => this.view(id)).filter((t) =>
            String(t.title).includes(s)
          ),
        ),
      ];
    }
    if ((m = path.match(/^\/tasks\/(\d+)$/))) {
      const id = Number(m[1]);
      const t = this.tasks.get(id);
      if (!t) return [404, { message: "not found" }];
      if (method === "GET") return [200, this.view(id)];
      if (method === "POST") {
        const next = { ...(body as Task) };
        delete next.labels;
        for (const f of this.ignoreOnWrite) next[f] = t[f];
        this.tasks.set(id, { ...next, id });
        if (next.done === true && t.done !== true) {
          this.bucketOf.set(id, this.doneBucket);
        } else if (this.unbucketOnWrite) {
          this.bucketOf.set(id, this.buckets[0].id);
        }
        this.touch(id);
        return [200, this.view(id)];
      }
    }
    if (method === "PUT" && (m = path.match(/^\/tasks\/(\d+)\/labels$/))) {
      this.taskLabels.get(Number(m[1]))!.add(
        (body as { label_id: number }).label_id,
      );
      return [201, {}];
    }
    if (
      method === "DELETE" &&
      (m = path.match(/^\/tasks\/(\d+)\/labels\/(\d+)$/))
    ) {
      this.taskLabels.get(Number(m[1]))!.delete(Number(m[2]));
      return [200, {}];
    }
    return [404, { message: `fake has no route ${method} ${path}` }];
  }
}

type MethodName = keyof typeof model.methods;

/** Run one method against a fresh fake with fetch stubbed; returns the store. */
async function withFake<T>(
  fake: FakeVikunja,
  fn: (
    run: (name: MethodName, args: Record<string, unknown>) => Promise<unknown>,
    store: Map<string, Record<string, unknown>>,
  ) => Promise<T>,
): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const [status, json] = fake.handle(init?.method ?? "GET", url, body);
    return Promise.resolve(
      new Response(JSON.stringify(json), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };
  const store = new Map<string, Record<string, unknown>>();
  const ctx = {
    globalArgs: {
      baseUrl: "http://vikunja.test",
      apiToken: "tk_test",
      projectId: 5,
    },
    writeResource: (_spec: string, name: string, payload: unknown) => {
      store.set(name, payload as Record<string, unknown>);
      return Promise.resolve({ name });
    },
    readResource: (name: string) => Promise.resolve(store.get(name) ?? null),
    logger: {
      info: (msg: string, props?: Record<string, unknown>) =>
        fake.logs.push({ level: "info", msg, props: props ?? {} }),
      warning: (msg: string, props?: Record<string, unknown>) =>
        fake.logs.push({ level: "warning", msg, props: props ?? {} }),
    },
  };
  // async, so a schema refusal from parse() rejects like a runtime one.
  const run = async (name: MethodName, args: Record<string, unknown>) => {
    const method = model.methods[name];
    // deno-lint-ignore no-explicit-any
    return await (method.execute as any)(method.arguments.parse(args), ctx);
  };
  try {
    return await fn(run, store);
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** A body that passes the full Definition of Ready. */
const READY_BODY =
  "<p><strong>Verdict (2026-09-27): CONFIRMED</strong> — the " +
  "example check printed the expected value.</p><p><strong>Acceptance:" +
  "</strong> <code>example-cli status</code> prints <code>ok</code>.</p>" +
  '<p>Source: <a href="obsidian://open?vault=example&file=note">note</a></p>' +
  "<p>" + "Context that makes the card executable. ".repeat(10) + "</p>";

const bucketTitle = (f: FakeVikunja, id: number) =>
  f.buckets.find((b) => b.id === f.bucketOf.get(id))!.title;
const labelTitles = (f: FakeVikunja, id: number) =>
  [...f.taskLabels.get(id)!].map((l) => f.labels.find((x) => x.id === l)!.title)
    .sort();

// ---------------------------------------------------------------- new_task

Deno.test("new_task attaches label + labels, then moves LAST", async () => {
  const f = new FakeVikunja();
  await withFake(f, async (run) => {
    await run("new_task", {
      title: "fresh",
      label: "automation",
      labels: ["TIER-B", "automation"],
      bucketName: "Next",
      description: READY_BODY,
      priority: 3,
    });
  });
  const id = 100;
  assertEquals(labelTitles(f, id), ["automation", "tier-B"]);
  assertStrictEquals(bucketTitle(f, id), "Next");
  const writes = f.writes.filter((w) => !w.startsWith("PUT /projects"));
  assert(writes.at(-1)!.includes("/buckets/11/tasks"), writes.join("\n"));
});

Deno.test("new_task with an unknown label creates nothing", async () => {
  const f = new FakeVikunja();
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("new_task", { title: "x", labels: ["tier-B", "nope"] }),
      Error,
      "nope",
    );
  });
  assertStrictEquals(f.tasks.size, 0);
  assertEquals(f.writes, []);
});

Deno.test("new_task attaches a label from beyond the first page", async () => {
  const f = new FakeVikunja();
  await withFake(f, async (run) => {
    await run("new_task", {
      title: "paged",
      labels: ["filler-077", "Filler-120"],
    });
  });
  assertEquals(labelTitles(f, 100), ["filler-077", "filler-120"]);
  const labelReads = f.reads.filter((r) => r.startsWith("/labels"));
  assertStrictEquals(labelReads.length, 3, labelReads.join("\n"));
});

Deno.test("an unknown label title still throws with all pages read, no writes", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ labelIds: [1] });
  await withFake(f, async (run) => {
    await assertRejects(
      () =>
        run("new_task", { title: "x", labels: ["filler-099", "filler-999"] }),
      Error,
      "filler-999",
    );
    await assertRejects(
      () => run("set_labels", { taskId: id, add: ["filler-121"] }),
      Error,
      "filler-121",
    );
  });
  assertEquals(f.writes, []);
  assertStrictEquals(f.tasks.size, 1);
});

Deno.test("label paging terminates when the server ignores page", async () => {
  const f = new FakeVikunja();
  f.ignorePage = true;
  await withFake(f, async (run) => {
    // Page 1 again adds nothing new, so the loop stops at page 2.
    await run("new_task", { title: "p1", labels: ["automation"] });
    await assertRejects(
      () => run("new_task", { title: "p2", labels: ["filler-080"] }),
      Error,
      "filler-080",
    );
  });
  assertStrictEquals(
    f.reads.filter((r) => r.startsWith("/labels")).length,
    4,
    f.reads.join("\n"),
  );
  assertStrictEquals(f.tasks.size, 1);
});

Deno.test("skipIfTitleExists finds a duplicate beyond the first page", async () => {
  const f = new FakeVikunja();
  // 60 open cards whose titles contain the search term; the exact match is
  // the last one, on page 2 of the search.
  for (let i = 0; i < 60; i++) f.seed({ title: `shared prefix ${i}` });
  const dupId = f.seed({ title: "shared prefix" });
  await withFake(f, async (run, store) => {
    await run("new_task", { title: "shared prefix", skipIfTitleExists: true });
    assert(store.has(`get-${dupId}`), [...store.keys()].join(","));
  });
  assertEquals(f.writes, []);
  assertStrictEquals(f.tasks.size, 61);
});

Deno.test("new_task refuses a stub into Next, or anywhere with requireReady", async () => {
  const f = new FakeVikunja();
  await withFake(f, async (run) => {
    await assertRejects(
      () =>
        run("new_task", {
          title: "stub",
          description: "<p>todo</p>",
          labels: ["automation", "tier-B"],
          priority: 3,
          bucketName: "Next",
        }),
      Error,
      "short-description",
    );
    await assertRejects(
      () => run("new_task", { title: "stub", requireReady: true }),
      Error,
      "empty-description",
    );
  });
  assertEquals(f.writes, []);
  // Negative control: the same stub in Backlog is still accepted, so
  // automated creators that file stubs keep working.
  await withFake(f, (run) => run("new_task", { title: "stub" }));
  assertStrictEquals(bucketTitle(f, 100), "Backlog");
});

Deno.test("new_task into Next needs a tier label and an area label", async () => {
  const f = new FakeVikunja();
  const card = { description: READY_BODY, priority: 3, bucketName: "Next" };
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("new_task", { ...card, title: "a", labels: ["automation"] }),
      Error,
      "missing-label-group",
    );
    await assertRejects(
      () => run("new_task", { ...card, title: "b", labels: ["tier-B"] }),
      Error,
      "missing-area-label",
    );
  });
  assertEquals(f.writes, []);
  await withFake(
    f,
    (run) =>
      run("new_task", {
        ...card,
        title: "c",
        labels: ["automation", "tier-B"],
      }),
  );
  assertStrictEquals(bucketTitle(f, 100), "Next");
});

Deno.test("new_task into Waiting needs a due date; into Doing is refused", async () => {
  const f = new FakeVikunja();
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("new_task", { title: "w", bucketName: "Waiting" }),
      Error,
      "missing-due-date",
    );
    await assertRejects(
      () => run("new_task", { title: "d", bucketName: "doing" }),
      Error,
      "refused-bucket",
    );
    assertEquals(f.writes, []);
    await run("new_task", {
      title: "w",
      bucketName: "Waiting",
      dueDate: "2026-11-04T17:00:00Z",
    });
  });
  assertStrictEquals(bucketTitle(f, 100), "Waiting");
  assertStrictEquals(f.tasks.get(100)!.due_date, "2026-11-04T17:00:00Z");
});

Deno.test("new_task sets a due date the create dropped, then reads it back", async () => {
  const f = new FakeVikunja();
  f.dropOnCreate = ["due_date", "priority"];
  await withFake(f, (run) =>
    run("new_task", {
      title: "dated",
      priority: 4,
      dueDate: "2026-11-04T17:00:00Z",
    }));
  const t = f.tasks.get(100)!;
  assertStrictEquals(t.due_date, "2026-11-04T17:00:00Z");
  assertStrictEquals(t.priority, 4);
  assert(f.writes.includes("POST /tasks/100"), f.writes.join("\n"));
});

Deno.test("new_task read-back mismatch throws naming the task id", async () => {
  const f = new FakeVikunja();
  f.dropOnCreate = ["description"];
  await withFake(f, async (run, store) => {
    await assertRejects(
      () => run("new_task", { title: "x", description: "<p>mine</p>" }),
      Error,
      "Task 100 was created but did not read back as sent: description",
    );
    // Recorded anyway, so a fix-up edit passes the recent-edit guard.
    assert(store.has("task-100"));
  });
});

Deno.test("duplicateTitle: refuse and skip match case-insensitively; allow creates", async () => {
  const f = new FakeVikunja();
  const dup = f.seed({ title: "Rotate The Example Key" });
  f.seed({ title: "rotate the example key", done: true, bucket: 13 });
  await withFake(f, async (run, store) => {
    await assertRejects(
      () =>
        run("new_task", {
          title: " rotate the example KEY ",
          duplicateTitle: "refuse",
        }),
      Error,
      `open task ${dup} already has that title`,
    );
    // Default (and the deprecated skipIfTitleExists: true) = skip.
    await run("new_task", { title: "ROTATE the example key" });
    await run("new_task", {
      title: "rotate the example key",
      skipIfTitleExists: true,
    });
    assert(store.has(`get-${dup}`));
    assert(!store.has(`task-${dup}`));
    assertEquals(f.writes, []);
    await run("new_task", {
      title: "rotate the example key",
      duplicateTitle: "allow",
    });
    await run("new_task", {
      title: "Rotate the example key",
      skipIfTitleExists: false,
    });
  });
  assertStrictEquals(f.tasks.size, 4);
});

Deno.test("a duplicate skip does not count as our write for the recent-edit guard", async () => {
  const f = new FakeVikunja();
  // Someone else edited this card just now.
  const id = f.seed({ title: "Human card", updated: new Date().toISOString() });
  await withFake(f, async (run, store) => {
    await run("new_task", { title: "human card" });
    assert(!store.has(`task-${id}`));
    assert(store.has(`get-${id}`));
    await assertRejects(
      () => run("update_task", { taskId: id, priority: 5 }),
      Error,
      "force: true",
    );
  });
  assertEquals(f.writes, []);
});

// ------------------------------------------------------------ board / get_task

Deno.test("board writes every not-done card with bucket, role and fields", async () => {
  const f = new FakeVikunja();
  const a = f.seed({
    bucket: 11,
    labelIds: [1, 2],
    description: READY_BODY,
    due_date: "2026-11-04T17:00:00Z",
  });
  const b = f.seed({ bucket: 10 });
  f.seed({ bucket: 13, done: true });
  await withFake(f, async (run, store) => {
    await run("board", {});
    const snap = store.get("board-5")! as {
      total: number;
      buckets: { title: string; role: string; count: number }[];
      cards: Record<string, unknown>[];
    };
    assertStrictEquals(snap.total, 2);
    assertEquals(snap.cards.map((c) => c.id), [b, a]);
    assertEquals(
      snap.buckets.map((x) => [x.title, x.role, x.count]),
      [
        ["Backlog", "backlog", 1],
        ["Next", "ready", 1],
        ["Doing", "doing", 0],
        ["Done", "done", 0],
        ["Waiting", "waiting", 0],
      ],
    );
    const card = snap.cards[1];
    assertEquals(card.bucket, "Next");
    assertEquals(card.role, "ready");
    assertEquals(card.labels, ["automation", "tier-B"]);
    assertEquals(card.description, READY_BODY);
    assertEquals(card.dueDate, "2026-11-04T17:00:00Z");
    assertEquals(card.priority, 2);
  });
  assertEquals(f.writes, []);
});

Deno.test("board: a 120-card board with full bodies stays small", async () => {
  const f = new FakeVikunja();
  for (let i = 0; i < 120; i++) {
    f.seed({
      bucket: [10, 11, 12, 14][i % 4],
      description: READY_BODY,
      labelIds: [1, 2],
    });
  }
  await withFake(f, async (run, store) => {
    await run("board", {});
    const snap = store.get("board-5")!;
    assertStrictEquals(snap.total, 120);
    const bytes = new TextEncoder().encode(JSON.stringify(snap)).length;
    // ~0.95 KB per card with a ~670-char body (about 113 KB in all).
    assert(bytes < 200_000, `snapshot is ${bytes} bytes`);
  });
});

Deno.test("get_task records the card and its bucket as get-<id>, not task-<id>", async () => {
  const f = new FakeVikunja();
  // Edited by someone a moment ago.
  const id = f.seed({ bucket: 11, updated: new Date().toISOString() });
  await withFake(f, async (run, store) => {
    await run("get_task", { taskId: id });
    const got = store.get(`get-${id}`)!;
    assertEquals(got.bucket, { title: "Next", role: "ready" });
    assertStrictEquals(got.id, id);
    assert(!store.has(`task-${id}`));
    // A read must not make that edit look like ours.
    await assertRejects(
      () => run("update_task", { taskId: id, priority: 4 }),
      Error,
      "force: true",
    );
  });
  assertEquals(f.writes, []);
});

// ------------------------------------------------------------- update_task

Deno.test("update_task changes only the named fields", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ title: "old", priority: 1, bucket: 11, labelIds: [2] });
  await withFake(f, async (run, store) => {
    await run("update_task", {
      taskId: id,
      description: "<p>new body</p>",
      priority: 4,
    });
    assertStrictEquals(store.get(`task-${id}`)!.priority, 4);
  });
  const t = f.tasks.get(id)!;
  assertStrictEquals(t.title, "old");
  assertStrictEquals(t.description, "<p>new body</p>");
  assertStrictEquals(t.priority, 4);
  assertEquals(labelTitles(f, id), ["tier-B"]);
  assertStrictEquals(bucketTitle(f, id), "Next");
});

Deno.test("update_task moves the card back when a write un-buckets it", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ bucket: 12 });
  f.unbucketOnWrite = true;
  await withFake(f, (run) => run("update_task", { taskId: id, title: "t2" }));
  assertStrictEquals(bucketTitle(f, id), "Doing");
  assertStrictEquals(f.tasks.get(id)!.title, "t2");
});

Deno.test("update_task fails when a field does not read back", async () => {
  const f = new FakeVikunja();
  const id = f.seed();
  f.ignoreOnWrite = ["description"];
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("update_task", { taskId: id, description: "<p>x</p>" }),
      Error,
      "description did not read back",
    );
  });
});

Deno.test("update_task refusals: done card, empty body, no fields", async () => {
  const f = new FakeVikunja();
  const done = f.seed({ done: true, bucket: 13 });
  const open = f.seed();
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("update_task", { taskId: done, priority: 3 }),
      Error,
      "is done",
    );
    await assertRejects(
      () => run("update_task", { taskId: open, description: "<p> </p>" }),
      Error,
      "empty description",
    );
    await assertRejects(() => run("update_task", { taskId: open }));
  });
  assertEquals(f.writes, []);
});

Deno.test("recent-edit guard: someone else's edit blocks, ours and force pass", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ updated: new Date().toISOString() });
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("update_task", { taskId: id, priority: 5 }),
      Error,
      "force: true",
    );
    await run("update_task", { taskId: id, priority: 5, force: true });
    // Our own write is recorded in task-<id>; the next edit needs no force.
    await run("update_task", { taskId: id, priority: 3 });
    // A later edit by someone else blocks again.
    f.touch(id);
    f.writes.push("human edit");
    f.touch(id);
    await assertRejects(
      () => run("set_labels", { taskId: id, add: ["storage"] }),
      Error,
      "force: true",
    );
  });
  assertStrictEquals(f.tasks.get(id)!.priority, 3);
});

// ------------------------------------------------------------ set_due_date

Deno.test("set_due_date: recent-edit guard blocks, force and our own write pass", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ updated: new Date().toISOString() });
  await withFake(f, async (run) => {
    await assertRejects(
      () =>
        run("set_due_date", { taskId: id, dueDate: "2026-11-04T17:00:00Z" }),
      Error,
      "force: true",
    );
    assertEquals(f.writes, []);
    await run("set_due_date", {
      taskId: id,
      dueDate: "2026-11-04T17:00:00Z",
      force: true,
    });
    // Recorded as ours: the next change needs no force.
    await run("set_due_date", { taskId: id, dueDate: "2026-11-05T17:00:00Z" });
  });
  assertStrictEquals(f.tasks.get(id)!.due_date, "2026-11-05T17:00:00Z");
});

Deno.test("set_due_date refuses done cards and clearing a waiting card's date", async () => {
  const f = new FakeVikunja();
  const done = f.seed({ done: true, bucket: 13 });
  const waiting = f.seed({ bucket: 14, due_date: "2026-11-04T17:00:00Z" });
  await withFake(f, async (run) => {
    await assertRejects(
      () =>
        run("set_due_date", { taskId: done, dueDate: "2026-11-04T17:00:00Z" }),
      Error,
      "is done",
    );
    await assertRejects(
      () => run("set_due_date", { taskId: waiting, dueDate: "" }),
      Error,
      "waiting card needs one",
    );
    assertEquals(f.writes, []);
    // Re-dating a waiting card is fine.
    await run("set_due_date", {
      taskId: waiting,
      dueDate: "2026-12-01T17:00:00Z",
    });
  });
  assertStrictEquals(f.tasks.get(waiting)!.due_date, "2026-12-01T17:00:00Z");
});

// -------------------------------------------------------------- set_labels

Deno.test("set_labels adds and removes by title, case-insensitively", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ labelIds: [1, 3] });
  await withFake(
    f,
    (run) =>
      run("set_labels", { taskId: id, add: ["Tier-B"], remove: ["STORAGE"] }),
  );
  assertEquals(labelTitles(f, id), ["automation", "tier-B"]);
  assert(!f.writes.some((w) => w.startsWith("POST /tasks")), "no body write");
});

Deno.test("set_labels adds and removes page-2+ titles with one label read", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ labelIds: [1, 110] });
  await withFake(
    f,
    (run) =>
      run("set_labels", {
        taskId: id,
        add: ["filler-060", "FILLER-101"],
        remove: ["filler-110"],
      }),
  );
  assertEquals(labelTitles(f, id), ["automation", "filler-060", "filler-101"]);
  // 120 labels at 50 per page: pages 1-3 once, not twice (add + remove).
  assertEquals(
    f.reads.filter((r) => r.startsWith("/labels")).map((r) =>
      new URLSearchParams(r.split("?")[1]).get("page")
    ),
    ["1", "2", "3"],
  );
});

Deno.test("set_labels refuses unknown titles and add/remove overlap", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ labelIds: [1] });
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("set_labels", { taskId: id, remove: ["automaton"] }),
      Error,
      "automaton",
    );
    await assertRejects(() =>
      run("set_labels", { taskId: id, add: ["storage"], remove: ["Storage"] })
    );
    await assertRejects(() => run("set_labels", { taskId: id }));
  });
  assertEquals(f.writes, []);
  assertEquals(labelTitles(f, id), ["automation"]);
});

// --------------------------------------------------------------- move_task

Deno.test("move_task moves and reads the placement back", async () => {
  const f = new FakeVikunja();
  const id = f.seed({
    bucket: 10,
    description: READY_BODY,
    priority: 3,
    labelIds: [1, 2],
  });
  await withFake(f, async (run, store) => {
    await run("move_task", { taskId: id, bucketName: "next" });
    assertEquals(
      (store.get(`task-${id}`)!.placement as { bucketTitle: string })
        .bucketTitle,
      "Next",
    );
  });
  assertStrictEquals(bucketTitle(f, id), "Next");
});

Deno.test("move_task refuses an unready card into Next, listing the findings", async () => {
  const f = new FakeVikunja();
  const stub = f.seed({ bucket: 10, labelIds: [2] });
  await withFake(f, async (run) => {
    const err = await assertRejects(
      () => run("move_task", { taskId: stub, bucketName: "Next" }),
      Error,
      "Refusing to move task",
    );
    for (
      const rule of [
        "short-description",
        "missing-area-label",
        "missing-verdict",
        "missing-acceptance",
        "missing-link",
      ]
    ) assert(err.message.includes(rule), `${rule}: ${err.message}`);
    assertEquals(f.writes, []);
    // force is the explicit override.
    await run("move_task", { taskId: stub, bucketName: "Next", force: true });
  });
  assertStrictEquals(bucketTitle(f, stub), "Next");
});

Deno.test("move_task into Waiting needs a due date", async () => {
  const f = new FakeVikunja();
  const undated = f.seed();
  const dated = f.seed({ due_date: "2026-11-04T17:00:00Z" });
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("move_task", { taskId: undated, bucketName: "Waiting" }),
      Error,
      "missing-due-date",
    );
    assertEquals(f.writes, []);
    await run("move_task", { taskId: dated, bucketName: "Waiting" });
    // Other columns stay light: Doing takes the stub as it is.
    await run("move_task", { taskId: undated, bucketName: "Doing" });
  });
  assertStrictEquals(bucketTitle(f, dated), "Waiting");
  assertStrictEquals(bucketTitle(f, undated), "Doing");
});

Deno.test("move_task refuses the done bucket and done cards", async () => {
  const f = new FakeVikunja();
  const open = f.seed();
  const done = f.seed({ done: true, bucket: 13 });
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("move_task", { taskId: open, bucketName: "Done" }),
      Error,
      "close_task",
    );
    await assertRejects(
      () => run("move_task", { taskId: done, bucketName: "Next" }),
      Error,
      "is done",
    );
    await assertRejects(
      () => run("move_task", { taskId: open, bucketName: "Icebox" }),
      Error,
      "available",
    );
  });
  assertEquals(f.writes, []);
});

// -------------------------------------------------------------- close_task

Deno.test("close_task needs humanInstructed, then closes and reads back", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ bucket: 12, updated: new Date().toISOString() });
  await withFake(f, async (run) => {
    await assertRejects(
      () => run("close_task", { taskId: id }),
      Error,
      "humanInstructed",
    );
    assertEquals(f.writes, []);
    await run("close_task", { taskId: id, humanInstructed: true });
    // Idempotent on an already-closed card.
    await run("close_task", { taskId: id, humanInstructed: true });
  });
  assertStrictEquals(f.tasks.get(id)!.done, true);
  assertStrictEquals(bucketTitle(f, id), "Done");
});

// -------------------------------------------------------------- apply_plan

type PlanResultLike = {
  outcome: string;
  valid: boolean;
  counts: Record<string, number>;
  problems: { index: number | null; problem: string }[];
  ops: {
    index: number;
    status: string;
    taskId: number | null;
    problems: string[];
    error?: string;
  }[];
};
const planOf = (store: Map<string, Record<string, unknown>>) =>
  store.get("plan-5") as unknown as PlanResultLike;

/** A plan with one problem of every kind, plus one valid op (#0). */
function badPlan(f: FakeVikunja) {
  const ok = f.seed({ title: "fine card" });
  const done = f.seed({ done: true, bucket: 13 });
  const hot = f.seed({ updated: new Date().toISOString() });
  const stub = f.seed({ title: "Existing Title", labelIds: [2] });
  const closing = f.seed();
  return {
    ids: { ok, done, hot, stub, closing },
    ops: [
      { op: "update", taskId: ok, priority: 4 }, // #0 valid
      { op: "update", taskId: 999, priority: 1 }, // #1 unknown task
      { op: "labels", taskId: done, add: ["storage"] }, // #2 done card
      { op: "update", taskId: hot, priority: 1 }, // #3 recent edit
      { op: "labels", taskId: ok, add: ["no-such-label"] }, // #4 unknown label
      { op: "move", taskId: ok, bucketName: "Icebox" }, // #5 unknown bucket
      { op: "create", title: "stub", bucketName: "Next" }, // #6 not ready
      { op: "create", title: "existing title", requireReady: false }, // #7 dup on board
      { op: "create", title: "twin", requireReady: false }, // #8 valid alone
      { op: "create", title: "TWIN ", requireReady: false }, // #9 dup in plan
      { op: "move", taskId: stub, bucketName: "Next" }, // #10 unready move
      { op: "close", taskId: closing }, // #11 no humanInstructed
      { op: "update", taskId: closing, priority: 5 }, // #12 after close
      { op: "update", taskId: stub }, // #13 no fields
      { op: "due", taskId: ok, dueDate: "someday" }, // #14 bad date
    ],
  };
}

Deno.test("apply_plan dry run writes nothing and reports every problem", async () => {
  const f = new FakeVikunja();
  const { ops } = badPlan(f);
  await withFake(f, async (run, store) => {
    await run("apply_plan", { ops });
    const r = planOf(store);
    assertEquals(r.outcome, "dry-run");
    assertEquals(r.valid, false);
    const byOp = (i: number) => r.ops[i].problems.join(" | ");
    assertEquals(r.ops[0].status, "ok");
    assertEquals(r.ops[8].status, "ok");
    const expect: Array<[number, string]> = [
      [1, "task 999 is not on the board"],
      [2, "is done"],
      [3, "force: true"],
      [4, "unknown label(s): no-such-label"],
      [5, 'unknown bucket "Icebox"'],
      [6, "empty-description"],
      [6, "no-labels"],
      [7, "already has this title"],
      [9, "duplicates the title of op #8"],
      [10, 'not ready for "Next"'],
      [10, "missing-area-label"],
      [11, "humanInstructed: true"],
      [12, "closed by op #11"],
      [13, "at least one of title, description, priority"],
      [14, "not a parseable instant"],
    ];
    for (const [i, text] of expect) {
      assertEquals(r.ops[i].status, "invalid", `op #${i}`);
      assert(byOp(i).includes(text), `op #${i}: ${byOp(i)}`);
    }
    assertEquals(r.counts.ops, 15);
    assertEquals(
      new Set(r.problems.map((p) => p.index)).size,
      13,
      "every bad op is listed, not just the first",
    );
  });
  assertEquals(f.writes, []);
});

Deno.test("apply_plan with apply: true and one bad op writes nothing", async () => {
  const f = new FakeVikunja();
  const a = f.seed();
  const b = f.seed();
  await withFake(f, async (run, store) => {
    await assertRejects(
      () =>
        run("apply_plan", {
          apply: true,
          ops: [
            { op: "update", taskId: a, priority: 4 },
            { op: "labels", taskId: a, add: ["storage"] },
            { op: "due", taskId: b, dueDate: "2026-11-04T17:00:00Z" },
            { op: "labels", taskId: b, add: ["storag"] }, // the bad one
            { op: "update", taskId: b, title: "renamed" },
          ],
        }),
      Error,
      "wrote nothing: 1 problem(s)",
    );
    const r = planOf(store);
    assertEquals(r.outcome, "refused");
    assertEquals(r.ops.map((o) => o.status), [
      "ok",
      "ok",
      "ok",
      "invalid",
      "ok",
    ]);
  });
  assertEquals(f.writes, []);
});

Deno.test("apply_plan applies mixed ops in order with read-backs", async () => {
  const f = new FakeVikunja();
  // Edited moments ago by someone: the first op forces, later ops on the
  // same card pass because the plan's own write is recorded as ours.
  const groom = f.seed({
    title: "Groom me",
    updated: new Date().toISOString(),
  });
  const closing = f.seed({ bucket: 12 });
  await withFake(f, async (run, store) => {
    await run("apply_plan", {
      apply: true,
      ops: [
        {
          op: "create",
          title: "Brand new ready card",
          description: READY_BODY,
          labels: ["automation", "tier-B"],
          priority: 3,
          bucketName: "Next",
        },
        {
          op: "update",
          taskId: groom,
          description: READY_BODY,
          priority: 4,
          force: true,
        },
        { op: "labels", taskId: groom, add: ["storage", "tier-B"] },
        { op: "due", taskId: groom, dueDate: "2026-11-04T17:00:00Z" },
        { op: "move", taskId: groom, bucketName: "Next" },
        { op: "close", taskId: closing, humanInstructed: true },
      ],
    });
    const r = planOf(store);
    assertEquals(r.outcome, "applied");
    assertEquals(r.ops.map((o) => o.status), Array(6).fill("done"));
    const created = r.ops[0].taskId!;
    assert(created > closing, `created id ${created}`);
    for (const id of [created, groom, closing]) {
      assert(store.has(`task-${id}`), `task-${id} recorded`);
    }
    // The last write to a card is what its task-<id> records.
    assertEquals(
      store.get(`task-${groom}`)!.updated,
      f.tasks.get(groom)!.updated,
    );
  });
  const newest = Math.max(...f.tasks.keys());
  assertStrictEquals(bucketTitle(f, newest), "Next");
  assertEquals(labelTitles(f, newest), ["automation", "tier-B"]);
  const g = f.tasks.get(groom)!;
  assertStrictEquals(g.description, READY_BODY);
  assertStrictEquals(g.priority, 4);
  assertStrictEquals(g.due_date, "2026-11-04T17:00:00Z");
  assertEquals(labelTitles(f, groom), ["storage", "tier-B"]);
  assertStrictEquals(bucketTitle(f, groom), "Next");
  assertStrictEquals(f.tasks.get(closing)!.done, true);
  assertStrictEquals(bucketTitle(f, closing), "Done");
});

Deno.test("apply_plan judges a move on the state earlier ops leave", async () => {
  const f = new FakeVikunja();
  const id = f.seed({ description: READY_BODY, priority: 3, labelIds: [1] });
  await withFake(f, async (run, store) => {
    // Move before the label op that makes it ready: refused, with a hint.
    await run("apply_plan", {
      ops: [
        { op: "move", taskId: id, bucketName: "Next" },
        { op: "labels", taskId: id, add: ["tier-B"] },
      ],
    });
    const bad = planOf(store);
    assertEquals(bad.ops[0].status, "invalid");
    assert(
      bad.ops[0].problems[0].includes("op #1 changes this card later"),
      bad.ops[0].problems[0],
    );
    // Swapped: valid.
    await run("apply_plan", {
      ops: [
        { op: "labels", taskId: id, add: ["tier-B"] },
        { op: "move", taskId: id, bucketName: "Next" },
      ],
    });
    assertEquals(planOf(store).valid, true);
  });
  assertEquals(f.writes, []);
});

Deno.test("apply_plan stops at a mid-run failure and reports not-run ops", async () => {
  const f = new FakeVikunja();
  const a = f.seed();
  const b = f.seed();
  const c = f.seed({ labelIds: [1] });
  f.ignoreOnWrite = ["description"]; // b's description write will not stick
  await withFake(f, async (run, store) => {
    const err = await assertRejects(
      () =>
        run("apply_plan", {
          apply: true,
          ops: [
            { op: "update", taskId: a, priority: 5 },
            { op: "update", taskId: b, description: "<p>new body</p>" },
            { op: "labels", taskId: c, add: ["storage"] },
            { op: "due", taskId: c, dueDate: "2026-11-04T17:00:00Z" },
          ],
        }),
      Error,
      "stopped at op #1 (update)",
    );
    assert(err.message.includes("not run: #2, #3"), err.message);
    const r = planOf(store);
    assertEquals(r.outcome, "failed");
    assertEquals(r.ops.map((o) => o.status), [
      "done",
      "failed",
      "not-run",
      "not-run",
    ]);
    assert(r.ops[1].error!.includes("description did not read back"));
    assertEquals(r.counts.done, 1);
    assertEquals(r.counts.notRun, 2);
  });
  assertStrictEquals(f.tasks.get(a)!.priority, 5);
  assertEquals(labelTitles(f, c), ["automation"]);
});

Deno.test("apply_plan: maxOps cap, and duplicateTitle skip leaves the op out", async () => {
  const f = new FakeVikunja();
  const existing = f.seed({ title: "Already here" });
  const ops = Array.from({ length: 3 }, (_, i) => ({
    op: "update",
    taskId: existing,
    priority: i + 1,
  }));
  await withFake(f, async (run, store) => {
    await run("apply_plan", { ops, maxOps: 2 });
    const capped = planOf(store);
    assertEquals(capped.valid, false);
    assertEquals(capped.problems[0].index, null);
    assert(capped.problems[0].problem.includes("more than maxOps 2"));

    await run("apply_plan", {
      apply: true,
      ops: [{
        op: "create",
        title: "already HERE",
        duplicateTitle: "skip",
        requireReady: false,
      }],
    });
    const r = planOf(store);
    assertEquals(r.outcome, "applied");
    assertEquals(r.ops[0].status, "skip");
    assertEquals(r.ops[0].taskId, existing);
  });
  assertEquals(f.writes, []);
});

// ------------------------------------------------------------- logging

Deno.test("every method logs its start, and every message is a constant template", async () => {
  const f = new FakeVikunja();
  const a = f.seed({ title: "Alpha card" });
  const b = f.seed({ title: "Beta card", bucket: 11 });
  const methods: Array<[MethodName, Record<string, unknown>]> = [
    ["new_task", { title: "Gamma card", labels: ["storage"] }],
    ["new_task", { title: "alpha CARD" }], // duplicate skip
    ["get_task", { taskId: a }],
    ["update_task", { taskId: a, priority: 4 }],
    ["update_task", { taskId: a, priority: 4 }], // no change
    ["set_labels", { taskId: a, add: ["automation"] }],
    ["move_task", { taskId: a, bucketName: "Doing" }],
    ["move_task", { taskId: a, bucketName: "Doing" }], // already there
    ["set_due_date", { taskId: a, dueDate: "2026-11-04T17:00:00Z" }],
    ["board", {}],
    ["apply_plan", { ops: [{ op: "labels", taskId: b, add: ["storag"] }] }],
    ["close_task", { taskId: a, humanInstructed: true }],
    ["list_recent", {}],
    ["audit", {}],
    ["reorder", {}],
    ["due_report", { now: "2026-09-27T12:00:00Z" }],
  ];
  await withFake(f, async (run) => {
    for (const [name, args] of methods) {
      const before = f.logs.length;
      await run(name, args);
      const mine = f.logs.slice(before);
      assert(
        mine.some((l) => l.level === "info" && l.props.method === name),
        `${name} logged no start line`,
      );
    }
  });
  const ids = [...f.tasks.keys()].map(String);
  for (const { msg, props } of f.logs) {
    // Every placeholder has a value, and no value was pasted into the text.
    for (const [, key] of msg.matchAll(/\{(\w+)\}/g)) {
      assert(key in props, `"${msg}" has no value for {${key}}`);
    }
    assert(!/\d/.test(msg), `"${msg}" has a number in the message text`);
    for (const id of ids) {
      assert(!msg.includes(id), `"${msg}" interpolates task id ${id}`);
    }
  }
  assert(f.logs.length >= methods.length * 2);
});
