import test from "node:test";
import assert from "node:assert/strict";

await import("../src/message-queue-core.js");
const Queue = globalThis.ProfileVaultMessageQueue;
const { QUEUE_STATE, RECIPIENT_STATE, QUEUE_LIMITS } = Queue;

function people(count, from = 1) {
  return Array.from({ length: count }, (_, index) => ({
    id: `r${index + from}`,
    name: `Person ${index + from}`,
    profileUrl: `/in/person-${index + from}`,
    text: `Hi Person ${index + from}, about the role.`
  }));
}

/** Drive a whole run: open, fill, and have the user send, honouring every wait. */
function runToCompletion(queue, { clock = 0, maxSteps = 10000, onAwait = "send" } = {}) {
  let now = clock;
  let steps = 0;
  for (;;) {
    if (steps++ > maxSteps) throw new Error("the queue did not terminate");
    const step = Queue.planQueueStep({ queue, now });
    if (step.action === "done" || step.action === "stop") return { step, now, steps };
    if (step.action === "wait") { now += Math.max(1, step.waitMs || 1); continue; }
    if (step.action === "open") { Queue.markOpening(queue, step.recipient.id); continue; }
    if (step.action === "await-open") { Queue.markAwaitingSend(queue, step.step?.id || activeId(queue)); continue; }
    if (step.action === "await-send") {
      if (onAwait === "send") Queue.markSent(queue, step.recipient.id, now);
      else Queue.markSkipped(queue, step.recipient.id);
      continue;
    }
    throw new Error(`unknown action ${step.action}`);
  }
}

function activeId(queue) {
  return Queue.activeEntry(queue)?.id || "";
}

test("the queue never leaves `awaiting-send` on its own — only the user's send or skip moves it", () => {
  // THE PROPERTY THE WHOLE FEATURE RESTS ON. There is deliberately no transition
  // out of AWAITING_SEND that this file can take by itself: not a timeout, not a
  // retry, not the planner. `markSent` and `markSkipped` are both reports of
  // something a human did. If a future change adds an automatic escape from this
  // state, that change has made the extension send messages, and this test is
  // where it should fail.
  const queue = Queue.createMessageQueue({ recipients: people(1) });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");

  // Ask the planner repeatedly across a long stretch of time. It must keep
  // answering "still waiting for the user" and never advance past this person.
  for (const now of [0, 1000, 60000, 3600000, 86400000 * 3]) {
    const step = Queue.planQueueStep({ queue, now });
    assert.equal(step.action, "await-send", `still waiting at ${now}ms`);
    assert.equal(step.recipient.id, "r1");
  }
  assert.equal(Queue.describeQueue(queue).sent, 0, "and nothing was ever marked sent");
});

test("only one person is ever open, so a message cannot reach the wrong composer", () => {
  const queue = Queue.createMessageQueue({ recipients: people(3) });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");

  // Even with two others pending and no rate limit owed, the planner refuses to
  // start anybody while one is open. Two open composers is exactly how a message
  // ends up addressed to the previous person.
  const step = Queue.planQueueStep({ queue, now: 999999 });
  assert.equal(step.action, "await-send");
  assert.equal(step.recipient.id, "r1");
  assert.equal(Queue.activeEntry(queue).id, "r1", "and there is exactly one active entry");
});

test("a person in a terminal state is never offered again, so nobody is messaged twice", () => {
  const queue = Queue.createMessageQueue({ recipients: people(2) });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");
  Queue.markSent(queue, "r1", 1000);

  // Re-marking a settled person changes nothing, whichever way it is attempted.
  assert.equal(Queue.markOpening(queue, "r1"), false, "cannot re-open a sent recipient");
  assert.equal(Queue.markAwaitingSend(queue, "r1"), false);
  assert.equal(Queue.markSent(queue, "r1", 2000), false);
  assert.equal(Queue.markSkipped(queue, "r1"), false);
  assert.equal(Queue.describeQueue(queue).sent, 1, "still exactly one send");
});

test("a duplicate id in the input is one recipient, so two concatenated lists cannot double-message", () => {
  const queue = Queue.createMessageQueue({ recipients: [...people(2), ...people(2)] });
  assert.equal(queue.entries.length, 2);
  assert.deepEqual(queue.entries.map((entry) => entry.id), ["r1", "r2"]);
});

test("a recipient with no text is refused at creation, not discovered with a composer open", () => {
  const queue = Queue.createMessageQueue({
    recipients: [{ id: "r1", name: "A", text: "" }, { id: "r2", name: "B", text: "Hi B" }]
  });
  const empty = queue.entries.find((entry) => entry.id === "r1");
  assert.equal(empty.state, RECIPIENT_STATE.FAILED);
  assert.equal(empty.reason, "empty-message");
  assert.equal(Queue.planQueueStep({ queue, now: 0 }).recipient.id, "r2", "and the walk goes straight to the next");
});

test("Stop ends the run at once and is never resumable — rule 12", () => {
  const queue = Queue.createMessageQueue({ recipients: people(5) });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");

  assert.equal(Queue.stopQueue(queue), true);
  assert.equal(queue.state, QUEUE_STATE.STOPPED);
  // Stop beats every other reason the queue might have to continue, including
  // somebody being mid-flight.
  assert.equal(Queue.planQueueStep({ queue, now: 0 }).action, "stop");
  assert.equal(Queue.resumeQueue(queue), false, "a stopped queue cannot be resumed");
  assert.equal(Queue.markSent(queue, "r1", 1), false, "and nothing can still be sent through it");
});

test("Stop records the person left mid-flight rather than abandoning them silently", () => {
  // Stop ends work; it never discards what the work produced. Somebody whose
  // composer was open when the user stopped is a fact worth showing.
  const queue = Queue.createMessageQueue({ recipients: people(3) });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");
  Queue.stopQueue(queue);

  const entry = queue.entries.find((candidate) => candidate.id === "r1");
  assert.equal(entry.state, RECIPIENT_STATE.SKIPPED);
  assert.equal(entry.reason, "stopped-while-open");
});

test("the gap is measured from the user's last send, and an idle queue owes no wait", () => {
  const queue = Queue.createMessageQueue({ recipients: people(2), limits: { minGapMs: 30000 } });
  // Nothing sent yet: the first person may be opened immediately.
  assert.equal(Queue.planQueueStep({ queue, now: 0 }).action, "open");

  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");
  Queue.markSent(queue, "r1", 10000);

  const tooSoon = Queue.planQueueStep({ queue, now: 20000 });
  assert.equal(tooSoon.action, "wait");
  assert.equal(tooSoon.reason, "rate-limited");
  assert.equal(tooSoon.waitMs, 20000, "and it says exactly how long is owed");

  assert.equal(Queue.planQueueStep({ queue, now: 40000 }).action, "open", "once the gap has passed");
});

test("the gap cannot be set to zero, because a queue with no floor is what the limit exists to prevent", () => {
  assert.equal(Queue.clampGap(0), QUEUE_LIMITS.MIN_ALLOWED_GAP_MS);
  assert.equal(Queue.clampGap(-5000), QUEUE_LIMITS.MIN_ALLOWED_GAP_MS);
  assert.equal(Queue.clampGap("nonsense"), QUEUE_LIMITS.MIN_GAP_MS);
  assert.equal(Queue.clampGap(60000), 60000, "a longer gap than the default is honoured");
  assert.equal(Queue.clampCap(0), QUEUE_LIMITS.DAILY_CAP);
  assert.equal(Queue.clampCap(99999), QUEUE_LIMITS.MAX_DAILY_CAP, "and the cap has a ceiling of its own");
});

test("the daily cap stops the run, and it counts a rolling day rather than a calendar one", () => {
  const queue = Queue.createMessageQueue({ recipients: people(5), limits: { minGapMs: 5000, dailyCap: 3 } });
  let now = 0;
  for (const id of ["r1", "r2", "r3"]) {
    Queue.markOpening(queue, id);
    Queue.markAwaitingSend(queue, id);
    Queue.markSent(queue, id, now);
    now += 5000;
  }
  const capped = Queue.planQueueStep({ queue, now });
  assert.equal(capped.action, "stop");
  assert.equal(capped.reason, "daily-cap-reached");
  assert.equal(capped.remaining, 2, "and it says how many were left");

  // A day later those sends have rolled out of the window and the rest may go.
  assert.equal(Queue.planQueueStep({ queue, now: now + 24 * 60 * 60 * 1000 + 1 }).action, "open");
});

test("a person who cannot be opened is retried, then failed — and cannot spend anybody else's allowance", () => {
  const queue = Queue.createMessageQueue({ recipients: people(2), limits: { minGapMs: 5000 } });

  Queue.markOpening(queue, "r1");
  Queue.markFailed(queue, "r1", "no-composer");
  assert.equal(queue.entries[0].state, RECIPIENT_STATE.PENDING, "first failure returns them to the queue");

  Queue.markOpening(queue, "r1");
  Queue.markFailed(queue, "r1", "no-composer");
  assert.equal(queue.entries[0].state, RECIPIENT_STATE.FAILED, "the second exhausts their own allowance");
  assert.equal(queue.entries[0].reason, "no-composer", "and the reason is kept");

  assert.equal(queue.entries[1].attempts, 0, "the next person's allowance is untouched");
  assert.equal(Queue.planQueueStep({ queue, now: 0 }).recipient.id, "r2");
});

test("every recipient ends in exactly one terminal state, and the run terminates", () => {
  // Drives the whole machine rather than asserting about it: forty people, a
  // real gap, every send honoured. If any path could loop or strand somebody,
  // this either never returns or leaves a non-terminal entry behind.
  const queue = Queue.createMessageQueue({
    recipients: people(40),
    limits: { minGapMs: 30000, dailyCap: 200 }
  });
  const { step } = runToCompletion(queue);
  assert.equal(step.action, "done");
  assert.equal(queue.entries.length, 40);
  for (const entry of queue.entries) {
    assert.ok(Queue.isTerminalRecipient(entry.state), `${entry.id} settled`);
  }
  assert.equal(Queue.describeQueue(queue).sent, 40);
});

test("a run where the user skips everybody still terminates, and sends nothing", () => {
  const queue = Queue.createMessageQueue({ recipients: people(12), limits: { minGapMs: 30000 } });
  const { step } = runToCompletion(queue, { onAwait: "skip" });
  assert.equal(step.action, "done");
  const summary = Queue.describeQueue(queue);
  assert.equal(summary.sent, 0);
  assert.equal(summary.skipped, 12);
});

test("pause holds the walk without ending it, and resume picks up where it stopped", () => {
  const queue = Queue.createMessageQueue({ recipients: people(3) });
  assert.equal(Queue.pauseQueue(queue), true);
  assert.equal(Queue.planQueueStep({ queue, now: 0 }).reason, "paused");
  assert.equal(Queue.resumeQueue(queue), true);
  assert.equal(Queue.planQueueStep({ queue, now: 0 }).action, "open");
});

test("an empty queue is done rather than running, and asking it for a step is safe", () => {
  const queue = Queue.createMessageQueue({ recipients: [] });
  assert.equal(queue.state, QUEUE_STATE.DONE);
  assert.equal(Queue.planQueueStep({ queue, now: 0 }).action, "done");
  assert.equal(Queue.planQueueStep({ queue: null, now: 0 }).action, "stop");
});

test("the summary counts every state, so the UI never has to derive one", () => {
  const queue = Queue.createMessageQueue({ recipients: people(4), limits: { minGapMs: 1000 } });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");
  Queue.markSent(queue, "r1", 1000);
  Queue.markSkipped(queue, "r2");
  Queue.markOpening(queue, "r3");
  Queue.markFailed(queue, "r3", "x");
  Queue.markOpening(queue, "r3");
  Queue.markFailed(queue, "r3", "x");

  const summary = Queue.describeQueue(queue, 1000);
  assert.equal(summary.total, 4);
  assert.equal(summary.sent, 1);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.remaining, 1);
  assert.equal(summary.sentToday, 1);
});

test("the core is a DOM-free, export-free IIFE like every other core in this repo", async () => {
  const { readFile } = await import("node:fs/promises");
  const { resolve, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const source = await readFile(resolve(root, "src/message-queue-core.js"), "utf8");
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  assert.ok(!/^\s*export\s/m.test(withoutComments), "no export keyword");
  assert.ok(!/\bdocument\b/.test(withoutComments), "no document");
  assert.ok(!/\bwindow\b/.test(withoutComments), "no window");
  assert.ok(!/\bchrome\b/.test(withoutComments), "no chrome");
  // It holds no clock of its own: `now` is always passed in, which is what lets
  // a test drive a whole day of rate limiting in a millisecond.
  assert.ok(!/Date\.now\(\)/.test(withoutComments), "no clock of its own");
  assert.ok(!/setTimeout|setInterval/.test(withoutComments), "and no timers");
});
