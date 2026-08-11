# Agent Coordination, Claims and Leases

## 1. Core invariant

At any instant, a work item may have **at most one valid active claim**.

This is a database invariant, not a UI convention.

## 2. Atomic claim

Never implement:

```text
read status -> if backlog -> write in_progress
```

because two processes can race.

Use one transaction/conditional update. Conceptually:

```sql
BEGIN IMMEDIATE;

UPDATE work_items
SET status = 'in_progress', updated_at = :now
WHERE id = :id
  AND status = 'backlog';

-- Continue only if exactly one row changed.
-- Insert/replace the new active claim inside the same transaction.

COMMIT;
```

If lease expiry can leave stale `in_progress` state, normalize expired claims inside the same transaction before evaluating claimability, or represent current status through authoritative claim state. Choose one consistent model and test it under races.

## 3. Claim token

A successful claim returns a cryptographically strong opaque token.

Requirements:
- generate >=128 bits entropy;
- do not derive from agent/session names;
- store only a secure hash when practical;
- never expose to other agents through list/get APIs;
- require for heartbeat, release, block and complete.

This protects against stale/restarted agents mutating work after ownership changed.

## 4. Lease semantics

Project setting:
- default lease: 30 minutes;
- recommended heartbeat: 5 minutes.

On heartbeat:
- verify token;
- verify current active claim;
- verify not already expired/reclaimed;
- set last heartbeat to now;
- set expiry to now + default lease.

Do not extend from the previous expiry indefinitely; extend from a trusted current timestamp.

## 5. Expiration

An expired claim is no longer ownership.

On expiry:
- claim state -> expired;
- work item becomes Backlog;
- activity event written;
- prior token becomes invalid permanently.

Expiry handling should be safe if two processes notice the same expiry concurrently.

## 6. Human forced release

The app may allow a user to release an active claim.

Behavior:
- warning if heartbeat is recent;
- transactionally invalidate claim and return item to Backlog;
- record actor and reason;
- old agent receives `CLAIM_TOKEN_INVALID` or `CLAIM_EXPIRED` on its next heartbeat/completion attempt.

## 7. Completion race

If an agent's lease expires immediately before completion, completion must fail unless the product intentionally provides a small grace period. V1 recommendation: **no hidden grace period**. Keep semantics deterministic.

Agent should heartbeat before long final validation/commit steps or immediately before completing.

## 8. Multiple different work items touching same code

V1 prevents duplicate work-item ownership only. It does **not** guarantee two different work items cannot modify overlapping files/components.

Future extension:
- `affected_components`;
- `affected_paths` or glob patterns;
- branch/worktree identity;
- warning or reservation for overlapping work.

Do not block V1 on this feature.

## 9. Git/worktree recommendation

Future agent integrations should encourage one branch/worktree per claimed item, e.g.:

`workstack/WS-109-support-pasted-images`

Workstack may record branch/worktree metadata without owning Git operations in V1.

## 10. Concurrency test cases

Must automate at least:

### Same item simultaneous claim
Launch 20 claim attempts for the same backlog item. Exactly one succeeds.

### Token isolation
Winner's token is not visible to losers or list APIs.

### Heartbeat vs forced release
After forced release, a concurrent/late heartbeat with old token cannot resurrect the claim.

### Expiry vs reclaim
After expiry, one new agent can claim. Old token can neither heartbeat nor complete.

### Double completion
Only one completion record exists even if client retries.

### App + MCP concurrency
App can read/update unrelated metadata while MCP claim transaction occurs without DB corruption.
