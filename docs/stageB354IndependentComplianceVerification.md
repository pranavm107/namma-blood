# Stage B3.5.4: Independent Offline Audit Compliance Verification

## 1. Architectural Role and Overview

**Stage B3.5.4** establishes an independent, offline, zero-trust verification system for the administrative decision audit ledger and its externally anchored checkpoints in **Namma Blood**.

While Stage B3.5.1 hardened the MongoDB append-only ledger, Stage B3.5.2 introduced hourly checkpoint generation with distributed CAS leasing, and Stage B3.5.3 implemented AWS S3 Object Lock COMPLIANCE mode external WORM anchoring, Stage B3.5.4 provides the **compliance auditing layer**.

The verifier operates under a strict zero-trust model:
- MongoDB metadata status fields (e.g. `anchoringStatus: 'ANCHORED'`, `verificationStatus: 'VERIFIED'`) are never trusted.
- The reported ledger watermark (`AuditChainHead.lastAnchoredSequence`) is never trusted.
- Cloud provider status flags or pre-computed hashes are never trusted.
- Stored MongoDB metadata claiming `COMPLIANCE` retention is treated as unverified offline claims, not live AWS proof.

Instead, the verifier independently re-executes all cryptographic operations, canonical payload serialization, hash calculations, detached Ed25519 signature checks, sequence continuity analysis, and S3 Object Lock compliance verification.

```
+----------------------------------------------------------------------------------------------------+
|                                    INDEPENDENT AUDIT VERIFIER                                      |
|                                                                                                    |
|  +---------------------------+     +---------------------------+     +--------------------------+  |
|  | Mode A: OFFLINE CRYPTO    |     | Mode B: OFFLINE BUNDLE    |     | Mode C: LIVE AWS ADAPTER |  |
|  | - Canonical payload check |     | - Mode A cryptographic    |     | - Mode A & B checks      |  |
|  | - SHA-256 hash integrity  |     | - S3 exact VersionId      |     | - Exact VersionId S3 API |  |
|  | - RFC 8032 Ed25519 sign   |     | - S3 body content hash    |     | - GetObjectRetention API |  |
|  | - Continuity & overlaps   |     | - Exported COMPLIANCE WORM|     | - Zero write/delete meth |  |
|  | - liveAwsVerified: false  |     | - liveAwsVerified: false  |     | - liveAwsVerified: true  |  |
|  +---------------------------+     +---------------------------+     +--------------------------+  |
|                                                                                                    |
|  +---------------------------------------+     +------------------------------------------------+  |
|  | Explicit Retention Policy             |     | Tri-Watermark Decoupled Consistency            |  |
|  | - AUDIT_WORM_REQUIRED_RETENTION_DAYS  | --> | - Operational Head (sequenceNumber)            |  |
|  | - Positive integer validation         |     | - Local Checkpoint (lastCheckpointedSeq)       |  |
|  | - Zero hardcoded 7-year assumption    |     | - External Anchored (lastAnchoredSeq)          |  |
|  | - CLI / API explicit days flag        |     | Invariant: anchoredSeq <= cursorSeq <= op      |  |
|  +---------------------------------------+     +------------------------------------------------+  |
+----------------------------------------------------------------------------------------------------+
```

---

## 2. Separate Verification Trust Levels

To guarantee transparency and prevent false claims of cloud-level assurance, the engine strictly separates three distinct verification trust levels:

### Mode A: Offline Cryptographic Verification (`OFFLINE_CRYPTOGRAPHIC`)
- **Scope**: Re-evaluates canonical JSON structure, canonical payload recreation, SHA-256 checkpoint hash recomputation, RFC 8032 Ed25519 digital signature verification using the auditor's SPKI public key, sequence continuity, previous checkpoint hash linkage, interval overlap detection, and duplicate identifier detection.
- **Assurance Boundary**: Proves data integrity and cryptographic non-repudiation.
- **Reporting Invariant**: Does **not** claim live AWS retention. Explicitly sets:
  - `verificationMode: 'OFFLINE_CRYPTOGRAPHIC'`
  - `s3EvidenceVerificationStatus: 'UNVERIFIED'`
  - `liveAwsVerificationPerformed: false`
  - `retentionVerificationSource: 'NONE'`
  - Warning notice: *"Offline cryptographic verification performed. Live AWS S3 Object Lock retention has not been verified."*

### Mode B: Offline Verification with Exported S3 Evidence (`OFFLINE_EXPORTED_EVIDENCE`)
- **Scope**: Ingests an exported evidence bundle or directory containing exact bucket name, deterministic object key, exact `VersionId`, raw S3 object body, independently exported Object Lock retention metadata, export timestamp, and source provenance.
- **Assurance Boundary**: Verifies that the exported S3 body matches the signed checkpoint hash, that `objectLockMode` is strictly `COMPLIANCE`, and that `RetainUntilDate` is active and in the future.
- **Reporting Invariant**: Clearly notes that exported evidence provenance must be trusted. Explicitly sets:
  - `verificationMode: 'OFFLINE_EXPORTED_EVIDENCE'`
  - `liveAwsVerificationPerformed: false`
  - `retentionVerificationSource: 'EXPORTED_EVIDENCE_PROVENANCE'` (or `'STORED_MONGODB_METADATA_UNVERIFIED_LIVE'`)
  - Warning notice: *"Exported S3 evidence verified offline. Exported evidence does not independently prove current live AWS state unless export provenance is independently trusted."*

### Mode C: Live AWS Verification (`LIVE_AWS_VERIFICATION`)
- **Scope**: Directly queries AWS S3 via an isolated, strictly read-only adapter using AWS SDK v3 (`GetObjectCommand` and `GetObjectRetentionCommand`).
- **Assurance Boundary**: Confirms live cloud compliance by querying the **exact immutable `VersionId`** stored in the checkpoint ledger. Never queries the latest version without VersionId.
- **Guardrails**:
  - Gated behind `ENABLE_LIVE_AWS_VERIFICATION=true`.
  - Adapter prototype and instances are programmatically inspected (`assertReadOnly()`) to ensure no write or delete methods (`putObject`, `deleteObject`, `deleteObjects`, `upload`, `putObjectRetention`, etc.) exist.
- **Reporting Invariant**:
  - `verificationMode: 'LIVE_AWS_VERIFICATION'`
  - `liveAwsVerificationPerformed: true`
  - `retentionVerificationSource: 'LIVE_AWS_S3_API'`

---

## 3. Four Primary Verification Outcomes & Sub-Statuses

Verification outcomes are strictly partitioned into four mutually exclusive statuses. Missing evidence is never conflated with valid evidence.

| Status | Definition | Criteria |
|---|---|---|
| `VALID` | Fully compliant and unbroken | Every evaluated structural, cryptographic (hash & Ed25519 signature), sequence continuity, and S3 Object Lock COMPLIANCE check passed without error or gap. |
| `INVALID` | Integrity breach or rule violation | Checkpoint hash mismatch, forged signature, altered payload, overlapping sequence range, duplicate checkpoint identity, missing S3 VersionId, corrupted body checksum, GOVERNANCE mode detected, expired retention timestamp, or retention period below required policy. |
| `INCOMPLETE` | Incomplete chain coverage or gaps | Missing required evidence fields, sequence gaps between checkpoints, chain not starting at sequence 1, or chain terminating before expected sequence. |
| `PENDING` | Unprocessed or uncommitted | Candidate evidence awaiting evaluation with zero evaluated checks. |

### Structured Metadata Fields in Every Verification Report

```json
{
  "verificationId": "VERIF-3efe8baaa7ae2955",
  "verificationTimestamp": "2026-11-09T11:09:26.367Z",
  "verifierVersion": "v1.1.0",
  "ledgerId": "GLOBAL_ADMIN_AUDIT_HEAD",
  "canonicalizationVersion": "v2",
  "verificationMode": "OFFLINE_EXPORTED_EVIDENCE",
  "cryptographicVerificationStatus": "VALID",
  "checkpointContinuityStatus": "VALID",
  "s3EvidenceVerificationStatus": "VALID",
  "liveAwsVerificationPerformed": false,
  "retentionVerificationSource": "EXPORTED_EVIDENCE_PROVENANCE",
  "evidenceProvenance": "AUDITOR_EXTRACT_20261109",
  "overallStatus": "VALID",
  "verifiedSequenceRange": {
    "startSequence": 1,
    "endSequence": 100,
    "totalRecords": 100,
    "totalCheckpoints": 1
  },
  "signingKeyId": "key-ed25519-primary",
  "individualChecks": [ ... ],
  "failedCheckIds": [],
  "missingEvidenceIds": [],
  "warnings": [
    "Exported S3 evidence verified offline. Exported evidence does not independently prove current live AWS state unless export provenance is independently trusted."
  ],
  "verifiedAt": "2026-11-09T11:09:26.367Z",
  "metadata": {
    "executionDurationMs": 1
  }
}
```

---

## 4. Explicit Retention Policy Configuration

### Removal of Implicit 7-Year Default
All hardcoded assumptions of a 7-year retention period (2555 days) have been removed from the verifier, CLI, controller, and test suites.

### Explicit Configuration Variable
- **Environment Variable**: `AUDIT_WORM_REQUIRED_RETENTION_DAYS`
- **Validation**: Must be a positive integer ($> 0$). Strings with decimals, non-integers, negative numbers, or zeroes are rejected with `TypeError` / `RangeError`.
- **Optional vs Required**:
  - If omitted and `enforceRetentionPolicy: false`, retention duration checks verify that `RetainUntilDate` is active in the future without asserting a specific retention duration.
  - If retention duration compliance is demanded (`enforceRetentionPolicy: true`), missing `AUDIT_WORM_REQUIRED_RETENTION_DAYS` causes `S3_RETENTION_POLICY_CONFIGURED` to fail as `INVALID`.

### CLI Option
- `--required-retention-days <days>`: Pass the explicit retention duration threshold to the CLI.

---

## 5. Core Components

### 5.1 Compliance Verification Engine (`backend/Hospital/auditCheckpointComplianceVerifier.js`)
Provides stateless, zero-mutation verification primitives:
- `AuditLiveAwsVerificationAdapter`: Isolated AWS SDK v3 read-only client adapter. Programmatically enforces absence of write or generic command execution methods. Enforces strict `ALLOWED_READ_ONLY_COMMANDS` allowlist (`GetObjectCommand`, `GetObjectRetentionCommand`) at the point of command dispatch. Keeps underlying client private. Requires exact `VersionId`.
- `verifySingleCheckpointEvidence(evidence, options)`: Inspects format version, deterministic IDs, payload integrity, canonical representation matching, SHA-256 recomputation, Ed25519 signature verification against provided public key, predecessor link, and S3 Object Lock COMPLIANCE evidence.
- `verifyCheckpointChain(checkpoints, options)`: Sorts checkpoints by `startSequence`, validates uniqueness of checkpoint IDs, checks interval overlap (`nextStart <= currentEnd`), detects gaps (`nextStart > currentEnd + 1`), verifies start coverage (`startSequence === expectedStartSequence`), and verifies end coverage (`endSequence === expectedEndSequence`).
- `verifyCheckpointLiveAws(checkpoints, options)`: Executes Mode C live verification by retrieving exact versions and retention metadata from S3, then feeding augmented evidence into `verifyCheckpointChain`.
- `compareWatermarkConsistency(operationalHead, cursor, chainHead, verifiedRange)`: Validates tri-watermark invariant:
  $$\text{lastAnchoredSequence} \le \text{lastCheckpointedSequence} \le \text{operationalHeadSequence}$$
  Guarantees zero database mutations.
- `verifyExportedEvidenceBundle(bundleInput, options)`: Parses exported JSON bundles or scanned directories containing checkpoints, auto-discovers public keys, and validates entire evidence datasets offline.

### 5.2 Offline Audit Verification CLI (`backend/scripts/verifyAuditCompliance.js`)
Standalone CLI executable for auditors, compliance officers, and air-gapped forensic reviews:
- **Modes**: `--mode <crypto|bundle|live>` (defaults to `bundle`).
- **Retention**: `--required-retention-days <days>`.
- **Zero Network Requirement**: In offline modes, runs completely without AWS or database connections.
- **Path Traversal Defense**: Strictly rejects relative directory traversal sequences (`..`), null bytes (`\0`), and malformed path strings.
- **Deterministic Exit Codes**:
  - `0`: All verification checks passed (`VALID`).
  - `1`: Evidence integrity failed or sequence gaps were detected (`INVALID` or `INCOMPLETE`).
  - `2`: Bad arguments, path traversal rejection, or file ingestion failure.

### 5.3 Auditor Read-Only Interface (`GET /api/admin/audit-ledger/compliance-verification`)
Protected by `protectEmergencyAuth` and `requireAdmin`:
- Strictly read-only (`lean()` queries).
- Accepts query parameters: `ledgerId`, `startSequence`, `endSequence`, `mode`, `requiredRetentionDays`.
- Defaults to Mode B with `retentionVerificationSource: 'STORED_MONGODB_METADATA_UNVERIFIED_LIVE'`.
- Clearly states: *"Stored MongoDB COMPLIANCE metadata does NOT constitute independent live AWS verification."*
- Requires `ENABLE_LIVE_AWS_VERIFICATION=true` on the server before serving `mode=live`.
- Advances zero watermarks and mutates zero documents.

---

## 6. Sample Verification Reports

### Mode A: Offline Cryptographic Verification
```json
{
  "verificationId": "VERIF-9a1b2c3d4e5f6789",
  "verificationMode": "OFFLINE_CRYPTOGRAPHIC",
  "overallStatus": "VALID",
  "cryptographicVerificationStatus": "VALID",
  "checkpointContinuityStatus": "VALID",
  "s3EvidenceVerificationStatus": "UNVERIFIED",
  "liveAwsVerificationPerformed": false,
  "retentionVerificationSource": "NONE",
  "warnings": [
    "Offline cryptographic verification performed. Live AWS S3 Object Lock retention has not been verified."
  ],
  "verifiedSequenceRange": {
    "startSequence": 1,
    "endSequence": 200,
    "totalRecords": 200,
    "totalCheckpoints": 2
  }
}
```

### Mode B: Offline Verification with Exported S3 Evidence
```json
{
  "verificationId": "VERIF-8b7a6c5d4e3f2109",
  "verificationMode": "OFFLINE_EXPORTED_EVIDENCE",
  "overallStatus": "VALID",
  "cryptographicVerificationStatus": "VALID",
  "checkpointContinuityStatus": "VALID",
  "s3EvidenceVerificationStatus": "VALID",
  "liveAwsVerificationPerformed": false,
  "retentionVerificationSource": "EXPORTED_EVIDENCE_PROVENANCE",
  "evidenceProvenance": "FORENSIC_EXPORT_20261109",
  "warnings": [
    "Exported S3 evidence verified offline. Exported evidence does not independently prove current live AWS state unless export provenance is independently trusted."
  ],
  "verifiedSequenceRange": {
    "startSequence": 1,
    "endSequence": 100,
    "totalRecords": 100,
    "totalCheckpoints": 1
  }
}
```

### Mode C: Live AWS Verification
```json
{
  "verificationId": "VERIF-1f2e3d4c5b6a7890",
  "verificationMode": "LIVE_AWS_VERIFICATION",
  "overallStatus": "VALID",
  "cryptographicVerificationStatus": "VALID",
  "checkpointContinuityStatus": "VALID",
  "s3EvidenceVerificationStatus": "VALID",
  "liveAwsVerificationPerformed": true,
  "retentionVerificationSource": "LIVE_AWS_S3_API",
  "verifiedSequenceRange": {
    "startSequence": 1,
    "endSequence": 100,
    "totalRecords": 100,
    "totalCheckpoints": 1
  }
}
```

---

## 7. Automated Test Matrix (53 Tests)

The suite `backend/tests/stageB354IndependentComplianceVerification.test.js` covers 53 comprehensive verification scenarios:

1. Valid checkpoint evidence (`VALID`)
2. Invalid checkpoint hash (`INVALID`)
3. Altered canonical payload (`INVALID`)
4. Invalid Ed25519 signature (`INVALID`)
5. Unknown signing key (`INVALID`)
6. Malformed signature (`INVALID`)
7. Unsupported format version (`INVALID`)
8. Missing evidence fields (`INCOMPLETE`)
9. Missing checkpoint range (`INCOMPLETE`)
10. Sequence gaps (`INCOMPLETE`)
11. Overlapping checkpoint ranges (`INVALID`)
12. Duplicate checkpoint identities (`INVALID`)
13. Broken cryptographic chain hash link (`INVALID`)
14. Missing S3 VersionId (`INVALID`)
15. Wrong S3 object key (`INVALID`)
16. Modified S3 object body failing content checksum (`INVALID`)
17. SHA-256 checksum mismatch (`INVALID`)
18. GOVERNANCE retention mode rejection (`INVALID`)
19. Missing retention metadata (`INVALID`)
20. Expired retention date (`INVALID`)
21. Conflicting S3 versions (`INVALID`)
22. Valid multiple-checkpoint chain (`VALID`)
23. Partial checkpoint coverage (`INCOMPLETE`)
24. Operational and anchored watermark inconsistency detected
25. Zero MongoDB mutations during verification
26. External watermark strictly unadvanced during verification
27. CLI valid evidence execution (exit 0)
28. CLI invalid evidence execution (exit 1)
29. CLI incomplete evidence execution (exit 1)
30. CLI path traversal rejection (exit 2)
31. Auditor API `GET /api/admin/audit-ledger/compliance-verification` (200)
32. Auditor API invalid sequence boundaries rejection (400)
33. Mode A: Offline cryptographic verification does not claim live AWS verification
34. Mode B: Offline exported evidence is distinguished from live S3 evidence
35. Mode C: Live AWS verification retrieves the exact VersionId
36. Mode C: Live verification checks GetObjectRetention for the exact version
37. Mode C: GOVERNANCE mode fails in live verification
38. Mode C: Missing retention metadata fails in live verification
39. Mode C: Incorrect retention timestamp fails in live verification
40. Mode C: Wrong VersionId fails in live verification
41. Mode C: Modified S3 object body fails in live verification
42. Mode C: Live verification performs zero S3 write or delete operations
43. Missing required retention policy is handled correctly
44. Seven-year retention is not silently assumed
45. Stored MongoDB COMPLIANCE metadata alone cannot establish live AWS verification
46. Auditor API reports its verification mode accurately
47. Verification never mutates MongoDB or advances the anchored watermark
48. Mode C: GetObjectCommand and GetObjectRetentionCommand are accepted by allowlisted dispatcher
49. Mode C: PutObjectCommand, DeleteObjectCommand, and PutObjectRetentionCommand are rejected
50. Mode C: Unknown and malformed command types are rejected fail-closed
51. Mode C: Rejected commands never reach the underlying mocked client
52. Mode C: AuditLiveAwsVerificationAdapter does not expose client or unrestricted send method
53. Mode C: Existing exact-VersionId live verification continues to work seamlessly with allowlist
