/**
 * Stage B3.4.1 Automated Test Suite
 * Namma Blood — Database Model, Audit Chain & Middleware Foundation
 *
 * Comprehensive Test Coverage:
 * 1. Audit Model Validation & Canonical Hashing
 * 2. Audit Chain Head & Monotonic Sequence Numbering
 * 3. Concurrent Audit Creation & Write Serialization
 * 4. Transaction Rollback & ACID Safety
 * 5. Hash Chain Verification & Tamper Detection
 * 6. Application-Level Immutability Enforcement
 * 7. Medical Officer Clarification Tracking Fields
 * 8. Decoupled Login Authentication & sessionScope Behavior
 * 9. Restricted Medical Officer Onboarding Middleware
 * 10. Strict Clinical Gate Preservation (Three-Gate Enforcement)
 * 11. Existing Roles Authentication Regression
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const bcryptjs = require('bcryptjs')

const userModel = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { MedicalOfficerHospital } = require('../Hospital/medicalOfficerHospitalModel')
const {
	NotificationOutbox,
} = require('../Hospital/notificationOutboxModel')
const {
	AdministrativeDecisionAudit,
	VALID_AUDIT_ENTITY_TYPES,
	VALID_AUDIT_DECISIONS,
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
} = require('../Hospital/auditIntegrityService')
const { protectMedicalOfficerOnboarding } = require('../Hospital/medicalOfficerOnboardingMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const { login } = require('../Login_And_Authentication/login')
const { withTransaction } = require('../Utils/transactionHelper')

process.env.JWT_SECRET =
	process.env.JWT_SECRET || 'test_jwt_secret_key_12345_super_secure_min_32'

const TEST_DB_URI =
	process.env.MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

function signToken(userId, extraClaims = {}) {
	return jwt.sign(
		{ id: userId, tokenVersion: 0, userType: 'user', ...extraClaims },
		process.env.JWT_SECRET,
		{ expiresIn: '1h' }
	)
}

function createMockReqRes(options = {}) {
	const req = {
		headers: options.headers || {},
		body: options.body || {},
		params: options.params || {},
		query: options.query || {},
		ip: options.ip || '127.0.0.1',
		model: options.model || null,
		user: options.user || null,
		userRole: options.userRole || null,
	}

	const res = {
		statusCode: 200,
		responseData: null,
		status(code) {
			this.statusCode = code
			return this
		},
		json(data) {
			this.responseData = data
			return this
		},
		send(data) {
			this.responseData = data
			return this
		},
	}

	return { req, res }
}

describe('Stage B3.4.1: Database Model, Audit Chain & Middleware Foundation', () => {
	let testAdmin
	let testDoctorUnverified
	let testDoctorVerified
	let testHospital
	let activeAssoc
	let adminToken
	let unverifiedDoctorToken
	let verifiedDoctorToken

	const createdUserIds = []
	const createdAdminIds = []
	const createdHospitalIds = []
	const createdAssocIds = []

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}

		await userModel.init()
		await AdministrativeDecisionAudit.init()
		await AuditChainHead.init()

		// 1. Create Test Admin
		testAdmin = await Admin.create({
			phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			email: `admin.b341.${Date.now()}@nammablood.test`,
			password: 'AdminPassword123!',
		})
		createdAdminIds.push(testAdmin._id)
		adminToken = signToken(testAdmin._id, { userType: 'user' })

		// 2. Create Active Hospital
		testHospital = await Hospital.create({
			hospitalCode: `HOSP-B341-${Date.now()}`,
			hospitalName: 'Apollo City Hospital B341',
			hospitalType: 'Private',
			address: {
				street: '12 Health Boulevard',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600002',
			},
			contactPhone: '9876543210',
			contactEmail: `contact.b341.${Date.now()}@test-hospital.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		createdHospitalIds.push(testHospital._id)

		// 3. Create Active Unverified Doctor (Gate 1 Active, Gate 2 Unsubmitted)
		testDoctorUnverified = await userModel.create({
			firstName: 'Dr. Anita',
			lastName: 'Deshmukh',
			email: `dr.anita.b341.${Date.now()}@test-doctor.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'DoctorPassword123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: 'Unsubmitted',
			verificationStatus: 'Pending',
			medicalRegistrationNumber: `REG-UNVER-${Date.now()}`,
			medicalCouncil: 'Tamil Nadu Medical Council',
			status: true,
		})
		createdUserIds.push(testDoctorUnverified._id)
		unverifiedDoctorToken = signToken(testDoctorUnverified._id, { userType: 'user' })

		// 4. Create Active Verified Doctor with Active Hospital Association (Gates 1, 2, 3 Active)
		testDoctorVerified = await userModel.create({
			firstName: 'Dr. Karthik',
			lastName: 'Sundaram',
			email: `dr.karthik.b341.${Date.now()}@test-doctor.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'DoctorPassword123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: 'Verified',
			verificationStatus: 'Verified',
			medicalRegistrationNumber: `REG-VER-${Date.now()}`,
			medicalCouncil: 'Tamil Nadu Medical Council',
			status: true,
		})
		createdUserIds.push(testDoctorVerified._id)
		verifiedDoctorToken = signToken(testDoctorVerified._id, { userType: 'user' })

		activeAssoc = await MedicalOfficerHospital.create({
			medicalOfficerUserId: testDoctorVerified._id,
			hospitalId: testHospital._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			availabilityStatus: 'Available',
		})
		createdAssocIds.push(activeAssoc._id)
	})

	after(async () => {
		if (createdAssocIds.length > 0) {
			await MedicalOfficerHospital.deleteMany({ _id: { $in: createdAssocIds } })
		}
		if (createdHospitalIds.length > 0) {
			await Hospital.deleteMany({ _id: { $in: createdHospitalIds } })
		}
		if (createdUserIds.length > 0) {
			await userModel.deleteMany({ _id: { $in: createdUserIds } })
		}
		if (createdAdminIds.length > 0) {
			await Admin.deleteMany({ _id: { $in: createdAdminIds } })
		}

		// Clean test audit collections via driver bypass
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})

		await mongoose.disconnect()
	})

	// Reset audit entries before each suite section to ensure clean sequence starts
	beforeEach(async () => {
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
	})

	// =========================================================================
	// 1. Audit Model Validation & Canonical Hashing
	// =========================================================================
	describe('1. Audit Model Validation & Canonical Hashing', () => {
		it('should create valid AdministrativeDecisionAudit entry with required fields', async () => {
			const auditEntry = new AdministrativeDecisionAudit({
				sequenceNumber: 1,
				entityType: 'CREDENTIAL',
				entityId: testDoctorUnverified._id,
				targetUserId: testDoctorUnverified._id,
				hospitalId: null,
				decisionType: 'CREDENTIAL_SUBMITTED',
				previousStatus: 'Unsubmitted',
				newStatus: 'Pending_Verification',
				actorId: testDoctorUnverified._id,
				actorModel: 'user',
				actorRole: 'MEDICAL_OFFICER',
				reason: 'Doctor submitted registration details',
				previousRecordHash: GENESIS_ANCHOR_HASH,
				recordHash: 'dummy_hash_for_validation',
			})

			const err = auditEntry.validateSync()
			assert.strictEqual(err, undefined, 'Validation must pass for valid fields')
		})

		it('should reject audit entry missing required fields (sequenceNumber, entityType, actorId)', () => {
			const auditEntry = new AdministrativeDecisionAudit({})
			const err = auditEntry.validateSync()
			assert.ok(err && err.errors, 'Validation error expected')
			assert.ok(err.errors.sequenceNumber, 'sequenceNumber is required')
			assert.ok(err.errors.entityType, 'entityType is required')
			assert.ok(err.errors.targetUserId, 'targetUserId is required')
			assert.ok(err.errors.actorId, 'actorId is required')
		})

		it('should reject invalid entityType or decisionType enums', () => {
			const auditEntry = new AdministrativeDecisionAudit({
				sequenceNumber: 1,
				entityType: 'INVALID_ENTITY_TYPE',
				decisionType: 'INVALID_DECISION_TYPE',
			})
			const err = auditEntry.validateSync(['entityType', 'decisionType'])
			assert.ok(err && err.errors.entityType, 'Invalid entityType must be rejected')
			assert.ok(err && err.errors.decisionType, 'Invalid decisionType must be rejected')
		})

		it('should reject invalid actorModel (only admin and user permitted)', () => {
			const auditEntry = new AdministrativeDecisionAudit({
				actorModel: 'bloodbankstaff',
			})
			const err = auditEntry.validateSync(['actorModel'])
			assert.ok(err && err.errors.actorModel, 'actorModel must be admin or user')
		})

		it('should compute deterministic canonical serialization string', () => {
			const record = {
				sequenceNumber: 1,
				hashVersion: 'v1',
				entityType: 'CREDENTIAL',
				entityId: '654321000000000000000001',
				targetUserId: '654321000000000000000002',
				hospitalId: null,
				decisionType: 'CREDENTIAL_APPROVED',
				previousStatus: 'Under_Review',
				newStatus: 'Verified',
				actorId: '654321000000000000000003',
				actorModel: 'admin',
				actorRole: 'ADMIN',
				previousRecordHash: GENESIS_ANCHOR_HASH,
			}

			const canonical = serializeAuditRecordCanonical(record)
			const expected = `1|v1|CREDENTIAL|654321000000000000000001|654321000000000000000002||CREDENTIAL_APPROVED|Under_Review|Verified|654321000000000000000003|admin|ADMIN|${GENESIS_ANCHOR_HASH}`
			assert.strictEqual(canonical, expected, 'Canonical serialization must match exact format')
		})

		it('should produce identical SHA-256 hashes for identical canonical records', () => {
			const rec1 = {
				sequenceNumber: 1,
				hashVersion: 'v1',
				entityType: 'CREDENTIAL',
				entityId: '654321000000000000000001',
				targetUserId: '654321000000000000000002',
				decisionType: 'CREDENTIAL_SUBMITTED',
				previousStatus: 'Unsubmitted',
				newStatus: 'Pending_Verification',
				actorId: '654321000000000000000002',
				actorModel: 'user',
				actorRole: 'MEDICAL_OFFICER',
				previousRecordHash: GENESIS_ANCHOR_HASH,
			}

			const hash1 = calculateRecordHash(rec1)
			const hash2 = calculateRecordHash({ ...rec1 })
			assert.strictEqual(hash1, hash2)
			assert.match(hash1, /^[0-9a-f]{64}$/, 'Hash must be valid 64-char hex SHA-256')
		})

		it('should deterministically canonicalize nested metadata objects regardless of key insertion order', () => {
			const meta1 = {
				verifierNotes: 'Verified against state registry',
				checks: { smcRegistrationValid: true, malpracticeHistoryFound: false },
				tags: ['renewal', 'urgent'],
			}
			const meta2 = {
				tags: ['renewal', 'urgent'],
				checks: { malpracticeHistoryFound: false, smcRegistrationValid: true },
				verifierNotes: 'Verified against state registry',
			}

			const rec1 = {
				sequenceNumber: 1,
				hashVersion: 'v2',
				entityType: 'CREDENTIAL',
				entityId: new mongoose.Types.ObjectId('654321000000000000000001'),
				targetUserId: new mongoose.Types.ObjectId('654321000000000000000002'),
				decisionType: 'CREDENTIAL_APPROVED',
				previousStatus: 'Under_Review',
				newStatus: 'Verified',
				actorId: new mongoose.Types.ObjectId('654321000000000000000003'),
				actorModel: 'admin',
				actorRole: 'ADMIN',
				reason: 'All checks passed',
				metadata: meta1,
				previousRecordHash: GENESIS_ANCHOR_HASH,
			}

			const rec2 = {
				...rec1,
				metadata: meta2,
			}

			const canonical1 = serializeAuditRecordCanonical(rec1)
			const canonical2 = serializeAuditRecordCanonical(rec2)
			assert.strictEqual(canonical1, canonical2, 'Canonical serialization must be strictly identical regardless of key order')

			const hash1 = calculateRecordHash(rec1)
			const hash2 = calculateRecordHash(rec2)
			assert.strictEqual(hash1, hash2, 'SHA-256 hashes must be strictly identical')
		})

		it('should deterministically format Dates, ObjectIds, Arrays, and Null values in canonical output', () => {
			const testDate = new Date('2026-11-08T12:00:00.000Z')
			const testId = new mongoose.Types.ObjectId('654321000000000000000001')

			const res = canonicalizeValue({
				id: testId,
				date: testDate,
				list: [1, 2, 'three'],
				nullable: null,
				finiteNum: 42.5,
			})

			assert.strictEqual(
				res,
				'{"date":"2026-11-08T12:00:00.000Z","finiteNum":42.5,"id":"654321000000000000000001","list":[1,2,"three"],"nullable":null}'
			)
		})

		it('should REJECT unsupported or ambiguous JavaScript types during canonicalization', () => {
			// BigInt
			assert.throws(() => canonicalizeValue({ bad: 100n }), /bigint/i)
			// Function
			assert.throws(() => canonicalizeValue({ bad: () => {} }), /function/i)
			// Symbol
			assert.throws(() => canonicalizeValue({ bad: Symbol('test') }), /symbol/i)
			// NaN
			assert.throws(() => canonicalizeValue({ bad: NaN }), /non-finite number/)
			// Infinity
			assert.throws(() => canonicalizeValue({ bad: Infinity }), /non-finite number/)
			// -Infinity
			assert.throws(() => canonicalizeValue({ bad: -Infinity }), /non-finite number/)
			// Invalid Date
			assert.throws(() => canonicalizeValue({ bad: new Date('invalid-date') }), /invalid Date/)
		})

		it('should REJECT unsupported hash versions with clear error', () => {
			assert.throws(
				() => serializeAuditRecordCanonical({ hashVersion: 'v99' }),
				/Unsupported hashVersion 'v99'/
			)
		})

		it('should detect tampering in any nested metadata or security-relevant field', () => {
			const baseRecord = {
				sequenceNumber: 5,
				hashVersion: 'v2',
				entityType: 'CREDENTIAL',
				entityId: '654321000000000000000001',
				targetUserId: '654321000000000000000002',
				decisionType: 'CREDENTIAL_APPROVED',
				previousStatus: 'Under_Review',
				newStatus: 'Verified',
				actorId: '654321000000000000000003',
				actorModel: 'admin',
				actorRole: 'ADMIN',
				reason: 'Legitimate decision reason',
				notes: 'Original administrative notes',
				evidenceReferences: ['https://medcouncil.gov.in/verify/12345'],
				grantedPermissions: ['VIEW_REQUESTS', 'VERIFY_REQUESTS'],
				metadata: { externalVerificationId: 'REG-2026-999', verifiedByCouncil: true },
				previousRecordHash: GENESIS_ANCHOR_HASH,
			}

			const baseHash = calculateRecordHash(baseRecord)

			// Tamper 1: change nested metadata field
			const tamperedMeta = {
				...baseRecord,
				metadata: { externalVerificationId: 'REG-2026-999', verifiedByCouncil: false },
			}
			assert.notStrictEqual(calculateRecordHash(tamperedMeta), baseHash)

			// Tamper 2: change reason
			const tamperedReason = { ...baseRecord, reason: 'Altered decision justification' }
			assert.notStrictEqual(calculateRecordHash(tamperedReason), baseHash)

			// Tamper 3: change grantedPermissions
			const tamperedPerms = { ...baseRecord, grantedPermissions: ['VIEW_REQUESTS'] }
			assert.notStrictEqual(calculateRecordHash(tamperedPerms), baseHash)

			// Tamper 4: change evidenceReferences
			const tamperedEvidence = { ...baseRecord, evidenceReferences: ['https://fake.site'] }
			assert.notStrictEqual(calculateRecordHash(tamperedEvidence), baseHash)
		})
	})

	// =========================================================================
	// 2. Audit Chain Head & Monotonic Sequence Numbering
	// =========================================================================
	describe('2. Audit Chain Head & Monotonic Sequence Numbering', () => {
		it('should safely initialize the singleton GLOBAL_ADMIN_AUDIT_HEAD', async () => {
			const head = await getOrInitAuditChainHead()
			assert.strictEqual(head._id, GLOBAL_HEAD_ID)
			assert.strictEqual(head.sequenceNumber, 0)
			assert.strictEqual(head.latestRecordHash, GENESIS_ANCHOR_HASH)
			assert.strictEqual(head.totalRecords, 0)
		})

		it('should append record and advance AuditChainHead monotonically in a transaction', async () => {
			await withTransaction(async (session) => {
				const auditData = {
					entityType: 'CREDENTIAL',
					entityId: testDoctorUnverified._id,
					targetUserId: testDoctorUnverified._id,
					hospitalId: null,
					decisionType: 'CREDENTIAL_SUBMITTED',
					previousStatus: 'Unsubmitted',
					newStatus: 'Pending_Verification',
					actorId: testDoctorUnverified._id,
					actorModel: 'user',
					actorRole: 'MEDICAL_OFFICER',
					reason: 'Initial submission of credentials',
				}

				const entry = await appendAuditRecordTransactional(session, auditData)
				assert.strictEqual(entry.sequenceNumber, 1)
				assert.strictEqual(entry.previousRecordHash, GENESIS_ANCHOR_HASH)
				assert.ok(entry.recordHash)

				const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).session(session)
				assert.strictEqual(head.sequenceNumber, 1)
				assert.strictEqual(head.latestRecordHash, entry.recordHash)
				assert.strictEqual(head.totalRecords, 1)
			})

			// Second record in sequence
			await withTransaction(async (session) => {
				const auditData2 = {
					entityType: 'CREDENTIAL',
					entityId: testDoctorUnverified._id,
					targetUserId: testDoctorUnverified._id,
					hospitalId: null,
					decisionType: 'CREDENTIAL_REVIEW_STARTED',
					previousStatus: 'Pending_Verification',
					newStatus: 'Under_Review',
					actorId: testAdmin._id,
					actorModel: 'admin',
					actorRole: 'ADMIN',
					notes: 'Admin opened dossier',
				}

				const entry2 = await appendAuditRecordTransactional(session, auditData2)
				assert.strictEqual(entry2.sequenceNumber, 2)

				const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).session(session)
				assert.strictEqual(head.sequenceNumber, 2)
				assert.strictEqual(head.latestRecordHash, entry2.recordHash)
				assert.strictEqual(head.totalRecords, 2)
			})
		})
	})

	// =========================================================================
	// 3. Concurrent Audit Creation & Write Serialization
	// =========================================================================
	describe('3. Concurrent Audit Creation & Write Serialization', () => {
		it('should serialize concurrent transactions without sequence collisions or chain forks', async () => {
			const runAuditAppend = async (itemNum) => {
				return await withTransaction(async (session) => {
					return await appendAuditRecordTransactional(session, {
						entityType: 'CREDENTIAL',
						entityId: testDoctorUnverified._id,
						targetUserId: testDoctorUnverified._id,
						hospitalId: null,
						decisionType: 'CREDENTIAL_SUBMITTED',
						previousStatus: 'Unsubmitted',
						newStatus: 'Pending_Verification',
						actorId: testDoctorUnverified._id,
						actorModel: 'user',
						actorRole: 'MEDICAL_OFFICER',
						notes: `Concurrent submission #${itemNum}`,
					})
				})
			}

			// Execute 3 concurrent append transactions
			const results = await Promise.all([runAuditAppend(1), runAuditAppend(2), runAuditAppend(3)])
			const seqs = results.map((r) => r.sequenceNumber).sort((a, b) => a - b)
			assert.deepStrictEqual(seqs, [1, 2, 3], 'Sequences must be contiguous [1, 2, 3] with zero collisions')

			// Verify chain integrity
			const integrity = await verifyAuditChainIntegrity()
			assert.strictEqual(integrity.isValid, true, 'Audit chain must be cryptographically sound')
			assert.strictEqual(integrity.totalRecords, 3)
			assert.strictEqual(integrity.verifiedSequence, 3)
		})

		it('should prevent duplicate execution and sequence collisions via unique sequence index', async () => {
			await withTransaction(async (session) => {
				await appendAuditRecordTransactional(session, {
					entityType: 'CREDENTIAL',
					entityId: testDoctorUnverified._id,
					targetUserId: testDoctorUnverified._id,
					decisionType: 'CREDENTIAL_SUBMITTED',
					previousStatus: 'Unsubmitted',
					newStatus: 'Pending_Verification',
					actorId: testDoctorUnverified._id,
					actorModel: 'user',
					actorRole: 'MEDICAL_OFFICER',
				})
			})

			// Attempting direct raw insertion with duplicate sequenceNumber 1 must fail
			await assert.rejects(
				async () => {
					await mongoose.connection.collection('administrativedecisionaudits').insertOne({
						sequenceNumber: 1,
						entityType: 'CREDENTIAL',
						entityId: testDoctorUnverified._id,
						targetUserId: testDoctorUnverified._id,
						decisionType: 'CREDENTIAL_SUBMITTED',
						previousStatus: 'Unsubmitted',
						newStatus: 'Pending_Verification',
						actorId: testDoctorUnverified._id,
						actorModel: 'user',
						actorRole: 'MEDICAL_OFFICER',
						previousRecordHash: GENESIS_ANCHOR_HASH,
						recordHash: 'duplicate_collision_attempt',
						hashVersion: 'v2',
					})
				},
				/E11000 duplicate key error/
			)
		})
	})

	// =========================================================================
	// 4. Transaction Rollback & ACID Safety
	// =========================================================================
	describe('4. Transaction Rollback & ACID Safety', () => {
		it('should roll back audit entry and head sequence advancement if transaction aborts', async () => {
			const initialHead = await getOrInitAuditChainHead()
			const initialSeq = initialHead.sequenceNumber

			try {
				await withTransaction(async (session) => {
					await appendAuditRecordTransactional(session, {
						entityType: 'HOSPITAL_ASSOCIATION',
						entityId: activeAssoc._id,
						targetUserId: testDoctorVerified._id,
						hospitalId: testHospital._id,
						decisionType: 'ASSOCIATION_APPROVED',
						previousStatus: 'Pending_Admin_Approval',
						newStatus: 'Active',
						actorId: testAdmin._id,
						actorModel: 'admin',
						actorRole: 'ADMIN',
					})

					// Simulated failure during subsequent phase (e.g. outbox failure)
					throw new Error('SIMULATED_TRANSACTION_FAILURE')
				})
			} catch (err) {
				assert.strictEqual(err.message, 'SIMULATED_TRANSACTION_FAILURE')
			}

			// Invariant: No audit entry persisted
			const count = await AdministrativeDecisionAudit.countDocuments({})
			assert.strictEqual(count, 0, 'No audit entry must persist after rollback')

			// Invariant: Head sequence did not advance
			const reloadedHead = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(reloadedHead.sequenceNumber, initialSeq, 'Head sequence must remain unchanged')
		})

		it('should ensure business decision, audit entry, and outbox event share atomic boundary and rollback completely on error', async () => {
			const targetDoc = await userModel.create({
				firstName: 'Dr. Atomic',
				lastName: 'Test',
				email: `dr.atomic.${Date.now()}@test-doctor.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'DoctorPassword123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				credentialStatus: 'Pending_Verification',
				status: true,
			})
			createdUserIds.push(targetDoc._id)

			try {
				await withTransaction(async (session) => {
					// 1. Business decision: update user model
					await userModel.findByIdAndUpdate(
						targetDoc._id,
						{ credentialStatus: 'Verified' },
						{ session }
					)

					// 2. Audit record insertion & head advancement
					await appendAuditRecordTransactional(session, {
						entityType: 'CREDENTIAL',
						entityId: targetDoc._id,
						targetUserId: targetDoc._id,
						decisionType: 'CREDENTIAL_APPROVED',
						previousStatus: 'Pending_Verification',
						newStatus: 'Verified',
						actorId: testAdmin._id,
						actorModel: 'admin',
						actorRole: 'ADMIN',
						reason: 'Credentials verified',
					})

					// 3. Outbox event creation
					await NotificationOutbox.create(
						[
							{
								eventId: `EVT-ATOMIC-${Date.now()}`,
								eventType: 'CREDENTIALS_REVIEWED',
								hospitalId: testHospital._id,
								recipientKey: `KEY-${Date.now()}`,
								recipientUserId: targetDoc._id,
								recipientEmail: targetDoc.email,
								recipientRole: 'MEDICAL_OFFICER',
								subject: 'Doctor Credentials Verified',
								sanitizedBody: 'Doctor credentials verified.',
							},
						],
						{ session }
					)

					// 4. Force unexpected downstream crash
					throw new Error('DOWNSTREAM_SYSTEM_CRASH')
				})
			} catch (err) {
				assert.strictEqual(err.message, 'DOWNSTREAM_SYSTEM_CRASH')
			}

			// Assert ZERO partial state across all 3 subsystems
			const reloadedDoc = await userModel.findById(targetDoc._id)
			assert.strictEqual(reloadedDoc.credentialStatus, 'Pending_Verification', 'Doctor status must NOT have updated')

			const auditCount = await AdministrativeDecisionAudit.countDocuments({ targetUserId: targetDoc._id })
			assert.strictEqual(auditCount, 0, 'No audit record must exist')

			const outboxCount = await NotificationOutbox.countDocuments({ recipientUserId: targetDoc._id })
			assert.strictEqual(outboxCount, 0, 'No outbox record must exist')
		})

		it('should safely handle transaction retry without creating duplicate audit records', async () => {
			let attempts = 0

			await withTransaction(async (session) => {
				attempts++
				if (attempts === 1) {
					// Simulate transient write conflict on first attempt using official MongoServerError
					const transientErr = new mongoose.mongo.MongoServerError({
						message: 'WriteConflict on AuditChainHead',
						errmsg: 'WriteConflict',
					})
					transientErr.addErrorLabel('TransientTransactionError')
					throw transientErr
				}

				// Second attempt executes cleanly
				return await appendAuditRecordTransactional(session, {
					entityType: 'CREDENTIAL',
					entityId: testDoctorUnverified._id,
					targetUserId: testDoctorUnverified._id,
					decisionType: 'CREDENTIAL_SUBMITTED',
					previousStatus: 'Unsubmitted',
					newStatus: 'Pending_Verification',
					actorId: testDoctorUnverified._id,
					actorModel: 'user',
					actorRole: 'MEDICAL_OFFICER',
					notes: 'Committed after retry',
				})
			})

			assert.strictEqual(attempts, 2, 'Must have executed retry on TransientTransactionError')

			// Exactly one record must exist
			const records = await AdministrativeDecisionAudit.find({})
			assert.strictEqual(records.length, 1, 'Only one audit record must be committed despite retry')
			assert.strictEqual(records[0].sequenceNumber, 1)

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.sequenceNumber, 1)
			assert.strictEqual(head.totalRecords, 1)
		})
	})

	// =========================================================================
	// 5. Hash Chain Verification & Tamper Detection
	// =========================================================================
	describe('5. Hash Chain Verification & Tamper Detection', () => {
		beforeEach(async () => {
			// Populate a 3-record valid chain
			for (let i = 1; i <= 3; i++) {
				await withTransaction(async (session) => {
					await appendAuditRecordTransactional(session, {
						entityType: 'CREDENTIAL',
						entityId: testDoctorUnverified._id,
						targetUserId: testDoctorUnverified._id,
						hospitalId: null,
						decisionType: i === 1 ? 'CREDENTIAL_SUBMITTED' : i === 2 ? 'CREDENTIAL_REVIEW_STARTED' : 'CREDENTIAL_APPROVED',
						previousStatus: i === 1 ? 'Unsubmitted' : i === 2 ? 'Pending_Verification' : 'Under_Review',
						newStatus: i === 1 ? 'Pending_Verification' : i === 2 ? 'Under_Review' : 'Verified',
						actorId: i === 1 ? testDoctorUnverified._id : testAdmin._id,
						actorModel: i === 1 ? 'user' : 'admin',
						actorRole: i === 1 ? 'MEDICAL_OFFICER' : 'ADMIN',
						notes: `Step #${i}`,
					})
				})
			}
		})

		it('should confirm healthy chain passes verification', async () => {
			const res = await verifyAuditChainIntegrity()
			assert.strictEqual(res.isValid, true)
			assert.strictEqual(res.totalRecords, 3)
			assert.strictEqual(res.verifiedSequence, 3)
			assert.strictEqual(res.errors.length, 0)
		})

		it('should detect record tampering (modified data/hash mismatch)', async () => {
			// Bypass Mongoose pre-hook using raw MongoDB collection update to simulate direct DBA tampering
			await mongoose.connection.collection('administrativedecisionaudits').updateOne(
				{ sequenceNumber: 2 },
				{ $set: { newStatus: 'Tampered_Status' } }
			)

			const res = await verifyAuditChainIntegrity()
			assert.strictEqual(res.isValid, false)
			assert.ok(res.errors.some((e) => e.includes('Tampered record detected at sequence 2')))
		})

		it('should detect broken hash linkage (previousRecordHash mismatch)', async () => {
			await mongoose.connection.collection('administrativedecisionaudits').updateOne(
				{ sequenceNumber: 3 },
				{ $set: { previousRecordHash: 'forged_previous_hash_value' } }
			)

			const res = await verifyAuditChainIntegrity()
			assert.strictEqual(res.isValid, false)
			assert.ok(res.errors.some((e) => e.includes('Previous hash mismatch at sequence 3')))
		})

		it('should detect sequence gap (missing intermediate record)', async () => {
			await mongoose.connection.collection('administrativedecisionaudits').deleteOne({
				sequenceNumber: 2,
			})

			const res = await verifyAuditChainIntegrity()
			assert.strictEqual(res.isValid, false)
			assert.ok(res.errors.some((e) => e.includes('Sequence gap detected')))
		})

		it('should detect terminal record deletion (head sequence mismatch)', async () => {
			await mongoose.connection.collection('administrativedecisionaudits').deleteOne({
				sequenceNumber: 3,
			})

			const res = await verifyAuditChainIntegrity()
			assert.strictEqual(res.isValid, false)
			assert.ok(
				res.errors.some((e) => e.includes('Terminal record sequence mismatch') || e.includes('Possible terminal-record deletion'))
			)
		})
	})

	// =========================================================================
	// 6. Application-Level Immutability Enforcement
	// =========================================================================
	describe('6. Application-Level Immutability Enforcement', () => {
		let testAuditEntry

		beforeEach(async () => {
			await withTransaction(async (session) => {
				testAuditEntry = await appendAuditRecordTransactional(session, {
					entityType: 'CREDENTIAL',
					entityId: testDoctorUnverified._id,
					targetUserId: testDoctorUnverified._id,
					hospitalId: null,
					decisionType: 'CREDENTIAL_SUBMITTED',
					previousStatus: 'Unsubmitted',
					newStatus: 'Pending_Verification',
					actorId: testDoctorUnverified._id,
					actorModel: 'user',
					actorRole: 'MEDICAL_OFFICER',
				})
			})
		})

		it('should reject doc.save() mutation on existing audit entry', async () => {
			testAuditEntry.newStatus = 'Hacked_Status'
			await assert.rejects(
				async () => await testAuditEntry.save(),
				/AdministrativeDecisionAudit records cannot be modified once created/
			)
		})

		it('should reject updateOne query on audit entry', async () => {
			await assert.rejects(
				async () =>
					await AdministrativeDecisionAudit.updateOne(
						{ _id: testAuditEntry._id },
						{ $set: { newStatus: 'Hacked_Status' } }
					),
				/AdministrativeDecisionAudit records are immutable/
			)
		})

		it('should reject deleteOne query on audit entry', async () => {
			await assert.rejects(
				async () =>
					await AdministrativeDecisionAudit.deleteOne({ _id: testAuditEntry._id }),
				/AdministrativeDecisionAudit records are immutable/
			)
		})
	})

	// =========================================================================
	// 7. Medical Officer Clarification Tracking Fields
	// =========================================================================
	describe('7. Medical Officer Clarification Tracking Fields', () => {
		it('should initialize clarification fields with correct defaults on user model', async () => {
			const doctor = await userModel.findById(testDoctorUnverified._id)
			assert.strictEqual(doctor.credentialClarificationRequested, false)
			assert.strictEqual(doctor.credentialClarificationNotes, '')
			assert.strictEqual(doctor.credentialClarificationRequestedAt, null)
			assert.strictEqual(doctor.credentialResubmissionCount, 0)
			assert.strictEqual(doctor.credentialReviewStartedAt, null)
		})

		it('should safely store clarification requests and track resubmissions', async () => {
			const doctor = await userModel.findById(testDoctorUnverified._id)
			doctor.credentialClarificationRequested = true
			doctor.credentialClarificationNotes = 'Please provide copy of State Medical Council renewal receipt.'
			doctor.credentialClarificationRequestedAt = new Date()
			doctor.credentialClarificationRequestedBy = testAdmin._id
			await doctor.save()

			const updated = await userModel.findById(testDoctorUnverified._id)
			assert.strictEqual(updated.credentialClarificationRequested, true)
			assert.strictEqual(
				updated.credentialClarificationNotes,
				'Please provide copy of State Medical Council renewal receipt.'
			)
			assert.ok(updated.credentialClarificationRequestedAt)
			assert.strictEqual(String(updated.credentialClarificationRequestedBy), String(testAdmin._id))
		})
	})

	// =========================================================================
	// 8. Decoupled Login Authentication & sessionScope Behavior
	// =========================================================================
	describe('8. Decoupled Login Authentication & sessionScope Behavior', () => {
		it('should ALLOW unverified active Medical Officer to authenticate and receive sessionScope: ONBOARDING (HTTP 200)', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: testDoctorUnverified.email,
					password: 'DoctorPassword123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.message, 'Login Successfully.')
			assert.ok(res.responseData?.token)
			assert.strictEqual(res.responseData?.role, 'MEDICAL_OFFICER')
			assert.strictEqual(res.responseData?.sessionScope, 'ONBOARDING')
			assert.strictEqual(res.responseData?.user?.accountStatus, 'Active')
		})

		it('should return sessionScope: CLINICAL for verified Medical Officer (HTTP 200)', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: testDoctorVerified.email,
					password: 'DoctorPassword123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.ok(res.responseData?.token)
			assert.strictEqual(res.responseData?.sessionScope, 'CLINICAL')
		})

		it('should strictly BLOCK suspended Medical Officer at login (HTTP 403)', async () => {
			const suspendedDoc = await userModel.create({
				firstName: 'Dr. Suspended',
				lastName: 'Account',
				email: `dr.susp.${Date.now()}@test-doctor.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'DoctorPassword123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Suspended',
				credentialStatus: 'Verified',
				status: true,
			})
			createdUserIds.push(suspendedDoc._id)

			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: suspendedDoc.email,
					password: 'DoctorPassword123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account is suspended/i)
		})

		it('should strictly BLOCK deactivated Medical Officer at login (HTTP 403)', async () => {
			const deactDoc = await userModel.create({
				firstName: 'Dr. Deactivated',
				lastName: 'Account',
				email: `dr.deact.${Date.now()}@test-doctor.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'DoctorPassword123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Deactivated',
				credentialStatus: 'Verified',
				status: true,
			})
			createdUserIds.push(deactDoc._id)

			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: deactDoc.email,
					password: 'DoctorPassword123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account is deactivated/i)
		})

		it('should strictly BLOCK Medical Officer with status: false at login (HTTP 401)', async () => {
			const inactiveDoc = await userModel.create({
				firstName: 'Dr. Inactive',
				lastName: 'Account',
				email: `dr.inactive.${Date.now()}@test-doctor.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'DoctorPassword123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				credentialStatus: 'Verified',
				status: false,
			})
			createdUserIds.push(inactiveDoc._id)

			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: inactiveDoc.email,
					password: 'DoctorPassword123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /Account is deactivated or suspended/i)
		})
	})

	// =========================================================================
	// 9. Restricted Medical Officer Onboarding Middleware
	// =========================================================================
	describe('9. Restricted Medical Officer Onboarding Middleware', () => {
		it('should AUTHORIZE active unverified Medical Officer to access onboarding middleware', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDoctorToken}` },
			})

			let nextCalled = false
			await protectMedicalOfficerOnboarding(req, res, () => {
				nextCalled = true
			})

			assert.strictEqual(nextCalled, true)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(req.userRole, 'MEDICAL_OFFICER')
			assert.strictEqual(req.sessionScope, 'ONBOARDING')
		})

		it('should REJECT unauthenticated request with HTTP 401', async () => {
			const { req, res } = createMockReqRes({})

			await protectMedicalOfficerOnboarding(req, res, () => {})
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /Authentication required/i)
		})

		it('should REJECT non-doctor roles (USER, STAFF, BLOODBANK, HOSPITAL_ADMIN, ADMIN) with HTTP 403', async () => {
			// Admin attempting onboarding endpoint
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${adminToken}` },
			})

			await protectMedicalOfficerOnboarding(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform administrators must use dedicated/i)
		})

		it('should REJECT cross-doctor access attempt with HTTP 403 (BOLA defense)', async () => {
			// Doctor A attempting to access Doctor B's dossier
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDoctorToken}` },
				params: { doctorId: String(testDoctorVerified._id) },
			})

			await protectMedicalOfficerOnboarding(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /You may only access or submit credentials for your own account/i)
		})

		it('should ALLOW doctor accessing their own doctorId in route params', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDoctorToken}` },
				params: { doctorId: String(testDoctorUnverified._id) },
			})

			let nextCalled = false
			await protectMedicalOfficerOnboarding(req, res, () => {
				nextCalled = true
			})
			assert.strictEqual(nextCalled, true)
		})

		it('should REJECT onboarding requests attempting mass-assignment of protected security fields (HTTP 400)', async () => {
			const forbiddenPayloads = [
				{ role: 'ADMIN' },
				{ credentialStatus: 'Verified' },
				{ verificationStatus: 'Verified' },
				{ accountStatus: 'Active' },
				{ status: true },
				{ permissions: ['VERIFY_EMERGENCY_REQUESTS'] },
				{ isVerified: true },
				{ associationStatus: 'Approved' },
			]

			for (const payload of forbiddenPayloads) {
				const { req, res } = createMockReqRes({
					headers: { authorization: `Bearer ${unverifiedDoctorToken}` },
					params: { doctorId: String(testDoctorUnverified._id) },
					body: payload,
				})

				await protectMedicalOfficerOnboarding(req, res, () => {})
				assert.strictEqual(res.statusCode, 400, `Payload with ${Object.keys(payload)[0]} must be rejected with 400`)
				assert.match(res.responseData?.message, /Mass-assignment violation/i)
			}
		})

		it('should strictly BLOCK suspended Medical Officer from onboarding middleware (HTTP 403)', async () => {
			const suspendedDoc = await userModel.create({
				firstName: 'Dr. SuspendedOnboard',
				lastName: 'Account',
				email: `dr.susp.onboard.${Date.now()}@test-doctor.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'DoctorPassword123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Suspended',
				credentialStatus: 'Unsubmitted',
				status: true,
			})
			createdUserIds.push(suspendedDoc._id)
			const token = signToken(suspendedDoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerOnboarding(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account is suspended/i)
		})

		it('should strictly BLOCK deactivated Medical Officer (status: false) from onboarding middleware (HTTP 401)', async () => {
			const inactiveDoc = await userModel.create({
				firstName: 'Dr. InactOnboard',
				lastName: 'Account',
				email: `dr.inact.onboard.${Date.now()}@test-doctor.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'DoctorPassword123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				credentialStatus: 'Unsubmitted',
				status: false,
			})
			createdUserIds.push(inactiveDoc._id)
			const token = signToken(inactiveDoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerOnboarding(req, res, () => {})
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /deactivated or suspended/i)
		})
	})

	// =========================================================================
	// 10. Strict Clinical Gate Preservation (Three-Gate Enforcement)
	// =========================================================================
	describe('10. Strict Clinical Gate Preservation (Three-Gate Enforcement)', () => {
		it('should strictly REJECT unverified Medical Officer from clinical routes via protectMedicalOfficerAuth (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDoctorToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('should ALLOW verified doctor with active hospital association to access clinical routes (HTTP 200)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			let nextCalled = false
			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {
				nextCalled = true
			})
			assert.strictEqual(nextCalled, true)
			assert.strictEqual(res.statusCode, 200)
		})

		it('should confirm sessionScope is NEVER trusted as an authorization control (fails closed on clinical route, HTTP 403)', async () => {
			// Attacker attempts to forge or pass sessionScope: 'CLINICAL' for unverified doctor
			const forgedToken = signToken(testDoctorUnverified._id, { sessionScope: 'CLINICAL' })

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${forgedToken}` },
			})
			req.sessionScope = 'CLINICAL' // Simulate client or upstream tampering

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			// Must fail closed because database state is authoritative
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})
	})

	// =========================================================================
	// 11. Existing Roles Authentication Regression
	// =========================================================================
	describe('11. Existing Roles Authentication Regression', () => {
		it('should preserve ADMIN authentication behavior', async () => {
			const { req, res } = createMockReqRes({
				model: Admin,
				body: {
					email: testAdmin.email,
					password: 'AdminPassword123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.ok(res.responseData?.token)
			assert.strictEqual(res.responseData?.message, 'Login Successfully.')
		})

		it('should preserve standard USER login behavior', async () => {
			const normalUser = await userModel.create({
				firstName: 'Ravi',
				lastName: 'Verma',
				email: `ravi.user.b341.${Date.now()}@test.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'UserPassword123!',
				gender: 'Male',
				dob: new Date('1990-01-01'),
				age: 34,
				bloodGroup: 'O+',
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: '45 Lake View Road',
				pinCode: 600001,
				role: 'USER',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(normalUser._id)

			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: normalUser.email,
					password: 'UserPassword123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.ok(res.responseData?.token)
			assert.strictEqual(res.responseData?.role, 'USER')
			assert.strictEqual(res.responseData?.sessionScope, undefined)
		})
	})
})
