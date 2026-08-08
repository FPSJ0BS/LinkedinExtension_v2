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
