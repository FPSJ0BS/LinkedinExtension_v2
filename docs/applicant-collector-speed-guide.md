# Applicant Collector Speed Guide

This file belongs in the applicant-extension project.

It is not a task file and it is not part of the separate logging or Time Machine project.

Claude Code should read this file whenever work involves applicant speed, scrolling, repeated profiles, resume timing, applicant switching, or unnecessary delays.

---

## Main rule

Keep all current data collection working.

Do not remove or weaken the existing extraction logic.

The collector must continue collecting the same data it collects now, including:

- Name
- Email
- Phone number
- Current company
- Current role
- Total experience
- Education
- Resume information
- Resume download
- Contact information
- Applicant saving
- Pagination
- Restart after interruption

The goal is only to make the workflow faster and remove unnecessary actions.

---

## Problems seen in the video

- The same applicant sometimes opens again before moving to the next applicant.
- One fixed or default profile sometimes appears between applicants.
- The collector waits too long between applicants.
- Some scrolling is repeated.
- The left applicant list sometimes moves while the right profile is being read.
- The profile scrolls down and later goes back up for resume handling.
- The resume viewer opens more often than necessary.

---

## Scrolling must remain

Do not remove right-side profile scrolling.

The right-side applicant profile must still scroll from top to bottom because experience, education, and other sections may load only after scrolling.

Improve it like this:

- Scroll the right-side profile once from top to bottom.
- Keep moving downward until all sections have loaded.
- Wait only when new content is loading.
- Do not repeatedly scroll over the same area.
- Do not scroll back to the top after reaching the bottom.
- Do not scroll the left applicant list while extracting the right-side profile.

The left applicant list should only scroll when collecting the full applicant roster for the current page.

---

## Correct workflow

For each page:

1. Collect the complete applicant list in the page's original order.
2. Return the left applicant list to the top.
3. Open the exact first applicant.
4. Confirm that the correct applicant is open.
5. Collect the top profile information.
6. Open contact information once and collect it.
7. Check for the resume while still near the top.
8. Download the resume if available.
9. Scroll the right-side profile from top to bottom once.
10. Collect all remaining profile data.
11. Save the applicant once.
12. Open the exact next applicant directly.
13. Repeat until the page is complete.
14. Move to the next page.

---

## Stop reopening the same applicant

After one applicant is saved, open the exact next applicant directly.

Do not:

- Return to the previous applicant
- Open the first visible applicant
- Open a default applicant
- Wait for the wrong applicant to settle
- Save the wrong applicant
- Process the same applicant twice

Use a stable applicant ID, profile link, or another reliable identifier.

---

## Remove only unnecessary scrolling

Keep the required right-side profile scrolling.

Remove only:

- Repeated scrolling over the same section
- Unnecessary upward scrolling
- Left-side list scrolling during right-side profile extraction
- Scrolling back to the top only for resume handling

---

## Resume handling

Handle the resume before the full profile scroll.

Use this order:

1. Look for a direct resume link.
2. If the link is available, use it directly.
3. If the link is not available, open the resume viewer.
4. Download the resume.
5. Close the viewer.
6. Scroll the right-side profile to the bottom once.

Do not scroll to the bottom and then return to the top for the resume.

---

## Remove unnecessary delays

Do not use long fixed waits when the required content is already ready.

Wait only for real conditions:

- Correct applicant opened
- Loading skeleton disappeared
- Contact information opened
- Resume viewer opened
- Resume download started
- New profile content loaded
- Save completed
- Next applicant row is ready

Keep short waits only where LinkedIn actually needs them.

---

## Keep applicant checking safe

The collector must still confirm that the correct applicant is open.

Use this simple flow:

1. Wait for the old profile to disappear.
2. Wait for the expected applicant to appear.
3. Let the profile settle once.
4. Check the applicant identity three quick times.

Do not perform the full loading and settling process three times.

If the wrong applicant appears, do not save it.

---

## Do not overcomplicate the fix

Make the smallest safe changes.

Do not:

- Redesign the collector
- Create a new architecture
- Rewrite working extraction code
- Change the data schema
- Change the CSV
- Change working pagination
- Change the separate logging project

Focus only on:

- Wrong applicant opening
- Same applicant reopening
- Unnecessary waits
- Repeated scrolling
- Resume ordering
- Left and right scroll confusion

---

## Success checks

The fix is complete when:

- The same applicant does not reopen unnecessarily.
- The next applicant opens directly.
- The left applicant list does not move while reading the right-side profile.
- The right-side profile still scrolls fully from top to bottom.
- All current data fields are still collected.
- Contact information still works.
- Resume download still works.
- Every applicant is saved once.
- No partial applicant is saved.
- Pagination still works.
- Stop Everything still works.
- The collector remains restartable.
- The collector is faster than before.

---

## Testing

Do not run the full collector regression after every small speed or scrolling edit.

### During normal speed and scrolling work

Run only the focused checks related to the code changed.

Examples:

- If row selection changed, verify that the exact next applicant opens directly.
- If profile scrolling changed, verify that the right-side profile reaches the bottom and the left applicant list does not move.
- If waiting logic changed, verify that the correct applicant is confirmed and unnecessary delay is reduced.
- If resume ordering changed, verify the resume flow still works for one applicant with a resume.
- If save timing changed, verify that one applicant is saved once.

Use the smallest useful test that proves the current change.

### Run the full regression only when required

Run the complete five-applicant and pagination test:

- Before declaring the speed work complete
- Before creating the final commit or release
- After changing shared extraction flow, applicant identity, saving, pagination, contact handling, or resume handling
- When a focused test shows unexpected behaviour
- When the user specifically asks for a complete validation

The full regression should verify:

- Correct applicant opened
- Right-side profile reached the bottom
- Existing fields were collected
- Contact details were collected
- Resume downloaded when available
- Applicant saved once
- Next applicant opened directly
- Pagination still worked
- Collected data did not regress

A small speed or scrolling edit should not be blocked by rerunning every full-data test each time.

---

## Claude Code instruction

Before working on applicant speed, scrolling, repeated profiles, resume timing, applicant switching, or delays:

1. Read this file.
2. Keep all current data collection working.
3. Make only the smallest safe changes.
4. Do not modify the separate logging project.

After finishing, report:

- Files changed
- Cause of the repeated profile
- Delays removed
- Scrolling changes
- Proof that right-side scrolling still collects all data
- Proof that existing fields still work
- Test results
- Current commit
- Rollback command
