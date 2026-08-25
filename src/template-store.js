/**
 * Persistence and CRUD for the recruiter's reusable message templates.
 *
 * WHY `chrome.storage.local` AND NOT IndexedDB — decided once, written down here
 * so nobody re-opens it. The IndexedDB database `profile-table-collector` holds
 * everything the user has actually collected: their saved profiles, their import
 * queue and every applicant record. Adding a template store to it means a schema
 * version bump against a live database that already carries that data, and a
 * failed upgrade there does not lose templates — it loses profiles. Rule 16 says
 * the database name never changes precisely because it preserves pre-3.0 data,
 * and templates are the wrong reason to take that risk. A template is small
 * config — a name and a body — with no relationship to a profile, no index to
 * query by and no migration history. `chrome.storage.local` carries all of it
 * under ONE key, `pv_message_templates`, and carries none of the migration risk.
 *
 * WHY A FACTORY OVER AN INJECTED ADAPTER. There is no jsdom and no Chrome in
 * `npm test`, so a module that reaches for the `chrome` global can only be read,
 * never executed. `createTemplateStore({ storage })` takes its storage the same
 * way [collector-tabs-core.js](./collector-tabs-core.js) takes its Chrome APIs:
 * the extension injects the real thing, the tests inject a Map. The default
 * binding to `chrome.storage.local` is resolved at CALL time and never at load,
 * so this file imports cleanly under Node with no DOM and no `chrome` global.
 *
 * WHY VALIDATION IS NOT DONE HERE. Every rule about what a template may contain
 * lives in `ProfileVaultMessageTemplates.validateTemplate`, and this file only
 * refuses what that validator rejects. One validator, asked by the store on the
 * way in and by the UI while the user types, is the only way the two can agree.
 * It is resolved at call time too — an injected `validate` wins, otherwise the
 * loaded core — and a store with no validator reachable REFUSES TO WRITE rather
 * than storing something nothing checked. That is rule 1 at the storage layer: a
 * wrong template is worse than a missing one.
 *
 * Export-free IIFE assigning `globalThis.ProfileVaultTemplateStore`, per the
 * project rule: it must load as a classic content script, as an ESM side-effect
 * import, and under Node's `await import()`. It touches no `document`, no
 * `window` and no `chrome` at load.
 */

(() => {
  "use strict";

  /** The one key every template lives under. Changing it orphans them all. */
  const STORAGE_KEY = "pv_message_templates";

  /** Mirrors the validator's own ceiling; used to keep a copy's name legal. */
  const TEMPLATE_NAME_MAX = 80;

  /** A name is one line, so its internal whitespace is collapsed. */
  function oneLine(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  /**
   * A body keeps its newlines — it is a message — so only the ends are trimmed.
   */
  function trimBody(value) {
    return String(value ?? "").trim();
  }

  function lower(value) {
    return oneLine(value).toLowerCase();
  }

  /**
   * One stored entry, or null when it is not a template at all.
   *
   * An id is the only field that cannot be repaired: without it the record
   * cannot be updated, removed or told apart from its neighbours, so an entry
   * missing one is dropped rather than guessed at.
   */
  function toRecord(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = String(value.id ?? "").trim();
    if (!id) return null;
    return {
      id,
      name: oneLine(value.name),
      body: typeof value.body === "string" ? value.body : String(value.body ?? ""),
      createdAt: String(value.createdAt ?? ""),
      updatedAt: String(value.updatedAt ?? "")
    };
  }

  /**
   * Whatever was stored, read as a list of templates — never throwing.
   *
   * A key that was never written, a value some older build left behind, a value
   * hand-edited into nonsense: all of them are "no templates yet". Throwing here
   * would take the whole messaging UI down over one bad value, and there is
   * nothing to recover from a value that is not a list of records anyway. A JSON
   * string is tried once because a build that wrote through a stringifying
   * adapter would otherwise look empty.
   */
  function parseTemplates(value) {
    let source = value;
    if (typeof source === "string") {
      try {
        source = JSON.parse(source);
      } catch {
        return [];
      }
    }
    if (!Array.isArray(source)) return [];
    const out = [];
    const seen = new Set();
    for (const entry of source) {
      const record = toRecord(entry);
      if (!record || seen.has(record.id)) continue;
      seen.add(record.id);
      out.push(record);
    }
    return out;
  }

  /**
   * Newest first. `id` breaks ties so two templates saved in the same
   * millisecond still have one definite order rather than whatever the stored
   * array happened to hold — the same reason `getAllApplicants` tie-breaks.
   */
  function byRecency(records) {
    return [...records].sort((a, b) =>
      String(b.updatedAt).localeCompare(String(a.updatedAt))
      || String(a.id).localeCompare(String(b.id)));
  }

  /** Keep `base + suffix` inside the validator's name ceiling. */
  function fitName(base, suffix) {
    if (base.length + suffix.length <= TEMPLATE_NAME_MAX) return base + suffix;
    return base.slice(0, Math.max(0, TEMPLATE_NAME_MAX - suffix.length)).trim() + suffix;
  }

  /**
   * "Name (copy)", then "Name (copy 2)", "Name (copy 3)" — the first one nobody
   * is already using, compared case-insensitively because the validator's
   * uniqueness rule is case-insensitive and a name it would refuse is no use.
   */
  function nextCopyName(name, existingNames = []) {
    const taken = new Set((existingNames || []).map(lower));
    const base = oneLine(name) || "Template";
    for (let n = 1; n <= 1000; n += 1) {
      const candidate = fitName(base, n === 1 ? " (copy)" : ` (copy ${n})`);
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    throw problemError([
      { field: "name", code: "name-duplicate", message: `No free copy name for "${base}".` }
    ]);
  }

  /** The one error shape the UI reads: a message to show, problems to show inline. */
  function problemError(problems) {
    const list = (Array.isArray(problems) ? problems : []).filter(Boolean);
    const error = new Error(
      list.map((problem) => problem.message || problem.code).filter(Boolean).join("; ")
      || "The template was refused."
    );
    error.problems = list;
    return error;
  }

  function notFound(id) {
    return problemError([
      { field: "id", code: "not-found", message: `No template with id "${id}".` }
    ]);
  }

  /** The real clock, replaced in tests so a timestamp can be asserted at all. */
  function defaultNow() {
    return new Date().toISOString();
  }

  let fallbackIdCounter = 0;

  /**
   * A real id source. `crypto.randomUUID` where it exists — every surface this
   * runs on has it — and a monotonic counter beside the clock otherwise, so two
   * ids minted in the same millisecond still differ. Tests inject their own,
   * which is the only way an assertion on an id can be deterministic.
   */
  function defaultId() {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") return `tpl-${cryptoApi.randomUUID()}`;
    fallbackIdCounter += 1;
    return `tpl-${Date.now().toString(36)}-${fallbackIdCounter.toString(36)}`;
  }

  /**
   * `chrome.storage.local` as the simple `get(key)` / `set(key, value)` adapter
   * this store speaks. Chrome's own shape is a bag in and a bag out; unwrapping
   * it in one place keeps every caller and every test on one interface.
   */
  function createChromeStorage(area) {
    return {
      async get(key) {
        const bag = await area.get(key);
        return bag ? bag[key] : undefined;
      },
      async set(key, value) {
        await area.set({ [key]: value });
      }
    };
  }

  /** Resolved at CALL time — this file must import with no `chrome` in sight. */
  function chromeLocalStorage() {
    const local = globalThis.chrome?.storage?.local;
    return local ? createChromeStorage(local) : null;
  }

  /**
   * The store.
   *
   * `options.storage`  async get(key) / set(key, value). Defaults to
   *                    chrome.storage.local, resolved when an operation runs.
   * `options.validate` validateTemplate({ name, body, existingNames }) -> problems[].
   *                    Defaults to the loaded message-templates core.
   * `options.now`      () -> ISO timestamp string.
   * `options.newId`    () -> a fresh template id.
   */
  function createTemplateStore(options = {}) {
    const injectedStorage = options.storage || null;
    const injectedValidate = typeof options.validate === "function" ? options.validate : null;
    const now = typeof options.now === "function" ? options.now : defaultNow;
    const newId = typeof options.newId === "function" ? options.newId : defaultId;

    function storage() {
      if (injectedStorage) return injectedStorage;
      const bound = chromeLocalStorage();
      if (bound) return bound;
      throw new Error(
        "template-store: no storage adapter — pass { storage } or run where chrome.storage.local exists"
      );
    }

    function validator() {
      if (injectedValidate) return injectedValidate;
      const core = globalThis.ProfileVaultMessageTemplates;
      if (core && typeof core.validateTemplate === "function") return core.validateTemplate;
      throw new Error(
        "template-store: message-templates-core.js is not loaded, so nothing can be validated and nothing is saved"
      );
    }

    /**
     * The stored list, for a write.
     *
     * A corrupt VALUE degrades to an empty list, but a storage adapter that
     * THROWS is allowed to throw: swallowing it here would let the next `set`
     * write a fresh list over templates that are still there.
     */
    async function readForWrite() {
      return parseTemplates(await storage().get(STORAGE_KEY));
    }

    async function write(records) {
      await storage().set(STORAGE_KEY, records);
    }

    function refuseIfInvalid(result) {
      const problems = (Array.isArray(result) ? result : []).filter(Boolean);
      // A validator that grows severities later (the body-length WARNING above
      // 1900 characters is not a refusal) must not start blocking saves. An
      // entry with no severity is a problem, which is the documented contract.
      const blocking = problems.filter((problem) => problem.severity !== "warning");
      if (blocking.length) throw problemError(problems);
      return problems;
    }

    function mintId(records) {
      const taken = new Set(records.map((record) => record.id));
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const id = String(newId() ?? "").trim();
        if (id && !taken.has(id)) return id;
      }
      throw new Error("template-store: the injected id source produced no unused id");
    }

    /**
     * Every template, newest first.
     *
     * The one read that never throws over a value: an unreadable store answers
     * "no templates", because a messaging panel that cannot open is worse than
     * one that opens empty. A missing storage adapter is a wiring bug, not a
     * value, and is still raised.
     */
    async function list() {
      const target = storage();
      let raw;
      try {
        raw = await target.get(STORAGE_KEY);
      } catch {
        return [];
      }
      return byRecency(parseTemplates(raw));
    }

    async function get(id) {
      const wanted = String(id ?? "").trim();
      if (!wanted) return null;
      const records = await list();
      return records.find((record) => record.id === wanted) || null;
    }

    /**
     * Create when there is no id, update when there is.
     *
     * An id that matches nothing stored is written under that id rather than
     * re-keyed, so restoring an exported template keeps its identity.
     * `createdAt` survives every update; `updatedAt` is restamped, and it is
     * what `list()` orders by.
     */
    async function save(input) {
      const records = await readForWrite();
      const wantedId = String(input?.id ?? "").trim();
      const index = wantedId ? records.findIndex((record) => record.id === wantedId) : -1;
      const existing = index >= 0 ? records[index] : null;
      const name = oneLine(input?.name);
      const body = trimBody(input?.body);
      // The record being edited is not its own duplicate, so its name is not in
      // the set the validator checks uniqueness against.
      const existingNames = records
        .filter((record) => record.id !== wantedId)
        .map((record) => record.name);
      refuseIfInvalid(validator()({ name, body, existingNames }));

      const stamp = String(now());
      const record = {
        id: wantedId || mintId(records),
        name,
        body,
        createdAt: existing?.createdAt || stamp,
        updatedAt: stamp
      };
      const next = index >= 0
        ? records.map((entry, at) => (at === index ? record : entry))
        : [...records, record];
      await write(next);
      return record;
    }

    /** True when something was removed, false when there was nothing to remove. */
    async function remove(id) {
      const wanted = String(id ?? "").trim();
      if (!wanted) return false;
      const records = await readForWrite();
      const next = records.filter((record) => record.id !== wanted);
      if (next.length === records.length) return false;
      await write(next);
      return true;
    }

    /** Rename in place — the body, and `createdAt`, are untouched. */
    async function rename(id, name) {
      const wanted = String(id ?? "").trim();
      const existing = await get(wanted);
      if (!existing) throw notFound(wanted);
      return save({ id: existing.id, name, body: existing.body });
    }

    /**
     * A copy, under a name nobody is using. The copy is a new template with its
     * own id and its own `createdAt` — it is not a version of the original.
     */
    async function duplicate(id) {
      const wanted = String(id ?? "").trim();
      const records = await readForWrite();
      const source = records.find((record) => record.id === wanted);
      if (!source) throw notFound(wanted);
      const name = nextCopyName(source.name, records.map((record) => record.name));
      return save({ name, body: source.body });
    }

    return { list, get, save, remove, rename, duplicate };
  }

  globalThis.ProfileVaultTemplateStore = {
    STORAGE_KEY,
    TEMPLATE_NAME_MAX,
    parseTemplates,
    nextCopyName,
    createChromeStorage,
    createTemplateStore
  };
})();
