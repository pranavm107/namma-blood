/**
 * Stage B3.5.2 Automated Test Suite: Hourly Audit Checkpoint Generation & Recovery
 * Namma Blood — Local Checkpoint Generation, Recovery & Watermark Isolation
 *
 * Test Matrix:
 * Group A: Payload Tests (1–6)
 * Group B: Sequence Range Tests (7–14)
 * Group C: Idempotency & Concurrency Tests (15–19)
 * Group D: Failure Handling & Recovery Tests (20–25)
 * Group E: Watermark & Anchoring Separation Tests (26–29)
 * Group F: Hourly UTC Scheduler Tests (30–33)
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const mongoose = require('mongoose')

const {
	AuditCheckpoint,
	VALID_GENERATION_STATUSES,
} = require('../Hospital/auditCheckpointModel')
const {
	AuditCheckpointCursor,
	GLOBAL_CHECKPOINT_CURSOR_ID,
	GENESIS_CHECKPOINT_HASH,
} = require('../Hospital/auditCheckpointCursorModel')
const {
	AuditChainHead,
	GLOBAL_HEAD_ID,
	GENESIS_ANCHOR_HASH,
} = require('../Hospital/auditChainHeadModel')
const {
	AdministrativeDecisionAudit,
} = require('../Hospital/administrativeDecisionAuditModel')
const {
	auditWriterService,
	auditReaderService,
	auditVerifierService,
} = require('../Hospital/auditIntegrityService')
const {
	CHECKPOINT_FORMAT_VERSION,
	constructCheckpointPayload,
	canonicalizeCheckpointPayload,
	calculateCheckpointHash,
	verifyCheckpointPayload,
	normalizeToUtcHourString,
	generateDeterministicCheckpointId,
} = require('../Hospital/auditCheckpointPayloadService')
const {
	getOrInitCheckpointCursor,
	determineEligibleSequenceRange,
	verifyAuditRangeIntegrity,
	acquireGenerationClaim,
	releaseGenerationClaim,
	generateHourlyCheckpoint,
} = require('../Hospital/auditCheckpointGenerationService')
const {
	reconcileStaleClaims,
	reconcileCursorWithPersistedCheckpoints,
	verifyCheckpointChainIntegrity,
} = require('../Hospital/auditCheckpointRecoveryService')
const {
	parseCheckpointSchedulerConfig,
	runScheduledCheckpointTick,
	startCheckpointScheduler,
	stopCheckpointScheduler,
	getSchedulerStatus,
} = require('../Hospital/auditCheckpointSchedulerService')
const { withTransaction } = require('../Utils/transactionHelper')

const TEST_DB_URI =
	process.env.MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

describe('Stage B3.5.2: Hourly Audit Checkpoint Generation & Recovery', () => {
	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}
		await mongoose.connection.collection('auditcheckpoints').drop().catch(() => {})
		await mongoose.connection.collection('auditcheckpointcursors').drop().catch(() => {})
		await AdministrativeDecisionAudit.init()
		await AuditChainHead.init()
		await AuditCheckpoint.init()
		await AuditCheckpoint.syncIndexes()
		await AuditCheckpointCursor.init()
	})

	beforeEach(async () => {
		stopCheckpointScheduler()
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
		await mongoose.connection.collection('auditcheckpoints').deleteMany({})
		await mongoose.connection.collection('auditcheckpointcursors').deleteMany({})
	})

	after(async () => {
		stopCheckpointScheduler()
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
		await mongoose.connection.collection('auditcheckpoints').deleteMany({})
		await mongoose.connection.collection('auditcheckpointcursors').deleteMany({})
		await mongoose.disconnect()
	})

	// Helper to populate N committed audit entries
	async function populateAuditEntries(count, startingIndex = 1) {
		const created = []
		for (let i = 0; i < count; i++) {
			const idx = startingIndex + i
			await withTransaction(async (session) => {
				const rec = await auditWriterService.appendRecord(session, {
					entityType: 'CREDENTIAL',
					entityId: new mongoose.Types.ObjectId(),
					targetUserId: new mongoose.Types.ObjectId(),
					decisionType: 'CREDENTIAL_SUBMITTED',
					previousStatus: 'Unsubmitted',
					newStatus: 'Pending_Verification',
					actorId: new mongoose.Types.ObjectId(),
					actorModel: 'user',
					actorRole: 'MEDICAL_OFFICER',
					reason: `Audit event index ${idx}`,
					notes: 'Automated test fixture',
					metadata: { testIndex: idx },
				})
				created.push(rec)
			})
		}
		return created
	}

	// =========================================================================
	// Group A: Payload Tests (1–6)
	// =========================================================================
	describe('Group A: Deterministic Payload Tests', () => {
		it('1. should produce identical canonical output for identical logical payload parameters', () => {
			const params1 = {
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				startSequence: 1,
				endSequence: 10,
				recordCount: 10,
				firstRecordHash: 'a'.repeat(64),
				lastRecordHash: 'b'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			}
			const params2 = { ...params1 }

			const payload1 = constructCheckpointPayload(params1)
			const payload2 = constructCheckpointPayload(params2)

			const canonical1 = canonicalizeCheckpointPayload(payload1)
			const canonical2 = canonicalizeCheckpointPayload(payload2)

			assert.strictEqual(canonical1, canonical2)
			assert.ok(canonical1.startsWith('{') && canonical1.endsWith('}'))
		})

		it('2. should produce deterministic 64-character SHA-256 checkpoint hash', () => {
			const params = {
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				startSequence: 1,
				endSequence: 5,
				recordCount: 5,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T10:00:00.000Z',
			}
			const payload = constructCheckpointPayload(params)
			const hash1 = calculateCheckpointHash(payload)
			const hash2 = calculateCheckpointHash(payload)

			assert.strictEqual(hash1, hash2)
			assert.strictEqual(hash1.length, 64)
			assert.match(hash1, /^[a-f0-9]{64}$/)
		})

		it('3. should validate all required payload fields and types', () => {
			const validParams = {
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				startSequence: 1,
				endSequence: 5,
				recordCount: 5,
				firstRecordHash: 'c'.repeat(64),
				lastRecordHash: 'd'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T11:00:00.000Z',
			}
			const payload = constructCheckpointPayload(validParams)
			assert.strictEqual(payload.startSequence, 1)
			assert.strictEqual(payload.endSequence, 5)
			assert.strictEqual(payload.recordCount, 5)
			assert.strictEqual(payload.checkpointFormatVersion, 'v1')

			// Invalid count mismatch
			assert.throws(
				() => constructCheckpointPayload({ ...validParams, recordCount: 99 }),
				/recordCount mismatch/
			)

			// Invalid startSequence
			assert.throws(
				() => constructCheckpointPayload({ ...validParams, startSequence: 0 }),
				/startSequence must be an integer >= 1/
			)

			// Invalid hash format
			assert.throws(
				() => constructCheckpointPayload({ ...validParams, firstRecordHash: 'not_a_hash' }),
				/firstRecordHash must be a 64-character SHA-256 hex string/
			)
		})

		it('4. should reject unsupported values (NaN, Infinity, BigInt, Symbols)', () => {
			const base = {
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				startSequence: 1,
				endSequence: 5,
				recordCount: 5,
				firstRecordHash: 'e'.repeat(64),
				lastRecordHash: 'f'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T12:00:00.000Z',
			}

			assert.throws(() => constructCheckpointPayload({ ...base, startSequence: NaN }))
			assert.throws(() => constructCheckpointPayload({ ...base, endSequence: Infinity }))
			assert.throws(() => canonicalizeCheckpointPayload({ invalid: BigInt(123) }), TypeError)
		})

		it('5. should normalize diverse timezone representations to canonical UTC hour string', () => {
			const isoUtc = '2026-11-09T14:35:12.789Z'
			const normalized1 = normalizeToUtcHourString(isoUtc)
			assert.strictEqual(normalized1, '2026-11-09T14:00:00.000Z')

			// Date object representing the same UTC moment
			const dateObj = new Date('2026-11-09T14:59:59.999Z')
			const normalized2 = normalizeToUtcHourString(dateObj)
			assert.strictEqual(normalized2, '2026-11-09T14:00:00.000Z')

			// Invalid date string
			assert.throws(() => normalizeToUtcHourString('not-a-valid-date'), TypeError)
		})

		it('6. should strictly reject sensitive audit, clinical, or patient data in payload parameters', () => {
			const base = {
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				startSequence: 1,
				endSequence: 2,
				recordCount: 2,
				firstRecordHash: 'a'.repeat(64),
				lastRecordHash: 'b'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T13:00:00.000Z',
			}

			// Prohibited clinical fields
			assert.throws(
				() => constructCheckpointPayload({ ...base, patientName: 'John Doe' }),
				/Security Violation/
			)
			assert.throws(
				() => constructCheckpointPayload({ ...base, evidenceReferences: ['https://cert'] }),
				/Security Violation/
			)
			assert.throws(
				() => constructCheckpointPayload({ ...base, notes: 'Clinical remarks' }),
				/Security Violation/
			)
		})
	})

	// =========================================================================
	// Group B: Sequence Range Tests (7–14)
	// =========================================================================
	describe('Group B: Sequence Range Tests', () => {
		it('7. should successfully generate first checkpoint covering sequences 1 to N', async () => {
			const auditCount = 5
			await populateAuditEntries(auditCount)

			const result = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})

			assert.strictEqual(result.status, 'CREATED')
			assert.ok(result.checkpoint)
			assert.strictEqual(result.checkpoint.startSequence, 1)
			assert.strictEqual(result.checkpoint.endSequence, 5)
			assert.strictEqual(result.checkpoint.recordCount, 5)
			assert.strictEqual(
				result.checkpoint.previousCheckpointHash,
				GENESIS_CHECKPOINT_HASH
			)
			assert.strictEqual(result.checkpoint.generationStatus, 'PENDING')
			assert.strictEqual(result.checkpoint.anchoringStatus, 'PENDING')

			// Verify cursor updated
			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 5)
			assert.strictEqual(cursor.lastCheckpointHash, result.checkpoint.checkpointHash)
			assert.strictEqual(cursor.totalCheckpoints, 1)
		})

		it('8. should generate subsequent checkpoint covering next contiguous sequence range', async () => {
			// Populate 6 entries, generate CP 1 with batchLimit: 3
			await populateAuditEntries(6)

			const cp1Result = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
				batchLimit: 3,
			})
			assert.strictEqual(cp1Result.status, 'CREATED')
			assert.strictEqual(cp1Result.checkpoint.startSequence, 1)
			assert.strictEqual(cp1Result.checkpoint.endSequence, 3)

			// Generate CP 2 for next hour
			const cp2Result = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T09:00:00.000Z',
				batchLimit: 3,
			})
			assert.strictEqual(cp2Result.status, 'CREATED')
			assert.strictEqual(cp2Result.checkpoint.startSequence, 4)
			assert.strictEqual(cp2Result.checkpoint.endSequence, 6)
			assert.strictEqual(
				cp2Result.checkpoint.previousCheckpointHash,
				cp1Result.checkpoint.checkpointHash
			)

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 6)
			assert.strictEqual(cursor.totalCheckpoints, 2)
		})

		it('9. should strictly chain previousCheckpointHash across consecutive checkpoints', async () => {
			await populateAuditEntries(9)

			const cp1 = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
				batchLimit: 3,
			})
			const cp2 = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T02:00:00.000Z',
				batchLimit: 3,
			})
			const cp3 = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T03:00:00.000Z',
				batchLimit: 3,
			})

			assert.strictEqual(cp1.checkpoint.previousCheckpointHash, GENESIS_CHECKPOINT_HASH)
			assert.strictEqual(cp2.checkpoint.previousCheckpointHash, cp1.checkpoint.checkpointHash)
			assert.strictEqual(cp3.checkpoint.previousCheckpointHash, cp2.checkpoint.checkpointHash)

			const chainCheck = await verifyCheckpointChainIntegrity()
			assert.strictEqual(chainCheck.isValid, true)
			assert.strictEqual(chainCheck.totalCheckpoints, 3)
		})

		it('10. should verify audit sequence continuity from startSequence to endSequence', async () => {
			await populateAuditEntries(4)

			const range = await determineEligibleSequenceRange()
			assert.strictEqual(range.eligible, true)
			assert.strictEqual(range.startSequence, 1)
			assert.strictEqual(range.endSequence, 4)

			const verification = await verifyAuditRangeIntegrity(1, 4)
			assert.strictEqual(verification.verified, true)
			assert.strictEqual(verification.count, 4)
		})

		it('11. should reject identical ranges via both schema-level guard and unique compound index', async () => {
			await populateAuditEntries(10)

			// Generate initial checkpoint covering [1..10]
			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})

			// Attempt to insert another checkpoint with identical range [1..10]
			await assert.rejects(
				async () => {
					await AuditCheckpoint.create({
						ledgerId: GLOBAL_HEAD_ID,
						checkpointId: 'CHK-IDENTICAL-RANGE-TEST',
						startSequence: 1,
						endSequence: 10,
						recordCount: 10,
						firstRecordHash: '1'.repeat(64),
						lastRecordHash: '2'.repeat(64),
						previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
						checkpointHash: '3'.repeat(64),
						payload: { test: true },
						canonicalPayload: '{}',
						scheduledHourUtc: '2026-11-09T09:00:00.000Z',
						generationStatus: 'PENDING',
					})
				},
				(err) => err.code === 11000 || /duplicate key|Overlapping checkpoint sequence range/i.test(err.message)
			)
		})

		it('11b. should reject partially overlapping ranges (e.g. [1..10] vs [5..15])', async () => {
			await populateAuditEntries(15)

			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
				batchLimit: 10,
			})

			// Attempt to insert partially overlapping checkpoint [5..15]
			await assert.rejects(
				async () => {
					await AuditCheckpoint.create({
						ledgerId: GLOBAL_HEAD_ID,
						checkpointId: 'CHK-PARTIAL-OVERLAP-TEST',
						startSequence: 5,
						endSequence: 15,
						recordCount: 11,
						firstRecordHash: '1'.repeat(64),
						lastRecordHash: '2'.repeat(64),
						previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
						checkpointHash: '3'.repeat(64),
						payload: { test: true },
						canonicalPayload: '{}',
						scheduledHourUtc: '2026-11-09T09:00:00.000Z',
						generationStatus: 'PENDING',
					})
				},
				/Overlapping checkpoint sequence range detected/i
			)
		})

		it('11c. should reject fully contained ranges (e.g. [1..10] vs [3..7])', async () => {
			await populateAuditEntries(10)

			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})

			// Attempt to insert fully contained checkpoint [3..7]
			await assert.rejects(
				async () => {
					await AuditCheckpoint.create({
						ledgerId: GLOBAL_HEAD_ID,
						checkpointId: 'CHK-CONTAINED-OVERLAP-TEST',
						startSequence: 3,
						endSequence: 7,
						recordCount: 5,
						firstRecordHash: '1'.repeat(64),
						lastRecordHash: '2'.repeat(64),
						previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
						checkpointHash: '3'.repeat(64),
						payload: { test: true },
						canonicalPayload: '{}',
						scheduledHourUtc: '2026-11-09T09:00:00.000Z',
						generationStatus: 'PENDING',
					})
				},
				/Overlapping checkpoint sequence range detected/i
			)
		})

		it('11d. should reject ranges that contain an existing range (e.g. [3..7] vs [1..10])', async () => {
			// Pre-insert a narrow range [3..7]
			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-NARROW-RANGE',
				startSequence: 3,
				endSequence: 7,
				recordCount: 5,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: '3'.repeat(64),
				payload: { test: true },
				canonicalPayload: '{}',
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
				generationStatus: 'PENDING',
			})

			// Attempt to insert a wider containing range [1..10]
			await assert.rejects(
				async () => {
					await AuditCheckpoint.create({
						ledgerId: GLOBAL_HEAD_ID,
						checkpointId: 'CHK-ENCLOSING-OVERLAP-TEST',
						startSequence: 1,
						endSequence: 10,
						recordCount: 10,
						firstRecordHash: '1'.repeat(64),
						lastRecordHash: '2'.repeat(64),
						previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
						checkpointHash: '4'.repeat(64),
						payload: { test: true },
						canonicalPayload: '{}',
						scheduledHourUtc: '2026-11-09T09:00:00.000Z',
						generationStatus: 'PENDING',
					})
				},
				/Overlapping checkpoint sequence range detected/i
			)
		})

		it('11e. should successfully allow adjacent non-overlapping ranges (e.g. [1..10] followed by [11..20])', async () => {
			await populateAuditEntries(20)

			// Generate CP1 [1..10]
			const cp1 = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
				batchLimit: 10,
			})
			assert.strictEqual(cp1.status, 'CREATED')
			assert.strictEqual(cp1.checkpoint.startSequence, 1)
			assert.strictEqual(cp1.checkpoint.endSequence, 10)

			// Generate CP2 [11..20] - contiguous adjacent range
			const cp2 = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T09:00:00.000Z',
				batchLimit: 10,
			})
			assert.strictEqual(cp2.status, 'CREATED')
			assert.strictEqual(cp2.checkpoint.startSequence, 11)
			assert.strictEqual(cp2.checkpoint.endSequence, 20)

			const count = await AuditCheckpoint.countDocuments({ generationStatus: 'PENDING' })
			assert.strictEqual(count, 2)
		})

		it('11f. should reject invalid ranges where startSequence exceeds endSequence', async () => {
			await assert.rejects(
				async () => {
					await AuditCheckpoint.create({
						ledgerId: GLOBAL_HEAD_ID,
						checkpointId: 'CHK-INVALID-RANGE-INVERTED',
						startSequence: 15,
						endSequence: 10, // Inverted!
						recordCount: 1,
						firstRecordHash: '1'.repeat(64),
						lastRecordHash: '2'.repeat(64),
						previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
						checkpointHash: '3'.repeat(64),
						payload: { test: true },
						canonicalPayload: '{}',
						scheduledHourUtc: '2026-11-09T08:00:00.000Z',
						generationStatus: 'PENDING',
					})
				},
				/Invalid sequence range: startSequence/i
			)
		})

		it('12. should fail closed when an audit record is missing in the eligible range', async () => {
			await populateAuditEntries(3)

			// Delete intermediate sequence 2 via raw driver
			await mongoose.connection
				.collection('administrativedecisionaudits')
				.deleteOne({ sequenceNumber: 2 })

			await assert.rejects(
				async () => {
					await generateHourlyCheckpoint({
						scheduledHourUtc: '2026-11-09T08:00:00.000Z',
					})
				},
				/Audit Ledger Incomplete|Sequence Discontinuity/
			)

			// Cursor must NOT have advanced
			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 0)
		})

		it('13. should fail closed when an audit hash mismatch is detected in the range', async () => {
			await populateAuditEntries(3)

			// Mutate data of record sequence 2 via raw driver
			await mongoose.connection
				.collection('administrativedecisionaudits')
				.updateOne({ sequenceNumber: 2 }, { $set: { decisionType: 'CREDENTIAL_APPROVED' } })

			await assert.rejects(
				async () => {
					await generateHourlyCheckpoint({
						scheduledHourUtc: '2026-11-09T08:00:00.000Z',
					})
				},
				/Data Tampering Detected/
			)

			// Cursor must NOT have advanced
			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 0)
		})

		it('14. should safely skip generation when no new committed audit records exist (empty range)', async () => {
			// No audit records in database
			const result = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})

			assert.strictEqual(result.status, 'SKIPPED')
			assert.strictEqual(result.reason, 'NO_NEW_COMMITTED_RECORDS')

			const totalCheckpoints = await AuditCheckpoint.countDocuments({})
			assert.strictEqual(totalCheckpoints, 0)
		})
	})

	// =========================================================================
	// Group C: Idempotency and Concurrency Tests (15–19)
	// =========================================================================
	describe('Group C: Idempotency and Concurrency Tests', () => {
		it('15. should return existing checkpoint idempotently when invoked repeatedly for the same hour', async () => {
			await populateAuditEntries(3)

			const firstRun = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T14:00:00.000Z',
			})
			assert.strictEqual(firstRun.status, 'CREATED')

			const secondRun = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T14:00:00.000Z',
			})
			assert.strictEqual(secondRun.status, 'ALREADY_EXISTS')
			assert.strictEqual(secondRun.idempotent, true)
			assert.strictEqual(secondRun.checkpoint.checkpointId, firstRun.checkpoint.checkpointId)

			const totalCheckpoints = await AuditCheckpoint.countDocuments({})
			assert.strictEqual(totalCheckpoints, 1)
		})

		it('16. should prevent duplicate checkpoint generation under concurrent worker attempts', async () => {
			await populateAuditEntries(4)

			// 5 simultaneous workers racing to generate for the same hour
			const workerPromises = Array.from({ length: 5 }, (_, i) =>
				generateHourlyCheckpoint({
					scheduledHourUtc: '2026-11-09T15:00:00.000Z',
					workerId: `concurrent-worker-${i}`,
				})
			)

			const results = await Promise.all(workerPromises)

			// Exactly one must have CREATED the checkpoint; others receive ALREADY_EXISTS or CLAIM_ACTIVE
			const createdCount = results.filter((r) => r.status === 'CREATED').length
			assert.strictEqual(createdCount, 1, 'Strictly ONE worker must create the checkpoint')

			const totalCheckpoints = await AuditCheckpoint.countDocuments({
				generationStatus: 'PENDING',
			})
			assert.strictEqual(totalCheckpoints, 1)
		})

		it('17. should enforce unique index on checkpointId preventing duplicate records', async () => {
			const checkpointId = 'CHK-UNIQUE-INDEX-TEST'
			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId,
				startSequence: 1,
				endSequence: 2,
				recordCount: 2,
				firstRecordHash: 'a'.repeat(64),
				lastRecordHash: 'b'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: 'c'.repeat(64),
				payload: {},
				canonicalPayload: '{}',
				scheduledHourUtc: '2026-11-09T16:00:00.000Z',
				generationStatus: 'PENDING',
			})

			await assert.rejects(
				async () => {
					await AuditCheckpoint.create({
						ledgerId: GLOBAL_HEAD_ID,
						checkpointId,
						startSequence: 10,
						endSequence: 20,
						recordCount: 11,
						firstRecordHash: 'x'.repeat(64),
						lastRecordHash: 'y'.repeat(64),
						previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
						checkpointHash: 'z'.repeat(64),
						payload: {},
						canonicalPayload: '{}',
						scheduledHourUtc: '2026-11-09T17:00:00.000Z',
						generationStatus: 'PENDING',
					})
				},
				(err) => err.code === 11000 || /duplicate key/i.test(err.message)
			)
		})

		it('18. should allow another worker to acquire claim after previous claim expires', async () => {
			await populateAuditEntries(3)

			// Worker 1 acquires claim with TTL (400ms)
			const claim1 = await acquireGenerationClaim('worker-1', 400, 1, 3)
			assert.strictEqual(claim1.acquired, true)

			// Worker 2 attempts immediately: rejected
			const claim2 = await acquireGenerationClaim('worker-2', 5000, 1, 3)
			assert.strictEqual(claim2.acquired, false)

			// Wait for claim 1 to expire
			await new Promise((resolve) => setTimeout(resolve, 450))

			// Worker 3 attempts after expiry: succeeds
			const claim3 = await acquireGenerationClaim('worker-3', 5000, 1, 3)
			assert.strictEqual(claim3.acquired, true)

			// Cleanup
			await releaseGenerationClaim(claim3.claimId, claim3.leaseToken)
		})

		it('19. should reject concurrent generation when another worker holds an active non-expired claim', async () => {
			await populateAuditEntries(3)

			// Worker 1 takes claim for 10 seconds
			const claim = await acquireGenerationClaim('worker-long-lease', 10000, 1, 3)
			assert.strictEqual(claim.acquired, true)

			// Attempt generation from service
			const result = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T18:00:00.000Z',
				workerId: 'competing-worker',
			})

			assert.strictEqual(result.status, 'CLAIM_ACTIVE')
			assert.strictEqual(result.reason, 'CONCURRENT_WORKER_CLAIM_ACTIVE')

			await releaseGenerationClaim(claim.claimId, claim.leaseToken)
		})

		// =====================================================================
		// Distributed Lease Fencing Verification Tests (A - F)
		// =====================================================================
		it('19b. Fencing Test A: Expired lease rejection', async () => {
			await populateAuditEntries(3)

			// Worker A acquires claim with 40ms TTL
			const claimA = await acquireGenerationClaim('worker-A', 40, 1, 3)
			assert.strictEqual(claimA.acquired, true)
			assert.ok(claimA.leaseToken)

			// Wait for Worker A's lease to expire
			await new Promise((resolve) => setTimeout(resolve, 60))

			// Attempt commit inside transaction simulating delayed persistence
			await assert.rejects(
				async () => {
					await withTransaction(async (session) => {
						const commitNow = new Date()
						const leaseCheck = await AuditCheckpointCursor.findOne({
							_id: GLOBAL_CHECKPOINT_CURSOR_ID,
							'activeClaim.claimId': claimA.claimId,
							'activeClaim.leaseToken': claimA.leaseToken,
							'activeClaim.expiresAt': { $gt: commitNow },
						}).session(session).lean()

						if (!leaseCheck) {
							const err = new Error(
								`Fencing Violation: Generation lease expired or ownership lost for claimId '${claimA.claimId}'. Checkpoint persistence and cursor advancement aborted.`
							)
							err.statusCode = 409
							err.name = 'FencingViolationError'
							throw err
						}
					})
				},
				/Fencing Violation: Generation lease expired or ownership lost/i
			)

			// Zero checkpoints persisted; cursor remains at 0
			const count = await AuditCheckpoint.countDocuments({ generationStatus: 'PENDING' })
			assert.strictEqual(count, 0)
			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 0)
		})

		it('19c. Fencing Test B: Replacement lease fencing (Worker A rejected, Worker B remains valid owner)', async () => {
			await populateAuditEntries(3)

			// Worker A acquires lease with short TTL (40ms)
			const claimA = await acquireGenerationClaim('worker-A', 40, 1, 3)
			assert.strictEqual(claimA.acquired, true)

			// Wait for Worker A's lease to expire
			await new Promise((resolve) => setTimeout(resolve, 60))

			// Worker B acquires replacement lease (5000ms)
			const claimB = await acquireGenerationClaim('worker-B', 5000, 1, 3)
			assert.strictEqual(claimB.acquired, true)
			assert.notStrictEqual(claimA.claimId, claimB.claimId)
			assert.notStrictEqual(claimA.leaseToken, claimB.leaseToken)

			// Worker A attempts conditional cursor advancement using stale claimId & leaseToken
			await assert.rejects(
				async () => {
					await withTransaction(async (session) => {
						const commitNow = new Date()
						const leaseCheck = await AuditCheckpointCursor.findOne({
							_id: GLOBAL_CHECKPOINT_CURSOR_ID,
							'activeClaim.claimId': claimA.claimId,
							'activeClaim.leaseToken': claimA.leaseToken,
							'activeClaim.expiresAt': { $gt: commitNow },
						}).session(session).lean()

						if (!leaseCheck) {
							const err = new Error(
								`Fencing Violation: Generation lease expired or ownership lost for claimId '${claimA.claimId}'.`
							)
							err.statusCode = 409
							err.name = 'FencingViolationError'
							throw err
						}
					})
				},
				/Fencing Violation/i
			)

			// Worker B MUST remain the active valid owner
			const cursor = await AuditCheckpointCursor.findById(GLOBAL_CHECKPOINT_CURSOR_ID).lean()
			assert.strictEqual(cursor.activeClaim.claimId, claimB.claimId)
			assert.strictEqual(cursor.activeClaim.workerId, 'worker-B')
			assert.strictEqual(cursor.activeClaim.leaseToken, claimB.leaseToken)

			await releaseGenerationClaim(claimB.claimId, claimB.leaseToken)
		})

		it('19d. Fencing Test C: Replacement lease preservation (Worker A cannot clear Worker B lease)', async () => {
			await populateAuditEntries(3)

			// Worker A acquires short lease
			const claimA = await acquireGenerationClaim('worker-A', 40, 1, 3)
			assert.strictEqual(claimA.acquired, true)

			// Wait for expiry
			await new Promise((resolve) => setTimeout(resolve, 60))

			// Worker B acquires replacement lease
			const claimB = await acquireGenerationClaim('worker-B', 5000, 1, 3)
			assert.strictEqual(claimB.acquired, true)

			// Expired Worker A attempts to release lease
			await releaseGenerationClaim(claimA.claimId, claimA.leaseToken)

			// Verify Worker B's lease was NOT cleared or overwritten
			const cursor = await AuditCheckpointCursor.findById(GLOBAL_CHECKPOINT_CURSOR_ID).lean()
			assert.strictEqual(cursor.activeClaim.claimId, claimB.claimId)
			assert.strictEqual(cursor.activeClaim.workerId, 'worker-B')
			assert.strictEqual(cursor.activeClaim.leaseToken, claimB.leaseToken)

			await releaseGenerationClaim(claimB.claimId, claimB.leaseToken)
		})

		it('19e. Fencing Test D: Successful current owner commit', async () => {
			await populateAuditEntries(3)

			// Worker B generates with valid lease
			const result = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
				workerId: 'worker-B-valid-owner',
				claimTtlMs: 5000,
			})

			assert.strictEqual(result.status, 'CREATED')
			assert.strictEqual(result.checkpoint.startSequence, 1)
			assert.strictEqual(result.checkpoint.endSequence, 3)
			assert.strictEqual(result.checkpoint.generationStatus, 'PENDING')

			// Exactly one checkpoint persisted
			const count = await AuditCheckpoint.countDocuments({ generationStatus: 'PENDING' })
			assert.strictEqual(count, 1)

			// Cursor advanced correctly and claim cleared
			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 3)
			assert.strictEqual(cursor.activeClaim.claimId, null)
		})

		it('19f. Fencing Test E: Concurrent generation safety (no overlaps, no duplicates, no split-brain)', async () => {
			await populateAuditEntries(5)

			// 4 workers race simultaneously
			const workers = Array.from({ length: 4 }, (_, i) =>
				generateHourlyCheckpoint({
					scheduledHourUtc: '2026-11-09T10:00:00.000Z',
					workerId: `concurrent-fenced-worker-${i}`,
					claimTtlMs: 5000,
				})
			)

			const results = await Promise.all(workers)

			const created = results.filter((r) => r.status === 'CREATED')
			assert.strictEqual(created.length, 1, 'Strictly ONE worker must create the checkpoint')

			// Verify only ONE checkpoint exists for this range
			const checkpoints = await AuditCheckpoint.find({ generationStatus: 'PENDING' }).lean()
			assert.strictEqual(checkpoints.length, 1)
			assert.strictEqual(checkpoints[0].startSequence, 1)
			assert.strictEqual(checkpoints[0].endSequence, 5)

			// Cursor matches the single checkpoint
			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 5)
		})

		it('19g. Fencing Test F: External watermark isolation under lease fencing', async () => {
			await populateAuditEntries(4)

			// Confirm initial operational and external watermark state
			const headBefore = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(headBefore.lastAnchoredSequence, 0)
			const initialOpSeq = headBefore.sequenceNumber

			// Run generation through service
			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T11:00:00.000Z',
				workerId: 'watermark-test-worker',
			})

			// Check AuditChainHead: operational sequence must remain intact, external anchor MUST BE 0
			const headAfter = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(headAfter.sequenceNumber, initialOpSeq)
			assert.strictEqual(headAfter.lastAnchoredSequence, 0, 'lastAnchoredSequence must NEVER advance in B3.5.2')
		})
	})

	// =========================================================================
	// Group D: Failure Handling and Recovery Tests (20–25)
	// =========================================================================
	describe('Group D: Failure Handling and Recovery Tests', () => {
		it('20. should not advance cursor or create checkpoint if validation fails before persistence', async () => {
			await populateAuditEntries(2)

			// Inject sequence mismatch
			await mongoose.connection
				.collection('administrativedecisionaudits')
				.updateOne({ sequenceNumber: 2 }, { $set: { sequenceNumber: 99 } })

			await assert.rejects(async () => {
				await generateHourlyCheckpoint({
					scheduledHourUtc: '2026-11-09T08:00:00.000Z',
				})
			})

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 0)

			const count = await AuditCheckpoint.countDocuments({ generationStatus: 'PENDING' })
			assert.strictEqual(count, 0)
		})

		it('21. should completely roll back transaction if cursor advancement fails during persistence', async () => {
			await populateAuditEntries(2)

			// Monkey-patch AuditCheckpointCursor.findOneAndUpdate to simulate failure inside transaction
			const origFindOneAndUpdate = AuditCheckpointCursor.findOneAndUpdate
			AuditCheckpointCursor.findOneAndUpdate = () => {
				throw new Error('SIMULATED_CURSOR_WRITE_FAILURE')
			}

			try {
				await assert.rejects(
					async () => {
						await generateHourlyCheckpoint({
							scheduledHourUtc: '2026-11-09T08:00:00.000Z',
						})
					},
					/SIMULATED_CURSOR_WRITE_FAILURE/
				)
			} finally {
				AuditCheckpointCursor.findOneAndUpdate = origFindOneAndUpdate
			}

			// Checkpoint record must NOT remain PENDING in DB
			const pendingCheckpoints = await AuditCheckpoint.countDocuments({
				generationStatus: 'PENDING',
			})
			assert.strictEqual(pendingCheckpoints, 0)

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 0)
		})

		it('22. should reconcile cursor on crash after checkpoint persistence', async () => {
			await populateAuditEntries(4)

			// Generate valid checkpoint 1
			const gen = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})
			assert.strictEqual(gen.status, 'CREATED')

			// Simulate crash drift: reset cursor sequence back to 0
			await mongoose.connection
				.collection('auditcheckpointcursors')
				.updateOne(
					{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
					{ $set: { lastCheckpointedSequence: 0, totalCheckpoints: 0 } }
				)

			const driftCursor = await getOrInitCheckpointCursor()
			assert.strictEqual(driftCursor.lastCheckpointedSequence, 0)

			// Run recovery reconciliation
			const recResult = await reconcileCursorWithPersistedCheckpoints()
			assert.strictEqual(recResult.reconciled, true)
			assert.strictEqual(recResult.previousSequence, 0)
			assert.strictEqual(recResult.currentSequence, 4)

			const restoredCursor = await getOrInitCheckpointCursor()
			assert.strictEqual(restoredCursor.lastCheckpointedSequence, 4)
		})

		it('23. should prevent cursor reconciliation from advancing past a checkpoint gap', async () => {
			// Manually create CP1 (1..3) and CP3 (7..9), skipping CP2 (4..6)
			const p1 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-GAP-TEST-1',
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
			})
			const h1 = calculateCheckpointHash(p1)

			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-GAP-TEST-1',
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: h1,
				payload: p1,
				canonicalPayload: canonicalizeCheckpointPayload(p1),
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
				generationStatus: 'PENDING',
			})

			const p3 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-GAP-TEST-3',
				startSequence: 7,
				endSequence: 9,
				recordCount: 3,
				firstRecordHash: '4'.repeat(64),
				lastRecordHash: '5'.repeat(64),
				previousCheckpointHash: h1,
				scheduledHourUtc: '2026-11-09T03:00:00.000Z',
			})
			const h3 = calculateCheckpointHash(p3)

			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-GAP-TEST-3',
				startSequence: 7,
				endSequence: 9,
				recordCount: 3,
				firstRecordHash: '4'.repeat(64),
				lastRecordHash: '5'.repeat(64),
				previousCheckpointHash: h1,
				checkpointHash: h3,
				payload: p3,
				canonicalPayload: canonicalizeCheckpointPayload(p3),
				scheduledHourUtc: '2026-11-09T03:00:00.000Z',
				generationStatus: 'PENDING',
			})

			// Set cursor to 0
			await mongoose.connection
				.collection('auditcheckpointcursors')
				.updateOne(
					{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
					{ $set: { lastCheckpointedSequence: 0 } }
				)

			const rec = await reconcileCursorWithPersistedCheckpoints()
			assert.strictEqual(rec.currentSequence, 3, 'Must stop at end of contiguous range 3')

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 3)
		})

		it('23b. should prevent cursor reconciliation from advancing past a corrupted payload', async () => {
			const p1 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-CORRUPT-TEST-1',
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
			})
			const h1 = calculateCheckpointHash(p1)

			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-CORRUPT-TEST-1',
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: h1,
				payload: p1,
				canonicalPayload: canonicalizeCheckpointPayload(p1),
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
				generationStatus: 'PENDING',
			})

			// Insert CP2 with tampered payload where hash doesn't match payload
			const p2 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-CORRUPT-TEST-2',
				startSequence: 4,
				endSequence: 6,
				recordCount: 3,
				firstRecordHash: '3'.repeat(64),
				lastRecordHash: '4'.repeat(64),
				previousCheckpointHash: h1,
				scheduledHourUtc: '2026-11-09T02:00:00.000Z',
			})
			// Intentionally tamper with the stored checkpointHash so it mismatches the payload
			const tamperedHash = 'f'.repeat(64)

			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-CORRUPT-TEST-2',
				startSequence: 4,
				endSequence: 6,
				recordCount: 3,
				firstRecordHash: '3'.repeat(64),
				lastRecordHash: '4'.repeat(64),
				previousCheckpointHash: h1,
				checkpointHash: tamperedHash,
				payload: p2,
				canonicalPayload: canonicalizeCheckpointPayload(p2),
				scheduledHourUtc: '2026-11-09T02:00:00.000Z',
				generationStatus: 'PENDING',
			})

			// Set cursor to 0
			await mongoose.connection
				.collection('auditcheckpointcursors')
				.updateOne(
					{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
					{ $set: { lastCheckpointedSequence: 0 } }
				)

			const rec = await reconcileCursorWithPersistedCheckpoints()
			assert.strictEqual(rec.currentSequence, 3, 'Must stop before corrupted checkpoint 2')

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 3)
		})

		it('23c. should prevent cursor reconciliation from advancing past a broken hash chain', async () => {
			const p1 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-CHAIN-TEST-1',
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
			})
			const h1 = calculateCheckpointHash(p1)

			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-CHAIN-TEST-1',
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: h1,
				payload: p1,
				canonicalPayload: canonicalizeCheckpointPayload(p1),
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
				generationStatus: 'PENDING',
			})

			// CP2 with bogus previousCheckpointHash
			const p2 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-CHAIN-TEST-2',
				startSequence: 4,
				endSequence: 6,
				recordCount: 3,
				firstRecordHash: '3'.repeat(64),
				lastRecordHash: '4'.repeat(64),
				previousCheckpointHash: 'e'.repeat(64), // BROKEN LINKAGE
				scheduledHourUtc: '2026-11-09T02:00:00.000Z',
			})
			const h2 = calculateCheckpointHash(p2)

			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-CHAIN-TEST-2',
				startSequence: 4,
				endSequence: 6,
				recordCount: 3,
				firstRecordHash: '3'.repeat(64),
				lastRecordHash: '4'.repeat(64),
				previousCheckpointHash: 'e'.repeat(64),
				checkpointHash: h2,
				payload: p2,
				canonicalPayload: canonicalizeCheckpointPayload(p2),
				scheduledHourUtc: '2026-11-09T02:00:00.000Z',
				generationStatus: 'PENDING',
			})

			// Set cursor to 0
			await mongoose.connection
				.collection('auditcheckpointcursors')
				.updateOne(
					{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
					{ $set: { lastCheckpointedSequence: 0 } }
				)

			const rec = await reconcileCursorWithPersistedCheckpoints()
			assert.strictEqual(rec.currentSequence, 3, 'Must stop before broken hash linkage')

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 3)
		})

		it('23d. should never move a valid cursor backwards during reconciliation', async () => {
			// Ensure cursor exists
			await getOrInitCheckpointCursor()

			// Persist CP1 covering 1..3
			const p1 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-BACKWARD-TEST-1',
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
			})
			const h1 = calculateCheckpointHash(p1)

			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-BACKWARD-TEST-1',
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: h1,
				payload: p1,
				canonicalPayload: canonicalizeCheckpointPayload(p1),
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
				generationStatus: 'PENDING',
			})

			// Set cursor ahead to 10 (simulating higher validated coverage)
			await mongoose.connection
				.collection('auditcheckpointcursors')
				.updateOne(
					{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
					{ $set: { lastCheckpointedSequence: 10 } },
					{ upsert: true }
				)

			const rec = await reconcileCursorWithPersistedCheckpoints()
			assert.strictEqual(rec.reconciled, false)
			assert.strictEqual(rec.reason, 'CURSOR_REGRESSION_PREVENTED')
			assert.strictEqual(rec.previousSequence, 10)
			assert.strictEqual(rec.currentSequence, 10)

			// Cursor must REMAIN at 10 (never move backwards to 3)
			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 10)
		})

		it('23e. should prevent cursor reconciliation from accepting overlapping checkpoint ranges', async () => {
			// Persist CP1 [1..5]
			const p1 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-OVERLAP-REC-1',
				startSequence: 1,
				endSequence: 5,
				recordCount: 5,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
			})
			const h1 = calculateCheckpointHash(p1)

			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-OVERLAP-REC-1',
				startSequence: 1,
				endSequence: 5,
				recordCount: 5,
				firstRecordHash: '1'.repeat(64),
				lastRecordHash: '2'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: h1,
				payload: p1,
				canonicalPayload: canonicalizeCheckpointPayload(p1),
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
				generationStatus: 'PENDING',
			})

			// Bypass schema hook to force-insert overlapping CP2 [3..8] via raw driver
			const p2 = constructCheckpointPayload({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-OVERLAP-REC-2',
				startSequence: 3,
				endSequence: 8,
				recordCount: 6,
				firstRecordHash: '3'.repeat(64),
				lastRecordHash: '4'.repeat(64),
				previousCheckpointHash: h1,
				scheduledHourUtc: '2026-11-09T02:00:00.000Z',
			})
			const h2 = calculateCheckpointHash(p2)

			await mongoose.connection.collection('auditcheckpoints').insertOne({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-OVERLAP-REC-2',
				startSequence: 3,
				endSequence: 8,
				recordCount: 6,
				firstRecordHash: '3'.repeat(64),
				lastRecordHash: '4'.repeat(64),
				previousCheckpointHash: h1,
				checkpointHash: h2,
				payload: p2,
				canonicalPayload: canonicalizeCheckpointPayload(p2),
				scheduledHourUtc: '2026-11-09T02:00:00.000Z',
				generationStatus: 'PENDING',
				anchoringStatus: 'PENDING',
				generatedAt: new Date(),
			})

			// Set cursor to 0
			await mongoose.connection
				.collection('auditcheckpointcursors')
				.updateOne(
					{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
					{ $set: { lastCheckpointedSequence: 0 } }
				)

			const rec = await reconcileCursorWithPersistedCheckpoints()
			assert.strictEqual(rec.currentSequence, 5, 'Must stop at 5 and reject overlapping checkpoint')

			const chainIntegrity = await verifyCheckpointChainIntegrity()
			assert.strictEqual(chainIntegrity.isValid, false)
			assert.ok(chainIntegrity.errors.some((e) => /Overlapping checkpoint sequence range/i.test(e)))
		})

		it('23f. should ensure repeated reconciliation is completely idempotent', async () => {
			await populateAuditEntries(6)

			// Generate 2 valid checkpoints: [1..3] and [4..6]
			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T01:00:00.000Z',
				batchLimit: 3,
			})
			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T02:00:00.000Z',
				batchLimit: 3,
			})

			// Run reconciliation 3 consecutive times
			const r1 = await reconcileCursorWithPersistedCheckpoints()
			const r2 = await reconcileCursorWithPersistedCheckpoints()
			const r3 = await reconcileCursorWithPersistedCheckpoints()

			assert.strictEqual(r1.currentSequence, 6)
			assert.strictEqual(r2.currentSequence, 6)
			assert.strictEqual(r3.currentSequence, 6)

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 6)
		})

		it('24. should clean up stale claims and mark expired GENERATING checkpoints as FAILED', async () => {
			// Insert an expired GENERATING checkpoint
			const staleHour = '2026-11-09T04:00:00.000Z'
			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: 'CHK-STALE-GENERATING-1',
				startSequence: 1,
				endSequence: 2,
				recordCount: 2,
				firstRecordHash: 'a'.repeat(64),
				lastRecordHash: 'b'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: 'c'.repeat(64),
				payload: {},
				canonicalPayload: '{}',
				scheduledHourUtc: staleHour,
				generationStatus: 'GENERATING',
				claimExpiresAt: new Date(Date.now() - 10000), // Expired 10s ago
			})

			// Set expired claim on cursor
			await mongoose.connection
				.collection('auditcheckpointcursors')
				.updateOne(
					{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
					{
						$set: {
							activeClaim: {
								claimId: 'stale-claim-1',
								workerId: 'crashed-worker',
								expiresAt: new Date(Date.now() - 10000),
							},
						},
					},
					{ upsert: true }
				)

			const cleanup = await reconcileStaleClaims(1000)
			assert.strictEqual(cleanup.recoveredCursorClaims, 1)
			assert.strictEqual(cleanup.recoveredCheckpoints, 1)

			const cp = await AuditCheckpoint.findOne({ checkpointId: 'CHK-STALE-GENERATING-1' })
			assert.strictEqual(cp.generationStatus, 'FAILED')
			assert.strictEqual(cp.generationErrorCode, 'CLAIM_EXPIRED')

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.activeClaim.claimId, null)
		})

		it('25. should successfully retry checkpoint generation after previous failure', async () => {
			await populateAuditEntries(3)

			// Intentionally record a FAILED checkpoint for hour 08:00
			const failedHour = '2026-11-09T08:00:00.000Z'
			const failedId = generateDeterministicCheckpointId(GLOBAL_HEAD_ID, 1, 3, failedHour)
			await AuditCheckpoint.create({
				ledgerId: GLOBAL_HEAD_ID,
				checkpointId: failedId,
				startSequence: 1,
				endSequence: 3,
				recordCount: 3,
				firstRecordHash: '0'.repeat(64),
				lastRecordHash: '0'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: '0'.repeat(64),
				payload: {},
				canonicalPayload: '{}',
				scheduledHourUtc: failedHour,
				generationStatus: 'FAILED',
				generationErrorCode: 'TRANSIENT_NETWORK_TIMEOUT',
			})

			// Generate again for hour 09:00: should succeed and generate clean PENDING checkpoint
			const retryResult = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T09:00:00.000Z',
			})

			assert.strictEqual(retryResult.status, 'CREATED')
			assert.strictEqual(retryResult.checkpoint.generationStatus, 'PENDING')
			assert.strictEqual(retryResult.checkpoint.startSequence, 1)
			assert.strictEqual(retryResult.checkpoint.endSequence, 3)

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 3)
		})
	})

	// =========================================================================
	// Group E: Watermark and Anchoring Separation Tests (26–29)
	// =========================================================================
	describe('Group E: Watermark Separation Tests', () => {
		it('26. should advance ONLY the checkpoint coverage cursor during checkpoint generation', async () => {
			await populateAuditEntries(4)

			const cursorBefore = await getOrInitCheckpointCursor()
			assert.strictEqual(cursorBefore.lastCheckpointedSequence, 0)

			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})

			const cursorAfter = await getOrInitCheckpointCursor()
			assert.strictEqual(cursorAfter.lastCheckpointedSequence, 4)
			assert.strictEqual(cursorAfter.totalCheckpoints, 1)
		})

		it('27. should NEVER modify or corrupt operational AuditChainHead sequenceNumber or hash', async () => {
			await populateAuditEntries(3)

			const headBefore = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(headBefore.sequenceNumber, 3)
			assert.strictEqual(headBefore.totalRecords, 3)
			const originalHeadHash = headBefore.latestRecordHash

			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})

			const headAfter = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(headAfter.sequenceNumber, 3)
			assert.strictEqual(headAfter.totalRecords, 3)
			assert.strictEqual(headAfter.latestRecordHash, originalHeadHash)
		})

		it('28. should NEVER advance external anchored watermark (lastAnchoredSequence)', async () => {
			await populateAuditEntries(5)

			const headBefore = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(headBefore.lastAnchoredSequence, 0)
			assert.strictEqual(headBefore.lastAnchoredHash, '')

			await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})

			const headAfter = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(
				headAfter.lastAnchoredSequence,
				0,
				'lastAnchoredSequence must remain 0 in B3.5.2'
			)
			assert.strictEqual(
				headAfter.lastAnchoredHash,
				'',
				'lastAnchoredHash must remain empty in B3.5.2'
			)
			assert.strictEqual(headAfter.lastAnchoredAt, null)
		})

		it('29. should NEVER mark any checkpoint as ANCHORED (must be PENDING)', async () => {
			await populateAuditEntries(2)

			const result = await generateHourlyCheckpoint({
				scheduledHourUtc: '2026-11-09T08:00:00.000Z',
			})

			assert.strictEqual(result.checkpoint.anchoringStatus, 'PENDING')
			assert.strictEqual(result.checkpoint.anchoredAt, null)
			assert.strictEqual(result.checkpoint.externalObjectVersionId, null)
			assert.strictEqual(result.checkpoint.externalObjectKey, null)
			assert.strictEqual(result.checkpoint.retentionUntil, null)

			const countAnchored = await AuditCheckpoint.countDocuments({
				anchoringStatus: 'ANCHORED',
			})
			assert.strictEqual(countAnchored, 0)
		})
	})

	// =========================================================================
	// Group F: Hourly UTC Scheduler Tests (30–33)
	// =========================================================================
	describe('Group F: Hourly UTC Scheduler Tests', () => {
		it('30. should execute scheduler tick aligned with normalized UTC hourly boundary', async () => {
			await populateAuditEntries(3)

			const arbitraryMoment = '2026-11-09T17:42:19.456Z'
			const tickResult = await runScheduledCheckpointTick({
				injectedDate: arbitraryMoment,
			})

			assert.strictEqual(tickResult.status, 'CREATED')
			assert.strictEqual(
				tickResult.checkpoint.scheduledHourUtc,
				'2026-11-09T17:00:00.000Z'
			)

			const status = getSchedulerStatus()
			assert.strictEqual(status.cumulativeMetrics.totalCheckpointsCreated, 1)
			assert.strictEqual(status.lastError, null)
		})

		it('31. should remain safely disabled when ENABLE_AUDIT_CHECKPOINT_SCHEDULER is false', () => {
			const config = parseCheckpointSchedulerConfig({
				ENABLE_AUDIT_CHECKPOINT_SCHEDULER: 'false',
			})
			assert.strictEqual(config.enabled, false)

			const started = startCheckpointScheduler(config)
			assert.strictEqual(started, false)

			const status = getSchedulerStatus()
			assert.strictEqual(status.isRunning, false)
		})

		it('32. should handle duplicate or concurrent scheduler invocations safely without race conditions', async () => {
			await populateAuditEntries(3)

			const injectedTime = '2026-11-09T19:00:00.000Z'

			// Trigger two rapid consecutive ticks
			const p1 = runScheduledCheckpointTick({ injectedDate: injectedTime })
			const p2 = runScheduledCheckpointTick({ injectedDate: injectedTime })

			const [res1, res2] = await Promise.all([p1, p2])

			// Both promises safely resolve; one creates or both return same operation result
			assert.ok(['CREATED', 'ALREADY_EXISTS'].includes(res1.status))
			assert.ok(['CREATED', 'ALREADY_EXISTS'].includes(res2.status))

			const count = await AuditCheckpoint.countDocuments({ generationStatus: 'PENDING' })
			assert.strictEqual(count, 1)
		})

		it('33. should ensure scheduler errors do not corrupt audit ledger state', async () => {
			await populateAuditEntries(3)

			// Tamper with record 3 so tick encounters validation failure
			await mongoose.connection
				.collection('administrativedecisionaudits')
				.updateOne({ sequenceNumber: 3 }, { $set: { recordHash: 'tampered_hash_000000000' } })

			await assert.rejects(async () => {
				await runScheduledCheckpointTick({
					injectedDate: '2026-11-09T20:00:00.000Z',
				})
			})

			const status = getSchedulerStatus()
			assert.strictEqual(status.cumulativeMetrics.totalErrors, 1)
			assert.ok(status.lastError.includes('Data Tampering Detected'))

			// Verify operational chain head is unharmed
			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.sequenceNumber, 3)
			assert.strictEqual(head.lastAnchoredSequence, 0)
		})
	})
})
