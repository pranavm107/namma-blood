# NAMMA BLOOD: STAGE B3.4 REVISED ARCHITECTURE SPECIFICATION
## Professional Credential Verification and Hospital Association Approval

**Document Version:** 2.1.0 (Audit Architecture Hardening Revision)
**Status:** Architecture Specification — Pending Implementation Approval
**Security Governance:** Namma Blood Healthcare Security Standards

---

## 1. Existing Architecture Assessment

### 1.1 Model & Route Inventory
Inspection of the live repository establishes the following foundations:
- `backend/User/userModel.js`: Decoupled `accountStatus` (`['Pending_Activation', 'Active', 'Suspended', 'Deactivated']`) and `credentialStatus` (`['Unsubmitted', 'Pending_Verification', 'Under_Review', 'Verified', 'Rejected', 'Suspended']`). Features partial unique index `uniq_medical_registration_number_per_doctor`.
- `backend/Hospital/medicalOfficerHospitalModel.js`: Compound unique index `{ medicalOfficerUserId: 1, hospitalId: 1 }`. `associationStatus` includes `['Pending', 'Pending_Hospital_Confirmation', 'Pending_Admin_Approval', 'Active', 'Suspended', 'Revoked', 'Expired', 'Rejected']`. Permissions allowlist: `['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS']`.
- `backend/Hospital/hospitalModel.js`: Institutional records with unique `hospitalCode`, `verificationStatus`, and `isActive`.
- `backend/Hospital/notificationOutboxModel.js`: Durable transactional outbox with compound unique index `{ eventId: 1, recipientKey: 1 }` supporting worker leases and idempotency.
- `backend/Emergency/emergencyAuthMiddleware.js` & `backend/Hospital/medicalOfficerMiddleware.js`: Fail-closed three-gate validation on all clinical endpoints.
- `backend/Admin/adminModel.js`: Platform administrator accounts stored in dedicated `admin` collection.

### 1.2 Identified Architectural Defect: Login Deadlock
In Stage B2 and Stage B3.3, `backend/Login_And_Authentication/login.js` evaluated Gate 2 (`credentialStatus === 'Verified'`) directly inside the login controller, returning HTTP 403 for any doctor whose credentials are unsubmitted, under review, or rejected. This conflated **identity authentication** with **clinical authorization**, creating a deadlock where unverified doctors could not log in to submit credentials, inspect clarification requests, or resubmit documentation.

---

## 2. Authentication vs. Clinical Authorization

### 2.1 The Two-Tier Gate Separation
To resolve the login deadlock without compromising clinical safety, the platform enforces an absolute boundary between identity authentication and clinical capability:

```
┌────────────────────────────────────────────────────────────────────────┐
│                   TIER 1: IDENTITY AUTHENTICATION                      │
│                  Endpoint: POST /api/user/login                        │
│                                                                        │
│   Gate 1: user.accountStatus === 'Active' && user.status === true      │
│   Outcome: Returns JWT with UI hint sessionScope = ONBOARDING|CLINICAL │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
          ┌─────────────────────────┴─────────────────────────┐
          │                                                   │
          ▼                                                   ▼
┌───────────────────────────────────┐       ┌───────────────────────────────────┐
│     ONBOARDING WORKFLOWS          │       │        CLINICAL WORKFLOWS         │
│  - Profile inspection             │       │  - Emergency request queue        │
│  - Credential submission          │       │  - Emergency verification         │
│  - Clarification response         │       │  - Availability toggles           │
│  - Association status review      │       │  - Patient clinical data          │
│                                   │       │                                   │
│  Guard: protectMedicalOfficer-    │       │  Guard: protectMedicalOfficer-    │
│         Onboarding                │       │         Auth                      │
│  Prerequisite: Gate 1 Active      │       │  Prerequisites: GATES 1, 2, AND 3 │
└───────────────────────────────────┘       └───────────────────────────────────┘
```

1. **Gate 1 (Account Status)**: Evaluated at `login.js`. An account with `accountStatus === 'Active'` and `status === true` receives an authenticated session token.
2. **Gate 2 (Professional Credentials)** & **Gate 3 (Hospital Association)**: Evaluated strictly by `protectMedicalOfficerAuth` on clinical routes. Unverified doctors receive **HTTP 403 Forbidden** on any clinical route, preventing access to emergency queues, patient details, and verification decisions.

### 2.2 Server-Side Authorization Invariant: Zero Trust for `sessionScope`
- **Crucial Security Invariant**: The `sessionScope` claim returned in the login payload is strictly a **client-side UI routing hint** (instructing the frontend whether to direct the user to `/medical-officer/onboarding` or `/medical-officer/dashboard`).
- **Zero Trust**: The backend server **NEVER** trusts `sessionScope`, client-provided headers, body fields, or token claims to authorize access.
- Every API endpoint enforces its own independent server-side middleware:
  - Onboarding routes require `protectMedicalOfficerOnboarding`, which queries the live database to verify `accountStatus === 'Active'`.
  - Clinical routes require `protectMedicalOfficerAuth`, which queries the live database to verify Gate 1 (`accountStatus === 'Active'`), Gate 2 (`credentialStatus === 'Verified'`), and Gate 3 (`associationStatus === 'Active'`, temporal validity, active verified hospital, and explicit permissions).

---

## 3. Restricted Medical Officer Onboarding Session

### 3.1 Token Scope & Authorization Boundaries
- When an active doctor with `credentialStatus !== 'Verified'` logs in:
  - The JWT payload retains standard identity fields (`id`, `tokenVersion`, `userType: 'user'`).
  - The login response returns `credentialStatus` and `sessionScope: 'ONBOARDING'`.
- **Allowed Endpoints (Under `protectMedicalOfficerOnboarding`)**:
  - `GET /api/medical-officers/me/profile`
  - `GET /api/medical-officers/credentials/status`
  - `POST /api/medical-officers/credentials/submit`
  - `PATCH /api/medical-officers/credentials/resubmit`
  - `GET /api/medical-officers/associations/status`
- **Strictly Prohibited Endpoints (Clinical Routes Blocked with HTTP 403)**:
  - `GET /api/medical-officer/requests`
  - `GET /api/medical-officer/queue`
  - `GET /api/medical-officer/requests/:id`
  - `PATCH /api/medical-officer/requests/:id/verify`
  - `PATCH /api/medical-officer/requests/:id/reject`
  - `PATCH /api/medical-officer/requests/:id/request-information`
  - `GET /api/medical-officer/dashboard`
  - `PATCH /api/medical-officer/hospitals/:id/availability`

---

## 4. Credential Verification Lifecycle

### 4.1 State Machine Transitions
```
[Unsubmitted]
      │
      │ Doctor submits credentials via POST /credentials/submit
      ▼
[Pending_Verification] ◄────────────────────────────────────────┐
      │                                                         │
      │ Admin starts review via PATCH /credentials/review-start  │ Doctor resubmits
      ▼                                                         │ via PATCH
[Under_Review]                                                  │ /credentials/resubmit
      ├───────────► [Admin Requests Clarification] ─────────────┘
      │
      ├───────────► [Admin Approves] ────► [Verified] ───► [Suspended]
      │
      └───────────► [Admin Rejects]  ────► [Rejected] ───► [Pending_Verification] (Resubmit)
```

### 4.2 State Invariants
- `GET /api/admin/medical-officers/credentials` is strictly idempotent and **never** mutates document status.
- Transition `Pending_Verification -> Under_Review` requires explicit administrative action (`review-start`).
- Initial submission moves `Unsubmitted -> Pending_Verification`.
- Clarification request keeps status as `Pending_Verification` with `clarificationRequested: true` and logs questions in the audit trail.
- Resubmission clears `clarificationRequested`, increments `resubmissionCount`, and sets `credentialStatus: 'Pending_Verification'`.
- Status `Verified` passes Gate 2. Status `Rejected` or `Suspended` fails Gate 2.

---

## 5. Hospital Association Approval Lifecycle

### 5.1 Association States & Separation
- Independent of doctor credentials, doctor-hospital associations follow their own state machine in `medicalofficerhospitals`:
  - `Pending_Hospital_Confirmation` (Doctor nominated hospital)
  - `Pending_Admin_Approval` (Hospital nominated doctor, or nomination accepted)
  - `Active` (Platform ADMIN approved)
  - `Suspended` (Temporarily inactivated by ADMIN or HOSPITAL_ADMIN)
  - `Revoked` (Affiliation permanently terminated)
  - `Rejected` (Platform ADMIN rejected proposed affiliation)
  - `Expired` (`expiresAt < now`)
- **Prerequisite Invariant**: An association **cannot** be approved (`Pending_Admin_Approval -> Active`) unless the doctor's `credentialStatus === 'Verified'`. Attempting to approve an association for an unverified doctor returns **HTTP 409 Conflict**.

---

## 6. Permission Model & Server-Side Allowlist

### 6.1 Server Allowlist
Clinical permissions are restricted strictly to:
```javascript
const VALID_MO_PERMISSIONS = ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS']
```

### 6.2 Least-Privilege Rules
1. **Default on Creation**: Newly created associations receive `['VIEW_EMERGENCY_REQUESTS']` only.
2. **Administrative Grant**: Platform ADMIN may optionally grant `VERIFY_EMERGENCY_REQUESTS` upon approving the association.
3. **Prohibited Permissions**: Wildcards (`*`), administrative scopes (`ADMIN`, `MANAGE_USERS`), bloodbank permissions, or arbitrary strings are rejected with **HTTP 400 Bad Request**.
4. **Separation**: Holding `VERIFY_EMERGENCY_REQUESTS` has zero effect if Gate 2 (`credentialStatus === 'Verified'`) or Gate 1 (`accountStatus === 'Active'`) fails.

---

## 7. Hardened Administrative Decision Audit Architecture

### 7.1 Atomic Sequence & Audit-Chain Head Model (`backend/Hospital/auditChainHeadModel.js`)

To prevent competing chain histories and fork hazards under concurrent administrative actions, the audit ledger is serialized via an atomic chain head document:

```javascript
const mongoose = require('mongoose')

const auditChainHeadSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      required: true,
      default: 'GLOBAL_ADMIN_AUDIT_HEAD',
    },
    sequenceNumber: {
      type: Number,
      required: true,
      default: 0,
    },
    latestRecordId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'administrativedecisionaudit',
      default: null,
    },
    latestRecordHash: {
      type: String,
      required: true,
      default: 'GENESIS_ANCHOR_0000000000000000000000000000000000000000000000000000000000000000',
    },
    totalRecords: {
      type: Number,
      required: true,
      default: 0,
    },
    lastAnchoredSequence: {
      type: Number,
      default: 0,
    },
    lastAnchoredHash: {
      type: String,
      default: '',
    },
    lastAnchoredAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
)

const AuditChainHead = mongoose.model('auditchainhead', auditChainHeadSchema)
module.exports = { AuditChainHead }
```

### 7.2 Append-Only Audit Entry Model (`backend/Hospital/administrativeDecisionAuditModel.js`)

```javascript
const mongoose = require('mongoose')
const crypto = require('crypto')

const administrativeDecisionAuditSchema = new mongoose.Schema(
  {
    sequenceNumber: {
      type: Number,
      required: true,
      unique: true, // Prevents duplicate sequence gaps
      index: true,
    },
    entityType: {
      type: String,
      enum: ['CREDENTIAL', 'HOSPITAL_ASSOCIATION'],
      required: true,
      index: true,
    },
    entityId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      index: true,
    },
    targetUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'user',
      required: true,
      index: true,
    },
    hospitalId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'hospital',
      default: null,
      index: true,
    },
    decisionType: {
      type: String,
      enum: [
        'CREDENTIAL_SUBMITTED',
        'CREDENTIAL_REVIEW_STARTED',
        'CREDENTIAL_INFO_REQUESTED',
        'CREDENTIAL_RESUBMITTED',
        'CREDENTIAL_APPROVED',
        'CREDENTIAL_REJECTED',
        'CREDENTIAL_SUSPENDED',
        'ASSOCIATION_APPROVED',
        'ASSOCIATION_REJECTED',
        'ASSOCIATION_SUSPENDED',
        'ASSOCIATION_REACTIVATED',
        'ASSOCIATION_REVOKED',
      ],
      required: true,
      index: true,
    },
    previousStatus: { type: String, required: true },
    newStatus: { type: String, required: true },
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: 'actorModel',
      index: true,
    },
    actorModel: {
      type: String,
      enum: ['admin', 'user'],
      required: true,
      default: 'admin',
    },
    actorRole: {
      type: String,
      enum: ['ADMIN', 'HOSPITAL_ADMIN', 'MEDICAL_OFFICER'],
      required: true,
    },
    reason: { type: String, trim: true, default: '' },
    notes: { type: String, trim: true, default: '' },
    evidenceReferences: { type: [String], default: [] },
    grantedPermissions: { type: [String], default: [] },
    requestIp: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    // Cryptographic Tamper-Evident Chaining
    previousRecordHash: { type: String, required: true },
    recordHash: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
)

// Immutability Hook: Block all application-level updates and deletions
administrativeDecisionAuditSchema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'findByIdAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'], function (next) {
  next(new Error('AdministrativeDecisionAudit records are immutable and cannot be updated or deleted.'))
})

administrativeDecisionAuditSchema.pre('save', function (next) {
  if (!this.isNew) {
    return next(new Error('AdministrativeDecisionAudit records cannot be modified once created.'))
  }
  next()
})
```

### 7.3 Atomic Transactional Advancement & Concurrency Safety
Audit entry creation and `AuditChainHead` advancement are strictly executed inside the **same MongoDB transaction session**:

```javascript
async function appendAuditRecordTransactional(session, auditData) {
  // 1. Atomically lock and retrieve current chain head within the transaction
  const currentHead = await AuditChainHead.findOneAndUpdate(
    { _id: 'GLOBAL_ADMIN_AUDIT_HEAD' },
    { $setOnInsert: { sequenceNumber: 0, latestRecordHash: 'GENESIS_ANCHOR_0000000000000000000000000000000000000000000000000000000000000000' } },
    { session, upsert: true, new: true, setDefaultsOnInsert: true }
  )

  const nextSeq = currentHead.sequenceNumber + 1
  const prevHash = currentHead.latestRecordHash

  // 2. Canonical serialization for SHA-256 computation
  const canonicalPayload = [
    nextSeq,
    auditData.entityType,
    String(auditData.entityId),
    auditData.decisionType,
    auditData.previousStatus,
    auditData.newStatus,
    String(auditData.actorId),
    prevHash
  ].join('|')

  const currentRecordHash = crypto.createHash('sha256').update(canonicalPayload).digest('hex')

  // 3. Insert audit entry with bound sequence and hash link
  const [createdEntry] = await AdministrativeDecisionAudit.create(
    [
      {
        ...auditData,
        sequenceNumber: nextSeq,
        previousRecordHash: prevHash,
        recordHash: currentRecordHash,
      }
    ],
    { session }
  )

  // 4. Advance chain head in the same transaction
  await AuditChainHead.updateOne(
    { _id: 'GLOBAL_ADMIN_AUDIT_HEAD', sequenceNumber: currentHead.sequenceNumber },
    {
      $set: {
        sequenceNumber: nextSeq,
        latestRecordId: createdEntry._id,
        latestRecordHash: currentRecordHash,
      },
      $inc: { totalRecords: 1 },
    },
    { session }
  )

  return createdEntry
}
```
**Concurrency Invariant**: Under concurrent administrative requests, MongoDB's document-level transaction locking on `GLOBAL_ADMIN_AUDIT_HEAD` forces write serialization. Exactly one transaction succeeds in advancing the head; concurrent conflicting sessions abort and cleanly roll back, eliminating fork hazards.

---

## 8. Database-Level Restrictions & Tamper Detection

### 8.1 MongoDB Engine-Level Role Restrictions (RBAC)
Application-level immutability is reinforced at the database engine level by configuring the dedicated application database user:
- Role privileges for `administrativedecisionaudits`:
  ```javascript
  {
    resource: { db: 'namma_blood_prod', collection: 'administrativedecisionaudits' },
    actions: ['find', 'insert'] // NO 'update', NO 'remove', NO 'dropCollection'
  }
  ```
- Role privileges for `auditchainheads`:
  ```javascript
  {
    resource: { db: 'namma_blood_prod', collection: 'auditchainheads' },
    actions: ['find', 'insert', 'update'] // NO 'remove', NO 'dropCollection'
  }
  ```
Even if an attacker gains arbitrary query execution within the application layer, the database engine itself rejects any attempt to update or delete audit entries.

### 8.2 Terminal-Record Deletion & Privileged Tampering Detection
If a compromised DBA credential is used to delete records directly from MongoDB:
1. **Terminal Deletion Detection**:
   - The `AuditChainHead` document tracks `sequenceNumber: S` and `latestRecordHash: H`.
   - If an attacker deletes the latest (terminal) audit record, `max(audit.sequenceNumber) = S - 1 != S` and the record with hash `H` is missing.
   - The platform integrity scanner (`verifyAuditChainIntegrity()`) compares the head against the collection and flags terminal truncation immediately.
2. **Intermediate Deletion Detection**:
   - Deleting an intermediate record causes a sequence gap ($N, N+2$) and invalidates the `previousRecordHash` link in record $N+2$.
3. **Modification Detection**:
   - Modifying any field in record $N$ invalidates its SHA-256 `recordHash` and breaks the `previousRecordHash` stored in record $N+1$.

### 8.3 Periodic External Hash Anchoring Strategy
To guard against attackers with complete root access to the database:
- **Anchoring Strategy**: Every 60 minutes (or every 500 audit events), a scheduled job takes:
  $$\text{AnchorSnapshot} = \{ \text{sequenceNumber}: S, \text{latestRecordHash}: H, \text{timestamp}: T \}$$
- **Destination**: The snapshot is cryptographically signed with an isolated HSM/KMS key and written to an immutable external destination:
  1. **Write-Once-Read-Many (WORM) Storage**: AWS S3 Object Lock (Compliance Mode) / Google Cloud Storage Bucket Lock with mandatory retention.
  2. **External Tamper-Evident Ledger**: Appended to an offsite append-only Git repository with verified GPG commits.
- **Verification**: Once anchored, an attacker cannot rewrite database history without detection, as any forged history will contradict the external anchor.

---

## 9. Supporting Evidence Security & Anti-SSRF Protections

1. **Protocol Restriction**: Must parse as valid URL with protocol strictly `https:` (`http:` permitted only on localhost development).
2. **Prohibited Schemes**: `javascript:`, `data:`, `file:`, `blob:`, `ftp:`, and relative paths are rejected with **HTTP 400 Bad Request**.
3. **Zero Backend Fetch (Anti-SSRF)**: The backend server **never** fetches, pings, downloads, or validates the remote HTTP contents. This completely eliminates Server-Side Request Forgery (SSRF) attack vectors against internal clouds or services.
4. **Secure Frontend Presentation**: When reviewed by ADMIN, links are rendered with `rel="noopener noreferrer"`, `target="_blank"`, and content security policy framing restrictions.

---

## 10. Notification & Outbox Integration

All decisions committed to MongoDB transactional sessions enqueue corresponding events in `NotificationOutbox`:
- `CREDENTIALS_SUBMITTED`
- `CREDENTIALS_INFO_REQUESTED`
- `CREDENTIALS_APPROVED`
- `CREDENTIALS_REJECTED`
- `ASSOCIATION_APPROVED`
- `ASSOCIATION_REJECTED`

### Privacy & Data Minimization Invariant
Outbox payloads store **zero** patient data, zero passwords, and zero full license files. Payload structures are limited to IDs, timestamps, public registration numbers, and sanitised administrative reasons.

---

## 11. Authority Matrix for Association Operations

| Operation | Permitted Actor | Authorization Mechanism | Audit Decision Type | Outbox Event |
| :--- | :--- | :--- | :--- | :--- |
| **Approve Association** | Platform `ADMIN` only | `req.userRole === 'ADMIN'` | `ASSOCIATION_APPROVED` | `ASSOCIATION_APPROVED` |
| **Reject Association** | Platform `ADMIN` only | `req.userRole === 'ADMIN'` | `ASSOCIATION_REJECTED` | `ASSOCIATION_REJECTED` |
| **Suspend Association** | `ADMIN` or Hospital's `HOSPITAL_ADMIN` | `ADMIN` or matching `hospitalId` | `ASSOCIATION_SUSPENDED` | `ASSOCIATION_SUSPENDED` |
| **Reactivate Association** | Platform `ADMIN` only | `req.userRole === 'ADMIN'` | `ASSOCIATION_REACTIVATED` | `ASSOCIATION_APPROVED` |
| **Revoke Association** | `ADMIN` or Hospital's `HOSPITAL_ADMIN` | `ADMIN` or matching `hospitalId` | `ASSOCIATION_REVOKED` | `ASSOCIATION_REVOKED` |

*Hospital Representatives (`HOSPITAL_ADMIN`) cannot approve associations for their own or any other hospital.*

---

## 12. API Contracts

### 12.1 Medical Officer Credential Endpoints
- `POST /api/medical-officers/credentials/submit`: Initial submission by active doctor.
- `GET /api/medical-officers/credentials/status`: Doctor inspects current status and clarification notes.
- `PATCH /api/medical-officers/credentials/resubmit`: Doctor resubmits updated information/evidence.
- `GET /api/admin/medical-officers/credentials`: ADMIN queue with status filters and search (idempotent read).
- `PATCH /api/admin/medical-officers/:id/credentials/review-start`: ADMIN claims review (`Pending_Verification -> Under_Review`).
- `PATCH /api/admin/medical-officers/:id/credentials/request-info`: ADMIN requests clarification with notes.
- `PATCH /api/admin/medical-officers/:id/credentials/approve`: ADMIN verifies credentials (Gate 2).
- `PATCH /api/admin/medical-officers/:id/credentials/reject`: ADMIN rejects credentials with mandatory reason.

### 12.2 Hospital Association Endpoints
- `GET /api/admin/hospital-associations`: ADMIN queue of pending and active associations.
- `PATCH /api/admin/hospital-associations/:id/approve`: ADMIN approves association (verifies Gate 2 prerequisite).
- `PATCH /api/admin/hospital-associations/:id/reject`: ADMIN rejects association with reason.
- `PATCH /api/admin/hospital-associations/:id/suspend`: Inactivates association.

---

## 13. Comprehensive Audit Integrity & Regression Test Plan

A dedicated test file `backend/tests/stageB34CredentialVerificationAndAssociationApproval.test.js` covers the following 8 critical audit-integrity scenarios alongside the operational lifecycle:

1. **Concurrent Audit Creation Test**:
   - Executes two simultaneous administrative decisions (e.g. approving two different doctor credentials) using `Promise.all`.
   - Asserts that both audit records are created with contiguous sequences $(S, S+1)$, matching cryptographic hashes, and the chain head advances to $S+1$ with zero race collisions or forks.
2. **Concurrent Administrative Decisions Test**:
   - Executes two simultaneous approval attempts for the *same* credential or association.
   - Asserts that exactly one transaction succeeds (HTTP 200) and the concurrent attempt is safely rejected with HTTP 409 Conflict.
3. **Audit Record Modification Test**:
   - Attempts to execute `AdministrativeDecisionAudit.updateOne()` or `.save()` on an existing audit entry.
   - Asserts that the operation throws an error and no mutation persists.
4. **Audit Record Deletion Test**:
   - Attempts to execute `AdministrativeDecisionAudit.deleteOne()` or `.deleteMany()`.
   - Asserts that the operation throws an error and the records remain intact.
5. **Missing Audit Records / Sequence Gap Test**:
   - Simulates a missing intermediate record ($S, S+2$).
   - Runs `verifyAuditChainIntegrity()` and asserts that the scanner detects the missing sequence and reports chain invalidity.
6. **Invalid Hash-Chain Links Test**:
   - Injects a simulated invalid `previousRecordHash` or forged `recordHash`.
   - Runs `verifyAuditChainIntegrity()` and asserts that the scanner pinpoints the exact tampered document.
7. **Audit-Chain Head Inconsistency Test**:
   - Simulates terminal-record deletion by removing the latest record while `AuditChainHead` remains at sequence $S$.
   - Asserts that `verifyAuditChainIntegrity()` flags head sequence mismatch (`head.sequenceNumber != max(record.sequenceNumber)`).
8. **Transaction Rollback Involving Audit Creation Test**:
   - Injects a failure during the notification outbox insertion phase of an administrative approval.
   - Asserts that the entire transaction rolls back atomically: credential status remains unchanged, no audit entry persists, and `AuditChainHead.sequenceNumber` does not advance.
9. **Zero-Trust `sessionScope` Enforcement**:
   - Authenticates doctor receiving `sessionScope: 'ONBOARDING'`.
   - Asserts that attempting to access clinical endpoints (`/api/medical-officer/requests`, `/verify`, `/dashboard`) returns HTTP 403 Forbidden.
10. **Full Platform Regression Invariant**:
    - Asserts that all 378 existing platform tests continue to pass with 0 failures and 0 regressions.
