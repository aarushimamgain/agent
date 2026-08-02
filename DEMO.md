# Demo script

A walkthrough of what to click to prove each requirement of the platform,
using the seeded "Job Application Screening" workflow. Everything below
assumes you've followed **Setup** first.

## Setup

```bash
git clone <this repo>
cd <repo>
npm install
npm start        # auto-creates data/workflow.db and runs migrations/schema.sql
```

Leave that running (it's the Express API on `http://localhost:3000`). In a
second terminal, from the repo root:

```bash
npm run seed     # populates the demo workflow + runs described below
```

`npm run seed` is safe to re-run - it skips seeding if the workflow already
exists. To start over from empty data, stop the server, delete `data/`, and
run `npm start` again before reseeding.

In a third terminal, start the frontend:

```bash
cd frontend
npm install
npm run dev       # React app on http://localhost:5173
```

Open `http://localhost:5173`. You should see one workflow, **Job
Application Screening**.

### What got seeded

One workflow, two published versions (v2 is current), four runs:

| Candidate | Run state | What it shows |
|---|---|---|
| Dana | `completed` | classified `strong_fit` → skipped human review → auto-notified the ATS |
| Erin | `completed` | classified `needs_review` → paused for approval → **approved** → completed |
| Frank | `waiting_approval` | classified `needs_review` → paused for approval → **left untouched** |
| Grace | `failed` | classified `strong_fit` → the ATS notification step failed → **left untouched** |

Frank's and Grace's runs are deliberately left mid-flight so you have live
buttons to click during the demo instead of everything already being
finished.

The pipeline is `structured_input → document_retrieval → ai_extraction →
ai_classification → deterministic_condition → human_approval →
mock_external_action → final_report` - all 8 step types, run through
deterministic mocks (see `src/execution/mocks.js`), so nothing here needs a
real AI API key or a real ATS integration.

---

## 1. Validation

Workflows → **Job Application Screening** → **Versions & Diff** tab →
**Publish new version**.

Paste this (a `mock_external_action` step with no permissions declared) and
click **Validate**:

```json
{
  "name": "broken",
  "steps": [
    { "id": "intake", "type": "structured_input", "inputs": {}, "config": { "fields": [] }, "permissions": { "tools": [] } },
    { "id": "call_ats", "type": "mock_external_action", "inputs": {}, "config": { "action_name": "notify_ats" }, "permissions": { "tools": [] } }
  ]
}
```

You'll get back structured errors, not a 500 - among them: `"fields" must
be a non-empty array` (structured_input needs at least one field),
`Missing required config "mock_response"`, and `must declare at least one
entry in permissions.tools` (mock_external_action always calls something
external). Nothing is persisted - **Validate** only calls `POST
/workflows/validate`, which never touches the database.

---

## 2. Pause / resume (human approval)

Workflows → **Job Application Screening** → **Graph & Runs** tab → **Recent
runs** → click Frank's run (`waiting_approval`).

You'll land on the run detail page with:
- Status badge: `waiting_approval`
- **Actions**: `Approve "human_review"` and `Reject "human_review"` buttons
- The **Steps** table showing `human_review` as `paused` and everything
  after it as `pending`

Click **Approve "human_review"**. The page re-polls, the run moves to
`completed`, and the **Actions** section changes to "no further actions
available" - the pause was a real database state (`run_steps.status =
'paused'`, `runs.status = 'waiting_approval'`), not something held in a
JavaScript variable: refresh the page before clicking Approve and it's
still paused.

(Alternatively click **Reject** instead - the run fails immediately with
`Rejected by ui-user`, and the audit trail below records it as an
`approval_decision` event with `status: rejected`.)

---

## 3. Retry

Open Grace's run (`failed`, from the workflow's **Recent runs** list or
**Run History**). The **Steps** table shows `notify_ats` as `failed`, and
`final_decision` never ran.

`mock_external_action` is deliberately **not** auto-retryable (see the
`retryable` flags in `src/schema/stepTypes.js`) - it has a real side
effect, so the engine refuses to silently retry it. Click **Recover failed
run ("notify_ats")** in the **Actions** section. The run completes.

This is the manual-confirmation retry path. The *automatic* retry path
(for read-only step types like `ai_extraction`, `ai_classification`,
`document_retrieval`, capped at `MAX_AUTO_RETRIES` in
`src/execution/engine.js`) can't be triggered live here because the
deterministic mocks never fail on their own - it's exercised directly in
`__tests__/engine.test.js` (`"a retryable step type is retried
automatically..."` and the exhaustion test next to it), which forces a
handler to throw a controlled number of times.

---

## 4. Idempotency

Immediately after recovering Grace's run above, look at the **Steps**
table row for `notify_ats`, or open its entry in **Full audit trail**
further down the page. Its output is:

```json
{ "idempotent_replay": true }
```

...instead of the normal `{ "status": "recorded", "queued_for_onboarding":
true }`. That's the tell: the very first attempt (before you recovered)
already inserted a row into `idempotency_keys` for `(run_id, step_id)`
*before* calling the mock action - and it did so successfully, even though
the action itself then failed. On recovery, the engine found that existing
claim and skipped calling the action a second time entirely, because
`idempotency_keys` has a `UNIQUE(run_id, step_id)` constraint - this isn't
app logic remembering to check first, it's the database refusing a second
claim. See the design note at the top of `src/execution/engine.js` and
`__tests__/idempotency.test.js` for the constraint being exercised
directly.

---

## 5. Permissions

Workflows → **Job Application Screening** → **Versions & Diff** →
**Publish new version**. Paste the current definition with one character
changed - `notify_ats`'s permission doesn't match what it actually calls:

```json
{
  "name": "Job Application Screening",
  "steps": [
    { "id": "intake", "type": "structured_input", "inputs": {}, "config": { "fields": [{ "name": "candidate_email", "type": "string" }, { "name": "resume_url", "type": "string" }] }, "permissions": { "tools": [] } },
    { "id": "fetch_resume", "type": "document_retrieval", "inputs": { "resume_url": { "from": "intake", "output": "resume_url" } }, "config": { "source": "resume_store", "query": "by_url" }, "permissions": { "tools": ["document_store.read"] } },
    { "id": "extract_candidate_info", "type": "ai_extraction", "inputs": { "resume_text": { "from": "fetch_resume", "output": "content" } }, "config": { "model": "gpt-4o", "output_fields": ["years_experience", "skills", "education_level"] }, "permissions": { "tools": ["llm.invoke"] } },
    { "id": "classify_candidate", "type": "ai_classification", "inputs": { "candidate_info": { "from": "extract_candidate_info", "output": "fields" } }, "config": { "model": "gpt-4o", "categories": ["strong_fit", "needs_review"] }, "permissions": { "tools": ["llm.invoke"] } },
    { "id": "check_review_needed", "type": "deterministic_condition", "inputs": { "fit": { "from": "classify_candidate", "output": "category" } }, "config": { "expression": "fit == 'needs_review'", "on_true": "human_review", "on_false": "notify_ats" }, "permissions": { "tools": [] } },
    { "id": "human_review", "type": "human_approval", "inputs": { "candidate_info": { "from": "extract_candidate_info", "output": "fields" }, "fit": { "from": "classify_candidate", "output": "category" } }, "config": { "approvers": ["hiring-manager@example.com"], "message": "Please confirm this candidate should advance to the interview stage." }, "permissions": { "tools": [] } },
    { "id": "notify_ats", "type": "mock_external_action", "inputs": { "candidate_info": { "from": "extract_candidate_info", "output": "fields" } }, "config": { "action_name": "notify_applicant_tracking_system", "mock_response": { "status": "recorded", "queued_for_onboarding": true } }, "permissions": { "tools": ["wrong_permission_name"] } },
    { "id": "final_decision", "type": "final_report", "inputs": { "fit": { "from": "classify_candidate", "output": "category" }, "candidate_info": { "from": "extract_candidate_info", "output": "fields" } }, "config": { "template": "Candidate screening complete. Fit: {{fit}}. Extracted info: {{candidate_info}}." }, "permissions": { "tools": [] } }
  ]
}
```

Click **Validate** first - it passes, because `notify_ats` *does* declare a
non-empty `permissions.tools`; the validator only checks that a
tool-calling step declares *something*, not that it's the *right* thing.
Click **Publish** (uncheck "set as current" if you don't want to disturb
the demo's default version), then start a run against this new version
from **Graph & Runs** with any candidate email/resume URL. It fails at
`notify_ats` with:

```
Step "notify_ats" attempted to use tool "notify_applicant_tracking_system", which is not declared in its permissions.tools.
```

This is the point: static validation and runtime enforcement are two
different checks, and the second one catches what the first can't
(`src/execution/engine.js`'s `assertToolPermission`, checked *before* the
mock action ever runs).

---

## 6. Audit trail

Open any run (Dana's is the simplest - fully completed, no approval). Full
audit trail is the last card on the page: every AI call, tool call,
condition evaluation, skip, approval decision, retry attempt, and final
result, in true chronological order, each with a JSON payload. Compare it
against **Full audit trail** on Erin's run (the approved one) to see the
extra `approval_requested` / `approval_decision` rows and the `notify_ats`
row's `status: skipped` instead of `success`.

---

## 7. Explainability

Same run, the card above the audit trail: **Why this path (plain-English
explanation)**. For Dana's run it reads through the whole pipeline in
sentences, e.g.:

> Step "check_review_needed" (condition) evaluated "fit == 'needs_review'"
> with fit = "strong_fit": the condition was FALSE, so the run took branch
> "notify_ats" and did not take branch "human_review".

Note it states the **actual compared value** (`fit = "strong_fit"`), not
just true/false - and the skipped step's row states *why* it was skipped,
naming the condition and the branch not taken. This is generated by
`src/execution/explainRun.js`, which only formats `audit_log` rows written
at decision time - it never re-runs or re-evaluates anything.

---

## 8. Rerun

**Run History** (top nav) → pick any row → **Rerun with new input**. The
form pre-fills the workflow version and the original run's input values;
change `candidate_email` or `resume_url` and pick a different version if
you like, then **Start new run**. You're dropped on the new run's detail
page, already executing.

---

## Everything above, automated

All of this (validation rules, pause/resume, idempotency, retries,
permission enforcement, recovery) also has direct unit-test coverage with
no server or browser involved:

```bash
npm test
```

39 tests across `__tests__/` - `engine.test.js` and `observability.test.js`
are the most relevant to this walkthrough.
