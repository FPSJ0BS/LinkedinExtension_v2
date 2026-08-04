# SKILLS.md

- **React component design:** class components (React 16.0.0, no hooks), controlled forms, compact
  table cells with a See-more affordance, polled status views, state-driven rendering, error
  presentation.
- **TypeScript:** strict typing for UI state, profile records, component props, queue items, session
  state, and the cross-context message contract.
- **Manifest V3:** permissions, module service workers, content scripts, extension pages, local
  CSP-compliant scripts, service-worker suspension, and unpacked loading.
- **DOM traversal:** visible-element checks, direct-text extraction, section boundaries, candidate
  scoring, excluded-context rejection, and nested entity parsing.
- **LinkedIn SPA lifecycle:** stale content-script recovery, bounded reinjection, build-ID matching,
  URL changes, and virtualized list rendering.
- **Careful lazy scrolling:** bounded step budgets, MutationObserver quiet detection, growth-based
  stopping, and guaranteed scroll restoration — without clicking any control.
- **Link canonicalization:** reducing arbitrary LinkedIn hrefs to a canonical `/in/<slug>`, rejecting
  company/school/feed links, and order-preserving deduplication.
- **Queue engineering:** pure state machines, one-at-a-time claim semantics, bounded retries,
  session limits, pause/resume/stop, skip, and crash-safe recovery that requires manual resume.
- **Challenge detection:** recognizing CAPTCHA, login walls, checkpoints, unusual-activity warnings,
  restrictions, and unavailable profiles — and stopping rather than working around them.
- **Data normalization:** canonical URLs, deterministic IDs, name derivation, arrays, missing fields,
  and partial-section metadata.
- **Experience parsing:** flat/grouped roles, one-company-per-block grouping, employment types,
  active-date validation, overlap-aware duration, and internship exclusion.
- **Education parsing:** one-institution-per-block formatting, degree/field/date segregation, and
  duplicate text removal.
- **IndexedDB:** local persistence, multi-store schema upgrades that preserve the database name,
  indexes, transactions, and invalid-record diagnostics.
- **CSV serialization:** stable schema, escaping, Unicode, multiline arrays, formula protection,
  import parsing, duplicate-safe merge, and partial exports scoped to a URL set.
- **Accessible UI:** labels, focusable controls, modal behavior, live status regions, progress
  indicators, editable forms, and clear errors.
- **Build engineering:** TypeScript compilation, deterministic asset copying, local React runtime
  packaging, service-worker module resolution, and manifest-reference validation.
- **Security and restraint:** minimum permissions, safe React rendering, no remote scripts, no hidden
  data collection, no automated outreach, deliberate pacing, and no circumvention of platform limits.
- **Testing:** Node built-in unit tests, pure-core state-machine tests, architecture and contract
  checks, manifest validation, sanitized browser fixtures, and honest separation of automated results
  from unverified live behavior.

## Skills exercised by 3.7.0 applicant collection

- **Recording a platform's own judgement without re-deriving it:** storing a qualification verdict,
  its explanation and its provenance as displayed, and keeping "the platform could not evaluate this"
  as a distinct third state rather than folding it into a miss.
- **Per-purpose control gating:** an allowlist keyed by *what the caller wants the control for*, a
  denylist that always wins, and requiring the caller to prove the element came from inside the
  container it claims to belong to — extended to a surface where the forbidden controls sit pixels
  away from the permitted ones.
- **Null-honest schemas:** distinguishing absent from empty throughout a record, so an export never
  implies a value the page did not show.
- **Two-column SPA scanning:** finding a detail panel and a list by what they contain, scrolling the
  panel rather than the document, and expanding collapsed sections under a bounded, fruitless-attempt
  budget.
- **Duplicate-safe file downloads:** host allowlisting, a persisted already-downloaded guard that
  survives service-worker restarts, and dialog-free saving with collision-safe names.
- **Streamed persistence:** saving each unit of work as it finishes so an interrupted run keeps
  everything it completed, with a merge that makes re-sending a record harmless.
- **Cooperative cancellation:** one abort signal honoured by the orchestrator and by every content
  script inside its walking loop, reported as an interruption rather than as a failure.

## Skills exercised by 3.2.0 full coverage

- **Exhaustive enumeration:** reading a collection's advertised total, resumable scroll cursors,
  multi-pass convergence, and proving a list is exhausted rather than assuming it.
- **Long-run orchestration:** `chrome.alarms` heartbeats, service-worker suspension survival, and
  separating a safe auto-resume (worker slept) from an unsafe one (challenge or restriction).
- **Pacing and restraint at scale:** randomized inter-item delays, periodic cool-downs, user-set caps,
  and consecutive-failure backoff.
- **Selector allow/deny policy:** permitting pagination-only controls while making outreach controls
  unclickable by construction and asserting that in tests.
- **Storage at scale:** batched IndexedDB writes, paged UI rendering, quota inspection, and bounded
  memory for multi-thousand-item queues.
