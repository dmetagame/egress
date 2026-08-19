# Retention Policy

Retention policy version `1` is intentionally conservative.

| Record | Policy |
| --- | --- |
| Canonical snapshots | Indefinite; never automatically deleted |
| Observation records | 3650-day review window |
| Alert records | 730-day review window |
| Operational events | 90-day review window |
| Alert delivery records | 90-day review window |

Automatic pruning is disabled. A review window is not permission to delete evidence. Any future pruning must:

1. use a new policy version;
2. preserve canonical snapshots needed to reproduce decisions;
3. write an auditable record to `egress_live_retention_audit`;
4. be run as an explicit operator action outside the poll cycle.

Review the current policy without modifying data:

```bash
npm run live:archive -- retention
```

Historical records remain distinguishable from current state. A previous complete snapshot is history only when the current observation is unavailable, stale, or invalid.
