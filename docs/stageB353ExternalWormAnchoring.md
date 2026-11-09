# Stage B3.5.3 Architecture Specification: External WORM Anchoring using AWS S3 Object Lock

## 1. Executive Summary

Stage B3.5.3 implements the **External WORM Anchoring Subsystem** for the Namma Blood healthcare platform. Building upon the tamper-evident administrative decision ledger (Stage B3.4/B3.5.1) and hourly local checkpoint generation (Stage B3.5.2), Stage B3.5.3 provides regulatory compliance immutability by anchoring local checkpoints into Write-Once-Read-Many (WORM) storage using **AWS S3 Object Lock in COMPLIANCE mode**.

Every anchored checkpoint is signed with a detached asymmetric RFC 8032 **Ed25519** signature, uploaded to S3 with mandatory Object Lock retention, retrieved by exact VersionId, and subjected to a strict **14-point independent post-upload verification pipeline** before advancing the external compliance watermark in MongoDB.

> [!IMPORTANT]
> **Strict Regulatory Immutability**:
> Under AWS S3 Object Lock `COMPLIANCE` mode, no user, administrator, or root AWS account can overwrite or delete an anchored checkpoint until the retention period expires. Downgrading to `GOVERNANCE` mode is strictly prohibited and rejected fail-closed.

---

## 2. Watermark Separation Architecture

Namma Blood enforces strict decoupling across three distinct watermarks:

```
[ Operational Ledger ]          [ Local Checkpoints ]            [ External Compliance WORM ]
  AuditChainHead                  AuditCheckpointCursor            AuditChainHead
  - sequenceNumber                - lastCheckpointedSequence       - lastAnchoredSequence
  - latestRecordHash              - lastCheckpointHash             - lastAnchoredHash
  - totalRecords                  - totalCheckpoints               - lastAnchoredAt
        │                               │                                │
        ▼                               ▼                                ▼
  Advances per live               Advances per local               Advances ONLY after
  committed transaction           hourly checkpoint                14-point independent
  in B3.4 / B3.5.1                generation in B3.5.2             S3 verification in B3.5.3
```

### Invariants:
1. **Operational Head (`AuditChainHead.sequenceNumber`)**:
   Tracks live transactional audit writes. Anchoring operations **NEVER** touch or mutate `sequenceNumber`.
2. **Local Coverage Cursor (`AuditCheckpointCursor.lastCheckpointedSequence`)**:
   Tracks sequences compiled into local `PENDING` checkpoints. Anchoring operations **NEVER** touch the checkpoint cursor.
3. **External Anchored Watermark (`AuditChainHead.lastAnchoredSequence`)**:
   Advances monotonically **ONLY** after an exact S3 VersionId has been verified by the independent verification pipeline inside an atomic MongoDB transaction.

---

## 3. Cryptographic Detached Signing Architecture

### Specification: `backend/Hospital/auditSigningService.js`
- **Algorithm**: RFC 8032 Ed25519 (Edwards-curve Digital Signature Algorithm).
- **Signing Input**: Exact deterministic canonical JSON string produced by `canonicalizeCheckpointPayload()`.
- **Signature Output**: 64-byte raw signature encoded as 128-character hexadecimal string.
- **Key Management**:
  - Detached signatures: signature is stored in S3 evidence and MongoDB subdocument, never inlined into the canonical payload itself.
  - Private keys are never persisted in MongoDB, logs, or error messages.
  - Public keys are represented in SPKI PEM format (`-----BEGIN PUBLIC KEY-----`).
  - Private keys are represented in PKCS#8 PEM format (`-----BEGIN PRIVATE KEY-----`).
  - Key rotation supported via explicit `keyId` identifiers (e.g. `namma-blood-audit-signing-2026-v1`).

---

## 4. AWS S3 Object Lock Storage Adapter

### Specification: `backend/Hospital/auditWormStorageAdapter.js`

### Object Key Structure
`namma-blood/audit-checkpoints/v1/{ledgerId}/{checkpointId}.json`
- Strict regex validation: `/^namma-blood\/audit-checkpoints\/v1\/[a-zA-Z0-9_\-]+\/[a-zA-Z0-9_\-]+\.json$/`.
- Path traversal sequences (`..`), slashes, or special characters are rejected fail-closed.

### Object Lock COMPLIANCE Configuration
- **Retention Mode**: Strictly `COMPLIANCE`.
- **Retention Duration**: Configured via `AUDIT_WORM_RETENTION_DAYS` (minimum 1 day, maximum 36,500 days).
- **RetainUntilDate**: Calculated in UTC (`baseDate + retentionDays * 86,400,000 ms`).
- **Bucket Versioning**: Required. If `PutObjectCommand` returns a null or missing `VersionId`, the adapter fails closed.

### Least Privilege Design
- The storage adapter implements **ZERO** delete or overwrite methods (`deleteObject`, `deleteVersion`, and `putObjectRetention` are completely absent).

---

## 5. Independent 14-Point Post-Upload Verification Pipeline

Before any local MongoDB state is updated or the external watermark is advanced, the anchoring service executes 14 verification checks:

| Step | Verification Check | Failure Action |
|---|---|---|
| 1 | S3 Object Key matches deterministic pattern | Rejects (`KEY_MISMATCH`) |
| 2 | S3 VersionId exists and is non-empty | Rejects (`MISSING_VERSION_ID`) |
| 3 | S3 `GetObjectCommand` retrieves exact VersionId | Rejects (`S3_GET_FAILED`) |
| 4 | Retrieved body SHA-256 matches upload receipt | Rejects (`CHECKSUM_MISMATCH`) |
| 5 | Retrieved body is valid JSON | Rejects (`INVALID_JSON`) |
| 6 | Core metadata (`checkpointId`, `startSequence`, `endSequence`, `checkpointHash`) matches local document | Rejects (`METADATA_MISMATCH`) |
| 7 | Retrieved `canonicalPayload` matches byte-for-byte | Rejects (`PAYLOAD_MISMATCH`) |
| 8 | SHA-256 of retrieved `canonicalPayload` equals `checkpointHash` | Rejects (`HASH_MISMATCH`) |
| 9 | Detached Ed25519 signature verifies against canonical payload using public key | Rejects (`SIGNATURE_VERIFICATION_FAILED`) |
| 10 | S3 `GetObjectRetentionCommand` returns active retention | Rejects (`OBJECT_LOCK_MISSING`) |
| 11 | Retention mode is strictly `COMPLIANCE` (rejects `GOVERNANCE`) | Rejects (`INVALID_OBJECT_LOCK_MODE`) |
| 12 | `RetainUntilDate` is strictly in the future | Rejects (`EXPIRED_RETENTION_DATE`) |
| 13 | Monotonic sequence continuity: `startSequence === head.lastAnchoredSequence + 1` | Rejects (`SEQUENCE_CONTINUITY_VIOLATION`) |
| 14 | Hash continuity: `previousCheckpointHash === head.lastAnchoredHash` (for N > 1) | Rejects (`HASH_CONTINUITY_VIOLATION`) |

---

## 6. Mandatory S3 Pre-Upload Reconciliation & Version Recovery

To guarantee idempotency, crash resilience, and prevent unnecessary duplicate S3 object versions, the anchoring service implements mandatory pre-upload storage reconciliation:

```
                      [ Checkpoint to Anchor ]
                                 │
                                 ▼
                   Query S3 ListObjectVersions
                   for deterministic object key
                                 │
              ┌──────────────────┴──────────────────┐
              ▼                                     ▼
      [ Case A: 0 Versions ]              [ Case B/C/D: >= 1 Version ]
              │                                     │
     Execute PutObject with                         ▼
    ObjectLock COMPLIANCE                 Inspect every candidate version:
              │                           - SHA-256 checksum match
              ▼                           - Metadata envelope match
     Receive S3 VersionId                 - Recomputed payload hash
                                          - Ed25519 signature validity
                                          - ObjectLock mode === COMPLIANCE
                                          - Future RetainUntilDate
                                                    │
                                  ┌─────────────────┴─────────────────┐
                                  ▼                                   ▼
                       [ Case C/D: Mismatch/Conflict ]      [ Case B/D: Valid Match ]
                                  │                                   │
                             FAIL CLOSED!                     Reuse Authoritative
                       - No PutObject issued                 Existing VersionId
                       - Watermark unadvanced                - No PutObject issued
                       - Checkpoint FAILED                   - Proceed to 14-point
                       - Structured incident logged            verification & commit
```

### Reconciliation Workflow Cases:
- **Case A: No Existing Object**:
  Uploads signed evidence with `ObjectLockMode: 'COMPLIANCE'` and exact retention timestamp.
- **Case B: Single Matching Existing Version**:
  Verifies complete evidence envelope, checkpoint hash, Ed25519 signature, SHA-256 checksum, and `COMPLIANCE` retention. Reuses existing `VersionId` without issuing another `PutObjectCommand`.
- **Case C: Mismatched Existing Content**:
  Fails closed immediately. Does not overwrite or create new versions, does not advance watermark, transitions checkpoint to `FAILED`, and logs structured incident telemetry.
- **Case D: Multiple Versions**:
  Inspects all version candidates. If all versions match the expected evidence unambiguously, selects the earliest created authoritative version. If versions conflict or contain ambiguous/tampered payloads, fails closed immediately.

---

## 7. Lifecycle & Data Model Updates

### Schema: `AuditCheckpoint` (`backend/Hospital/auditCheckpointModel.js`)

#### Anchoring Statuses
- `PENDING`: Locally generated checkpoint awaiting WORM anchoring.
- `SIGNING`: Worker acquired claim and is executing detached Ed25519 signing.
- `UPLOADING`: Worker is uploading evidence payload to AWS S3 Object Lock.
- `UPLOADED`: Upload succeeded with VersionId, transitioning to verification.
- `VERIFYING`: Independent 14-point verification pipeline is executing.
- `ANCHORED`: Terminal immutable state. Fully anchored and verified.
- `FAILED`: Transient or permanent failure during signing, upload, or verification.

#### Immutability Guards
- Once `anchoringStatus === 'ANCHORED'`, the record and its `anchoringEvidence` cannot be modified or deleted via Mongoose query or document methods.
- Document-level `deleteOne` and query-level `deleteMany`, `deleteOne`, `findOneAndDelete`, `updateOne`, `findOneAndUpdate` reject modifications to anchored records with HTTP 403.

#### Anchoring Evidence Subdocument
```json
{
  "s3Bucket": "namma-blood-audit-worm",
  "s3ObjectKey": "namma-blood/audit-checkpoints/v1/GLOBAL_ADMIN_AUDIT_HEAD/CHK-001.json",
  "s3VersionId": "v_1775642400_abc123",
  "s3ETag": "9b10e43f05380550f7d8b348",
  "sha256Checksum": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "objectLockMode": "COMPLIANCE",
  "retentionUntil": "2027-04-08T10:00:00.000Z",
  "signature": "3a8f...",
  "signatureAlgorithm": "Ed25519",
  "signingKeyId": "namma-blood-audit-signing-2026-v1",
  "verifiedAt": "2026-04-08T10:05:00.000Z",
  "anchoredAt": "2026-04-08T10:05:00.000Z",
  "verificationStatus": "VERIFIED"
}
```

---

## 8. AWS IAM Least-Privilege Policy Specification

For production deployment, the anchoring service role requires strictly minimal permissions on the target S3 bucket. Deletion, overwrite, and policy modification actions are explicitly omitted or denied:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowS3WormPutObjectWithComplianceLock",
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:PutObjectRetention"
      ],
      "Resource": "arn:aws:s3:::namma-blood-audit-worm/namma-blood/audit-checkpoints/v1/*",
      "Condition": {
        "StringEquals": {
          "s3:x-amz-object-lock-mode": "COMPLIANCE"
        }
      }
    },
    {
      "Sid": "AllowS3WormReadForVerification",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:GetObjectVersion",
        "s3:GetObjectRetention"
      ],
      "Resource": "arn:aws:s3:::namma-blood-audit-worm/namma-blood/audit-checkpoints/v1/*"
    },
    {
      "Sid": "DenyObjectDeletionAndModification",
      "Effect": "Deny",
      "Action": [
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
        "s3:BypassGovernanceRetention"
      ],
      "Resource": "arn:aws:s3:::namma-blood-audit-worm/*"
    }
  ]
}
```

---

## 9. S3 Bucket Configuration Prerequisites

1. **Bucket Versioning**: Must be `Enabled`.
2. **Object Lock**: Must be enabled at bucket creation time.
3. **Default Retention**: Recommended `COMPLIANCE` mode with configured retention days.
4. **Server-Side Encryption**: SSE-KMS or SSE-S3.
5. **Block Public Access**: All 4 Block Public Access settings enabled (`True`).

---

## 10. Concurrency & Distributed Lease Control

- **Distributed CAS Claim**: Workers call `acquireAnchoringClaim(checkpointId, workerId, ttlMs)`.
- **Fencing Token**: A 256-bit cryptographic `leaseToken` is generated per claim.
- **Transactional Commit**: In `anchorNextCheckpoint`, the final state transition and watermark update in MongoDB require `anchoringLeaseToken === leaseToken` and non-expired lease within `withTransaction`.
- **Stale Claim Recovery**: `reconcileStaleAnchoringClaims()` identifies claims where worker crashed or lease expired, resetting them to `FAILED` for safe retry.
