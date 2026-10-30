# Payments and Settlements — Design and Safety

## Status
A verified payment/settlement integration is not implemented by this documentation change. Do not display any payment as successful unless the configured provider confirms it through a verified server-side event or reconciliation.

## Required state separation
- Invoice: draft, issued, overdue, cancelled.
- Order: created, pending, failed, cancelled.
- Payment: pending, authorized, captured/paid, failed, refunded, partially_refunded.
- Settlement: pending, processing, settled, failed, reversed.
- Expense: recorded, pending, paid.

Order creation or a browser redirect is not proof of payment. A captured payment is not proof that the payout reached the bank.

## Future implementation checklist
1. Confirm provider eligibility, KYC, current fees and terms.
2. Create orders on the server and validate amount/currency server-side.
3. Verify provider signatures using the official procedure and raw request body where required.
4. Deduplicate webhook event IDs and make processing idempotent.
5. Persist provider references, timestamps and reconciliation results.
6. Keep refunds behind explicit owner authorization.
7. Test in provider sandbox; do not fabricate production events.
8. Never collect/store UPI PINs, OTPs, banking passwords or raw card details.
