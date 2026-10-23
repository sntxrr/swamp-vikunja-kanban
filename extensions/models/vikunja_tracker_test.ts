import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  kindOfStatus,
  model,
  parseRef,
  relationsOf,
} from "./vikunja_tracker.ts";

// An in-memory Vikunja v2.6, as far as the tracker uses it: tasks with
// identifiers, buckets on one kanban view (expand=buckets), labels,
// comments, two-sided relations, assignees and project users.

type Raw = Record<string, unknown>;

const INVERSE: Record<string, string> = {
  subtask: "parenttask",
  parenttask: "subtask",
  blocked: "blocking",
  blocking: "blocked",
  duplicateof: "duplicates",
  duplicates: "duplicateof",
  related: "related",
};

class FakeVikunja {
  projectId = 7;
  viewId = 70;
  buckets = [
    { id: 1, title: "Backlog" },
    { id: 2, title: "Doing" },
    { id: 3, title: "Done" },
  ];
  labels = [{ id: 1, title: "automation" }, { id: 2, title: "tier-C" }];
  users = [{ id: 1, username: "sntxrr" }];
  tasks = new Map<number, Raw>();
  bucketOf = new Map<number, number>();
  comments = new Map<number, Raw[]>();
  relations: Array<{ from: number; kind: string; to: number }> = [];
  nextId = 500;
  nextComment = 9000;
  token = "tk_good";
  calls: string[] = [];
  /** Answer every label attach with a 500. */
  failLabels = false;

  seed(over: Raw = {}, projectId = this.projectId): number {
    const id = this.nextId++;
    const index = id - 400;
    this.tasks.set(id, {
      id,
      index,
      identifier: `#${index}`,
      project_id: projectId,
      title: `Task ${id}`,
      description: "",
      created: "2026-10-23T00:00:00Z",
      updated: "2026-10-23T00:00:00Z",
      labels: [],
      assignees: [],
      ...over,
    });
    this.bucketOf.set(id, 1);
    return id;
  }

  private view(task: Raw): Raw {
    const id = task.id as number;
    const related: Record<string, Raw[]> = {};
    for (const r of this.relations.filter((r) => r.from === id)) {
      const other = this.tasks.get(r.to)!;
      (related[r.kind] ??= []).push({
        id: other.id,
        index: other.index,
        identifier: other.identifier,
      });
    }
    return {
      ...task,
      related_tasks: related,
      buckets: [{ id: this.bucketOf.get(id), project_view_id: this.viewId }],
    };
  }

  handle(method: string, url: URL, auth: string, body: Raw | null): Response {
    const json = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (auth !== `Bearer ${this.token}`) {
      return json({ message: "Invalid token" }, 401);
    }
    const path = url.pathname.replace(/^\/api\/v1/, "");
    this.calls.push(`${method} ${path}`);
    const page = Number(url.searchParams.get("page") ?? "1");
    const paged = (items: unknown[]) => json(page === 1 ? items : []);
    let m: RegExpExecArray | null;
    const p = this.projectId;
    if (method === "GET" && path === `/projects/${p}/views`) {
      return json([{ id: 69, view_kind: "list" }, {
        id: this.viewId,
        view_kind: "kanban",
      }]);
    }
    if (
      method === "GET" && path === `/projects/${p}/views/${this.viewId}/buckets`
    ) {
      return json(this.buckets);
    }
    if (method === "GET" && path === "/labels") return paged(this.labels);
    if (method === "GET" && path === `/projects/${p}/projectusers`) {
      const s = url.searchParams.get("s") ?? "";
      return json(this.users.filter((u) => u.username.includes(s)));
    }
    if ((m = /^\/projects\/(\d+)\/tasks\/by-index\/(\d+)$/.exec(path))) {
      const hit = [...this.tasks.values()].find((t) =>
        t.project_id === Number(m![1]) && t.index === Number(m![2])
      );
      return hit ? json(this.view(hit)) : json({ message: "not found" }, 404);
    }
    if (method === "PUT" && path === `/projects/${p}/tasks`) {
      const id = this.seed({
        title: body!.title,
        description: body!.description,
      });
      return json(this.tasks.get(id), 201);
    }
    if (
      method === "POST" &&
      (m = new RegExp(
        `^/projects/${p}/views/${this.viewId}/buckets/(\\d+)/tasks$`,
      )
        .exec(path))
    ) {
      this.bucketOf.set(body!.task_id as number, Number(m[1]));
      return json(body);
    }
    if ((m = /^\/tasks\/(\d+)(\/.*)?$/.exec(path))) {
      const id = Number(m[1]);
      const task = this.tasks.get(id);
      if (!task) return json({ message: "The task does not exist." }, 404);
      const rest = m[2] ?? "";
      if (method === "GET" && rest === "") return json(this.view(task));
      if (method === "DELETE" && rest === "") {
        this.tasks.delete(id);
        return json({ message: "deleted" });
      }
      if (method === "GET" && rest === "/comments") {
        return paged(this.comments.get(id) ?? []);
      }
      if (method === "PUT" && rest === "/comments") {
        const c = {
          id: this.nextComment++,
          comment: body!.comment,
          author: { username: "sntxrr" },
          created: new Date().toISOString(),
        };
        this.comments.set(id, [...(this.comments.get(id) ?? []), c]);
        return json(c, 201);
      }
      if (method === "PUT" && rest === "/labels" && this.failLabels) {
        return json({ message: "boom" }, 500);
      }
      if (method === "PUT" && rest === "/labels") {
        const l = this.labels.find((l) => l.id === body!.label_id)!;
        (task.labels as Raw[]).push(l);
        return json(body, 201);
      }
      if (method === "PUT" && rest === "/assignees") {
        const u = this.users.find((u) => u.id === body!.user_id)!;
        (task.assignees as Raw[]).push(u);
        return json(body, 201);
      }
      if (method === "PUT" && rest === "/relations") {
        const to = body!.other_task_id as number;
        const kind = body!.relation_kind as string;
        this.relations.push({ from: id, kind, to });
        this.relations.push({ from: to, kind: INVERSE[kind], to: id });
        return json(body, 201);
      }
      if (
        method === "DELETE" && (m = /^\/relations\/(\w+)\/(\d+)$/.exec(rest))
      ) {
        const kind = m[1];
        const to = Number(m[2]);
        const before = this.relations.length;
        this.relations = this.relations.filter((r) =>
          !(r.from === id && r.kind === kind && r.to === to) &&
          !(r.from === to && r.kind === INVERSE[kind] && r.to === id)
        );
        return before === this.relations.length
          ? json({ message: "not found" }, 404)
          : json({ message: "deleted" });
      }
    }
    return json({ message: `unhandled ${method} ${path}` }, 500);
  }
}

function harness(fake: FakeVikunja, token = fake.token) {
  const records = new Map<string, Raw>();
  const logs: string[] = [];
  const ctx = {
    globalArgs: {
      baseUrl: "http://vikunja.test",
      apiToken: token,
      projectId: fake.projectId,
    },
    readResource: (name: string) => Promise.resolve(records.get(name) ?? null),
    writeResource: (_spec: string, name: string, data: Raw) => {
      records.set(name, structuredClone(data));
      return Promise.resolve({ name });
    },
    logger: {
      info: (msg: string, props?: Record<string, unknown>) =>
        logs.push(`${msg} ${JSON.stringify(props)}`),
    },
  };
  let n = 0;
  const op = async (operation: string, request: Raw | string) => {
    const answer = `answer-${++n}`;
    await model.methods.operate.execute(
      { operation, request, answer, run: "run-1" },
      ctx,
    );
    return records.get(answer)!;
  };
  return { ctx, records, logs, op };
}

async function withFetch(fake: FakeVikunja, fn: () => Promise<void>) {
  const real = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    return Promise.resolve(
      fake.handle(
        init?.method ?? "GET",
        url,
        headers.get("Authorization") ?? "",
        body,
      ),
    );
  };
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
}

Deno.test("parseRef: stable ids, #N and PREFIX-N display ids", () => {
  assertEquals(parseRef("515"), { taskId: 515 });
  assertEquals(parseRef("#93"), { index: 93 });
  assertEquals(parseRef("ST-3"), { index: 3 });
  assertEquals(parseRef("n-12x"), null);
});

Deno.test("kindOfStatus maps HTTP statuses onto the five kinds", () => {
  assertEquals(
    [401, 403, 404, 429, 400, 500, 502].map(kindOfStatus),
    [
      "auth",
      "auth",
      "not_found",
      "rate_limited",
      "invalid",
      "upstream",
      "upstream",
    ],
  );
});

Deno.test("relationsOf reads both ends; related falls back to lower id", () => {
  const task = {
    id: 10,
    related_tasks: {
      subtask: [{ id: 11, identifier: "#2" }],
      blocking: [{ id: 12, identifier: "#3" }],
      related: [{ id: 13, identifier: "#4" }, { id: 5, identifier: "#1" }],
      precedes: [{ id: 14, identifier: "#5" }],
    },
  };
  assertEquals(
    relationsOf(task, () => null).map((r) =>
      `${r.direction} ${r.type} ${r.issue}`
    ),
    [
      "incoming blocked_by 12",
      "outgoing parent_of 11",
      "incoming related_to 5",
      "outgoing related_to 13",
    ],
  );
  assertEquals(
    relationsOf(task, (id) => id === 13 ? { from: 13, to: 10 } : null)
      .find((r) => r.issue === "13")?.direction,
    "incoming",
  );
});

Deno.test("describe: vikunja, contract 1, assign only", async () => {
  const fake = new FakeVikunja();
  const h = harness(fake);
  h.ctx.globalArgs = { ...h.ctx.globalArgs, assignee: "sntxrr" } as never;
  await model.methods.describe.execute({}, h.ctx);
  assertEquals(h.records.get("description"), {
    tracker: "vikunja",
    contract: 1,
    origin: "snapshot",
    capabilities: { history: false, assign: true, pullRequests: false },
    closesDuplicates: false,
    assignee: "sntxrr",
  });
});

Deno.test("the contract's checks hold against the fake", async () => {
  const fake = new FakeVikunja();
  const { op } = harness(fake);
  await withFetch(fake, async () => {
    const ok = (a: Raw) => {
      assert(a.ok === true, JSON.stringify(a));
      return a.result as Raw;
    };
    const fails = (a: Raw, kind: string) =>
      assertEquals([a.ok, a.kind], [false, kind], JSON.stringify(a));

    // Create, then fetch by stable and display id.
    const issue = ok(
      await op("create", { title: "T", body: "Body *md*", type: "automation" }),
    );
    assertEquals(issue.labels, ["automation"]);
    assertEquals(issue.description, "Body *md*");
    assertEquals((issue.status as Raw).name, "Backlog");
    assertEquals(
      ok(await op("fetch_issue", { issue: issue.display })).id,
      issue.id,
    );
    fails(
      await op("create", { title: "T", body: "", type: "Nope" }),
      "invalid",
    );

    // Comment, read back by its id.
    const c = ok(await op("comment", { issue: issue.id, body: "conformance" }));
    const read = ok(await op("fetch_issue", { issue: issue.id }));
    assertEquals(
      (read.activity as Raw[]).map((a) => [a.kind, a.id, a.body]),
      [["comment", c.id, "conformance"]],
    );

    // Status: changed, then nothing; unknown lists the valid ones.
    assertEquals(
      ok(await op("set_status", { issue: issue.id, status: "doing" })),
      {
        changed: true,
        status: { id: "2", name: "Doing" },
      },
    );
    assertEquals(
      ok(await op("set_status", { issue: issue.id, status: "Doing" })).changed,
      false,
    );
    const bad = await op("set_status", { issue: issue.id, status: "Nope" });
    fails(bad, "invalid");
    assert(String(bad.detail).includes("Done"));

    // Missing tickets.
    fails(await op("fetch_issue", { issue: "999999" }), "not_found");
    fails(await op("comment", { issue: "999999", body: "x" }), "not_found");

    // Assign once.
    assertEquals(ok(await op("assign", { issue: issue.id, user: "sntxrr" })), {
      changed: true,
      user: "sntxrr",
      status: "Doing",
      dropped: [],
    });
    assertEquals(
      ok(await op("assign", { issue: issue.id, user: "sntxrr" })).changed,
      false,
    );
    fails(await op("assign", { issue: "999999", user: "sntxrr" }), "not_found");

    // Capabilities not offered are refused as invalid.
    fails(
      await op("link_pr", { issue: issue.id, url: "https://x" }),
      "invalid",
    );

    // Relations: each kind written, read on both ends, removed.
    const mk = async (title: string) =>
      ok(await op("create", { title, body: "", type: "automation" }));
    const [a, b, c2, d] = [
      await mk("A"),
      await mk("B"),
      await mk("C"),
      await mk("D"),
    ];
    const rels = async (t: Raw) =>
      (ok(await op("fetch_issue", { issue: t.id })).relations as Raw[])
        .map((r) => `${r.direction} ${r.type} ${r.issue}`).sort();
    for (
      const type of ["parent_of", "blocked_by", "related_to", "duplicate_of"]
    ) {
      // Relate from the higher id so related_to's fallback is not what passes.
      const [x, y] = [d, a];
      assertEquals(ok(await op("relate", { issue: x.id, type, to: y.id })), {
        changed: true,
      }, type);
      assertEquals(ok(await op("relate", { issue: x.id, type, to: y.id })), {
        changed: false,
      }, type);
      assertEquals(await rels(x), [`outgoing ${type} ${y.id}`], type);
      assertEquals(await rels(y), [`incoming ${type} ${x.id}`], type);
      assertEquals(ok(await op("unrelate", { issue: x.id, type, to: y.id })), {
        changed: true,
      }, type);
      assertEquals(ok(await op("unrelate", { issue: x.id, type, to: y.id })), {
        changed: false,
      }, type);
      assertEquals(await rels(x), [], type);
      assertEquals(await rels(y), [], type);
    }

    // The rules refuse as invalid and write nothing.
    const rel = (x: Raw, type: string, y: Raw) =>
      op("relate", { issue: x.id, type, to: y.id });
    fails(await rel(a, "related_to", a), "invalid");
    ok(await rel(a, "parent_of", b));
    ok(await rel(b, "parent_of", c2));
    fails(await rel(d, "parent_of", b), "invalid");
    fails(await rel(c2, "parent_of", a), "invalid");
    ok(await op("unrelate", { issue: b.id, type: "parent_of", to: c2.id }));
    ok(await op("unrelate", { issue: a.id, type: "parent_of", to: b.id }));
    ok(await rel(d, "duplicate_of", a));
    fails(await rel(d, "duplicate_of", b), "invalid");
    fails(await rel(c2, "duplicate_of", d), "invalid");
    fails(await rel(a, "duplicate_of", b), "invalid");
    ok(await op("unrelate", { issue: d.id, type: "duplicate_of", to: a.id }));
    for (const t of [a, b, c2, d]) assertEquals(await rels(t), []);
    fails(
      await op("relate", { issue: a.id, type: "related_to", to: "999999" }),
      "not_found",
    );
    fails(
      await op("relate", { issue: "999999", type: "related_to", to: a.id }),
      "not_found",
    );
    fails(
      await op("unrelate", { issue: a.id, type: "related_to", to: "999999" }),
      "not_found",
    );
  });
});

Deno.test("a task in another project is not_found", async () => {
  const fake = new FakeVikunja();
  const other = fake.seed({}, 5);
  const { op } = harness(fake);
  await withFetch(fake, async () => {
    const a = await op("fetch_issue", { issue: String(other) });
    assertEquals([a.ok, a.kind], [false, "not_found"]);
    const before = fake.calls.length;
    await op("comment", { issue: String(other), body: "x" });
    assert(
      !fake.calls.slice(before).some((c) => c.startsWith("PUT")),
      "nothing written to another project",
    );
  });
});

Deno.test("a bad token is an auth answer, and never in the answer", async () => {
  const fake = new FakeVikunja();
  const { op } = harness(fake, "tk_wrong_secret");
  await withFetch(fake, async () => {
    const a = await op("comment", { issue: "500", body: "x" });
    assertEquals([a.ok, a.kind], [false, "auth"]);
    assert(!JSON.stringify(a).includes("tk_wrong_secret"));
  });
});

Deno.test("a succeeded answer is never made again; a failed one is", async () => {
  const fake = new FakeVikunja();
  const id = fake.seed();
  const { ctx, records } = harness(fake);
  await withFetch(fake, async () => {
    const args = {
      operation: "comment",
      request: JSON.stringify({ issue: String(id), body: "once" }),
      answer: "answer-ledger-1",
      run: "r1",
    };
    await model.methods.operate.execute(args, ctx);
    await model.methods.operate.execute({ ...args, run: "r2" }, ctx);
    assertEquals(fake.comments.get(id)?.length, 1);
    assertEquals(records.get("answer-ledger-1")?.run, "r1");

    records.set("answer-ledger-2", { ok: false, kind: "upstream", run: "r1" });
    await model.methods.operate.execute(
      { ...args, answer: "answer-ledger-2", run: "r2" },
      ctx,
    );
    assertEquals(fake.comments.get(id)?.length, 2);
    assertEquals(records.get("answer-ledger-2")?.run, "r2");
  });
});

Deno.test("a request that is not a JSON object is an invalid answer", async () => {
  const fake = new FakeVikunja();
  const { op } = harness(fake);
  await withFetch(fake, async () => {
    for (const request of ["{nope", "[1]"]) {
      const a = await op("fetch_issue", request);
      assertEquals([a.ok, a.kind], [false, "invalid"]);
    }
  });
});

Deno.test("create rolls back a task whose type label fails to attach", async () => {
  const fake = new FakeVikunja();
  fake.failLabels = true;
  const { op } = harness(fake);
  await withFetch(fake, async () => {
    const a = await op("create", { title: "T", body: "", type: "automation" });
    assertEquals([a.ok, a.kind], [false, "upstream"]);
    assert(String(a.detail).includes("deleted again"), String(a.detail));
    assertEquals(fake.tasks.size, 0, "no half-made card left behind");
  });
});
