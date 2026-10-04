# Round 2 — privacy, message types, scheduling

Build order: **A → B → C**. Each part is deployed and tested before the next starts.

---

## A. Number privacy (display-only)

**Goal:** phone numbers are hidden on screen by default; the last 4 digits identify a person.

- Hiding happens **in the browser only** — no extra requests. The server sends numbers as before.
  (Protects against people looking at the screen, not against a signed-in user opening developer tools.)
- Applies to contacts, students (father/mother), opt-outs, campaign reports and our own sender numbers.
- **👁 button** shows the number instantly with a **copy** button; it hides again after 30 s (configurable)
  or when you leave the page. **Show all numbers / Hide numbers** for the whole table.
- **Search keeps working** (search "3210" or the full number).
- **Settings → Privacy:** hide numbers on/off, re-hide time.

---

## B. People, labelled numbers and message types

### People instead of phone rows
- A **person** has a name, notes and **several labelled numbers**: Personal, Work, Home, or any custom label; one is **primary**.
- Lists contain **people**. The same person in three lists is one person with one set of numbers; list-specific columns from a CSV
  (route, department…) stay attached to that list membership.
- Existing contacts are converted automatically: same number in several lists → one person, number labelled *Mobile*, primary.
- **School (Frappe)** students keep their numbers labelled **Father / Mother / Student** (still read-only, synced).

### Message types (what the message is for)
Defined once in **Settings → Message types**; each has a default **number rule**, speed and quiet-hours behaviour:

| Type | Default rule | Speed | Quiet hours | Opted-out (STOP) |
|---|---|---|---|---|
| 📢 Notice | Primary number (school: primary parent) | Normal | respected | skipped |
| 💌 Invitation | Primary number | Normal | respected | skipped |
| 💰 Fees | Primary (school: Father → Mother) | Normal | respected | skipped |
| 🎉 Greeting | Primary | Safe | respected | skipped |
| ⏰ Reminder | Primary | Normal | respected | skipped |
| 🚨 SOS / Emergency | **All numbers** (school: both parents + student) | Urgent | **ignored** | **still sent** — confirmed at launch, logged |

Types can be renamed, added or removed. A **rule** is an ordered list of labels plus a mode:
*first available* (e.g. Work → Personal) or *all of them* (e.g. Father + Mother).

### Rules are layered, so nobody sets 1000 people by hand
1. **Message type default** (above)
2. **List rule** — e.g. *Staff: Notices → Work, fallback Personal; Invitations → Personal*
3. **Person exception** — only for the few people who differ (e.g. this teacher wants everything on Personal)

Missing number → next label in the rule. Two labels with the same number → one message. The preview shows the breakdown
("612 to Father, 41 fell back to Mother, 3 have no number").

### In the campaign editor
Step 1 becomes **"What is this message?"** — pick a type. It fills in the number rule, speed, quiet hours and suggests the
type's templates. Everything stays adjustable for that one campaign.

### Import
- **CSV with several phone columns** (Phone, Work Phone, Mobile 2…): a mapping screen shows the first rows and lets you label
  each phone column before importing.
- **Paste:** `Name, 98765 43210, 98111 22233` → first number primary, second labelled *Mobile 2*.

---

## C. Scheduling

A **"When"** step in every campaign:

| Mode | Options | Example |
|---|---|---|
| **Send now** | — (today's behaviour) | |
| **Once, spread out** | start date & time · daily sending window (e.g. 10:00–16:00) · daily limit for this campaign · weekdays only · skip school holidays | 1565 parents, 400/day, 10–4 |
| **Repeating** | daily · weekdays · chosen weekdays · every N days · monthly (day N / last day) — at an **exact time** (09:06) or a **random time in a window** (9–10) · ends never / on a date / after N runs · rotate message variants | Drivers, every weekday, random 9–10 |
| **Date-based (drip)** | date source: **student birthday** (Frappe) · a **date column** from a CSV or list field · one or more **steps** with offsets and their own message (−7 days, −1 day, on the day) · send time exact / random window | Birthday wishes at 8–9 am; fee reminders 7 days and 1 day before the due date |

How it works
- A scheduled campaign is a **template**; every run creates its own campaign **run** with its own report, so history is clear.
- The **audience is recalculated at every run** (new students / contacts included, left ones excluded).
- **Next 5 runs** shown before you save; schedule can be **paused, resumed, ended**.
- Runs never overlap: if the previous run is still sending, the next waits (and is logged).
- **Per-person frequency cap** (Settings, default 3 per day across all campaigns, SOS exempt) so repeating schedules can't
  flood the same parent.
- Variants rotate per run so the same text isn't sent every day (lower ban risk).
- If the app was down at run time: catch up within 2 hours, otherwise skip and log.

### Needs from Frappe
- Birthdays: `Student.date_of_birth` — **already readable** (1004/1004 filled).
- Skip school holidays: needs read access to **Holiday List** (small script for you to run, like the first Frappe setup).
- Optional later: staff from **Employee** (needs read access too).
