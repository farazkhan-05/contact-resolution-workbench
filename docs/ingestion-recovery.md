# Ordinary ingestion recovery

Starting main: `f5d2651135b785340620b13c1070824daa731901`. Source: exact F08/F12/F13/F14/F15 sections of the 3 October 2026 re-baseline audit.

Before changing application code, five synthetic frontend reproductions passed by asserting the defects: failed AI retained a locked Job after Close/reopen; a status error was hidden behind extraction progress; closing retained polling and allowed completion callbacks; review/CSV/export Retry only refreshed Cases; remount had no ordinary activity recovery.

## Recovery contract

HTTP 202 means accepted work. A failed status GET leaves the outcome unknown and never submits CSV, AI, or review again. A terminal failed AI Job can be reset with Try again, preserving editable text; only explicit Extract creates a new Job. Completed Jobs never resubmit automatically. An uncertain submission acknowledgement blocks another extraction in that mounted dialog; inspect Recent activity and Cases first.

The existing authenticated `/api/v1/jobs` endpoint lists all Jobs in the server-authorized workspace, newest first. GET by ID enforces the same ownership. Responses include timestamps, row counts, type/status, and safe error metadata, excluding payloads and task IDs. There are no server filters, pagination, or limits. No backend API or execution code changed.

Recent activity is a compact, collapsible section. It retrieves durable Jobs on authenticated mount/reload, opening, recheck, and import acceptance/completion. It shows ordinary CSV/AI imports: all active imports and the latest 20 terminal imports. InvestigationPanel remains separate. Labels are Queued, Running, Completed, Failed. Cards show creation/start/completion times and imported counts; error codes map to simple safe text. Arbitrary error messages, source labels, raw evidence, task IDs, and internal exceptions are excluded.

Opening activity resumes read-only tracking of active Jobs. Closing activity stops card polling. Reload leaves activity and the AI modal closed; Cases load through their normal API. Activity's Refresh cases retrieves completed Cases without repeating ingestion.

AI polling belongs to the open dialog. Closing/unmounting invalidates its generation and cancels its timer. Reopening checks the retained Job. Deterministic generation guards reject late responses from an old Job or closed dialog. The Case refresh callback also checks ownership after its asynchronous read. CSV tracking remains application owned, with workspace/session and request-generation checks.

Status errors pause polling and show Check again, which only GETs durable status. Jobs active for two minutes, measured from started_at or created_at, show “This is taking longer than expected.” Status remains authoritative; no failure transition or replay is invented.

The generic banner Retry is removed. Queue errors offer Refresh cases; detail and uncertain review errors offer Refresh case. Review controls require durable read-back after an uncertain write. CSV status errors offer Check again; submission/terminal failures point to activity. Export errors offer Try export again, repeating only the GET/download.

The AI dialog focuses its input or an available button, supports Escape outside an in-flight submission, restores trigger focus (or the compact actions trigger), and announces status/errors. F19 remains partial: no complete focus trap/background inertness; credential dialogs are outside scope.

## Verification and limitations

Deterministic tests cover failure reset/new submission, read-only status recovery, Close/timer cancellation, reversed A/B responses, old-generation completion after a new attempt, reload of all four states, long-running visibility, bounded display/privacy/workspace switching, uncertain submission, focus/Escape/return, queue labeling, review read-back, export-only retry, CSV recheck, and ordinary success. Local Playwright verifies mocked status failure/recheck, completed activity after reload, desktop/mobile layout, and existing shell/auth/review/CSV/export/Sources paths. Its stale CSV success assertion and incomplete mock Job identity were updated to the existing contract.

An added backend test verifies the unchanged Jobs list's isolation, ordering, timestamps, and private-field exclusion. The local verification totals are recorded below; subsequent release evidence is in the [October acceptance record](production-release-acceptance-2026-10-11.md).

Final local gates: 101 frontend unit tests passed; 8 local Playwright tests passed; consolidated backend regressions with disposable localhost PostgreSQL passed 194 tests with 5 optional investigation integration tests skipped. Aggregate: 303 passed, 5 skipped. Frontend TypeScript/build, tracked-source lint and backend changed-test Ruff passed. Full frontend lint also passed with `.system_generated/**` excluded; an unqualified initial lint run found six pre-existing errors in the ignored audit probe. No expensive live provider matrix was rerun.

F12/F13/F14/F15 are addressed. F08 is partially addressed: stale work is visible and recheckable, but lost delivery or killed workers can still leave durable Jobs active indefinitely. No reconciler, scheduler, watchdog, outbox, automatic replay, worker kill recovery, historical repair, or execution-state change was implemented.

The list API fetches full workspace history before the modest frontend filter; this is intended for bounded portfolio use. A lost submission acknowledgement cannot be correlated to one particular Job through current safe response fields; the UI directs the user to activity/Cases and does not guess or repeat the write. Historical outcomes are not repaired.
