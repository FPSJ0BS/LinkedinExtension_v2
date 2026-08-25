/**
 * Message template persistence (TASK-0181).
 *
 * The store keeps templates in `chrome.storage.local` under one key rather than
 * in the IndexedDB database that holds the user's collected profiles and
 * applicants — that reasoning is written at the top of the file under test, and
 * asserted here only where it is observable: the key, and the fact that nothing
 * reaches for `chrome` until an operation actually runs.
 *
 * Everything runs against an in-memory storage adapter and an injected clock,
 * id source and validator. There is no Chrome and no jsdom in `npm test`, and
 * the validator lives in a file another surface owns — a test that waited for
 * either would be a test that cannot run.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Imported with no `document`, no `window` and no `chrome` defined. If the
// module touched any of them at load, this line alone would fail.
assert.equal(globalThis.chrome, undefined, "the suite runs with no chrome global");
await import("../src/template-store.js");
const TemplateStore = globalThis.ProfileVaultTemplateStore;

/**
 * Storage that behaves like `chrome.storage.local` in the one way that matters
 * here: what comes back out is a structured clone, not the array that went in.
 * A store that handed callers its own live array would pass every assertion
 * below while letting a caller mutate what is "stored".
 */
function fakeStorage(initialValue) {
  const bag = new Map();
  if (initialValue !== undefined) bag.set(TemplateStore.STORAGE_KEY, initialValue);
  return {
    bag,
    writes: 0,
    async get(key) {
      const value = bag.get(key);
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
    },
    async set(key, value) {
      this.writes += 1;
      bag.set(key, JSON.parse(JSON.stringify(value)));
    },
    stored() {
      return bag.get(TemplateStore.STORAGE_KEY);
    }
  };
}

/**
 * The documented contract of `ProfileVaultMessageTemplates.validateTemplate`,
 * standing in for it: a LIST of `{ field, code, message }`, never a boolean.
 * Only the rules this store's own behaviour depends on are modelled — required
 * fields and the case-insensitive uniqueness of a name — because the rest is
 * the other file's to assert, not this one's.
 */
function stubValidator(calls = []) {
  return function validateTemplate({ name, body, existingNames }) {
    calls.push({ name, body, existingNames });
    const problems = [];
    if (!name) problems.push({ field: "name", code: "name-required", message: "A name is required." });
    if (name && name.length > 80) {
      problems.push({ field: "name", code: "name-too-long", message: "80 characters at most." });
    }
    if (!body) problems.push({ field: "body", code: "body-required", message: "A body is required." });
    const taken = (existingNames || []).map((value) => String(value).toLowerCase());
    if (name && taken.includes(name.toLowerCase())) {
      problems.push({ field: "name", code: "name-duplicate", message: "That name is already used." });
    }
    return problems;
  };
}

/** A clock that ticks one whole second per call, so ordering is checkable. */
function fakeClock(start = 0) {
  let tick = start;
  return () => {
    tick += 1;
    return new Date(Date.UTC(2026, 0, 1, 0, 0, tick)).toISOString();
  };
}

function fakeIds() {
  let n = 0;
  return () => {
    n += 1;
    return `tpl-${n}`;
  };
}

function makeStore(overrides = {}) {
  const storage = overrides.storage || fakeStorage();
  const calls = [];
  const store = TemplateStore.createTemplateStore({
    storage,
    validate: overrides.validate || stubValidator(calls),
    now: overrides.now || fakeClock(),
    newId: overrides.newId || fakeIds()
  });
  return { store, storage, calls };
}

test("a saved template is created with an id, both timestamps and trimmed fields", async () => {
  const { store, storage } = makeStore();
  const saved = await store.save({ name: "  Intro   note ", body: "  Hi {{first_name}},\n\nWe liked your CV.  " });

  assert.equal(saved.id, "tpl-1");
  // The name is one line, so its internal run of spaces is collapsed. The body
  // is a message and keeps its newlines — only its ends are trimmed.
  assert.equal(saved.name, "Intro note");
  assert.equal(saved.body, "Hi {{first_name}},\n\nWe liked your CV.");
  assert.equal(saved.createdAt, "2026-01-01T00:00:01.000Z");
  assert.equal(saved.updatedAt, "2026-01-01T00:00:01.000Z");
  assert.deepEqual(storage.stored(), [saved]);
});

test("templates live in chrome.storage.local under one key, never in the profile database", async () => {
  const { store, storage } = makeStore();
  await store.save({ name: "One", body: "Body" });

  assert.equal(TemplateStore.STORAGE_KEY, "pv_message_templates");
  assert.deepEqual([...storage.bag.keys()], ["pv_message_templates"]);

  // The reasoning is load-bearing, not decorative: the next person to want a
  // template index will reach for IndexedDB unless the file says why not.
  const source = await readFile(resolve(root, "src/template-store.js"), "utf8");
  assert.match(source, /profile-table-collector/);
  assert.match(source, /version bump against a live database/);
  // Project rule: an export-free IIFE that works as a classic script too.
  assert.equal(/^\s*export\s/m.test(source), false, "no export keyword");
  assert.match(source, /globalThis\.ProfileVaultTemplateStore/);
});

test("saving with an existing id updates that record in place and keeps createdAt", async () => {
  const { store, storage } = makeStore();
  const first = await store.save({ name: "Intro", body: "First body" });
  const updated = await store.save({ id: first.id, name: "Intro v2", body: "Second body" });

  assert.equal(updated.id, first.id);
  assert.equal(updated.name, "Intro v2");
  assert.equal(updated.body, "Second body");
  assert.equal(updated.createdAt, first.createdAt, "createdAt survives an edit");
  assert.notEqual(updated.updatedAt, first.updatedAt, "updatedAt is restamped");
  assert.equal(storage.stored().length, 1, "an update is not a second record");
});

test("a template may be re-saved under its own name — it is not its own duplicate", async () => {
  const { store, calls } = makeStore();
  const first = await store.save({ name: "Intro", body: "Body" });
  await store.save({ name: "Follow up", body: "Body" });
  const edited = await store.save({ id: first.id, name: "Intro", body: "Edited body" });

  // The name of the record being edited is deliberately absent from the set the
  // validator checks uniqueness against; every OTHER name is present.
  assert.deepEqual(calls[2].existingNames, ["Follow up"]);
  assert.equal(edited.body, "Edited body");
});

test("list is newest first, by updatedAt, and an edit moves a template to the top", async () => {
  const { store } = makeStore();
  const a = await store.save({ name: "A", body: "a" });
  await store.save({ name: "B", body: "b" });
  await store.save({ name: "C", body: "c" });

  assert.deepEqual((await store.list()).map((record) => record.name), ["C", "B", "A"]);
  await store.save({ id: a.id, name: "A", body: "a edited" });
  assert.deepEqual((await store.list()).map((record) => record.name), ["A", "C", "B"]);
});

test("get answers with the record, and with null for an id nothing is stored under", async () => {
  const { store } = makeStore();
  const saved = await store.save({ name: "Intro", body: "Body" });

  assert.deepEqual(await store.get(saved.id), saved);
  assert.equal(await store.get("tpl-nope"), null);
  assert.equal(await store.get(""), null);
  assert.equal(await store.get(undefined), null);
});

test("remove deletes one template and answers false when there was nothing to remove", async () => {
  const { store, storage } = makeStore();
  const a = await store.save({ name: "A", body: "a" });
  await store.save({ name: "B", body: "b" });

  assert.equal(await store.remove(a.id), true);
  assert.deepEqual((await store.list()).map((record) => record.name), ["B"]);

  const before = storage.writes;
  assert.equal(await store.remove(a.id), false, "already gone");
  assert.equal(await store.remove(""), false);
  assert.equal(storage.writes, before, "a removal that removes nothing writes nothing");
});

test("a duplicate is named \"Name (copy)\", and the second copy is \"(copy 2)\"", async () => {
  const { store } = makeStore();
  const source = await store.save({ name: "Interview invite", body: "Hi {{first_name}}" });

  const first = await store.duplicate(source.id);
  assert.equal(first.name, "Interview invite (copy)");
  assert.equal(first.body, source.body, "the body is copied verbatim");
  assert.notEqual(first.id, source.id, "a copy is a new template, not a version");
  assert.equal(first.createdAt, first.updatedAt);

  const second = await store.duplicate(source.id);
  assert.equal(second.name, "Interview invite (copy 2)");

  // Copying the copy collides with nothing already taken, so it takes the first
  // free slot rather than stacking suffixes.
  const third = await store.duplicate(first.id);
  assert.equal(third.name, "Interview invite (copy) (copy)");
  assert.equal((await store.list()).length, 4);
});

test("a copy of a maximum-length name is shortened rather than refused for length", async () => {
  const { store } = makeStore();
  const longName = "N".repeat(TemplateStore.TEMPLATE_NAME_MAX);
  const source = await store.save({ name: longName, body: "Body" });

  const copy = await store.duplicate(source.id);
  assert.ok(copy.name.length <= TemplateStore.TEMPLATE_NAME_MAX, copy.name);
  assert.match(copy.name, /\(copy\)$/);
});

test("duplicate and rename refuse an id nothing is stored under, and say so as problems", async () => {
  const { store } = makeStore();
  await assert.rejects(() => store.duplicate("tpl-nope"), (error) => {
    assert.deepEqual(error.problems.map((problem) => problem.code), ["not-found"]);
    return true;
  });
  await assert.rejects(() => store.rename("tpl-nope", "New"), (error) => {
    assert.equal(error.problems[0].field, "id");
    return true;
  });
});

test("rename changes only the name", async () => {
  const { store } = makeStore();
  const saved = await store.save({ name: "Old", body: "Body stays" });
  const renamed = await store.rename(saved.id, "New");

  assert.equal(renamed.id, saved.id);
  assert.equal(renamed.name, "New");
  assert.equal(renamed.body, "Body stays");
  assert.equal(renamed.createdAt, saved.createdAt);
});

test("an invalid record is refused, carries the problems list, and writes nothing", async () => {
  const { store, storage } = makeStore();
  await store.save({ name: "Taken", body: "Body" });
  const writes = storage.writes;

  await assert.rejects(() => store.save({ name: "  ", body: "" }), (error) => {
    assert.ok(error instanceof Error);
    assert.deepEqual(error.problems.map((problem) => problem.code), ["name-required", "body-required"]);
    assert.match(error.message, /A name is required/);
    return true;
  });
  // Uniqueness is the validator's rule, and the store simply obeys the answer.
  await assert.rejects(() => store.save({ name: "taken", body: "Body" }), (error) => {
    assert.deepEqual(error.problems.map((problem) => problem.code), ["name-duplicate"]);
    return true;
  });
  assert.equal(storage.writes, writes, "a refused save never reaches storage");
  assert.equal((await store.list()).length, 1);
});

test("a warning is not a refusal — a save is blocked only by a problem without one", async () => {
  // The validator warns above 1900 characters and blocks above 8000. If this
  // store treated every entry in the list as blocking, the day the validator
  // starts returning warnings is the day long templates stop saving.
  const { store } = makeStore({
    validate: () => [{ field: "body", code: "body-long", message: "Longer than an InMail.", severity: "warning" }]
  });
  const saved = await store.save({ name: "Long", body: "x".repeat(2000) });
  assert.equal(saved.name, "Long");
});

test("nothing is saved when no validator can be reached", async () => {
  // Not injected here, and message-templates-core.js is not loaded by this
  // suite: an unvalidated template must not reach storage (rule 1).
  const storage = fakeStorage();
  const store = TemplateStore.createTemplateStore({ storage, now: fakeClock(), newId: fakeIds() });
  assert.equal(globalThis.ProfileVaultMessageTemplates, undefined);
  await assert.rejects(() => store.save({ name: "Intro", body: "Body" }), /message-templates-core/);
  assert.equal(storage.writes, 0);
});

test("a corrupt or absent stored value reads as an empty list rather than throwing", async () => {
  for (const stored of [undefined, null, "not json at all", 42, { name: "not a list" }, [], [null, 7, "x"]]) {
    const { store } = makeStore({ storage: fakeStorage(stored) });
    assert.deepEqual(await store.list(), [], `stored: ${JSON.stringify(stored)}`);
  }

  // An entry with no id cannot be updated, removed or told from its neighbours,
  // so it is dropped — and the entries around it still load.
  const { store } = makeStore({
    storage: fakeStorage([
      { id: "tpl-a", name: "Kept", body: "a", updatedAt: "2026-01-02T00:00:00.000Z" },
      { name: "No id", body: "b" },
      { id: "tpl-a", name: "Duplicate id", body: "c" }
    ])
  });
  assert.deepEqual((await store.list()).map((record) => record.name), ["Kept"]);
});

test("a value stored as a JSON string still reads, so no template is lost to the adapter", async () => {
  const raw = JSON.stringify([{ id: "tpl-a", name: "Intro", body: "Body", updatedAt: "2026-01-01T00:00:00.000Z" }]);
  const { store } = makeStore({ storage: fakeStorage(raw) });
  assert.deepEqual((await store.list()).map((record) => record.name), ["Intro"]);
});

test("a storage adapter that throws answers with an empty list, but a write still raises", async () => {
  // A messaging panel that opens empty beats one that cannot open. A WRITE is
  // different: swallowing the failure would put a fresh list over templates
  // that are still there, so it is allowed to throw.
  const broken = {
    async get() { throw new Error("storage unavailable"); },
    async set() { throw new Error("storage unavailable"); }
  };
  const store = TemplateStore.createTemplateStore({
    storage: broken,
    validate: stubValidator(),
    now: fakeClock(),
    newId: fakeIds()
  });
  assert.deepEqual(await store.list(), []);
  await assert.rejects(() => store.save({ name: "Intro", body: "Body" }), /storage unavailable/);
});

test("the chrome binding is deferred to call time, not resolved at import", async () => {
  // The module was imported at the top of this file with no `chrome` defined.
  // Building a store still works; only an operation looks for the global, which
  // is what lets this file be tested in Node at all.
  const store = TemplateStore.createTemplateStore();
  await assert.rejects(() => store.list(), /no storage adapter/);

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: [{ id: "tpl-a", name: "From chrome", body: "b", updatedAt: "2026-01-01T00:00:00.000Z" }] }; },
        async set() {}
      }
    }
  };
  try {
    assert.deepEqual((await store.list()).map((record) => record.name), ["From chrome"]);
  } finally {
    delete globalThis.chrome;
  }
});

test("createChromeStorage unwraps chrome's bag-in bag-out shape in one place", async () => {
  const seen = [];
  const area = {
    async get(key) { seen.push(["get", key]); return { [key]: ["value"] }; },
    async set(bag) { seen.push(["set", bag]); }
  };
  const adapter = TemplateStore.createChromeStorage(area);
  assert.deepEqual(await adapter.get("pv_message_templates"), ["value"]);
  await adapter.set("pv_message_templates", ["next"]);
  assert.deepEqual(seen, [
    ["get", "pv_message_templates"],
    ["set", { pv_message_templates: ["next"] }]
  ]);
  // A key that was never written comes back undefined, not a bag.
  const empty = TemplateStore.createChromeStorage({ async get() { return {}; }, async set() {} });
  assert.equal(await empty.get("pv_message_templates"), undefined);
});

test("an id that matches nothing stored is written under that id rather than re-keyed", async () => {
  // Restoring an exported template keeps its identity; the alternative is a
  // restore that silently becomes a different template.
  const { store } = makeStore();
  const saved = await store.save({ id: "tpl-from-export", name: "Restored", body: "Body" });
  assert.equal(saved.id, "tpl-from-export");
  assert.deepEqual(await store.get("tpl-from-export"), saved);
});
