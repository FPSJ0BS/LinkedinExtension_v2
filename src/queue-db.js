// Thin IndexedDB persistence adapter for the import queue.
// All decision logic lives in import-queue-core.js; this module only loads and
// stores `{ items, session }` so the queue survives popup closure, service-worker
// suspension, tab reloads, and browser restarts.

import { QUEUE_STORE, SESSION_STORE, requestAsPromise, withNamedStore } from "./db.js";
import { createItem, createSession } from "./import-queue-core.js";

export async function loadItems() {
  const raw = await withNamedStore(QUEUE_STORE, "readonly", (store) => requestAsPromise(store.getAll()));
  return (raw || [])
    // Rows written by an earlier release predate newer fields such as
    // lastCollectedAt, so every row is filled out against the current shape.
    .map((item) => ({ ...createItem(item?.url || "", item?.addedAt || ""), ...item }))
    .filter((item) => item.url)
    .sort((left, right) => String(left.addedAt).localeCompare(String(right.addedAt)));
}

export async function loadSession() {
  const raw = await withNamedStore(SESSION_STORE, "readonly", (store) => requestAsPromise(store.get("session")));
  return raw ? { ...createSession(), ...raw } : createSession();
}

export async function loadState() {
  const [items, session] = await Promise.all([loadItems(), loadSession()]);
  return { items, session };
}

export async function saveSession(session) {
  const record = { ...createSession(), ...session, key: "session" };
  await withNamedStore(SESSION_STORE, "readwrite", (store) => requestAsPromise(store.put(record)));
  return record;
}

export async function saveItems(items) {
  await withNamedStore(QUEUE_STORE, "readwrite", async (store) => {
    for (const item of items || []) await requestAsPromise(store.put(item));
  });
  return items;
}

/**
 * Phase 28: write a single queue row.
 * The orchestrator uses this instead of rewriting the whole queue after every
 * profile, so a multi-thousand-entry queue costs one write per state change.
 */
export async function putItem(item) {
  if (!item?.url) return null;
  await withNamedStore(QUEUE_STORE, "readwrite", (store) => requestAsPromise(store.put(item)));
  return item;
}

export async function countItems() {
  return withNamedStore(QUEUE_STORE, "readonly", (store) => requestAsPromise(store.count()));
}

/** Replace the whole queue with `items`, deleting rows that are no longer present. */
export async function replaceItems(items) {
  const keep = new Set((items || []).map((item) => item.url));
  await withNamedStore(QUEUE_STORE, "readwrite", async (store) => {
    const existing = await requestAsPromise(store.getAllKeys());
    for (const key of existing || []) {
      if (!keep.has(key)) await requestAsPromise(store.delete(key));
    }
    for (const item of items || []) await requestAsPromise(store.put(item));
  });
  return items;
}

export async function saveState(state) {
  await replaceItems(state.items || []);
  await saveSession(state.session || createSession());
  return state;
}

export async function clearItems() {
  await withNamedStore(QUEUE_STORE, "readwrite", (store) => requestAsPromise(store.clear()));
}
