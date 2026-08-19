# Alert Delivery

Alert generation is deterministic and persisted before delivery. The delivery layer is downstream of the archive and cannot change risk classification or execution parameters.

## Sinks

`AlertSink` is the provider-neutral interface. The current sinks are:

- `console`: structured redacted logs for local operation;
- `webhook`: HTTPS POST with HMAC authentication and an idempotency key.

Configure the webhook on the server only:

- `EGRESS_ALERT_WEBHOOK_URL`
- `EGRESS_ALERT_WEBHOOK_SECRET` (at least 32 characters)
- optional `EGRESS_ALERT_WEBHOOK_SINK_ID`

The URL and secret must be supplied together. Embedded URL credentials are rejected. `NEXT_PUBLIC_` configuration is rejected for database, webhook-secret, signer, private-key, and mnemonic names.

## Delivery guarantees

Each alert/sink pair has one durable idempotency key: `<sink-id>:<alert-id>`. PostgreSQL or the local test archive stores delivery attempts, response status, retry timing, and a lease. A worker claims a lease before sending. Lease IDs are random UUIDs, so workers starting in the same millisecond cannot accidentally share an active lease. Retries are bounded by configured per-run and total-attempt limits with deterministic exponential backoff.

An external provider may receive a request immediately before a worker crashes. A later retry can therefore be attempted, but it carries the same idempotency key and signed alert identity. Exactly-once delivery cannot be guaranteed by Egress alone.

Delivery failure degrades operator health; it does not invalidate a successfully archived observation and never enables a transaction.
