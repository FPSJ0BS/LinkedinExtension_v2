# Applicant messaging — how to use it, and what it will refuse to do

Message one applicant at a time from a reusable template, filled in from the data
already collected about that person. Added in **3.10.0** (TASK-0188).

---

## The one thing to understand first

**The extension types the message. You send it.**

LinkedIn's composer has a footer reading *"Press Enter to Send"*. This feature
fills the box and stops there. You read what it wrote, and you press Enter.

That is not a limitation that was worked around — it is the design, and every
other safety property follows from it:

- No Send control is ever resolved, found or pressed. `send` and `inmail` stay on
  the applicant denylist for **every** purpose, so no Send control can even be
  *classified* as clickable, by any caller.
- There is no `SEND` message type in the extension, so nothing could ask for one.
- There is no bulk anything. No "message all", no multi-select, no queue, no loop
  over the list. One applicant, one composer, one insertion, driven by you.

If you want a message sent, a human sends it. That is the whole contract.

---

## Setup

None beyond installing the extension — see [SETUP.md](SETUP.md). Templates are
stored locally in `chrome.storage.local`, never in the profile database, and
never leave your machine.

---

## Using it

1. **Open the applicant on LinkedIn.** Go to your job's applicants page and click
   the person you want to message, so their panel is open on the right.
2. **Open the extension's applicants dashboard** and select that same applicant.
3. **Pick a template, or type a custom message.** Both go in the same box — a
   custom message is just a body with no template attached.
4. **Read the preview.** It renders against that applicant's real collected data,
   so what you see is what will be typed.
5. **Press Insert.** The extension clicks the panel's own **Message** button,
   waits for the composer, checks it is addressed to the right person, and types.
6. **Read it in LinkedIn's composer, then press Enter yourself.**

---

## Template variables

Write `{{variable_name}}` anywhere in the body. Use `{{variable_name|fallback}}`
to supply a value for applicants who are missing that field.

| Token | Means | Example |
|---|---|---|
| `{{full_name}}` | Full name | RAHUL Mishra |
| `{{first_name}}` | First name | RAHUL |
| `{{first_name_titled}}` | First name, title-cased | Rahul |
| `{{headline}}` | Headline | Business Development Executive at Brevity Software Solutions |
| `{{location}}` | Location | Lucknow, Uttar Pradesh, India |
| `{{current_role}}` | Current role | Business Development Executive |
| `{{current_company}}` | Current company | Brevity Software Solutions PVT. LTD. |
| `{{total_experience}}` | Total experience | 3 years |
| `{{education}}` | Education | University of Lucknow |
| `{{job_title}}` | The job they applied to | Senior Frontend Engineer |
| `{{job_company}}` | That job's company | Acme Technologies |
| `{{applied_at}}` | When they applied | 2 weeks ago |

**Why `{{first_name_titled}}` exists.** Real LinkedIn data contains names like
`RAHUL Mishra`, and `Hi RAHUL,` reads badly. The titled variant fixes a name that
is *all upper* or *all lower* case and leaves anything already mixed alone — so
`McDonald`, `de Souza` and `O'Brien` are never "corrected" into something wrong.

Limits: template name ≤ 80 characters, body ≤ 8000. Over 1900 characters you get
a warning, because that is the InMail ceiling — a warning, not a refusal.

---

## Why a message gets blocked

**A variable with no value blocks the message.** If an applicant has no
`current_company` and your template says `…your work at {{current_company}}`, the
Insert button is disabled and the UI names the variable.

This is deliberate, and it is the most important rule in the feature. The
alternative is sending someone `Hi ,` or `…your work at .` A missing value stays
empty and **a wrong value is worse than a blank one** — so instead of quietly
rendering nothing, it stops and tells you.

Two ways to fix it:

- Give the variable a fallback: `{{current_company|your current company}}`
- Or edit the message for that person.

---

## Why an insertion gets refused

Each refusal is specific on purpose, so you can tell what to do next.

| What you see | What happened |
|---|---|
| The hiring page is showing a different applicant | The panel on LinkedIn is open on somebody else. Open the right person there first. |
| Open the applicant on the hiring page first | No applicant panel is open at all. |
| The composer is addressed to someone else | LinkedIn's messaging overlay is still showing a previous conversation. |
| There's already text in the composer | You have a draft in there. It is never appended to and never cleared — deal with it yourself. |
| No Message button was found on that applicant's panel | The panel offers no Message control on this layout. |
| The text didn't land correctly | It was typed but reading it back did not match. **Check the composer before sending.** |

**The recipient check is not paranoia.** LinkedIn's messaging overlay persists as
you move between applicants, so the *previous* person's conversation is routinely
what is on screen when the next one opens. The composer must say who it is
addressed to and agree — silence is refused, never assumed — and a composer
naming two people is refused outright. Being wrong here does not cost a blank
field, it sends one applicant's message to another applicant.

---

## What it may click

Exactly one new control: **the applicant panel's own `Message` button**, and only
when its whole label is `Message` (optionally followed by the person's name, the
way a screen-reader name renders it).

Still refused, right next to it: **Rate as**, **More…**, Reject, Shortlist, Move
to, Archive, Hire, Interview, Schedule, Add note — every control that would change
your ATS — plus **Send**, **InMail**, and anything offering to message a *set* of
people (`Message all`, `Message selected`). See rule 5 in
[CLAUDE.md](../CLAUDE.md).

---

## Before you trust it

**None of this has been run against a live LinkedIn page.** Fixtures are not the
live DOM (rule 20). The first real run is yours, and unlike everything else this
extension does, a mistake here reaches a person rather than a spreadsheet cell.

So the first time: pick one applicant, insert, and **read the composer carefully
before pressing Enter.** If something is wrong, the message has not gone
anywhere — that is exactly why the extension stops where it does.
