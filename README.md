# X Follow Intelligence

Manifest V3 extension for tracking follows originating from networking-related posts on X and checking follow-back status.

## Version 2.1.0

Core flow:
1. Detect networking-related posts.
2. Associate Follow actions with a relevant networking post when possible, with a V1-compatible fallback.
3. Store a structured follow record.
4. Wait 30 seconds in development mode.
5. Check follow-back status.
6. Show the result in the popup.

### States
`WAITING`, `CHECKING`, `FOLLOWED_BACK`, `NOT_FOLLOWED_BACK`, `RETRY_PENDING`, `CHECK_FAILED`, `UNFOLLOWED`

### Reliability
- Stable post/follow IDs
- Storage normalization and schema versioning
- Persisted pending checks for MV3 recovery
- Serialized storage mutations
- Duplicate protection
- Safe popup rendering
- URL validation
- Bounded detected-post retention
- 90-day networking-post retention for unreferenced backend observations
- Unfollow detection cancels pending checks and records relationship history
- Networking classifier supports common professional/networking language without treating every generic `connect` mention as networking

### Development timer
The testing delay is intentionally 30 seconds: `delayInMinutes: 0.5`.

## Tests
```bash
node --check storage.js
node --check content.js
node --check background.js
node --check popup.js
node tests/storage.test.js
```


## Database migration

Before using the updated backend against an existing database, run:

```bash
psql -U <user> -d x_follow_intelligence -f backend/migrations/001_v2_1_data_model.sql
```

The migration adds per-user X-post deduplication and allows the `UNFOLLOWED` follow state.
