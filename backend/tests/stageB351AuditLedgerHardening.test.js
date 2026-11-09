/**
 * Stage B3.5.1 Automated Test Suite: Audit Ledger Hardening
 * Namma Blood — Immutable Administrative Decision Audit Ledger
 *
 * Comprehensive Test Coverage:
 * 1. Valid audit append
 * 2. Sequential audit append
 * 3. Concurrent append & transaction serialization
 * 4. Duplicate sequence prevention
 * 5. Transaction rollback & ACID safety
 * 6. Chain-head consistency
 * 7. v1 canonicalization compatibility
 * 8. v2 canonicalization compatibility
 * 9. Audit record mutation detection
 * 10. Audit record deletion detection
 * 11. Previous hash tampering detection
 * 12. Sequence gap detection
 * 13. Reordered record detection
 * 14. Append-only service restrictions (Mongoose lifecycle guards & bulkWrite)
 * 15. Existing B3.4 credential and association audit compatibility
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const mongoose = require('mongoose')

const {
	AdministrativeDecisionAudit,
	VALID_AUDIT_ENTITY_TYPES,
	VALID_AUDIT_DECISIONS,
	VALID_ACTOR_MODELS,
	VALID_ACTOR_ROLES,
} = require('../Hospital/administrativeDecisionAuditModel')
const {
	AuditChainHead,
	GENESIS_ANCHOR_HASH,
} = require('../Hospital/auditChainHeadModel')
const {
	HASH_VERSION,
	HASH_VERSION_V1,
	HASH_VERSION_V2,
	GLOBAL_HEAD_ID,
	canonicalizeValue,
	serializeAuditRecordCanonical,
	calculateRecordHash,
	getOrInitAuditChainHead,
	appendAuditRecordTransactional,
	verifyAuditChainIntegrity,
	auditWriterService,
	auditReaderService,
	auditVerifierService,
} = require('../Hospital/auditIntegrityService')
const { withTransaction } = require('../Utils/transactionHelper')

const TEST_DB_URI =
	process.env.MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

describe('Stage B3.5.1: Immutable Audit Ledger Hardening', () => {
	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}
		await AdministrativeDecisionAudit.init()
		await AuditChainHead.init()

		// Clean up collections for a pristine baseline
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
	})

	beforeEach(async () => {
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
	})

	after(async () => {
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
		await mongoose.disconnect()
	})

	// Helper to generate a valid dummy audit payload
	function generateSampleAuditPayload(overrides = {}) {
		return {
			entityType: 'CREDENTIAL',
			entityId: new mongoose.Types.ObjectId(),
			targetUserId: new mongoose.Types.ObjectId(),
			decisionType: 'CREDENTIAL_SUBMITTED',
			previousStatus: 'Unsubmitted',
			newStatus: 'Pending_Verification',
			actorId: new mongoose.Types.ObjectId(),
			actorModel: 'user',
			actorRole: 'MEDICAL_OFFICER',
			reason: 'Initial onboarding credentials submission',
			notes: 'Council registration verified against state portal',
			evidenceReferences: ['https://storage.nammablood.test/evidence/cert.pdf'],
			grantedPermissions: [],
			metadata: { registrationYear: 2021, medicalCouncil: 'TNMC' },
			...overrides,
		}
	}

	// =========================================================================
	// 1. Valid audit append
	// =========================================================================
	it('1. should successfully append a valid audit entry within a transaction', async () => {
		const payload = generateSampleAuditPayload()

		let createdRecord
		await withTransaction(async (session) => {
			createdRecord = await auditWriterService.appendRecord(session, payload)
		})

		assert.ok(createdRecord, 'Record must be created')
		assert.strictEqual(createdRecord.sequenceNumber, 1)
		assert.strictEqual(createdRecord.previousRecordHash, GENESIS_ANCHOR_HASH)
		assert.strictEqual(createdRecord.hashVersion, HASH_VERSION_V2)
		assert.strictEqual(typeof createdRecord.recordHash, 'string')
		assert.strictEqual(createdRecord.recordHash.length, 64)

		const fetched = await auditReaderService.getRecordBySequence(1)
		assert.ok(fetched, 'Record must be queryable by sequence')
		assert.strictEqual(fetched.sequenceNumber, 1)
		assert.strictEqual(fetched.recordHash, createdRecord.recordHash)
	})

	// =========================================================================
	// 2. Sequential audit append
	// =========================================================================
	it('2. should monotonically advance sequences across sequential appends', async () => {
		const recordCount = 5
		const createdRecords = []

		for (let i = 1; i <= recordCount; i++) {
			await withTransaction(async (session) => {
				const rec = await auditWriterService.appendRecord(
					session,
					generateSampleAuditPayload({
						reason: `Sequential step ${i}`,
						metadata: { stepIndex: i },
					})
				)
				createdRecords.push(rec)
			})
		}

		assert.strictEqual(createdRecords.length, recordCount)

		let expectedPrev = GENESIS_ANCHOR_HASH
		for (let i = 0; i < recordCount; i++) {
			const rec = createdRecords[i]
			assert.strictEqual(rec.sequenceNumber, i + 1, `Sequence must be ${i + 1}`)
			assert.strictEqual(
				rec.previousRecordHash,
				expectedPrev,
				`Record ${rec.sequenceNumber} must point to previous hash`
			)
			expectedPrev = rec.recordHash
		}

		const head = await auditReaderService.getChainHead()
		assert.strictEqual(head.sequenceNumber, recordCount)
		assert.strictEqual(head.totalRecords, recordCount)
		assert.strictEqual(head.latestRecordHash, createdRecords[recordCount - 1].recordHash)

		const verification = await auditVerifierService.verifyChain()
		assert.strictEqual(verification.isValid, true)
		assert.strictEqual(verification.totalRecords, recordCount)
		assert.strictEqual(verification.errors.length, 0)
	})

	// =========================================================================
	// 3. Concurrent append & transaction serialization
	// =========================================================================
	it('3. should safely serialize concurrent appends without collisions or forks', async () => {
		const concurrentCount = 6

		const appendTasks = Array.from({ length: concurrentCount }, (_, i) => {
			return withTransaction(async (session) => {
				return await auditWriterService.appendRecord(
					session,
					generateSampleAuditPayload({
						reason: `Concurrent transaction ${i}`,
						metadata: { workerId: i },
					})
				)
			})
		})

		const results = await Promise.all(appendTasks)
		assert.strictEqual(results.length, concurrentCount)

		// All sequences must be unique from 1 to concurrentCount
		const sequences = results.map((r) => r.sequenceNumber).sort((a, b) => a - b)
		for (let i = 0; i < concurrentCount; i++) {
			assert.strictEqual(sequences[i], i + 1, `Expected sequence ${i + 1}`)
		}

		const verification = await auditVerifierService.verifyChain()
		assert.strictEqual(verification.isValid, true)
		assert.strictEqual(verification.totalRecords, concurrentCount)
		assert.strictEqual(verification.errors.length, 0)
	})

	// =========================================================================
	// 4. Duplicate sequence prevention
	// =========================================================================
	it('4. should prevent duplicate sequence numbers via unique database index', async () => {
		await withTransaction(async (session) => {
			await auditWriterService.appendRecord(session, generateSampleAuditPayload())
		})

		// Attempt direct creation with sequenceNumber: 1
		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.create([
					{
						...generateSampleAuditPayload(),
						sequenceNumber: 1,
						previousRecordHash: GENESIS_ANCHOR_HASH,
						recordHash: 'dummy_hash_0000000000000000000000000000000000000000000000000000000000',
					},
				])
			},
			(err) => {
				assert.ok(
					err.code === 11000 || /duplicate key/i.test(err.message),
					`Expected duplicate key error code 11000, got: ${err.message}`
				)
				return true
			}
		)
	})

	// =========================================================================
	// 5. Transaction rollback & ACID safety
	// =========================================================================
	it('5. should roll back audit record and head advancement when transaction aborts', async () => {
		await withTransaction(async (session) => {
			await auditWriterService.appendRecord(session, generateSampleAuditPayload())
		})

		const headBefore = await auditReaderService.getChainHead()
		assert.strictEqual(headBefore.sequenceNumber, 1)

		// Transaction that aborts intentionally
		await assert.rejects(
			async () => {
				await withTransaction(async (session) => {
					await auditWriterService.appendRecord(
						session,
						generateSampleAuditPayload({ reason: 'Failing transaction' })
					)
					throw new Error('INTENTIONAL_TRANSACTION_FAILURE')
				})
			},
			/INTENTIONAL_TRANSACTION_FAILURE/
		)

		const count = await auditReaderService.getRecordCount()
		assert.strictEqual(count, 1, 'Only the initial committed record must remain')

		const headAfter = await auditReaderService.getChainHead()
		assert.strictEqual(headAfter.sequenceNumber, 1, 'Head sequence must not have advanced')
		assert.strictEqual(headAfter.totalRecords, 1, 'Head totalRecords must not have advanced')

		const verification = await auditVerifierService.verifyChain()
		assert.strictEqual(verification.isValid, true)
	})

	// =========================================================================
	// 6. Chain-head consistency
	// =========================================================================
	it('6. should ensure chain head is strictly consistent with the ledger state', async () => {
		let lastRec
		for (let i = 1; i <= 3; i++) {
			await withTransaction(async (session) => {
				lastRec = await auditWriterService.appendRecord(
					session,
					generateSampleAuditPayload({ reason: `Entry ${i}` })
				)
			})
		}

		const head = await auditReaderService.getChainHead()
		assert.strictEqual(head.sequenceNumber, 3)
		assert.strictEqual(head.totalRecords, 3)
		assert.strictEqual(head.latestRecordId.toString(), lastRec._id.toString())
		assert.strictEqual(head.latestRecordHash, lastRec.recordHash)

		const chainCheck = await auditVerifierService.verifyChain()
		assert.strictEqual(chainCheck.isValid, true)
		assert.strictEqual(chainCheck.verifiedSequence, 3)
	})

	// =========================================================================
	// 7. v1 canonicalization compatibility
	// =========================================================================
	it('7. should deterministically serialize and verify legacy v1 records', async () => {
		const targetUserId = new mongoose.Types.ObjectId()
		const entityId = new mongoose.Types.ObjectId()
		const actorId = new mongoose.Types.ObjectId()

		const v1Record = {
			sequenceNumber: 1,
			hashVersion: HASH_VERSION_V1,
			entityType: 'CREDENTIAL',
			entityId,
			targetUserId,
			hospitalId: null,
			decisionType: 'CREDENTIAL_SUBMITTED',
			previousStatus: 'Unsubmitted',
			newStatus: 'Pending_Verification',
			actorId,
			actorModel: 'user',
			actorRole: 'MEDICAL_OFFICER',
			previousRecordHash: GENESIS_ANCHOR_HASH,
		}

		const canonicalV1 = serializeAuditRecordCanonical(v1Record)
		assert.strictEqual(
			canonicalV1,
			`1|v1|CREDENTIAL|${entityId}|${targetUserId}||CREDENTIAL_SUBMITTED|Unsubmitted|Pending_Verification|${actorId}|user|MEDICAL_OFFICER|${GENESIS_ANCHOR_HASH}`
		)

		const expectedHash = crypto.createHash('sha256').update(canonicalV1, 'utf8').digest('hex')
		const computedHash = calculateRecordHash(v1Record)
		assert.strictEqual(computedHash, expectedHash)

		// Create record directly with v1 hashVersion and verify through verifier
		v1Record.recordHash = computedHash
		await AdministrativeDecisionAudit.create([v1Record])
		await AuditChainHead.findOneAndUpdate(
			{ _id: GLOBAL_HEAD_ID },
			{
				sequenceNumber: 1,
				latestRecordId: v1Record._id,
				latestRecordHash: computedHash,
				totalRecords: 1,
			},
			{ upsert: true }
		)

		const verifyResult = await auditVerifierService.verifyChain()
		assert.strictEqual(verifyResult.isValid, true)
		assert.strictEqual(verifyResult.errors.length, 0)
	})

	// =========================================================================
	// 8. v2 canonicalization compatibility
	// =========================================================================
	it('8. should deterministically canonicalize v2 records with sorted keys, ISO dates, ObjectIds', async () => {
		const testId = new mongoose.Types.ObjectId('507f191e810c19729de860ea')
		const testDate = new Date('2026-03-31T12:00:00.000Z')

		const objWithVariedKeyOrder1 = {
			z: 'last',
			a: 'first',
			m: { y: 2, b: 1, id: testId, date: testDate },
			arr: [3, 1, 2],
		}
		const objWithVariedKeyOrder2 = {
			arr: [3, 1, 2],
			m: { date: testDate, b: 1, id: testId, y: 2 },
			a: 'first',
			z: 'last',
		}

		const serialized1 = canonicalizeValue(objWithVariedKeyOrder1)
		const serialized2 = canonicalizeValue(objWithVariedKeyOrder2)

		assert.strictEqual(
			serialized1,
			serialized2,
			'Key ordering must not change canonical representation'
		)
		assert.ok(
			serialized1.includes('"id":"507f191e810c19729de860ea"'),
			'ObjectId must be serialized as hex string'
		)
		assert.ok(
			serialized1.includes('"date":"2026-03-31T12:00:00.000Z"'),
			'Date must be serialized as ISO 8601 UTC string'
		)

		// Check v2 serialization output
		const sampleRecord = {
			...generateSampleAuditPayload(),
			sequenceNumber: 1,
			hashVersion: HASH_VERSION_V2,
			previousRecordHash: GENESIS_ANCHOR_HASH,
		}
		const v2Canonical = serializeAuditRecordCanonical(sampleRecord)
		assert.ok(typeof v2Canonical === 'string')
		assert.ok(v2Canonical.startsWith('{') && v2Canonical.endsWith('}'))
	})

	// =========================================================================
	// 9. Audit record mutation detection
	// =========================================================================
	it('9. should detect unauthorized data mutation in any protected audit field', async () => {
		let rec
		await withTransaction(async (session) => {
			rec = await auditWriterService.appendRecord(session, generateSampleAuditPayload())
		})

		// Simulating raw collection-level mutation bypass
		await mongoose.connection
			.collection('administrativedecisionaudits')
			.updateOne({ _id: rec._id }, { $set: { decisionType: 'CREDENTIAL_APPROVED' } })

		const verification = await auditVerifierService.verifyChain()
		assert.strictEqual(verification.isValid, false, 'Chain must be flagged invalid')
		assert.ok(
			verification.errors.some((e) => e.includes('Tampered record detected at sequence 1')),
			`Expected tampering error, got: ${verification.errors.join(', ')}`
		)
	})

	// =========================================================================
	// 10. Audit record deletion detection
	// =========================================================================
	it('10. should detect intermediate and terminal record deletion from the ledger', async () => {
		for (let i = 1; i <= 3; i++) {
			await withTransaction(async (session) => {
				await auditWriterService.appendRecord(
					session,
					generateSampleAuditPayload({ reason: `Entry ${i}` })
				)
			})
		}

		// Delete intermediate record (sequence 2) via raw driver
		await mongoose.connection
			.collection('administrativedecisionaudits')
			.deleteOne({ sequenceNumber: 2 })

		const verification = await auditVerifierService.verifyChain()
		assert.strictEqual(verification.isValid, false)
		assert.ok(
			verification.errors.some((e) => e.includes('Sequence gap detected at record index 1')),
			'Must detect sequence gap from deleted record'
		)
		assert.ok(
			verification.errors.some((e) => e.includes('Record count mismatch')),
			'Must detect totalRecords mismatch with AuditChainHead'
		)
	})

	// =========================================================================
	// 11. Previous hash tampering detection
	// =========================================================================
	it('11. should detect tampering with previousRecordHash linkage', async () => {
		for (let i = 1; i <= 2; i++) {
			await withTransaction(async (session) => {
				await auditWriterService.appendRecord(
					session,
					generateSampleAuditPayload({ reason: `Entry ${i}` })
				)
			})
		}

		// Tamper with sequence 2 previousRecordHash
		const forgedPrevHash = crypto.createHash('sha256').update('forged_hash').digest('hex')
		await mongoose.connection
			.collection('administrativedecisionaudits')
			.updateOne({ sequenceNumber: 2 }, { $set: { previousRecordHash: forgedPrevHash } })

		const verification = await auditVerifierService.verifyChain()
		assert.strictEqual(verification.isValid, false)
		assert.ok(
			verification.errors.some((e) => e.includes('Previous hash mismatch at sequence 2')),
			'Must detect broken hash linkage'
		)
	})

	// =========================================================================
	// 12. Sequence gap detection
	// =========================================================================
	it('12. should detect sequence gaps where sequence numbers jump non-monotonically', async () => {
		await withTransaction(async (session) => {
			await auditWriterService.appendRecord(
				session,
				generateSampleAuditPayload({ reason: 'Entry 1' })
			)
		})

		// Forcibly update sequenceNumber from 1 to 2
		await mongoose.connection
			.collection('administrativedecisionaudits')
			.updateOne({ sequenceNumber: 1 }, { $set: { sequenceNumber: 2 } })

		const verification = await auditVerifierService.verifyChain()
		assert.strictEqual(verification.isValid, false)
		assert.ok(
			verification.errors.some((e) => e.includes('Sequence gap detected at record index 0')),
			'Must detect missing sequence 1'
		)
	})

	// =========================================================================
	// 13. Reordered record detection
	// =========================================================================
	it('13. should detect out-of-order or reordered records via verifyRecordSequence', async () => {
		const records = []
		for (let i = 1; i <= 3; i++) {
			await withTransaction(async (session) => {
				const rec = await auditWriterService.appendRecord(
					session,
					generateSampleAuditPayload({ reason: `Entry ${i}` })
				)
				records.push(rec.toObject())
			})
		}

		// Legitimate sequence: passes verification
		const validCheck = auditVerifierService.verifyRecordSequence(records)
		assert.strictEqual(validCheck.isValid, true)
		assert.strictEqual(validCheck.errors.length, 0)

		// Reordered sequence: [rec2, rec1, rec3]
		const reordered = [records[1], records[0], records[2]]
		const reorderedCheck = auditVerifierService.verifyRecordSequence(reordered)
		assert.strictEqual(reorderedCheck.isValid, false)
		assert.ok(
			reorderedCheck.errors.some((e) => e.includes('Sequence order error')),
			'Must detect sequence order error'
		)
		assert.ok(
			reorderedCheck.errors.some((e) => e.includes('Hash linkage mismatch')),
			'Must detect hash linkage mismatch when reordered'
		)
	})

	// =========================================================================
	// 14. Append-only service restrictions (Mongoose lifecycle guards & bulkWrite)
	// =========================================================================
	it('14. should reject all Mongoose update, replace, delete and bulkWrite operations', async () => {
		let testRecord
		await withTransaction(async (session) => {
			testRecord = await auditWriterService.appendRecord(
				session,
				generateSampleAuditPayload()
			)
		})

		// 14.1 Query updates
		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.updateOne(
					{ _id: testRecord._id },
					{ $set: { reason: 'Mutated' } }
				)
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.updateMany(
					{ _id: testRecord._id },
					{ $set: { reason: 'Mutated' } }
				)
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.findOneAndUpdate(
					{ _id: testRecord._id },
					{ $set: { reason: 'Mutated' } }
				)
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.findByIdAndUpdate(testRecord._id, {
					$set: { reason: 'Mutated' },
				})
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		// 14.2 Query replacements
		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.replaceOne(
					{ _id: testRecord._id },
					generateSampleAuditPayload({ sequenceNumber: 1, previousRecordHash: 'x', recordHash: 'y' })
				)
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.findOneAndReplace(
					{ _id: testRecord._id },
					generateSampleAuditPayload({ sequenceNumber: 1, previousRecordHash: 'x', recordHash: 'y' })
				)
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		// 14.3 Query deletions
		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.deleteOne({ _id: testRecord._id })
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.deleteMany({ _id: testRecord._id })
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.findOneAndDelete({ _id: testRecord._id })
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.findByIdAndDelete(testRecord._id)
			},
			/AdministrativeDecisionAudit records are immutable/
		)

		// 14.4 Document-level mutations & deletions
		const doc = await AdministrativeDecisionAudit.findById(testRecord._id)
		doc.reason = 'Attempted save mutation'
		await assert.rejects(
			async () => {
				await doc.save()
			},
			/AdministrativeDecisionAudit records cannot be modified once created/
		)

		await assert.rejects(
			async () => {
				await doc.deleteOne()
			},
			/AdministrativeDecisionAudit records are immutable and cannot be updated or deleted/
		)

		// 14.5 BulkWrite rejection
		await assert.rejects(
			async () => {
				await AdministrativeDecisionAudit.bulkWrite([
					{
						updateOne: {
							filter: { _id: testRecord._id },
							update: { $set: { reason: 'Bulk mutated' } },
						},
					},
				])
			},
			/AdministrativeDecisionAudit records are immutable and bulk write operations are prohibited/
		)

		// 14.6 AuditChainHead delete protection
		await assert.rejects(
			async () => {
				await AuditChainHead.deleteOne({ _id: GLOBAL_HEAD_ID })
			},
			/AuditChainHead singleton document is protected against deletion/
		)

		await assert.rejects(
			async () => {
				await AuditChainHead.deleteMany({})
			},
			/AuditChainHead singleton document is protected against deletion/
		)
	})

	// =========================================================================
	// 15. Existing B3.4 credential and association audit compatibility
	// =========================================================================
	it('15. should verify that all B3.4 administrative decision types append and verify cleanly', async () => {
		const sampleDecisions = [
			{ decisionType: 'CREDENTIAL_SUBMITTED', entityType: 'CREDENTIAL' },
			{ decisionType: 'CREDENTIAL_REVIEW_STARTED', entityType: 'CREDENTIAL' },
			{ decisionType: 'CREDENTIAL_INFO_REQUESTED', entityType: 'CREDENTIAL' },
			{ decisionType: 'CREDENTIAL_RESUBMITTED', entityType: 'CREDENTIAL' },
			{ decisionType: 'CREDENTIAL_APPROVED', entityType: 'CREDENTIAL' },
			{ decisionType: 'ASSOCIATION_APPROVED', entityType: 'HOSPITAL_ASSOCIATION' },
			{ decisionType: 'ASSOCIATION_SUSPENDED', entityType: 'HOSPITAL_ASSOCIATION' },
			{ decisionType: 'ASSOCIATION_PERMISSIONS_UPDATED', entityType: 'HOSPITAL_ASSOCIATION' },
			{ decisionType: 'ASSOCIATION_REVOKED', entityType: 'HOSPITAL_ASSOCIATION' },
		]

		for (const d of sampleDecisions) {
			await withTransaction(async (session) => {
				await auditWriterService.appendRecord(
					session,
					generateSampleAuditPayload({
						decisionType: d.decisionType,
						entityType: d.entityType,
						reason: `Lifecycle transition for ${d.decisionType}`,
						grantedPermissions:
							d.decisionType === 'ASSOCIATION_PERMISSIONS_UPDATED'
								? ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS']
								: [],
					})
				)
			})
		}

		const count = await auditReaderService.getRecordCount()
		assert.strictEqual(count, sampleDecisions.length)

		const verification = await auditVerifierService.verifyChain()
		assert.strictEqual(verification.isValid, true)
		assert.strictEqual(verification.totalRecords, sampleDecisions.length)
		assert.strictEqual(verification.errors.length, 0)
	})
})
