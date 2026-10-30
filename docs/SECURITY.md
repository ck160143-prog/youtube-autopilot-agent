# Security Baseline

## Current status
This document records minimum requirements; it does not claim the existing application is already a hardened multi-tenant SaaS. Refer to `PROJECT_AUDIT.md`.

## Required before onboarding business customers
- Authentication and server-side role checks on every private endpoint.
- Tenant ownership enforced in database queries/policies, not only frontend filters.
- Input validation, bounded request sizes, rate limiting and safe error responses.
- CSRF controls for cookie-authenticated state-changing actions where applicable.
- Secure cookie settings and OAuth state validation.
- Secret redaction in logs and no credentials in Git.
- Idempotency and replay/expiry checks for approval and payment events.
- Database backups, migration review and a tested rollback path.
- File upload validation, size/type limits and safe temporary-file cleanup.
- Data minimization, retention/deletion policy and customer consent/permissions.
- Least privilege for providers and integrations.

## Human approval
Do not send customer messages, publish public videos, create paid commitments, charge customers, issue refunds, or perform money movement without the required explicit approval and provider authorization.

## Incident response
If a secret is exposed: revoke/rotate it with the provider, update the deployment secret, check logs for misuse, and document the incident without copying the secret into the report.
