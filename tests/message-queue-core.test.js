import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

await import("../src/message-queue-core.js");
const Queue = globalThis.ProfileVaultMessageQueue;
const { QUEUE_STATE, RECIPIENT_STATE, QUEUE_LIMITS } = Queue;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFile(resolve(root, file), "utf8");

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

test("the queue never leaves `awaiting-send` on its own — only a reported send or skip moves it", () => {
  // THE PROPERTY THE WHOLE FEATURE RESTS ON, and it survived the feature
  // changing under it. There is deliberately no transition out of AWAITING_SEND
  // that this file can take by itself: not a timeout, not a retry, not the
  // planner. `markSent` and `markSkipped` are both REPORTS OF AN OBSERVATION
  // made elsewhere, never a conclusion this file reached.
  //
  // WHAT CHANGED IN 3.14.0 IS ONLY WHO OBSERVES. Until then `markSent` meant
  // "the user pressed Send"; now the adapter presses it, and `markSent` means
  // "the adapter pressed Send AND WATCHED THE MESSAGE GO" — the composer emptied
  // and an outgoing message appeared. Pressing alone is still not a send and is
  // still not a route into this state's exit; see the adapter-contract test
  // below, which is where that half is held.
  //
  // The mechanical assertion is untouched by any of that, and it is the one that
  // matters: if a future change adds an automatic escape from this state — a
  // timeout that assumes the send landed, a retry that re-opens somebody
  // mid-flight — that change has made the extension send messages nobody
  // watched, and this test is where it should fail.
  const queue = Queue.createMessageQueue({ recipients: people(1) });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");

  // Ask the planner repeatedly across a long stretch of time. It must keep
  // answering "still waiting to be told" and never advance past this person.
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

// ================================================ the adapter contract (3.14.0)
//
// The queue engine above is pure and cannot know whether a message went. It is
// TOLD, by the worker, which is told by the content script. So the half of the
// safety argument the engine cannot hold lives in `src/background.ts`, and these
// tests hold it there — the same way tests/universal-stop.test.js holds Stop
// against the worker rather than against a comment about Stop.
//
// The property: **there is no route from "Send was pressed" to `sent`.** Only an
// observation gets there. Pressing is an action, a message going is an outcome,
// and a person wrongly marked sent is a person who never gets their message and
// nobody ever finds out.

/** Everything the worker does with one recipient, in source order. */
async function observationBranch() {
  const worker = await read("src/background.ts");
  const from = worker.indexOf("function applyMessageObservation");
  const to = worker.indexOf("function adoptMessageRunControl");
  assert.ok(from > 0 && to > from, "the worker must translate an observation into a transition");
  return worker.slice(from, to);
}

test("pressing Send is not a route to SENT — only an observation the adapter made is", async () => {
  const worker = await read("src/background.ts");

  // `markSent` is reachable from exactly ONE place in the entire worker. Not a
  // convenience, a guarantee: a second call site is a second definition of what
  // "sent" means, and only one of them would be the one with the observation
  // check in front of it.
  assert.equal(
    (worker.match(/MessageQueue\.markSent\(/g) || []).length,
    1,
    "markSent must have exactly one call site in the worker"
  );

  const apply = await observationBranch();

  // The observation is a STRICT literal `true`. Absent, `undefined`, `"yes"` and
  // a truthy object are all "did not go", because the only reading of this field
  // that is safe is the one that requires the adapter to have looked.
  assert.match(apply, /const observed = reply\.observedSent === true;/, "observedSent must be compared strictly");
  assert.match(apply, /const pressed = reply\.pressed === true;/, "and so must pressed");

  // And the single call site is guarded by BOTH the observation and the
  // read-back verification of the composer.
  assert.match(
    apply,
    /if \(verified && observed\) \{\s*MessageQueue\.markSent\(/,
    "markSent must be guarded by `verified && observed` and nothing weaker"
  );

  // The composer verification is all four facts, not any of them.
  for (const proof of [
    "reply.ok === true",
    "reply.opened === true",
    "reply.identityConfirmed === true",
    "reply.filled === true"
  ]) {
    assert.ok(apply.includes(proof), `the composer must be proven by ${proof}`);
  }
  assert.match(apply, /messageTextMatches\(recipient\?\.text, reply\.readBack\)/, "and by a read-back of the approved text");
});

test("a pressed-but-unconfirmed send is terminal — never sent, and never retried", async () => {
  const apply = await observationBranch();

  // `markFailed` returns somebody to the queue to be opened again. Opening again
  // somebody whose Send may already have gone is the double-message this whole
  // design exists to make impossible, so an ambiguous outcome must be terminal.
  const pressedBranch = apply.slice(apply.indexOf("if (pressed || observed)"));
  assert.ok(pressedBranch.length > 0, "a pressed-without-observation branch must exist");
  const skipAt = pressedBranch.indexOf("MessageQueue.markSkipped");
  const failAt = pressedBranch.indexOf("MessageQueue.markFailed");
  assert.ok(skipAt > 0, "it must settle them terminally with markSkipped");
  assert.ok(failAt < 0 || failAt > skipAt, "and must not reach the retrying markFailed first");
  assert.match(pressedBranch, /pressed-but-not-confirmed/, "with a reason that names the doubt");

  // An observation with no verified composer is worse, not better: something
  // went somewhere, and we cannot say it was this text to this person.
  assert.match(apply, /sent-to-an-unverified-composer/, "an unverified send is recorded as one, not as a send");

  // A missing reply is "we do not know", not "it failed". Same terminal
  // treatment, different reason.
  assert.match(apply, /markSkipped\(queue, id, cleanRunReason\(reply\?\.error\) \|\| "no-observation"\)/, "a silent adapter settles the person terminally");
  assert.match(apply, /markSkipped\(queue, id, "identity-mismatch"\)/, "and so does a reply about somebody else");

  // `markFailed` — the retrying one — is reachable only past every one of those,
  // which is the definition of an evidenced non-send.
  const failIndex = apply.indexOf("MessageQueue.markFailed");
  assert.ok(failIndex > apply.indexOf("if (pressed || observed)"), "markFailed is the last branch, not the first");
});

test("a timeout is recorded as `we do not know`, never as a failure that may be retried", async () => {
  const worker = await read("src/background.ts");
  const one = worker.slice(
    worker.indexOf("async function messageOneRecipient"),
    worker.indexOf("async function walkMessageRun")
  );

  // THE DISTINCTION THAT DECIDES WHETHER SOMEBODY IS OPENED TWICE. A reply that
  // echoes `recipientId` is evidence — an adapter that got to the end and says
  // it did not press, which is the one case a retry cannot duplicate. Silence is
  // not evidence: two minutes of nothing from a content script that was told to
  // press Send is indistinguishable from a send that went. So the reply the
  // catch synthesizes deliberately carries NO `recipientId`, which is what routes
  // this person into the terminal `no-observation` branch instead of the
  // retrying one.
  const built = one.slice(one.indexOf("} catch (error) {", one.indexOf("await sendTabMessage(")));
  const synthesized = built.slice(built.indexOf("reply = {"), built.indexOf("};", built.indexOf("reply = {")));
  assert.ok(synthesized.length > 0, "a timeout must synthesize a reply rather than leave it undefined");
  assert.ok(!/recipientId/.test(synthesized), "a round trip that never answered may not vouch for anybody");
  assert.ok(!/observedSent:\s*true/.test(synthesized), "and certainly may not claim an observation");
  assert.ok(!/pressed:\s*true/.test(synthesized));
  assert.match(one, /MESSAGE_SEND_TIMEOUT_MS/, "and the round trip must be bounded at all");

  // The other half of the same rule, in the branch that reads it: silence is
  // settled terminally, and only an answered round trip reaches `markFailed`.
  const apply = await observationBranch();
  const silentAt = apply.indexOf('const echoed = String(reply?.recipientId || "");');
  assert.ok(silentAt > 0, "the branch must turn on whether anybody answered");
  assert.ok(
    apply.indexOf("MessageQueue.markSkipped", silentAt) < apply.indexOf("MessageQueue.markFailed"),
    "silence is settled before the retrying branch is ever reached"
  );
});

test("the walk's generation starts at 1, so a fresh worker does not mistake 0 for a live walk", async () => {
  const worker = await read("src/background.ts");
  const section = worker.slice(worker.indexOf("// ======================================================= messaging a list"));

  // `messageRunWalker` uses 0 for "nobody is walking". If the generation also
  // started at 0 they would be equal on a fresh worker, `kickMessageRun` would
  // conclude a walk was already in flight, and a run interrupted by the worker's
  // death would never resume — which is the whole reason any of this is
  // persisted.
  assert.match(section, /let messageRunGeneration = 1;/, "the generation must not start at the walker's sentinel");
  assert.match(section, /let messageRunWalker = 0;/, "and 0 must mean nobody is walking");
  const kick = section.slice(section.indexOf("function kickMessageRun"), section.indexOf("async function resumeMessageRun"));
  assert.match(kick, /if \(messageRunWalker === messageRunGeneration\) return;/, "one walk per generation, never two");
});

test("Stop ends a message run, and the run is the first thing the universal Stop ends", async () => {
  const worker = await read("src/background.ts");
  const stop = worker.slice(
    worker.indexOf("async function stopEverything"),
    worker.indexOf("async function handleApplicantCommand")
  );
  assert.match(stop, /await stopMessageRun\(/, "the universal Stop must end a message run too");

  const teardown = worker.slice(
    worker.indexOf("async function stopMessageRun"),
    worker.indexOf("async function ensureMessageRunHeartbeat")
  );
  // The generation is burned before the first await, so a walk already in flight
  // cannot take one more step — one more step here is one more human messaged.
  const bumpAt = teardown.indexOf("messageRunGeneration += 1");
  const awaitAt = teardown.indexOf("await ");
  assert.ok(bumpAt > 0 && bumpAt < awaitAt, "the generation must be burned before anything is awaited");
  assert.match(teardown, /MessageQueue\.stopQueue\(/, "and the queue itself must be stopped");
  // Rule 12: Stop ends work, it never discards what the work produced.
  assert.ok(
    !/storage\.local\.remove\(MESSAGE_RUN_KEY\)/.test(teardown),
    "Stop must not delete the record of who was messaged"
  );

  // Dispatcher order: the universal Stop is matched before the message family,
  // so a Stop is never queued behind the very work it is trying to end.
  const listener = worker.slice(worker.indexOf("chrome.runtime.onMessage.addListener"));
  const stopBranch = listener.indexOf("message?.type === STOP_ALL");
  const messageBranch = listener.indexOf('startsWith("PV_MESSAGE_")');
  const applicantBranch = listener.indexOf('startsWith("PV_APPLICANT_")');
  const importBranch = listener.indexOf('startsWith("PV_IMPORT_")');
  assert.ok(messageBranch > 0, "the worker must route the message family");
  assert.ok(stopBranch < messageBranch, "STOP_ALL is still matched first");
  assert.ok(messageBranch < applicantBranch && messageBranch < importBranch, "and the message family before the older two");
});

test("the run is durable before it is acted on, so a dead worker cannot re-open anybody", async () => {
  const worker = await read("src/background.ts");
  const one = worker.slice(
    worker.indexOf("async function messageOneRecipient"),
    worker.indexOf("async function walkMessageRun")
  );

  // The order that matters: mark, PERSIST, then dispatch. Reversed, a worker
  // torn down mid-round-trip would come back to somebody still `pending` and
  // open them a second time.
  const markAt = one.indexOf("MessageQueue.markOpening");
  const writeAt = one.indexOf("await persistMessageRun(record);", markAt);
  const sendAt = one.indexOf("await sendTabMessage(");
  assert.ok(markAt > 0 && writeAt > markAt && sendAt > writeAt, "mark, persist, then dispatch — in that order");

  // The tab is resolved before any attempt is spent: an unreachable hiring page
  // is not a fact about a recipient, and charging it to them would walk the whole
  // list into `failed` two attempts at a time.
  assert.ok(one.indexOf("resolveApplicantTab()") < markAt, "the tab is resolved before an attempt is spent");
  assert.match(one, /MessageQueue\.stopQueue\(queue, cleanRunReason\(error\)/, "and an unreachable page stops the run instead");
});

test("the worker owns the tab through the one controller, and never steals focus mid-walk", async () => {
  const worker = await read("src/background.ts");
  const one = worker.slice(
    worker.indexOf("async function messageOneRecipient"),
    worker.indexOf("async function walkMessageRun")
  );
  // Rule 13: one place creates, activates or closes a tab.
  assert.ok(!/chrome\.tabs\.(create|update|remove)/.test(one), "the walk must not touch chrome.tabs itself");
  // Rule 9: a hidden tab renders nothing, so the tab is activated —
  // rule 15: but focus belongs to a direct user command, and a gap is not one.
  assert.match(one, /Tabs\.activate\(tabId, \{ focusWindow: false \}\)/, "activated, never focused");
  assert.match(one, /ensureContentScript\(tabId, APPLICANT_SCRIPTS/, "and the existing injection path is reused");
});

test("the thirty-second gap is spent, not shortened, by the keep-alive chunking", async () => {
  const worker = await read("src/background.ts");
  const sleep = worker.slice(
    worker.indexOf("async function messageRunSleep"),
    worker.indexOf("async function messageOneRecipient")
  );

  // The wait is chunked only so an MV3 worker survives it. `until` is fixed from
  // the full `waitMs` and the loop runs to it, so no chunk can end the wait early.
  assert.match(sleep, /const until = Date\.now\(\) \+ Math\.max\(0, Number\(waitMs\) \|\| 0\);/, "the full wait is owed up front");
  assert.match(sleep, /delay\(Math\.min\(MESSAGE_KEEPALIVE_MS, left\)\)/, "and each chunk is at most the keep-alive interval");
  assert.match(sleep, /await readMessageRunRecord\(\)/, "each chunk touches storage: the keep-alive, and how a Stop reaches the loop");

  // Only a PAUSE is given a poll interval it did not have. The gap is untouched.
  const walk = worker.slice(
    worker.indexOf("async function walkMessageRun"),
    worker.indexOf("async function settleMessageRun")
  );
  assert.match(
    walk,
    /step\.reason === "paused" \? MESSAGE_PAUSE_POLL_MS : Number\(step\.waitMs\) \|\| 0/,
    "a paused run polls; a rate-limited one waits exactly what it was told"
  );
});

// ------------------------------------------------- surviving the worker's death
// The stored run is the queue object itself, so persistence is a JSON round trip
// and the questions worth asking about it are answerable here, against the real
// engine: does a settled person survive as settled, and can a revived run offer
// anybody it already finished?

/** What `chrome.storage.local` does to the run: structured clone, in effect. */
const roundTrip = (queue) => JSON.parse(JSON.stringify(queue));

test("a run persisted and revived never re-offers anybody already settled", () => {
  const queue = Queue.createMessageQueue({ recipients: people(4), limits: { minGapMs: 5000 } });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");
  Queue.markSent(queue, "r1", 1000);
  Queue.markSkipped(queue, "r2", "cannot-be-messaged");

  // The worker dies here. Everything it knew is whatever storage holds.
  const revived = roundTrip(queue);

  assert.equal(revived.entries[0].state, RECIPIENT_STATE.SENT, "a send survives the round trip");
  assert.equal(revived.entries[0].sentAt, 1000, "with the time it went");
  assert.equal(revived.lastSentAt, 1000, "and the gap it started");
  assert.equal(revived.entries[1].state, RECIPIENT_STATE.SKIPPED);

  // The planner picks up from the survivors, and the two who are done are done.
  const step = Queue.planQueueStep({ queue: revived, now: 60000 });
  assert.equal(step.action, "open");
  assert.equal(step.recipient.id, "r3", "the walk resumes at the first unsettled person");
  assert.equal(Queue.markOpening(revived, "r1"), false, "and a sent person cannot be re-opened");
  assert.equal(Queue.markOpening(revived, "r2"), false);

  const { step: end } = runToCompletion(revived, { clock: 60000 });
  assert.equal(end.action, "done");
  assert.equal(Queue.describeQueue(revived).sent, 3, "exactly one send per person, across the interruption");
});

test("somebody the worker died holding is settled as neither sent nor retryable", () => {
  // The three things true about a person found mid-flight by a new worker:
  // nobody observed a send, so they may not be marked sent; a Send may
  // nevertheless have been pressed, so they may not be retried; and they are not
  // nothing, so they may not be dropped. That is exactly one available answer.
  const queue = Queue.createMessageQueue({ recipients: people(3), limits: { minGapMs: 5000 } });
  Queue.markOpening(queue, "r1");
  Queue.markAwaitingSend(queue, "r1");

  const revived = roundTrip(queue);
  const stranded = Queue.activeEntry(revived);
  assert.equal(stranded.id, "r1", "the interrupted person is exactly the active entry");

  // This is the transition `reviveMessageRun` makes, and the only one it may.
  assert.equal(Queue.markSkipped(revived, stranded.id, "interrupted-while-open"), true);
  assert.equal(Queue.activeEntry(revived), null, "nobody is left mid-flight");
  assert.ok(Queue.isTerminalRecipient(revived.entries[0].state), "and they are terminal");
  assert.equal(Queue.describeQueue(revived).sent, 0, "an interruption is never counted as a send");
  assert.equal(Queue.planQueueStep({ queue: revived, now: 60000 }).recipient.id, "r2", "the walk moves on");
});

test("the worker's revive settles the stranded and can reach neither markSent nor markFailed", async () => {
  const worker = await read("src/background.ts");
  const revive = worker.slice(worker.indexOf("function reviveMessageRun"), worker.indexOf("function describeMessageRun"));

  assert.match(revive, /MessageQueue\.activeEntry\(queue\)/, "it finds them through the core, not by scanning states itself");
  assert.match(revive, /markSkipped\(queue, open\.id, "interrupted-while-open"\)/, "and settles them terminally, with the reason");
  assert.ok(!/markSent/.test(revive), "a revive must never conclude a message went");
  assert.ok(!/markFailed/.test(revive), "and must never return them to the queue to be opened again");

  // It is only ever run when this worker has no walk of its own in flight —
  // otherwise it would settle the person whose composer is open right now.
  const resume = worker.slice(
    worker.indexOf("async function resumeMessageRun"),
    worker.indexOf("async function handleMessageRunCommand")
  );
  assert.match(resume, /if \(messageRunWalker\) return false;/, "a live walk must not be revived underneath");
  assert.match(resume, /reviveMessageRun\(record\)/);
});

test("the stored run is kept when it ends, because the record of who was messaged is the product", async () => {
  const worker = await read("src/background.ts");
  const settle = worker.slice(
    worker.indexOf("async function settleMessageRun"),
    worker.indexOf("async function stopMessageRun")
  );
  assert.match(settle, /persistMessageRun\(record\)/, "the outcome is written");
  assert.ok(!/storage\.local\.remove/.test(settle), "and never deleted at the end of a run");
  assert.match(settle, /alarms\.clear\(MESSAGE_RUN_ALARM\)/, "a finished run keeps no machinery alive");

  // It ages out instead, exactly as the applicant auto-run lease does.
  const readRecord = worker.slice(
    worker.indexOf("async function readMessageRunRecord"),
    worker.indexOf("async function writeMessageRunRecord")
  );
  assert.match(readRecord, /MESSAGE_RUN_TTL_MS/, "an expired run is swept rather than resumed");
});

test("a second START cannot build a second queue over the same people", async () => {
  const worker = await read("src/background.ts");
  const handler = worker.slice(worker.indexOf("async function handleMessageRunCommand"));
  const start = handler.slice(handler.indexOf("MESSAGE_RUN_MESSAGES.START"));

  const guardAt = start.indexOf("isLiveMessageQueue(existing.queue)");
  const createAt = start.indexOf("MessageQueue.createMessageQueue");
  assert.ok(guardAt > 0 && guardAt < createAt, "a live run is detected before another queue is built");
  assert.match(start, /alreadyRunning: true/, "and the caller is told so rather than silently starting again");

  // Detached: replies immediately and walks without being awaited. The reply is
  // dispatched AFTER the walk is kicked off and without an `await` in front of
  // it, which is the COLLECT_ALL pattern — a list of forty people at a
  // thirty-second gap is twenty minutes, and the page may close at any point in
  // it. (`indexOf` would find the already-running guard's reply, which is a
  // different `started: true` and deliberately comes earlier.)
  assert.match(start, /walkMessageRun\(generation\)\.catch\(\(\) => undefined\)/, "the walk is detached");
  const finalReply = start.indexOf("return { ok: true, started: true, total: queue.entries.length");
  assert.ok(finalReply > 0, "START must answer with what it started");
  assert.ok(finalReply > start.indexOf("walkMessageRun(generation)"), "the reply does not wait for the walk");
  assert.ok(!/await walkMessageRun/.test(handler), "the walk is never awaited by a command handler");
});

test("the message family is one exported object of PV_MESSAGE_ literals", async () => {
  const messages = await read("src/messages.ts");
  const family = messages.slice(
    messages.indexOf("export const MESSAGE_RUN_MESSAGES"),
    messages.indexOf("export const STOP_ALL")
  );
  assert.ok(family.length > 0, "the family must exist");

  for (const [key, literal] of [
    ["START", "PV_MESSAGE_START"],
    ["STATUS", "PV_MESSAGE_STATUS"],
    ["STOP", "PV_MESSAGE_STOP"],
    ["SEND_ONE", "PV_MESSAGE_SEND_ONE"]
  ]) {
    assert.match(family, new RegExp(`${key}: "${literal}"`), `${key} must be ${literal}`);
  }
  assert.match(family, /\} as const;/, "declared `as const`, like every other family in this file");

  // Every literal in the family carries the domain prefix, so the worker's
  // `startsWith` branch can never route one of them somewhere else.
  for (const literal of family.match(/"PV_[A-Z_]+"/g) || []) {
    assert.ok(literal.startsWith('"PV_MESSAGE_'), `${literal} does not belong to this family`);
  }

  // The recipient that reaches the content script is the queue's own entry shape.
  const recipient = messages.slice(
    messages.indexOf("export interface MessageRunRecipient"),
    messages.indexOf("export interface MessageSendObservation")
  );
  for (const field of ["id", "name", "profileUrl", "applicationId", "text"]) {
    assert.match(recipient, new RegExp(`${field}: string;`), `a recipient must carry ${field}`);
  }

  // And the reply is an observation, with the two fields kept apart by name.
  const observation = messages.slice(
    messages.indexOf("export interface MessageSendObservation"),
    messages.indexOf("export interface MessageRunEntry")
  );
  for (const field of ["recipientId", "opened", "identityConfirmed", "filled", "readBack", "pressed", "observedSent"]) {
    assert.ok(observation.includes(field), `the observation must report ${field}`);
  }
});

test("a walk can never write a Stop back out of the record", async () => {
  const worker = await read("src/background.ts");
  const section = worker.slice(worker.indexOf("// ======================================================= messaging a list"));

  // The walk holds its copy of the run across a round trip that can take two
  // minutes, and a Stop pressed inside that window lands in storage underneath
  // it. A plain write would put `running` back over the Stop and a later alarm
  // would carry on messaging people after the recruiter stopped — so every write
  // the walk makes goes through one guard that brings the Stop forward first.
  const guarded = ["messageOneRecipient", "walkMessageRun", "settleMessageRun", "recordMessageOutcome"];
  for (const fn of guarded) {
    const at = section.indexOf(`function ${fn}`);
    assert.ok(at > 0, `${fn} must exist`);
  }

  const persist = section.slice(section.indexOf("async function persistMessageRun"), section.indexOf("async function recordMessageOutcome"));
  assert.match(persist, /adoptMessageRunControl\(record\.queue, stored\)/, "a concurrent Stop is adopted before the write");
  assert.match(persist, /String\(stored\.runId\) !== String\(record\.runId\)/, "and a reply for a replaced run is refused outright");

  const adopt = section.slice(section.indexOf("function adoptMessageRunControl"), section.indexOf("async function persistMessageRun"));
  assert.match(adopt, /QUEUE_STATE\.STOPPED/, "a Stop is carried across");
  assert.match(adopt, /QUEUE_STATE\.PAUSED/, "and so is a Pause");

  // Only the deliberate authors of a stop write the record directly: START,
  // which creates it, and stopMessageRun, which just read it itself. Everything
  // downstream of a dispatch goes through the guard.
  const walk = section.slice(section.indexOf("async function messageOneRecipient"), section.indexOf("async function settleMessageRun"));
  assert.ok(!/writeMessageRunRecord/.test(walk), "the walk itself never writes the record directly");

  // And a Stop that lands while the pre-dispatch write is in flight is still
  // honoured, because the walk re-checks the run after writing and before
  // anybody is opened.
  const one = section.slice(section.indexOf("async function messageOneRecipient"), section.indexOf("async function walkMessageRun"));
  const persistAt = one.indexOf("await persistMessageRun(record);");
  const checkAt = one.indexOf("!isLiveMessageQueue(queue)");
  const sendAt = one.indexOf("await sendTabMessage(");
  assert.ok(persistAt > 0 && checkAt > persistAt && sendAt > checkAt, "persist, re-check, then dispatch");
});
