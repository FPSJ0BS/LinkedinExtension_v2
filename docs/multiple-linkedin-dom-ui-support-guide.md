# Multiple LinkedIn DOM and UI Support Guide

This file belongs in the applicant extension project inside the `docs` folder.

Claude Code must read this file before changing anything related to multiple LinkedIn layouts, DOM selectors, field locations, section detection, contact layouts, resume layouts, or UI compatibility.

## Goal

Make the extension work across slightly different LinkedIn applicant UIs where the same data appears in different places.

The extension must automatically adjust to the active UI while keeping:

- the current workflow
- the current extracted fields
- the current applicant schema
- the current CSV output
- the current resume download
- the current contact collection
- the current pagination
- the current save and restart behaviour

Do not break the UI that already works.

## Main rule

Do not replace working extraction logic just to support another UI.

Add safe fallback readers for the new UI and merge their results into the same applicant record.

Use this order:

```text
current working reader
→ new UI fallback reader
→ shared semantic fallback
→ existing saved value
```

Never replace a valid value with an empty or weaker value.

## One applicant record

All UI versions must write into the same existing applicant object.

Do not create a separate schema for each UI.

The same final fields must remain connected, including:

- name
- email
- phone number
- current company
- current role
- total experience
- experience
- education
- resume information
- resume file
- job ID
- applicant ID
- all other existing fields

## Applicant identity protection

Before reading, opening Contact, connecting a resume, or saving:

1. Confirm the expected applicant is open.
2. Read data only from that applicant's panel.
3. Confirm the identity again before saving.

If the panel changes to another applicant, stop that extraction and do not save it.

Never mix:

- one applicant's name with another applicant's experience
- one applicant's contact details with another applicant
- a previous resume link with the next applicant
- stale DOM data after LinkedIn remounts the panel

## Multiple UI detection

Detect the active UI using several stable features, such as:

- headings
- section names
- accessible labels
- button text
- roles
- links
- stable data attributes
- nearby label and value relationships

Do not detect a UI from one generated CSS class.

If no known UI is detected, use the generic semantic readers instead of failing.

## Field readers

Every important field may have several possible locations.

### Name

Try:

1. applicant heading
2. panel title
3. applicant summary
4. stable profile metadata

Do not read recruiter names, company names, job titles, or button labels as the applicant name.

### Current role

Try:

1. explicit current-role field
2. top-card headline
3. applicant summary
4. latest valid Experience title

Do not use the role being applied for as the current role unless LinkedIn clearly labels it as current employment.

### Current company

Try:

1. explicit current-company field
2. top-card employment summary
3. latest valid Experience company

Do not use the hiring company, recruiter company, or school as the applicant's current company.

### Email and phone

Contact information may appear in:

- a modal
- a drawer
- a popover
- an expanded section
- an inline contact block

Open Contact once per applicant and read only from the contact UI connected to the current applicant.

### Experience

Find the Experience section by its heading and local container, not by page position.

Keep these values connected to each Experience entry:

- title
- company
- employment type
- start date
- end date
- duration
- location
- description

### Education

Find the Education section by its heading and local container.

Keep these values connected to each Education entry:

- institution
- degree
- field of study
- start year
- end year
- grade
- description

Never save company names or job titles inside Education.

Never save school or degree data inside Experience.

### Resume

Resume information may appear as:

- a direct link
- a document card
- a button
- viewer metadata
- a download action
- a document descriptor

Use this order:

```text
direct resume link
→ document metadata
→ resume viewer fallback
```

The resume must always be linked to the current applicant before it is downloaded or saved.

Never reuse a resume URL from the previous applicant.

## Section mapping

Build a section map from visible headings and nearby containers.

Possible sections include:

- top card
- contact
- experience
- education
- skills
- application details
- resume
- additional information

Do not assume section order is fixed.

Different UIs may place Experience, Education, Resume, or Contact in different positions.

Read sections by meaning, not by index.

## Right-side scrolling

Do not remove right-side profile scrolling.

The right-side applicant profile must still scroll from top to bottom because some sections load only after scrolling.

For every UI:

- find the correct right-side profile scroller
- confirm it is not the left applicant list
- scroll downward until all lazy-loaded sections appear
- update the section map when new content loads
- avoid repeating the same scroll area
- do not move the left applicant list during profile extraction

## Safe merge

Merge field by field.

Rules:

- keep the strongest valid value
- fill only missing fields from fallbacks
- never replace valid data with empty data
- never replace a high-confidence value with a weaker value
- remove duplicates
- preserve existing saved data when the new UI is incomplete
- keep merge-only saving
- save only after the applicant pass is complete

## DOM remount safety

LinkedIn may rebuild the applicant panel without reloading the page.

When that happens:

- do not reuse old DOM nodes
- find the panel again
- find sections again
- confirm the applicant identity again
- cancel readers connected to the old panel
- continue only if the same expected applicant is open

Store stable IDs and descriptors, not long-lived element references.

## Unknown UI handling

If a field or section cannot be matched safely:

- continue collecting other fields
- keep the existing saved value for the missing field
- report the unmatched heading or section
- do not guess
- do not stop the full run for one optional field

If applicant identity cannot be confirmed, do not save the applicant.

## Capture and diagnostics

Add a safe diagnostic option for unknown UIs, such as:

```text
Capture Current Applicant UI
```

The capture may include:

- sanitized relevant HTML
- detected headings
- accessible labels
- section map
- reader results
- unmatched headings
- detected UI type
- extension build ID

Do not capture:

- cookies
- session tokens
- passwords
- credentials
- unrelated browser storage

Every useful captured layout should later become a regression fixture.

## Click safety

Different UIs may move buttons, but click safety must remain.

Before every click:

1. confirm the intended container
2. confirm the target is inside that container
3. confirm the label or purpose
4. reject dangerous actions

Never click:

- Reject
- Shortlist
- Message
- Change status
- unrelated recruiter controls

## Testing

During development, run focused tests only for the reader or UI changed.

Examples:

- Name reader changed: test Name on the current and new UI.
- Education reader changed: confirm Education and Experience stay separate.
- Contact UI changed: test Contact for that UI.
- Resume UI changed: test direct resume and viewer fallback.
- Scroller changed: confirm the right panel moves and the left list stays still.

Run the full regression only before final completion or after changing shared applicant identity, saving, pagination, Contact, Resume, or the main extraction flow.

## Final checks

Before completion, verify:

- the current UI still works
- every new supported UI works
- all layouts produce the same applicant schema
- existing fields are not lost
- Experience and Education remain separate
- data never leaks between applicants
- right-side scrolling still loads all sections
- Contact still works
- Resume still works
- every applicant saves once
- next applicant selection still works
- pagination still works
- Stop Everything still works
- interrupted runs remain restartable
- CSV output remains unchanged

## Claude Code instruction

Before working on multiple DOM or UI support:

1. Read `CLAUDE.md`.
2. Read this file.
3. Inspect the current working readers.
4. Preserve the current workflow and extracted data.
5. Add small fallback readers instead of replacing working logic.
6. Connect all UI variants into the same applicant record.
7. Confirm every value belongs to the expected applicant.
8. Keep right-side scrolling.
9. Keep click safety.
10. Use focused tests during development and a full regression before completion.

After finishing, report:

- supported UI layouts
- files changed
- readers preserved
- fallback readers added
- field mapping changes
- stale DOM protection
- unmatched headings found
- tests performed
- proof that the current UI still works
- proof that extracted data did not regress
- current commit
- rollback command

# Phased Implementation Plan

Work through these phases one by one. Do not start the next phase until the current phase is completed, tested, reported, and approved.

---

## Phase 1 — Protect the Current Working UI

First document and protect what already works. Do not change extraction logic yet.

Confirm the current UI correctly handles:

- applicant identity
- name
- email
- phone number
- current role
- current company
- total experience
- Experience
- Education
- Contact
- Resume
- right-side profile scrolling
- saving
- next-applicant selection
- pagination
- restart after interruption

Create focused fixtures or tests for the current layout so future UI support cannot silently break it.

### Phase 1 completion

Stop and report:

- current UI structure
- current readers used
- current fields collected
- current scroll container
- current Contact path
- current Resume path
- baseline test results
- files changed

Do not start Phase 2 automatically.

---

## Phase 2 — Confirm One Shared Applicant Schema

All UIs must write into the same existing applicant record. Do not create separate final schemas for different layouts.

Keep the current schema and CSV unchanged.

Use field-by-field merging:

```text
current trusted value
→ stronger new value
→ valid fallback value
→ existing saved value
```

Rules:

- never replace valid data with empty data
- never replace a high-confidence value with a weaker value
- never replace detailed data with a shorter incomplete value
- remove duplicates
- preserve saved data when the current UI is incomplete
- never merge data from different applicants

### Phase 2 completion

Stop and report:

- canonical schema used
- merge rules
- fields with fallback support
- proof that CSV and schema did not change
- tests performed

Do not start Phase 3 automatically.

---

## Phase 3 — Strengthen Shared Semantic Readers

Keep the current selectors and add semantic fallbacks after them.

Prefer:

- headings
- section names
- `aria-label`
- roles
- button text
- link purpose
- stable data attributes
- nearby label-value relationships
- local section containers

Do not rely only on generated LinkedIn class names. Do not scan the whole page when the applicant panel or a specific section can be used.

Each reader should return a value, its source, and confidence:

```javascript
{
  value,
  source,
  confidence
}
```

### Phase 3 completion

Stop and report:

- readers strengthened
- existing selectors preserved
- semantic fallbacks added
- current-UI test results
- proof that current extracted data did not change

Do not start Phase 4 automatically.

---

## Phase 4 — Add Lightweight UI Detection

Detect only meaningful layout differences. Use several stable features, not one generated class.

Possible detection features:

- top-card structure
- section-heading pattern
- Contact location
- Resume location
- panel structure
- accessible labels
- stable data attributes

Example:

```javascript
function detectApplicantUI(panel) {
  if (matchesCurrentUI(panel)) return "current";
  if (matchesAlternativeUI(panel)) return "alternative";
  return "generic";
}
```

The detected UI may only decide which reader runs first. It must not change the applicant schema, workflow, save format, pagination, or current UI behaviour.

### Phase 4 completion

Stop and report:

- UI signatures added
- current UI detection result
- alternative UI detection result
- generic fallback behaviour
- tests performed

Do not start Phase 5 automatically.

---

## Phase 5 — Add Support for the Second UI

Add only the readers that are actually different. Do not duplicate the full extraction pipeline.

Use reader chains:

```text
Name:
current reader
→ alternative UI reader
→ generic semantic reader
```

```text
Current company:
current top-card reader
→ alternative summary reader
→ latest valid Experience company
```

```text
Resume:
current direct-link reader
→ alternative document-card reader
→ viewer fallback
```

Keep the current UI path first unless the alternative layout is positively detected.

### Phase 5 completion

Test both UIs and stop. Report:

- alternative UI differences
- fallback readers added
- current readers preserved
- field mapping for both UIs
- proof that both produce the same applicant schema
- proof that the current UI still works

Do not start Phase 6 automatically.

---

## Phase 6 — Protect Section Boundaries

Build a section map from headings and local containers.

```javascript
{
  topCard,
  contact,
  experience,
  education,
  skills,
  applicationDetails,
  resume,
  additionalInformation
}
```

Do not assume section order is fixed.

For Experience, connect:

- title
- company
- employment type
- start date
- end date
- duration
- location
- description

For Education, connect:

- institution
- degree
- field of study
- start year
- end year
- grade
- description

Never:

- save company names inside Education
- save school details inside Experience
- classify a section only by its page position
- merge Contact or Resume text into profile sections

### Phase 6 completion

Stop and report:

- section-map changes
- Experience tests
- Education tests
- proof that section order can change safely
- proof that fields remain in the correct category

Do not start Phase 7 automatically.

---

## Phase 7 — Support Different Scroll Containers

Keep right-side profile scrolling. Do not remove it.

For every supported UI:

1. Find the active applicant panel.
2. Find its real scrollable container.
3. Confirm it is not the left applicant list.
4. Confirm it contains the expected applicant panel.
5. Scroll downward until all lazy-loaded sections appear.
6. Update the section map as content loads.
7. Avoid rereading completed sections.
8. Avoid repeating the same scroll position.

The left applicant list may scroll only while building the page roster. It must not move during right-side profile extraction.

### Phase 7 completion

Stop and report:

- scroll container detected for each UI
- proof that right-side scrolling reached the bottom
- proof that the left applicant list stayed still
- lazy-loaded sections found
- tests performed

Do not start Phase 8 automatically.

---

## Phase 8 — Add Unknown-UI Diagnostics

When a layout cannot be understood safely, report it instead of silently returning empty fields.

Add a UI action such as:

```text
Capture Current Applicant UI
```

Show or record:

- detected UI type
- detected headings
- unmatched headings
- section map
- reader results
- reader sources
- missing fields
- extension build ID

Do not guess unknown values. Do not stop the entire page for one missing optional field. If applicant identity is uncertain, do not save the record.

### Phase 8 completion

Stop and report:

- diagnostic UI added
- unmatched-heading display
- missing-field reporting
- safe failure behaviour
- tests performed

Do not start Phase 9 automatically.

---

## Phase 9 — Add Sanitized DOM Capture

Capture only information needed to support a new layout.

Allowed:

- sanitized applicant-panel HTML
- headings
- accessible labels
- section map
- reader results
- unmatched headings
- detected UI type
- build ID

Never capture:

- cookies
- session tokens
- passwords
- credentials
- unrelated page content
- unrelated browser storage

Give every capture a stable name so it can become a fixture.

### Phase 9 completion

Stop and report:

- capture data format
- sanitization rules
- sensitive-data exclusions
- sample capture result
- tests performed

Do not start Phase 10 automatically.

---

## Phase 10 — Add Fixture-Based Regression Tests

Store sanitized captured layouts as fixtures:

```text
tests/
  fixtures/
    current-ui.html
    alternative-ui.html
    another-ui.html
```

Run the same readers against every fixture.

Verify:

- applicant identity
- name
- current role
- current company
- Experience
- Education
- Contact
- Resume
- same final schema
- no applicant-data leakage
- no section mixing

Use `linkedom` only as a development dependency if approved. Do not include it in the production extension bundle.

### Phase 10 completion

Stop and report:

- fixtures added
- test dependency added, if any
- tests for each layout
- proof that old layouts still pass
- proof that new layouts produce the same schema

Do not start Phase 11 automatically.

---

## Phase 11 — Contact and Resume Variants

Support different Contact and Resume UIs without changing the normal workflow.

Contact may appear as:

- modal
- drawer
- popover
- inline block
- expanded section

Resume may appear as:

- direct link
- document card
- button metadata
- viewer descriptor
- download action

Use:

```text
direct source
→ layout-specific fallback
→ viewer fallback
```

Keep:

- one Contact opening per applicant
- Resume linked to the correct applicant
- current file naming
- current download behaviour
- no reuse of a previous applicant's Resume link

### Phase 11 completion

Stop and report:

- Contact variants supported
- Resume variants supported
- direct and viewer paths tested
- applicant-identity checks
- proof that current Contact and Resume paths still work

Do not start Phase 12 automatically.

---

## Phase 12 — Final Live Validation

Use focused tests during development. Run the full live regression only before completion or after changing shared identity, saving, pagination, Contact, Resume, or the main extraction flow.

Final validation must confirm:

- current UI still works
- every new supported UI works
- the same applicant schema is produced
- current CSV remains compatible
- existing fields are not lost
- Experience and Education remain separate
- no data leaks between applicants
- right-side scrolling loads all sections
- Contact works
- Resume works
- every applicant saves once
- next applicant opens correctly
- applicant page order is preserved
- pagination works
- Stop Everything works
- interrupted runs remain restartable

### Phase 12 completion report

Report:

- all supported UIs
- all files changed
- existing readers preserved
- fallback readers added
- layout detection
- section mapping
- scroll-container handling
- diagnostics and captures
- fixtures and tests
- proof that current workflow still works
- proof that extracted data did not regress
- current commit
- rollback command

---

# Phase Working Rule

For every phase:

1. Read `CLAUDE.md`.
2. Read this file.
3. Work only on the current phase.
4. Make the smallest safe changes.
5. Run focused tests for the code changed.
6. Preserve the current workflow and extracted data.
7. Stop after the phase is complete.
8. Report the results.
9. Wait for approval before starting the next phase.

Do not combine multiple phases into one large refactor.

# Phase 1 Starting Prompt

```text
Read `CLAUDE.md` and `docs/multiple-linkedin-dom-ui-support-guide.md`, begin Phase 1 only, protect and document the current working UI and extracted data, then stop and report before starting Phase 2.
```

# Prompt for the Next Approved Phase

```text
Read `CLAUDE.md` and `docs/multiple-linkedin-dom-ui-support-guide.md`, continue with the next approved phase only, preserve the current workflow and extracted data, then stop and report.
```
