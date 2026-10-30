# Implementation Plan — BABA AI Business Automation OS

## Product boundary
The current product is a YouTube automation app. Business automation is a substantial new product surface; it must be added in small steps and must not be described as complete until implemented and tested.

## Milestone 0 — baseline (current)
- Record current routes, environment requirements, deployment commands and known limitations.
- Preserve the existing default branch and add new work on a feature branch.
- Run the existing test suite and capture results before feature work.

## Milestone 1 — secure foundation
- Map all API routes and authentication boundaries.
- Decide on a durable database based on existing infrastructure and budget.
- Add schema migrations, backup/restore instructions, server-side validation and safe error handling.
- Add authentication/roles before persisting business customer data.
- Add audit events with redaction; never log credentials or sensitive payloads.

## Milestone 2 — CRM
- Tenant, user, lead, interaction, follow-up, client, service package and project entities.
- Server-enforced ownership and tenant scoping on every operation.
- Search, pagination, status filters, follow-up dates and CSV export.
- Empty states instead of fabricated demo data.

## Milestone 3 — approval queue
- Store exact proposed action and payload hash on the server.
- States: draft, pending_approval, approved, executing, completed, rejected, failed, expired.
- Expiry, replay prevention, idempotency, actor/timestamp audit log and re-approval on payload change.
- External messages, paid operations and sensitive actions require explicit approval.

## Milestone 4 — sales/service workflows
- Generate drafts for outreach, follow-ups, proposals and delivery checklists.
- Validate AI output; do not invent lead details or claim unverified results.
- Manual trigger first; only add scheduled execution when hosting persistence and scheduler reliability are confirmed.

## Milestone 5 — payment ledger
- Provider adapter, server-created orders, verified signatures/webhooks, deduplication and reconciliation.
- Separate invoice, order, payment, refund and settlement states.
- Sandbox tests first. No simulated production payments or automatic transfers/refunds.

## Milestone 6 — reporting and cost controls
- Track actual recorded leads, work, provider usage, invoices, verified payments, settlements and expenses.
- Distinguish gross revenue, operating expenses, estimated profit and cash settled.
- Per-tenant usage caps, 429 stop behavior, timeouts and bounded retries.

## Milestone 7 — release
- Automated tests, security review, migration/rollback plan and mobile QA.
- Deploy only after owner approval; verify health endpoint and logs after release.

## Acceptance criteria
A milestone is complete only when implementation exists, tests are executed and pass, data survives restart where persistence is required, authorization is tested, and docs describe actual behavior. A dashboard screenshot or successful build alone is not acceptance.
