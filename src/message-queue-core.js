// Walking a list of recipients, one at a time, without sending anything.
//
// This file is PURE — no DOM, no chrome, no timers of its own. It decides what
// should happen next and the adapter does it. That split is not tidiness: the
// questions worth being certain about here are "can it message somebody twice",
// "can it skip somebody silently" and "does it always stop", and all three are
// answerable in a Node test against this file. None of them is answerable by
// watching a live recruiter account, which is the only other place this logic
// could have lived.
//
// **The queue never sends.** It opens a person, has their message typed in, and
// then waits to be told the human sent it. `awaiting-send` is the state it sits
// in, and nothing in this file or its adapter can leave that state on its own —
// only `markSent` and `markSkipped`, both of which are the user's decision. The
// rate limits below therefore bound how fast a HUMAN is walked through a list,
// which is still worth bounding: LinkedIn throttles on volume and cadence
// regardless of whose finger pressed the key.
(() => {
  const CORE = () => globalThis.ProfileVaultApplicants || null;

  function cleanText(value) {
    const core = CORE();
    if (core?.cleanText) return core.cleanText(value);
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  /** The run as a whole. */
  const QUEUE_STATE = Object.freeze({
    IDLE: "idle",
    RUNNING: "running",
    PAUSED: "paused",
    /** Ended by the user. Terminal, and never resumed — rule 12. */
    STOPPED: "stopped",
    /** Every recipient reached a terminal state. */
    DONE: "done"
  });

  /**
   * One recipient's progress.
   *
   * Exactly one of SENT / SKIPPED / FAILED is terminal for a person, and a
   * person in a terminal state is never offered again. That is what makes
   * double-messaging structurally impossible rather than merely unlikely.
   */
  const RECIPIENT_STATE = Object.freeze({
    PENDING: "pending",
    /** Their panel/profile is being opened and the composer found. */
    OPENING: "opening",
    /** The text is in their composer, verified by read-back. */
    AWAITING_SEND: "awaiting-send",
    SENT: "sent",
    SKIPPED: "skipped",
    FAILED: "failed"
  });

  const TERMINAL_RECIPIENT_STATES = Object.freeze([
    RECIPIENT_STATE.SENT, RECIPIENT_STATE.SKIPPED, RECIPIENT_STATE.FAILED
  ]);

  function isTerminalRecipient(state) {
    return TERMINAL_RECIPIENT_STATES.indexOf(state) >= 0;
  }

  /**
   * How fast a person may be walked through a list.
   *
   * These are not about politeness. LinkedIn throttles messaging on volume and
   * cadence, and a queue firing as fast as somebody can hold down a key looks
   * exactly like the automation this feature deliberately is not. The gap is
   * the floor between two recipients; the cap is the most this queue will hand
   * over in a rolling day.
   *
   * Both are overridable by the caller because the right numbers depend on the
   * account, and neither may be set to zero — a queue with no floor is the
   * thing these limits exist to prevent.
   */
  const QUEUE_LIMITS = Object.freeze({
    MIN_GAP_MS: 30000,
    MIN_ALLOWED_GAP_MS: 5000,
    DAILY_CAP: 50,
    MAX_DAILY_CAP: 200,
    /** A person who cannot be opened is retried this many times, then failed. */
    MAX_ATTEMPTS: 2
  });

  const DAY_MS = 24 * 60 * 60 * 1000;

  function clampGap(value) {
    const gap = Number(value);
    if (!Number.isFinite(gap)) return QUEUE_LIMITS.MIN_GAP_MS;
    return Math.max(QUEUE_LIMITS.MIN_ALLOWED_GAP_MS, Math.round(gap));
  }

  function clampCap(value) {
    const cap = Number(value);
    if (!Number.isFinite(cap) || cap <= 0) return QUEUE_LIMITS.DAILY_CAP;
    return Math.min(QUEUE_LIMITS.MAX_DAILY_CAP, Math.round(cap));
  }

  /**
   * A queue over recipients the caller has already decided are ready.
   *
   * `recipients` are expected to have passed `isRecipientReady` — this file does
   * not re-render templates and does not decide whether a message is blocked.
   * It is handed the final text per recipient and walks the list. A recipient
   * with no text is refused at creation rather than at send time, because
   * discovering it mid-walk means discovering it with a composer already open.
   */
  function createMessageQueue({ recipients = [], audience = "", limits = {}, startedAt = 0 } = {}) {
    const minGapMs = clampGap(limits.minGapMs ?? QUEUE_LIMITS.MIN_GAP_MS);
    const dailyCap = clampCap(limits.dailyCap ?? QUEUE_LIMITS.DAILY_CAP);

    const entries = [];
    const seen = new Set();
    for (const recipient of recipients) {
      const id = cleanText(recipient?.id);
      const text = cleanText(recipient?.text);
      // A duplicate id in the input is the same person twice. Kept once, so a
      // caller that concatenated two lists cannot message anybody twice.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      entries.push({
        id,
        name: cleanText(recipient?.name),
        profileUrl: cleanText(recipient?.profileUrl),
        applicationId: cleanText(recipient?.applicationId),
        text,
        state: text ? RECIPIENT_STATE.PENDING : RECIPIENT_STATE.FAILED,
        reason: text ? "" : "empty-message",
        attempts: 0,
        sentAt: 0
      });
    }

    return {
      audience: cleanText(audience),
      state: entries.some((entry) => entry.state === RECIPIENT_STATE.PENDING)
        ? QUEUE_STATE.IDLE
        : QUEUE_STATE.DONE,
      minGapMs,
      dailyCap,
      startedAt: Number(startedAt) || 0,
      lastSentAt: 0,
      entries,
      stoppedReason: ""
    };
  }

  /** How many were handed over in the rolling day ending at `now`. */
  function sentInWindow(queue, now) {
    const since = Number(now) - DAY_MS;
    return queue.entries.filter((entry) => entry.state === RECIPIENT_STATE.SENT && entry.sentAt > since).length;
  }

  function pendingCount(queue) {
    return queue.entries.filter((entry) => entry.state === RECIPIENT_STATE.PENDING).length;
  }

  /** The person currently open, if any. There is never more than one. */
  function activeEntry(queue) {
    return queue.entries.find((entry) =>
      entry.state === RECIPIENT_STATE.OPENING || entry.state === RECIPIENT_STATE.AWAITING_SEND) || null;
  }

  /**
   * What should happen next.
   *
   * The one function the adapter calls in its loop, and the only place the order
   * of these questions is decided. That order is the whole safety argument:
   *
   *   1. **Stopped beats everything.** Rule 12 — Stop ends work, immediately,
   *      and is checked before any reason the queue might have to continue.
   *   2. **Someone already open beats starting someone new.** Two open
   *      composers is how a message reaches the wrong person; there can only
   *      ever be one, and while it is open the answer is always "wait for the
   *      human", never "open the next one".
   *   3. Then paused, then nothing-left, then the daily cap, then the gap.
   *
   * `now` is passed in rather than read, so a test can drive a whole day of
   * behaviour in a millisecond and so this file holds no clock of its own.
   */
  function planQueueStep({ queue, now = 0 } = {}) {
    const at = Number(now) || 0;
    const decide = (action, extra = {}) => ({ action, ...extra });

    if (!queue) return decide("stop", { reason: "no-queue" });
    if (queue.state === QUEUE_STATE.STOPPED) {
      return decide("stop", { reason: queue.stoppedReason || "stopped" });
    }

    // Somebody is open. Nothing else may start, whatever the clock says.
    const open = activeEntry(queue);
    if (open) {
      return open.state === RECIPIENT_STATE.AWAITING_SEND
        ? decide("await-send", { recipient: open, reason: "waiting-for-the-user-to-send" })
        : decide("await-open", { recipient: open, reason: "opening" });
    }

    if (queue.state === QUEUE_STATE.PAUSED) return decide("wait", { reason: "paused", waitMs: 0 });

    const remaining = pendingCount(queue);
    if (remaining === 0) return decide("done", { reason: "every-recipient-settled" });

    if (sentInWindow(queue, at) >= queue.dailyCap) {
      return decide("stop", { reason: "daily-cap-reached", remaining });
    }

    // The gap is measured from the last message the USER sent, not from the
    // last time this was asked — so a queue that sat idle owes no wait.
    const since = at - (queue.lastSentAt || 0);
    if (queue.lastSentAt && since < queue.minGapMs) {
      return decide("wait", { reason: "rate-limited", waitMs: queue.minGapMs - since, remaining });
    }

    const next = queue.entries.find((entry) => entry.state === RECIPIENT_STATE.PENDING);
    return decide("open", { recipient: next, remaining });
  }

  /** Mark the person the adapter is about to open. */
  function markOpening(queue, id) {
    return transition(queue, id, RECIPIENT_STATE.PENDING, RECIPIENT_STATE.OPENING, (entry) => {
      entry.attempts += 1;
      queue.state = QUEUE_STATE.RUNNING;
    });
  }

  /** Their composer holds the approved text, verified by read-back. */
  function markAwaitingSend(queue, id) {
    return transition(queue, id, RECIPIENT_STATE.OPENING, RECIPIENT_STATE.AWAITING_SEND);
  }

  /**
   * The user sent it.
   *
   * The ONLY route to SENT, and it is the adapter reporting an observation —
   * the composer emptied and an outgoing message appeared — never this file
   * deciding. `lastSentAt` starts the gap for the next person.
   */
  function markSent(queue, id, at = 0) {
    return transition(queue, id, RECIPIENT_STATE.AWAITING_SEND, RECIPIENT_STATE.SENT, (entry) => {
      entry.sentAt = Number(at) || 0;
      queue.lastSentAt = entry.sentAt;
      settleIfFinished(queue);
    });
  }

  /** The user moved past them. Terminal — they are not offered again. */
  function markSkipped(queue, id, reason = "skipped-by-user") {
    const entry = queue?.entries.find((candidate) => candidate.id === id);
    if (!entry || isTerminalRecipient(entry.state)) return false;
    entry.state = RECIPIENT_STATE.SKIPPED;
    entry.reason = reason;
    settleIfFinished(queue);
    return true;
  }

  /**
   * They could not be opened or the text could not be verified.
   *
   * Retried up to `MAX_ATTEMPTS` because the usual cause is a page mid-render,
   * and then failed for good with the reason kept. A failure returns them to
   * PENDING rather than silently dropping them — but the attempt count is what
   * stops that becoming a loop, and it is counted per person so one bad
   * recipient cannot spend anybody else's allowance.
   */
  function markFailed(queue, id, reason = "failed") {
    const entry = queue?.entries.find((candidate) => candidate.id === id);
    if (!entry || isTerminalRecipient(entry.state)) return false;
    entry.reason = reason;
    entry.state = entry.attempts >= QUEUE_LIMITS.MAX_ATTEMPTS
      ? RECIPIENT_STATE.FAILED
      : RECIPIENT_STATE.PENDING;
    settleIfFinished(queue);
    return true;
  }

  function transition(queue, id, from, to, after = null) {
    const entry = queue?.entries.find((candidate) => candidate.id === id);
    if (!entry || entry.state !== from) return false;
    entry.state = to;
    if (after) after(entry);
    return true;
  }

  function settleIfFinished(queue) {
    if (queue.state === QUEUE_STATE.STOPPED) return;
    if (!queue.entries.some((entry) => !isTerminalRecipient(entry.state))) queue.state = QUEUE_STATE.DONE;
  }

  /** Pause is reversible; stop is not. */
  function pauseQueue(queue) {
    if (queue.state === QUEUE_STATE.RUNNING || queue.state === QUEUE_STATE.IDLE) {
      queue.state = QUEUE_STATE.PAUSED;
      return true;
    }
    return false;
  }

  function resumeQueue(queue) {
    if (queue.state !== QUEUE_STATE.PAUSED) return false;
    queue.state = pendingCount(queue) ? QUEUE_STATE.RUNNING : QUEUE_STATE.DONE;
    return true;
  }

  /**
   * Stop, and it is final — rule 12.
   *
   * A person left mid-flight is recorded as skipped rather than abandoned in
   * `awaiting-send`, because "the run ended while their composer was open" is a
   * thing the user needs to see. Stop ends the work; it never discards the
   * record of what the work did.
   */
  function stopQueue(queue, reason = "stopped-by-user") {
    if (!queue || queue.state === QUEUE_STATE.STOPPED) return false;
    const open = activeEntry(queue);
    if (open) {
      open.state = RECIPIENT_STATE.SKIPPED;
      open.reason = "stopped-while-open";
    }
    queue.state = QUEUE_STATE.STOPPED;
    queue.stoppedReason = reason;
    return true;
  }

  /** Counts for the UI, and the only shape it should read. */
  function describeQueue(queue, now = 0) {
    if (!queue) return { state: QUEUE_STATE.IDLE, total: 0, sent: 0, skipped: 0, failed: 0, pending: 0, remaining: 0, sentToday: 0 };
    const count = (state) => queue.entries.filter((entry) => entry.state === state).length;
    return {
      state: queue.state,
      audience: queue.audience,
      total: queue.entries.length,
      sent: count(RECIPIENT_STATE.SENT),
      skipped: count(RECIPIENT_STATE.SKIPPED),
      failed: count(RECIPIENT_STATE.FAILED),
      pending: count(RECIPIENT_STATE.PENDING),
      remaining: pendingCount(queue),
      sentToday: sentInWindow(queue, now),
      dailyCap: queue.dailyCap,
      minGapMs: queue.minGapMs,
      stoppedReason: queue.stoppedReason || ""
    };
  }

  globalThis.ProfileVaultMessageQueue = {
    QUEUE_STATE, RECIPIENT_STATE, TERMINAL_RECIPIENT_STATES, isTerminalRecipient,
    QUEUE_LIMITS, clampGap, clampCap,
    createMessageQueue, planQueueStep, describeQueue,
    markOpening, markAwaitingSend, markSent, markSkipped, markFailed,
    pauseQueue, resumeQueue, stopQueue,
    activeEntry, pendingCount, sentInWindow
  };
})();
