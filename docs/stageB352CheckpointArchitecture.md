# Stage B3.5.2 Architecture Specification: Hourly Audit Checkpoint Generation & Recovery

## 1. Executive Summary

Stage B3.5.2 introduces a deterministic, recoverable, and idempotent hourly checkpoint generation subsystem for the **Namma Blood** administrative decision audit ledger.

This milestone establishes the local foundation for compliance verification by compiling committed audit blocks into cryptographically chained, immutable checkpoint records stored locally in MongoDB.

> [!CRITICAL]
> **Milestone Boundary**:
> Stage B3.5.2 generates and persists local checkpoints only. External WORM anchoring remains unimplemented.
> Local checkpoint generation does **NOT** provide AWS S3 Object Lock protection, digital signing, or regulatory compliance immutability. Those capabilities belong strictly to future authorized milestones (B3.5.3, B3.5.4, and B3.5.5).

---

## 2. Watermark Separation Architecture

To prevent architectural drift and race hazards, Namma Blood strictly decouples three distinct watermarks:

```
[ Operational Ledger ]      [ Local Checkpoints ]        [ External Compliance Anchor ]
  AuditChainHead              AuditCheckpointCursor        AuditChainHead
  - sequenceNumber            - lastCheckpointedSequence   - lastAnchoredSequence
  - latestRecordHash          - lastCheckpointHash         - lastAnchoredHash
  - totalRecords              - totalCheckpoints           - lastAnchoredAt
        │                           │                            │
        ▼                           ▼                            ▼
  Advances per               Advances per                 Advances ONLY after
  committed txn              persisted checkpoint         independent S3 WORM
  in B3.4/B3.5.1             in B3.5.2                    verification in B3.5.4
```

1. **Operational Audit Head (`AuditChainHead.sequenceNumber`)**:
   Tracks the latest sequence number written by live transactions in `AdministrativeDecisionAudit`.
2. **Checkpoint Coverage Cursor (`AuditCheckpointCursor.lastCheckpointedSequence`)**:
   Tracks the highest sequence number compiled into a locally verified, successfully persisted `PENDING` checkpoint.
3. **External Anchored Watermark (`AuditChainHead.lastAnchoredSequence`)**:
   Tracks the sequence independently verified as stored under AWS S3 Object Lock in `COMPLIANCE` retention mode. **MUST NEVER** advance during local checkpoint generation.

---

## 3. Checkpoint Data Model & Indexes

### Model: `AuditCheckpoint` (`backend/Hospital/auditCheckpointModel.js`)

| Field | Type | Description |
|---|---|---|
| `ledgerId` | String | Target ledger ID (`GLOBAL_ADMIN_AUDIT_HEAD`) |
| `checkpointId` | String | Deterministic unique ID (`CHK-{ledgerId}-{startSeq}-{endSeq}-{utcHour}`) |
| `formatVersion` | String | Checkpoint format version (`v1`) |
| `startSequence` | Number | Starting sequence number of the covered range (inclusive) |
| `endSequence` | Number | Ending sequence number of the covered range (inclusive) |
| `recordCount` | Number | Total records covered ($endSequence - startSequence + 1$) |
| `firstRecordHash` | String | SHA-256 hash of the record at `startSequence` |
| `lastRecordHash` | String | SHA-256 hash of the record at `endSequence` |
| `previousCheckpointHash` | String | Checkpoint hash of predecessor checkpoint, or `GENESIS_CHECKPOINT_HASH` |
| `checkpointHash` | String | SHA-256 hash computed over the canonical checkpoint payload |
| `payload` | Mixed | Strict deterministic cryptographic metadata payload |
| `canonicalPayload` | String | Lexicographically sorted canonical JSON string |
| `scheduledHourUtc` | String | Normalized UTC hour (`YYYY-MM-DDTHH:00:00.000Z`) |
| `generationStatus` | String | Enum: `GENERATING`, `PENDING`, `FAILED` |
| `anchoringStatus` | String | Enum: `PENDING`, `ANCHORED`, `FAILED` (Always `PENDING` in B3.5.2) |

### Indexes & Range Protection Strategy

#### 1. Database Index Guarantees vs Application Guarantees
Standard B-Tree indexes enforce uniqueness only on exact tuples, not arbitrary interval overlap. The system therefore applies a multi-layered defense-in-depth model:

| Layer | Mechanism | Guarantees Provided | Limitations |
|---|---|---|---|
| **MongoDB Unique Index** | `{ checkpointId: 1 }` (unique) | Guarantees no two records can share the same deterministic checkpoint ID. | Does not evaluate interval geometry. |
| **MongoDB Partial Compound Index** | `{ ledgerId: 1, startSequence: 1, endSequence: 1 }` (unique for `['GENERATING', 'PENDING']`) | Guarantees no two active checkpoints can have the identical `(startSequence, endSequence)` tuple. | Cannot natively prevent partial or enclosed interval overlaps (e.g. `[1..10]` vs `[5..15]`). |
| **Distributed CAS Lease** | `AuditCheckpointCursor.activeClaim` with atomic `findOneAndUpdate` | Serializes range assignment so that concurrent workers cannot execute range calculation simultaneously. | Relies on monotonic cursor state. |
| **Transactional Overlap Validation** | `AuditCheckpoint.findOne({ startSequence: { $lte: newEnd }, endSequence: { $gte: newStart } })` inside ACID transaction | Evaluates committed state inside MongoDB multi-document transaction; aborts transaction with `OverlappingCheckpointRangeError` if an overlapping interval exists. | Evaluated at generation runtime. |
| **Schema Pre-Save Guard** | Mongoose `pre('save')` validation query | Validates that any new or sequence-modified checkpoint does not overlap with any existing active checkpoint before write persistence, even outside generation service. | Mongoose-level enforcement. |

---

## 4. Generation State Lifecycle & Immutability Consistency

To eliminate lifecycle ambiguity and preserve strict immutability, Namma Blood defines the following state lifecycle:

1. **In-Flight Claim Storage**:
   Worker generation claims are held **exclusively in `AuditCheckpointCursor.activeClaim`** as an atomic lease with TTL. Checkpoint records are **never** persisted in a partial or unverified state.
2. **Atomic Persistence as `PENDING`**:
   Once audit sequence continuity, hash chaining, and deterministic payload hashing are verified, the checkpoint is persisted directly in `generationStatus: 'PENDING'` inside the same MongoDB ACID transaction that advances the cursor and clears the active claim.
3. **Immutability Invariant**:
   Because `PENDING` checkpoints are created atomically upon full verification, they are immutable from inception. Core cryptographic fields cannot be modified via query update or document save.
4. **Stale Claim Recovery vs Checkpoint Recovery**:
   - `reconcileStaleClaims` frees expired leases on `AuditCheckpointCursor.activeClaim` (and transitions any orphaned `GENERATING` records to `FAILED`).
   - `reconcileCursorWithPersistedCheckpoints` realigns the cursor strictly forward to the highest contiguous, cryptographically verified `PENDING` checkpoint.

---

## 5. Deterministic Payload & Hash Calculation

The checkpoint payload contains **cryptographic metadata only**. In strict accordance with the Healthcare Data Minimization policy, no patient names, ages, donor details, clinical notes, evidence URLs, passwords, or tokens are permitted.

### Canonical Payload Structure
```json
{
  "checkpointFormatVersion": "v1",
  "checkpointId": "CHK-GLOBAL_ADMIN_AUDIT_HEAD-0000000001-0000000005-20261109T080000Z",
  "endSequence": 5,
  "firstRecordHash": "a1b2c3d4...",
  "lastRecordHash": "e5f6g7h8...",
  "ledgerId": "GLOBAL_ADMIN_AUDIT_HEAD",
  "previousCheckpointHash": "GENESIS_CHECKPOINT_0000000000000000000000000000000000000000000000000000000000000000",
  "recordCount": 5,
  "scheduledHourUtc": "2026-11-09T08:00:00.000Z",
  "startSequence": 1
}
```

### Hash Formula
$$H_{\text{checkpoint}} = \text{SHA256}(\text{canonicalizeValue}(P))$$

Where `canonicalizeValue` performs deterministic code-point key sorting, finite number checks, and standard ISO 8601 UTC date string serialization.

---

## 6. Concurrency, Idempotency & Lease Fencing

### 1. Generation Leases & Cryptographic Fencing
Before generation begins, a worker acquires an atomic lease on `AuditCheckpointCursor`:
- `activeClaim.claimId`: Unique claim UUID (`claim-{timestamp}-{randomHex}`).
- `activeClaim.leaseToken`: 256-bit cryptographically unpredictable hex token (`crypto.randomBytes(32).toString('hex')`).
- `activeClaim.workerId`: Worker identifier.
- `activeClaim.expiresAt`: Lease expiry timestamp ($T_{\text{now}} + \text{claimTtlMs}$).

```
[ Worker A Lease Expired ]               [ Worker B Active Lease ]
   claimId: claim-A                         claimId: claim-B
   leaseToken: token-A                      leaseToken: token-B
        │                                        │
        ▼ (Attempts Commit)                      ▼ (Attempts Commit)
 Conditional Check on Cursor:             Conditional Check on Cursor:
 match token-A & unexpired                match token-B & unexpired
        │                                        │
        ▼                                        ▼
    REJECTED (FencingViolation)              COMMITTED (Checkpoint & Cursor Advanced)
```

#### Fencing Invariants:
1. **Pre-Commit Fencing Verification**:
   Inside the transaction session, before persisting the checkpoint document, the worker queries `AuditCheckpointCursor` matching `_id`, `claimId`, `leaseToken`, and `expiresAt: { $gt: commitNow }`. If not matched, the transaction aborts with `FencingViolationError`.
2. **Conditional Atomic Advancement**:
   Cursor advancement (`lastCheckpointedSequence`, `lastCheckpointHash`) is executed via `findOneAndUpdate` strictly conditioned on the same `claimId`, `leaseToken`, and unexpired timestamp. If a concurrent worker took over the lease, zero documents match and the transaction aborts.
3. **Lease Preservation on Release**:
   `releaseGenerationClaim(claimId, leaseToken)` enforces matching both `claimId` and `leaseToken`, preventing an expired worker from inadvertently clearing or corrupting a replacement worker's active lease.
4. **Failure Logging Fencing**:
   Workers aborted due to `FencingViolationError` are prohibited from creating `FAILED` checkpoint records, ensuring an expired worker never corrupts or collides with a replacement worker's progress.

### 2. Idempotent Scheduling
If checkpoint generation is triggered multiple times for the same UTC hour or sequence range:
- The service inspects `AuditCheckpoint` for an existing `PENDING` record matching `scheduledHourUtc` or `checkpointId`.
- If present, it returns `{ status: 'ALREADY_EXISTS', idempotent: true }` without inserting a duplicate.

---

## 6. Crash Recovery & Failure Handling

| Failure Point | Impact | Recovery Mechanism |
|---|---|---|
| Crash before validation | Claim remains on cursor | `reconcileStaleClaims` frees cursor when lease expires |
| Failure during validation | Range verification throws | Claim is released immediately; zero records written |
| Crash during persistence | Transaction aborts | MongoDB ACID transaction rolls back both document and cursor |
| Crash after persistence before cursor | Checkpoint exists, cursor behind | `reconcileCursorWithPersistedCheckpoints` detects highest contiguous checkpoint and advances cursor safely |
| Missing audit records | Sequence discontinuity | Fails closed; halts generation; preserves ledger state |

---

## 7. Scheduler Configuration

Environment variables and defaults:

| Variable | Default | Boundary Rules |
|---|---|---|
| `ENABLE_AUDIT_CHECKPOINT_SCHEDULER` | `false` | Must be explicitly enabled; false in dev/test |
| `AUDIT_CHECKPOINT_INTERVAL_MS` | `3600000` (1 hr) | Clamped to minimum 5000ms |
| `AUDIT_CHECKPOINT_BATCH_LIMIT` | `1000` | Clamped to 1–5000 records |
| `AUDIT_CHECKPOINT_CLAIM_TTL_MS` | `60000` (1 min) | Clamped to minimum 5000ms |

---

## 8. Operational Troubleshooting

1. **`CLAIM_ACTIVE` in logs**: Another scheduler instance or manual tick is actively running. If the process crashed, the claim will automatically expire within 60 seconds and recover on the next tick.
2. **`Audit Ledger Incomplete`**: A sequence gap was detected in the database. Run `verifyAuditChainIntegrity()` to locate the missing sequence number. Checkpoint generation will fail closed until the ledger sequence continuity is resolved.
3. **`Data Tampering Detected`**: A record's stored hash does not match its canonical recomputed SHA-256 hash. Investigate raw database access logs.
