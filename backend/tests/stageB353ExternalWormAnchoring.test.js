/**
 * Stage B3.5.3 Automated Test Suite: External WORM Anchoring using AWS S3 Object Lock
 * Namma Blood — Detached Signing, S3 Object Lock COMPLIANCE, Independent Verification & Watermark Decoupling
 *
 * Test Matrix:
 * Group A: Cryptographic Detached Signing Tests (1–7)
 * Group B: AWS S3 Object Lock Storage Adapter Tests (8–19)
 * Group C: Anchoring Lifecycle and Recovery Tests (20–28)
 * Group D: Monotonic Watermark Advancement Tests (29–37)
 * Group E: Security and Isolation Invariants (38–42)
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const mongoose = require('mongoose')

const {
	AuditCheckpoint,
	VALID_ANCHORING_STATUSES,
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
	auditVerifierService,
} = require('../Hospital/auditIntegrityService')
const {
	constructCheckpointPayload,
	canonicalizeCheckpointPayload,
	calculateCheckpointHash,
	normalizeToUtcHourString,
	generateDeterministicCheckpointId,
} = require('../Hospital/auditCheckpointPayloadService')
const {
	getOrInitCheckpointCursor,
	generateHourlyCheckpoint,
} = require('../Hospital/auditCheckpointGenerationService')
const {
	SUPPORTED_SIGNING_ALGORITHMS,
	DEFAULT_SIGNING_ALGORITHM,
	DEFAULT_KEY_ID,
	parseSigningConfig,
	generateSigningKeyPair,
	resolvePrivateKey,
	resolvePublicKey,
	signCheckpointPayload,
	verifyCheckpointSignature,
} = require('../Hospital/auditSigningService')
const {
	S3_KEY_PREFIX,
	TARGET_OBJECT_LOCK_MODE,
	buildS3ObjectKey,
	validateS3ObjectKey,
	validateRetentionDays,
	calculateRetainUntilDate,
	AuditWormStorageAdapter,
} = require('../Hospital/auditWormStorageAdapter')
const {
	determineNextEligibleAnchoringCheckpoint,
	acquireAnchoringClaim,
	releaseAnchoringClaim,
	reconcileStaleAnchoringClaims,
	verifyAnchoredCheckpointVersion,
	anchorNextCheckpoint,
	getAnchoringStatus,
} = require('../Hospital/auditCheckpointAnchoringService')
const { withTransaction } = require('../Utils/transactionHelper')

const TEST_DB_URI =
	process.env.MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

/**
 * In-Memory Mock S3Client simulating AWS S3 Object Lock in COMPLIANCE mode.
 */
class MockS3Client {
	constructor(options = {}) {
		this.options = options
		this.store = new Map() // Key -> Array of versions
		this.putCommandCalls = []
		this.forcePutError = null
		this.forceNullVersionId = false
		this.forceModeOverride = null
		this.forceExpiredRetention = false
		this.forceCorruptedBody = false
	}

	async send(command) {
		const commandName = command.constructor.name

		if (commandName === 'PutObjectCommand') {
			if (this.forcePutError) {
				throw this.forcePutError
			}

			this.putCommandCalls.push(command.input)
			const key = command.input.Key
			const body = command.input.Body
			const versionId = this.forceNullVersionId
				? null
				: `v_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
			const eTag = `"${crypto.createHash('md5').update(body).digest('hex')}"`

			const versionRecord = {
				versionId,
				key,
				body,
				eTag,
				contentType: command.input.ContentType,
				objectLockMode: this.forceModeOverride || command.input.ObjectLockMode,
				objectLockRetainUntilDate: this.forceExpiredRetention
					? new Date(Date.now() - 3600000)
					: command.input.ObjectLockRetainUntilDate,
				metadata: command.input.Metadata,
				createdAt: new Date(),
			}

			if (!this.store.has(key)) {
				this.store.set(key, [])
			}
			this.store.get(key).push(versionRecord)

			return {
				VersionId: versionId,
				ETag: eTag,
			}
		}

		if (commandName === 'GetObjectCommand') {
			const key = command.input.Key
			const versionId = command.input.VersionId

			const versions = this.store.get(key)
			if (!versions) {
				const err = new Error(`NoSuchKey: The specified key does not exist.`)
				err.name = 'NoSuchKey'
				throw err
			}

			const record = versionId
				? versions.find((v) => v.versionId === versionId)
				: versions[versions.length - 1]

			if (!record) {
				const err = new Error(`NoSuchVersion: The specified version does not exist.`)
				err.name = 'NoSuchVersion'
				throw err
			}

			let responseBody = record.body
			if (this.forceCorruptedBody) {
				responseBody = responseBody + '<!-- tampered -->'
			}

			return {
				VersionId: record.versionId,
				ETag: record.eTag,
				Body: {
					transformToString: async () => responseBody,
				},
			}
		}

		if (commandName === 'GetObjectRetentionCommand') {
			const key = command.input.Key
			const versionId = command.input.VersionId

			const versions = this.store.get(key)
			if (!versions) {
				const err = new Error(`NoSuchKey: The specified key does not exist.`)
				throw err
			}

			const record = versions.find((v) => v.versionId === versionId)
			if (!record) {
				const err = new Error(`NoSuchVersion: The specified version does not exist.`)
				throw err
			}

			if (!record.objectLockMode) {
				return { Retention: null }
			}

			return {
				Retention: {
					Mode: record.objectLockMode,
					RetainUntilDate: record.objectLockRetainUntilDate,
				},
			}
		}

		if (commandName === 'ListObjectVersionsCommand') {
			const prefix = command.input.Prefix || ''
			const versionsList = []

			for (const [key, versions] of this.store.entries()) {
				if (!prefix || key.startsWith(prefix)) {
					for (let i = 0; i < versions.length; i++) {
						const v = versions[i]
						versionsList.push({
							Key: v.key,
							VersionId: v.versionId,
							IsLatest: i === versions.length - 1,
							LastModified: v.createdAt,
							ETag: v.eTag,
						})
					}
				}
			}

			return {
				Versions: versionsList,
			}
		}

		throw new Error(`Unsupported MockS3Command: ${commandName}`)
	}

	addCustomVersion(key, versionRecord = {}) {
		if (!this.store.has(key)) {
			this.store.set(key, [])
		}
		const fullRecord = {
			versionId:
				versionRecord.versionId ||
				`v_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
			key,
			body:
				typeof versionRecord.body === 'string'
					? versionRecord.body
					: JSON.stringify(versionRecord.body || {}),
			eTag:
				versionRecord.eTag ||
				`"${crypto.createHash('md5').update(typeof versionRecord.body === 'string' ? versionRecord.body : JSON.stringify(versionRecord.body || '')).digest('hex')}"`,
			contentType: versionRecord.contentType || 'application/json',
			objectLockMode:
				versionRecord.objectLockMode !== undefined
					? versionRecord.objectLockMode
					: 'COMPLIANCE',
			objectLockRetainUntilDate:
				versionRecord.objectLockRetainUntilDate ||
				new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
			metadata: versionRecord.metadata || {},
			createdAt: versionRecord.createdAt || new Date(),
		}
		this.store.get(key).push(fullRecord)
		return fullRecord
	}
}

describe('Stage B3.5.3: External WORM Anchoring using AWS S3 Object Lock', () => {
	let testKeyPair
	let mockS3Client
	let storageAdapter

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

		testKeyPair = generateSigningKeyPair()
	})

	beforeEach(async () => {
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
		await mongoose.connection.collection('auditcheckpoints').deleteMany({})
		await mongoose.connection.collection('auditcheckpointcursors').deleteMany({})

		mockS3Client = new MockS3Client()
		storageAdapter = new AuditWormStorageAdapter({
			s3Client: mockS3Client,
			retentionDays: 365,
			bucket: 'test-worm-bucket',
		})
	})

	after(async () => {
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

	// Helper to generate a valid PENDING checkpoint
	async function createPendingCheckpoint(recordCount = 5, hour = '2026-04-08T10:00:00.000Z') {
		await populateAuditEntries(recordCount)
		const genResult = await generateHourlyCheckpoint({
			scheduledHourUtc: normalizeToUtcHourString(hour),
		})
		assert.strictEqual(genResult.status, 'CREATED')
		const checkpoint = await AuditCheckpoint.findOne({ checkpointId: genResult.checkpoint.checkpointId })
		assert.strictEqual(checkpoint.anchoringStatus, 'PENDING')
		return checkpoint
	}

	// =========================================================================
	// GROUP A: Cryptographic Detached Signing Tests (1–7)
	// =========================================================================
	describe('Group A: Cryptographic Detached Signing Tests', () => {
		it('1. should generate detached Ed25519 signature over canonical checkpoint payload', () => {
			const samplePayload = {
				formatVersion: 'v1',
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				checkpointId: 'chk_test_1',
				startSequence: 1,
				endSequence: 10,
				recordCount: 10,
				firstRecordHash: 'a'.repeat(64),
				lastRecordHash: 'b'.repeat(64),
				previousCheckpointHash: GENESIS_CHECKPOINT_HASH,
				checkpointHash: 'c'.repeat(64),
				scheduledHourUtc: '2026-04-08T10:00:00.000Z',
			}
			const canonical = canonicalizeCheckpointPayload(samplePayload)
			const res = signCheckpointPayload(canonical, testKeyPair.privateKey, { keyId: 'key-1' })

			assert.strictEqual(res.algorithm, 'Ed25519')
			assert.strictEqual(res.keyId, 'key-1')
			assert.strictEqual(typeof res.signature, 'string')
			assert.strictEqual(res.signature.length, 128) // 64 bytes = 128 hex chars
			assert.strictEqual(res.canonicalPayload, canonical)
		})

		it('2. should verify detached signature for unmodified payload with matching public key', () => {
			const canonical = canonicalizeCheckpointPayload({ foo: 'bar', baz: 123 })
			const signRes = signCheckpointPayload(canonical, testKeyPair.privateKey)
			const verifyRes = verifyCheckpointSignature(
				canonical,
				signRes.signature,
				testKeyPair.publicKey
			)

			assert.strictEqual(verifyRes.isValid, true)
			assert.strictEqual(verifyRes.algorithm, 'Ed25519')
			assert.strictEqual(verifyRes.error, undefined)
		})

		it('3. should fail signature verification when a single character or byte in payload is altered', () => {
			const original = canonicalizeCheckpointPayload({ amount: 100, target: 'Alice' })
			const signRes = signCheckpointPayload(original, testKeyPair.privateKey)

			const tampered = original.replace('100', '101')
			const verifyRes = verifyCheckpointSignature(
				tampered,
				signRes.signature,
				testKeyPair.publicKey
			)

			assert.strictEqual(verifyRes.isValid, false)
			assert.match(verifyRes.error, /Cryptographic signature verification failed/i)
		})

		it('4. should fail signature verification when public key does not match signing private key', () => {
			const canonical = canonicalizeCheckpointPayload({ status: 'APPROVED' })
			const signRes = signCheckpointPayload(canonical, testKeyPair.privateKey)

			const otherKeyPair = generateSigningKeyPair()
			const verifyRes = verifyCheckpointSignature(
				canonical,
				signRes.signature,
				otherKeyPair.publicKey
			)

			assert.strictEqual(verifyRes.isValid, false)
			assert.match(verifyRes.error, /Cryptographic signature verification failed/i)
		})

		it('5. should fail signature verification for malformed signatures (truncated, modified hex, non-hex)', () => {
			const canonical = canonicalizeCheckpointPayload({ id: 1 })
			const signRes = signCheckpointPayload(canonical, testKeyPair.privateKey)

			// Truncated signature
			const truncated = signRes.signature.slice(0, 64)
			const resTrunc = verifyCheckpointSignature(canonical, truncated, testKeyPair.publicKey)
			assert.strictEqual(resTrunc.isValid, false)
			assert.match(resTrunc.error, /Invalid signature length/i)

			// Flipped byte in signature
			const tamperedChar = signRes.signature[0] === 'a' ? 'b' : 'a'
			const tamperedSig = tamperedChar + signRes.signature.slice(1)
			const resTampered = verifyCheckpointSignature(canonical, tamperedSig, testKeyPair.publicKey)
			assert.strictEqual(resTampered.isValid, false)

			// Non-hex
			const nonHex = 'Z'.repeat(128)
			const resNonHex = verifyCheckpointSignature(canonical, nonHex, testKeyPair.publicKey)
			assert.strictEqual(resNonHex.isValid, false)
		})

		it('6. should produce deterministic SPKI public key and PKCS#8 private key via generateSigningKeyPair', () => {
			const kp = generateSigningKeyPair()
			assert.ok(kp.publicKey.startsWith('-----BEGIN PUBLIC KEY-----'))
			assert.ok(kp.publicKey.trim().endsWith('-----END PUBLIC KEY-----'))
			assert.ok(kp.privateKey.startsWith('-----BEGIN PRIVATE KEY-----'))
			assert.ok(kp.privateKey.trim().endsWith('-----END PRIVATE KEY-----'))
		})

		it('7. should reject unsupported signing algorithms or missing key configuration fail-closed', () => {
			assert.throws(
				() => parseSigningConfig({ algorithm: 'RSA-SHA256' }),
				/Unsupported signing algorithm/
			)
			assert.throws(
				() => resolvePrivateKey({}),
				/Private key is missing/
			)
			assert.throws(
				() => resolvePublicKey({}),
				/Public key is missing/
			)
		})
	})

	// =========================================================================
	// GROUP B: AWS S3 Object Lock Storage Adapter Tests (8–19)
	// =========================================================================
	describe('Group B: AWS S3 Object Lock Storage Adapter Tests', () => {
		it('8. should build deterministic S3 object key adhering to approved pattern', () => {
			const key = buildS3ObjectKey('GLOBAL_ADMIN_AUDIT_HEAD', 'chk_20260408_01')
			assert.strictEqual(
				key,
				'namma-blood/audit-checkpoints/v1/GLOBAL_ADMIN_AUDIT_HEAD/chk_20260408_01.json'
			)
		})

		it('9. should reject path traversal, special characters, or invalid prefix in object key validator', () => {
			assert.strictEqual(validateS3ObjectKey('../etc/passwd'), false)
			assert.strictEqual(validateS3ObjectKey('namma-blood/audit-checkpoints/v1/../../escape.json'), false)
			assert.strictEqual(validateS3ObjectKey('wrong-prefix/GLOBAL_ADMIN_AUDIT_HEAD/chk_1.json'), false)
			assert.strictEqual(validateS3ObjectKey('namma-blood/audit-checkpoints/v1/bad$id/chk_1.json'), false)
			assert.throws(
				() => buildS3ObjectKey('../escape', 'chk_1'),
				/Invalid ledgerId/
			)
		})

		it('10. should calculate accurate UTC RetainUntilDate in future based on retention days', () => {
			const base = new Date('2026-04-08T00:00:00.000Z')
			const retainDate = calculateRetainUntilDate(365, base)
			const expectedMs = base.getTime() + 365 * 24 * 60 * 60 * 1000
			assert.strictEqual(retainDate.getTime(), expectedMs)
			assert.ok(retainDate > base)
		})

		it('11. should reject invalid retention duration (zero, negative, non-integer, empty) fail-closed', () => {
			assert.throws(() => validateRetentionDays(0), /must be a positive integer/)
			assert.throws(() => validateRetentionDays(-5), /must be a positive integer/)
			assert.throws(() => validateRetentionDays(3.14), /must be a positive integer/)
			assert.throws(() => validateRetentionDays(''), /is required/)
			assert.throws(() => validateRetentionDays(null), /is required/)
			assert.throws(() => validateRetentionDays(999999), /outside allowed bounds/)
		})

		it('12. should enforce ObjectLockMode COMPLIANCE in PutObjectCommand', async () => {
			const res = await storageAdapter.uploadCheckpointEvidence({
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				checkpointId: 'chk_test_12',
				evidenceDocument: { test: true },
				retentionDays: 30,
			})

			assert.strictEqual(res.objectLockMode, 'COMPLIANCE')
			assert.strictEqual(mockS3Client.putCommandCalls.length, 1)
			assert.strictEqual(mockS3Client.putCommandCalls[0].ObjectLockMode, 'COMPLIANCE')
		})

		it('13. should enforce ObjectLockRetainUntilDate matches calculated retention timestamp', async () => {
			const beforeUpload = Date.now()
			const res = await storageAdapter.uploadCheckpointEvidence({
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				checkpointId: 'chk_test_13',
				evidenceDocument: { test: true },
				retentionDays: 30,
			})
			const afterUpload = Date.now()

			const expectedMin = beforeUpload + 30 * 24 * 60 * 60 * 1000
			const expectedMax = afterUpload + 30 * 24 * 60 * 60 * 1000
			const actualMs = res.retentionUntil.getTime()
			assert.ok(actualMs >= expectedMin && actualMs <= expectedMax)
			assert.strictEqual(
				mockS3Client.putCommandCalls[0].ObjectLockRetainUntilDate.getTime(),
				actualMs
			)
		})

		it('14. should return non-null VersionId and fail closed if S3 returns null or missing VersionId', async () => {
			// Normal case
			const res = await storageAdapter.uploadCheckpointEvidence({
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				checkpointId: 'chk_test_14a',
				evidenceDocument: { test: true },
				retentionDays: 1,
			})
			assert.ok(res.versionId && typeof res.versionId === 'string')

			// Null version ID simulation
			mockS3Client.forceNullVersionId = true
			await assert.rejects(
				() =>
					storageAdapter.uploadCheckpointEvidence({
						ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
						checkpointId: 'chk_test_14b',
						evidenceDocument: { test: true },
						retentionDays: 1,
					}),
				/S3 bucket versioning and Object Lock must be enabled/
			)
		})

		it('15. should retrieve exact object version and verify body and SHA-256 checksum', async () => {
			const doc = { payload: 'exact-version-body-test' }
			const upload = await storageAdapter.uploadCheckpointEvidence({
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				checkpointId: 'chk_test_15',
				evidenceDocument: doc,
				retentionDays: 1,
			})

			const retrieved = await storageAdapter.getObjectVersion({
				objectKey: upload.objectKey,
				versionId: upload.versionId,
			})

			assert.strictEqual(retrieved.versionId, upload.versionId)
			assert.strictEqual(retrieved.body, JSON.stringify(doc))
			assert.strictEqual(retrieved.sha256Checksum, upload.sha256Checksum)
		})

		it('16. should retrieve and verify S3 Object Lock retention metadata mode is COMPLIANCE', async () => {
			const upload = await storageAdapter.uploadCheckpointEvidence({
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				checkpointId: 'chk_test_16',
				evidenceDocument: { sample: 1 },
				retentionDays: 10,
			})

			const retention = await storageAdapter.getObjectRetention({
				objectKey: upload.objectKey,
				versionId: upload.versionId,
			})

			assert.strictEqual(retention.mode, 'COMPLIANCE')
			assert.ok(retention.retainUntilDate instanceof Date)
			assert.ok(retention.retainUntilDate > new Date())
		})

		it('17. should reject if S3 returns mode GOVERNANCE fail-closed', async () => {
			mockS3Client.forceModeOverride = 'GOVERNANCE'
			const upload = await storageAdapter.uploadCheckpointEvidence({
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				checkpointId: 'chk_test_17',
				evidenceDocument: { test: true },
				retentionDays: 1,
			})

			await assert.rejects(
				() =>
					storageAdapter.getObjectRetention({
						objectKey: upload.objectKey,
						versionId: upload.versionId,
					}),
				/Security Violation: Object Lock mode is 'GOVERNANCE', expected strictly 'COMPLIANCE'/
			)
		})

		it('18. should reject if S3 returns missing retention metadata fail-closed', async () => {
			mockS3Client.forceModeOverride = null
			const upload = await storageAdapter.uploadCheckpointEvidence({
				ledgerId: 'GLOBAL_ADMIN_AUDIT_HEAD',
				checkpointId: 'chk_test_18',
				evidenceDocument: { test: true },
				retentionDays: 1,
			})

			// Remove retention record
			const versions = mockS3Client.store.get(upload.objectKey)
			versions[0].objectLockMode = null

			await assert.rejects(
				() =>
					storageAdapter.getObjectRetention({
						objectKey: upload.objectKey,
						versionId: upload.versionId,
					}),
				/Object Lock Missing/
			)
		})

		it('19. should verify storage adapter exposes zero deletion or overwrite methods', () => {
			assert.strictEqual(storageAdapter.deleteObject, undefined)
			assert.strictEqual(storageAdapter.delete, undefined)
			assert.strictEqual(storageAdapter.remove, undefined)
			assert.strictEqual(storageAdapter.deleteVersion, undefined)
		})
	})

	// =========================================================================
	// GROUP C: Anchoring Lifecycle and Recovery Tests (20–28)
	// =========================================================================
	describe('Group C: Anchoring Lifecycle and Recovery Tests', () => {
		it('20. should transition checkpoint through anchoring lifecycle to ANCHORED', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			assert.strictEqual(checkpoint.anchoringStatus, 'PENDING')

			const anchorRes = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
					keyId: 'test-key-2026',
				},
				retentionDays: 90,
			})

			assert.strictEqual(anchorRes.anchored, true)
			assert.strictEqual(anchorRes.checkpointId, checkpoint.checkpointId)

			const updated = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(updated.anchoringStatus, 'ANCHORED')
			assert.ok(updated.anchoredAt instanceof Date)
			assert.ok(updated.externalObjectVersionId)
			assert.ok(updated.externalObjectKey)
		})

		it('21. should persist complete anchoringEvidence subdocument upon successful anchoring', async () => {
			const checkpoint = await createPendingCheckpoint(2)

			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
					keyId: 'test-evidence-key',
				},
				retentionDays: 180,
			})

			const updated = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId }).lean()
			const ev = updated.anchoringEvidence

			assert.ok(ev, 'anchoringEvidence subdocument must exist')
			assert.strictEqual(ev.s3Bucket, 'test-worm-bucket')
			assert.strictEqual(ev.s3ObjectKey, buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId))
			assert.ok(ev.s3VersionId)
			assert.ok(ev.sha256Checksum)
			assert.strictEqual(ev.objectLockMode, 'COMPLIANCE')
			assert.ok(ev.retentionUntil)
			assert.ok(ev.signature)
			assert.strictEqual(ev.signatureAlgorithm, 'Ed25519')
			assert.strictEqual(ev.signingKeyId, 'test-evidence-key')
			assert.strictEqual(ev.verificationStatus, 'VERIFIED')
			assert.ok(ev.verifiedAt)
			assert.ok(ev.anchoredAt)
		})

		it('22. should prevent deletion of ANCHORED checkpoint via query and document middleware', async () => {
			const checkpoint = await createPendingCheckpoint(2)
			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const anchoredDoc = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(anchoredDoc.anchoringStatus, 'ANCHORED')

			// Query deletion
			await assert.rejects(
				() => AuditCheckpoint.deleteOne({ _id: anchoredDoc._id }),
				/AuditCheckpoint records in PENDING or ANCHORED status are immutable and cannot be deleted/
			)

			// Document deletion
			await assert.rejects(
				() => anchoredDoc.deleteOne(),
				/AuditCheckpoint records in PENDING or ANCHORED status are immutable and cannot be deleted/
			)
		})

		it('23. should prevent update of ANCHORED checkpoint via query and document middleware', async () => {
			const checkpoint = await createPendingCheckpoint(2)
			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const anchoredDoc = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })

			// Query update
			await assert.rejects(
				() =>
					AuditCheckpoint.updateOne(
						{ _id: anchoredDoc._id },
						{ $set: { formatVersion: 'v2' } }
					),
				/AuditCheckpoint records in ANCHORED status are immutable and cannot be updated/
			)

			// Document save update
			anchoredDoc.formatVersion = 'v2'
			await assert.rejects(
				() => anchoredDoc.save(),
				/AuditCheckpoint records in ANCHORED status are immutable and cannot be updated/
			)
		})

		it('24. should transition checkpoint to FAILED on upload error with error details', async () => {
			const checkpoint = await createPendingCheckpoint(2)
			mockS3Client.forcePutError = new Error('S3 500 Internal Service Error')

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, false)
			assert.match(res.error, /S3 500 Internal Service Error/)

			const failedDoc = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(failedDoc.anchoringStatus, 'FAILED')
			assert.ok(failedDoc.anchoringErrorCode)
			assert.match(failedDoc.anchoringErrorMessage, /S3 500 Internal Service Error/)
			assert.ok(failedDoc.anchoringErrorAt instanceof Date)
			assert.strictEqual(failedDoc.anchoringClaimedBy, null)
		})

		it('25. should not advance AuditChainHead.lastAnchoredSequence on anchoring failure', async () => {
			await createPendingCheckpoint(2)
			mockS3Client.forcePutError = new Error('Network Timeout')

			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.lastAnchoredSequence, 0)
			assert.strictEqual(head.lastAnchoredHash, '')
		})

		it('26. should allow another worker to acquire claim after previous claim expires', async () => {
			const checkpoint = await createPendingCheckpoint(2)

			// Worker 1 acquires claim with 20ms TTL
			const claim1 = await acquireAnchoringClaim(checkpoint.checkpointId, 'worker-1', 20)
			assert.strictEqual(claim1.claimed, true)

			// Immediate attempt by Worker 2 fails
			const claim2 = await acquireAnchoringClaim(checkpoint.checkpointId, 'worker-2', 20)
			assert.strictEqual(claim2.claimed, false)

			// Wait for TTL expiration
			await new Promise((resolve) => setTimeout(resolve, 35))

			// Worker 2 attempts again after expiry
			const claim3 = await acquireAnchoringClaim(checkpoint.checkpointId, 'worker-2', 2000)
			assert.strictEqual(claim3.claimed, true)
			assert.strictEqual(claim3.checkpoint.anchoringClaimedBy, 'worker-2')
		})

		it('27. should reconcile stale claims and reset stuck checkpoints to FAILED', async () => {
			const checkpoint = await createPendingCheckpoint(2)

			// Manually simulate a stuck checkpoint
			await AuditCheckpoint.updateOne(
				{ checkpointId: checkpoint.checkpointId },
				{
					$set: {
						anchoringStatus: 'UPLOADING',
						anchoringClaimedBy: 'crashed-worker',
						anchoringClaimExpiresAt: new Date(Date.now() - 5000), // Expired 5s ago
					},
				}
			)

			const reconcileRes = await reconcileStaleAnchoringClaims({ maxStaleAgeMs: 1000 })
			assert.strictEqual(reconcileRes.staleCount, 1)
			assert.ok(reconcileRes.reconciledCheckpoints.includes(checkpoint.checkpointId))

			const reconciledDoc = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(reconciledDoc.anchoringStatus, 'FAILED')
			assert.strictEqual(reconciledDoc.anchoringErrorCode, 'STALE_ANCHORING_CLAIM_EXPIRED')
			assert.strictEqual(reconciledDoc.anchoringClaimedBy, null)
		})

		it('28. should successfully retry anchoring of previously FAILED checkpoint', async () => {
			const checkpoint = await createPendingCheckpoint(2)

			// Step 1: Simulate initial failure
			mockS3Client.forcePutError = new Error('Transient 503 Service Unavailable')
			const failedRes = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})
			assert.strictEqual(failedRes.anchored, false)

			// Step 2: Clear simulated error and retry
			mockS3Client.forcePutError = null
			const retryRes = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(retryRes.anchored, true)
			assert.strictEqual(retryRes.checkpointId, checkpoint.checkpointId)

			const anchoredDoc = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(anchoredDoc.anchoringStatus, 'ANCHORED')
			assert.strictEqual(anchoredDoc.anchoringAttempt, 2)
		})
	})

	// =========================================================================
	// GROUP D: Monotonic Watermark Advancement Tests (29–37)
	// =========================================================================
	describe('Group D: Monotonic Watermark Advancement Tests', () => {
		it('29. should monotonically advance AuditChainHead.lastAnchoredSequence after anchoring', async () => {
			const checkpoint = await createPendingCheckpoint(5)
			assert.strictEqual(checkpoint.startSequence, 1)
			assert.strictEqual(checkpoint.endSequence, 5)

			const headBefore = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(headBefore.lastAnchoredSequence, 0)

			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const headAfter = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(headAfter.lastAnchoredSequence, 5)
			assert.ok(headAfter.lastAnchoredAt instanceof Date)
		})

		it('30. should update AuditChainHead.lastAnchoredHash to anchored checkpoint hash', async () => {
			const checkpoint = await createPendingCheckpoint(4)

			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.lastAnchoredHash, checkpoint.checkpointHash)
		})

		it('31. should advance watermark and update checkpoint atomically in transaction', async () => {
			await createPendingCheckpoint(3)

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})
			assert.strictEqual(res.anchored, true)

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			const chk = await AuditCheckpoint.findOne({ checkpointId: res.checkpointId }).lean()

			assert.strictEqual(head.lastAnchoredSequence, chk.endSequence)
			assert.strictEqual(head.lastAnchoredHash, chk.checkpointHash)
			assert.strictEqual(chk.anchoringStatus, 'ANCHORED')
		})

		it('32. should NEVER modify or corrupt AuditChainHead.sequenceNumber during anchoring', async () => {
			await populateAuditEntries(7)
			const headInitial = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			const operationalSeq = headInitial.sequenceNumber
			assert.strictEqual(operationalSeq, 7)

			// Generate checkpoint for first 4 entries
			await generateHourlyCheckpoint({
				batchLimit: 4,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T10:00:00.000Z'),
			})

			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const headFinal = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(headFinal.sequenceNumber, operationalSeq, 'Operational sequenceNumber must remain intact!')
			assert.strictEqual(headFinal.lastAnchoredSequence, 4)
		})

		it('33. should prevent sequence gaps: skip checkpoint with startSequence > lastAnchoredSequence + 1', async () => {
			await populateAuditEntries(10)

			// Generate checkpoint A [1..5]
			await generateHourlyCheckpoint({
				batchLimit: 5,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T10:00:00.000Z'),
			})
			// Generate checkpoint B [6..10]
			await generateHourlyCheckpoint({
				batchLimit: 5,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T11:00:00.000Z'),
			})

			// Set head lastAnchoredSequence artificially to 2 (gap: checkpoint B starts at 6, expected 3)
			await AuditChainHead.updateOne(
				{ _id: GLOBAL_HEAD_ID },
				{ $set: { lastAnchoredSequence: 2 } }
			)

			const eligible = await determineNextEligibleAnchoringCheckpoint()
			assert.strictEqual(eligible, null, 'Must not return non-contiguous checkpoint')
		})

		it('34. should anchor sequential checkpoints strictly in order ([1..5] then [6..10])', async () => {
			await populateAuditEntries(10)

			// Generate checkpoint 1 [1..5]
			const gen1 = await generateHourlyCheckpoint({
				batchLimit: 5,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T10:00:00.000Z'),
			})
			// Generate checkpoint 2 [6..10]
			const gen2 = await generateHourlyCheckpoint({
				batchLimit: 5,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T11:00:00.000Z'),
			})

			// First anchor run must anchor checkpoint 1
			const anchor1 = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})
			assert.strictEqual(anchor1.anchored, true)
			assert.strictEqual(anchor1.checkpointId, gen1.checkpoint.checkpointId)
			assert.strictEqual(anchor1.startSequence, 1)
			assert.strictEqual(anchor1.endSequence, 5)

			let head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.lastAnchoredSequence, 5)

			// Second anchor run must anchor checkpoint 2
			const anchor2 = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})
			assert.strictEqual(anchor2.anchored, true)
			assert.strictEqual(anchor2.checkpointId, gen2.checkpoint.checkpointId)
			assert.strictEqual(anchor2.startSequence, 6)
			assert.strictEqual(anchor2.endSequence, 10)

			head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.lastAnchoredSequence, 10)
		})

		it('35. should fail closed when candidate previousCheckpointHash does not match lastAnchoredHash', async () => {
			await populateAuditEntries(10)
			await generateHourlyCheckpoint({
				batchLimit: 5,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T10:00:00.000Z'),
			})
			await generateHourlyCheckpoint({
				batchLimit: 5,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T11:00:00.000Z'),
			})

			// Anchor first checkpoint
			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			// Tamper with head's lastAnchoredHash
			await AuditChainHead.updateOne(
				{ _id: GLOBAL_HEAD_ID },
				{ $set: { lastAnchoredHash: 'TAMPERED_HASH_00000000000000000000000000000000000000000000000000' } }
			)

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, false)
			assert.strictEqual(res.reason, 'ANCHORING_HASH_DISCONTINUITY')
		})

		it('36. should safely handle concurrent workers attempting to anchor the same checkpoint', async () => {
			const checkpoint = await createPendingCheckpoint(4)

			const worker1Promise = anchorNextCheckpoint({
				workerId: 'worker-concurrent-1',
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const worker2Promise = anchorNextCheckpoint({
				workerId: 'worker-concurrent-2',
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const [res1, res2] = await Promise.all([worker1Promise, worker2Promise])

			// Exactly one worker must succeed, other worker gets CLAIM_FAILED or NO_ELIGIBLE
			const successCount = (res1.anchored ? 1 : 0) + (res2.anchored ? 1 : 0)
			assert.strictEqual(successCount, 1, 'Exactly one worker must succeed')

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.lastAnchoredSequence, 4)
		})

		it('37. should roll back and leave checkpoint unanchored if verification or commit fails', async () => {
			const checkpoint = await createPendingCheckpoint(3)

			// Tamper with body in S3 so verification step fails
			mockS3Client.forceCorruptedBody = true

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, false)
			assert.strictEqual(res.reason, 'CHECKSUM_MISMATCH')

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.lastAnchoredSequence, 0)

			const chk = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId }).lean()
			assert.strictEqual(chk.anchoringStatus, 'FAILED')
		})
	})

	// =========================================================================
	// GROUP E: Security and Isolation Invariants (38–42)
	// =========================================================================
	describe('Group E: Security and Isolation Invariants', () => {
		it('38. should maintain strict separation between operational sequence, checkpoint cursor, and anchored watermark', async () => {
			await populateAuditEntries(10)
			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.sequenceNumber, 10)
			assert.strictEqual(head.lastAnchoredSequence, 0)

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 0)
		})

		it('39. should ensure checkpoint generation in B3.5.2 NEVER advances lastAnchoredSequence', async () => {
			await populateAuditEntries(6)
			await generateHourlyCheckpoint({
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T10:00:00.000Z'),
			})

			const cursor = await getOrInitCheckpointCursor()
			assert.strictEqual(cursor.lastCheckpointedSequence, 6)

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.lastAnchoredSequence, 0, 'lastAnchoredSequence must remain 0 during generation')
		})

		it('40. should ensure anchoring advances lastAnchoredSequence but NEVER touches checkpoint cursor or operational sequenceNumber', async () => {
			await populateAuditEntries(6)
			await generateHourlyCheckpoint({
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T10:00:00.000Z'),
			})

			const cursorBefore = await getOrInitCheckpointCursor()
			assert.strictEqual(cursorBefore.lastCheckpointedSequence, 6)

			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const cursorAfter = await getOrInitCheckpointCursor()
			assert.strictEqual(cursorAfter.lastCheckpointedSequence, 6, 'Cursor must not be modified by anchoring')

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()
			assert.strictEqual(head.sequenceNumber, 6, 'Operational sequenceNumber must not be modified by anchoring')
			assert.strictEqual(head.lastAnchoredSequence, 6, 'lastAnchoredSequence must advance to 6')
		})

		it('41. should execute end-to-end pipeline: write audits -> checkpoint -> WORM anchor -> status telemetry', async () => {
			// Step 1: Write administrative decision audits
			await populateAuditEntries(5)

			// Step 2: Generate local B3.5.2 checkpoint
			const gen = await generateHourlyCheckpoint({
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T12:00:00.000Z'),
			})
			assert.strictEqual(gen.status, 'CREATED')

			// Step 3: Anchor checkpoint to external WORM
			const anchor = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
					keyId: 'prod-compliance-2026',
				},
				retentionDays: 365,
			})
			assert.strictEqual(anchor.anchored, true)
			assert.strictEqual(anchor.objectLockMode, 'COMPLIANCE')

			// Step 4: Check telemetry
			const status = await getAnchoringStatus(GLOBAL_HEAD_ID)
			assert.strictEqual(status.headSequence, 5)
			assert.strictEqual(status.lastAnchoredSequence, 5)
			assert.strictEqual(status.statusCounts.ANCHORED, 1)
			assert.strictEqual(status.statusCounts.PENDING, 0)
			assert.strictEqual(status.nextEligibleCheckpointId, null)
		})

		it('42. should independently verify complete 14-point post-anchoring integrity against S3 evidence', async () => {
			await populateAuditEntries(4)
			const gen = await generateHourlyCheckpoint({
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T14:00:00.000Z'),
			})

			const anchor = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
					keyId: 'verifier-key-1',
				},
				retentionDays: 365,
			})
			assert.strictEqual(anchor.anchored, true)

			const anchoredDoc = await AuditCheckpoint.findOne({ checkpointId: gen.checkpoint.checkpointId }).lean()
			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID).lean()

			const s3Receipt = {
				bucket: 'test-worm-bucket',
				objectKey: anchoredDoc.anchoringEvidence.s3ObjectKey,
				versionId: anchoredDoc.anchoringEvidence.s3VersionId,
				sha256Checksum: anchoredDoc.anchoringEvidence.sha256Checksum,
				retentionUntil: anchoredDoc.anchoringEvidence.retentionUntil,
			}

			const verifyResult = await verifyAnchoredCheckpointVersion(
				anchoredDoc,
				s3Receipt,
				{
					storageAdapter,
					publicKeyPem: testKeyPair.publicKey,
					signingConfig: { keyId: 'verifier-key-1' },
					head,
				}
			)

			assert.strictEqual(verifyResult.verified, true)
			assert.strictEqual(verifyResult.details.objectLockMode, 'COMPLIANCE')
			assert.strictEqual(verifyResult.details.signatureAlgorithm, 'Ed25519')
			assert.strictEqual(verifyResult.details.signingKeyId, 'verifier-key-1')
		})
	})

	// =========================================================================
	// GROUP F: S3 Object Lock Upload Idempotency & Version Reconciliation Tests (43–56)
	// =========================================================================
	describe('Group F: S3 Object Lock Upload Idempotency and Version Reconciliation Tests', () => {
		// Helper to construct exact valid evidence document for an existing checkpoint
		function constructMatchingEvidenceDocument(checkpoint, keyPair, keyId = 'test-key-id') {
			const signResult = signCheckpointPayload(checkpoint.canonicalPayload, keyPair.privateKey, { keyId })
			return {
				formatVersion: checkpoint.formatVersion || 'v1',
				ledgerId: checkpoint.ledgerId,
				checkpointId: checkpoint.checkpointId,
				startSequence: checkpoint.startSequence,
				endSequence: checkpoint.endSequence,
				recordCount: checkpoint.recordCount,
				firstRecordHash: checkpoint.firstRecordHash,
				lastRecordHash: checkpoint.lastRecordHash,
				previousCheckpointHash: checkpoint.previousCheckpointHash,
				checkpointHash: checkpoint.checkpointHash,
				payload: checkpoint.payload,
				canonicalPayload: checkpoint.canonicalPayload,
				generatedAt: checkpoint.generatedAt
					? new Date(checkpoint.generatedAt).toISOString()
					: new Date().toISOString(),
				scheduledHourUtc: checkpoint.scheduledHourUtc,
				signature: {
					algorithm: signResult.algorithm,
					keyId: signResult.keyId,
					publicKey: keyPair.publicKey,
					signature: signResult.signature,
				},
			}
		}

		it('43. should upload signed checkpoint evidence when no existing object exists in S3 (Case A)', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
			assert.strictEqual(mockS3Client.store.has(key), false)
			assert.strictEqual(mockS3Client.putCommandCalls.length, 0)

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, true)
			assert.strictEqual(res.reusedExisting, false)
			assert.strictEqual(mockS3Client.putCommandCalls.length, 1)

			const updated = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(updated.anchoringStatus, 'ANCHORED')
			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 3)
		})

		it('44. should reuse matching existing object in S3 without issuing another PutObject request (Case B)', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)

			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)
			const initialVersion = mockS3Client.addCustomVersion(key, {
				versionId: 'v_existing_matched_001',
				body: evidence,
				objectLockMode: 'COMPLIANCE',
				objectLockRetainUntilDate: new Date(Date.now() + 180 * 24 * 60 * 60 * 1000),
			})

			assert.strictEqual(mockS3Client.putCommandCalls.length, 0)

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, true)
			assert.strictEqual(res.reusedExisting, true)
			assert.strictEqual(res.versionId, initialVersion.versionId)
			assert.strictEqual(mockS3Client.putCommandCalls.length, 0, 'Must NOT issue PutObject request!')

			const updated = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(updated.anchoringStatus, 'ANCHORED')
			assert.strictEqual(updated.externalObjectVersionId, initialVersion.versionId)
		})

		it('45. should verify that reuse of existing matching object preserves single version in S3', async () => {
			const checkpoint = await createPendingCheckpoint(2)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)

			mockS3Client.addCustomVersion(key, {
				versionId: 'v_single_001',
				body: evidence,
				objectLockMode: 'COMPLIANCE',
			})

			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const versions = mockS3Client.store.get(key)
			assert.strictEqual(versions.length, 1, 'S3 must still hold exactly 1 version')
		})

		it('46. should fail closed when existing S3 object has mismatched content (Case C)', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)

			// Mismatched evidence (different sequence range and tampered payload)
			const mismatchedDoc = {
				formatVersion: 'v1',
				ledgerId: checkpoint.ledgerId,
				checkpointId: checkpoint.checkpointId,
				startSequence: 999, // Mismatched
				endSequence: 1000,
				recordCount: 2,
				firstRecordHash: 'a'.repeat(64),
				lastRecordHash: 'b'.repeat(64),
				previousCheckpointHash: 'c'.repeat(64),
				checkpointHash: 'f'.repeat(64),
				canonicalPayload: '{"tampered":true}',
				signature: {
					signature: 'a'.repeat(128),
				},
			}

			mockS3Client.addCustomVersion(key, {
				versionId: 'v_mismatched_001',
				body: mismatchedDoc,
				objectLockMode: 'COMPLIANCE',
			})

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, false)
			assert.strictEqual(res.reason, 'STORAGE_INTEGRITY_MISMATCH')
			assert.strictEqual(mockS3Client.putCommandCalls.length, 0, 'Must not overwrite or issue PutObject')

			const failedDoc = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(failedDoc.anchoringStatus, 'FAILED')
			assert.strictEqual(failedDoc.anchoringErrorCode, 'STORAGE_INTEGRITY_MISMATCH')
		})

		it('47. should ensure content mismatch does NOT advance the external anchored watermark', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)

			mockS3Client.addCustomVersion(key, {
				versionId: 'v_tampered_002',
				body: { checkpointId: checkpoint.checkpointId, corrupted: true },
				objectLockMode: 'COMPLIANCE',
			})

			await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 0, 'Watermark must remain strictly at 0')
			assert.strictEqual(head.lastAnchoredHash, '')
		})

		it('48. should verify existing COMPLIANCE retention before allowing version reuse', async () => {
			const checkpoint = await createPendingCheckpoint(2)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)

			const futureRetention = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
			mockS3Client.addCustomVersion(key, {
				versionId: 'v_compliance_ok',
				body: evidence,
				objectLockMode: 'COMPLIANCE',
				objectLockRetainUntilDate: futureRetention,
			})

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, true)
			assert.strictEqual(res.objectLockMode, 'COMPLIANCE')
		})

		it('49. should reject version reuse if existing S3 object has GOVERNANCE retention mode', async () => {
			const checkpoint = await createPendingCheckpoint(2)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)

			mockS3Client.addCustomVersion(key, {
				versionId: 'v_gov_001',
				body: evidence,
				objectLockMode: 'GOVERNANCE', // Illegal mode
			})

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, false)
			assert.strictEqual(res.reason, 'STORAGE_INTEGRITY_MISMATCH')
			assert.strictEqual(mockS3Client.putCommandCalls.length, 0)
			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 0)
		})

		it('50. should reject version reuse if existing S3 object is missing retention metadata', async () => {
			const checkpoint = await createPendingCheckpoint(2)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)

			mockS3Client.addCustomVersion(key, {
				versionId: 'v_missing_lock_001',
				body: evidence,
				objectLockMode: null, // Missing Object Lock
			})

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, false)
			assert.strictEqual(res.reason, 'STORAGE_INTEGRITY_MISMATCH')
			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 0)
		})

		it('51. should recover from crash after S3 upload and before MongoDB persistence (Scenario 2)', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)

			// Step 1: Worker 1 signs and uploads to S3
			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)
			const uploaded = mockS3Client.addCustomVersion(key, {
				versionId: 'v_crash_uploaded_001',
				body: evidence,
				objectLockMode: 'COMPLIANCE',
			})

			// Checkpoint remains unanchored in MongoDB (crash simulation)
			await AuditCheckpoint.updateOne(
				{ checkpointId: checkpoint.checkpointId },
				{ $set: { anchoringStatus: 'FAILED', anchoringClaimedBy: null, anchoringClaimExpiresAt: null } }
			)

			// Step 2: Later Worker 2 executes anchoring
			const res = await anchorNextCheckpoint({
				workerId: 'worker-recovery-2',
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			// Step 3: Worker 2 discovers existing version, reuses it, and advances watermark
			assert.strictEqual(res.anchored, true)
			assert.strictEqual(res.reusedExisting, true)
			assert.strictEqual(res.versionId, uploaded.versionId)
			assert.strictEqual(mockS3Client.putCommandCalls.length, 0, 'Must NOT issue second PutObject')

			const anchoredDoc = await AuditCheckpoint.findOne({ checkpointId: checkpoint.checkpointId })
			assert.strictEqual(anchoredDoc.anchoringStatus, 'ANCHORED')
			assert.strictEqual(anchoredDoc.externalObjectVersionId, uploaded.versionId)

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 3)
		})

		it('52. should handle multiple identical matching versions deterministically (Case D)', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)

			const earlierDate = new Date('2026-04-08T09:00:00.000Z')
			const laterDate = new Date('2026-04-08T09:05:00.000Z')

			const v1 = mockS3Client.addCustomVersion(key, {
				versionId: 'v_matching_earlier',
				body: evidence,
				objectLockMode: 'COMPLIANCE',
				createdAt: earlierDate,
			})
			mockS3Client.addCustomVersion(key, {
				versionId: 'v_matching_later',
				body: evidence,
				objectLockMode: 'COMPLIANCE',
				createdAt: laterDate,
			})

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, true)
			assert.strictEqual(res.reusedExisting, true)
			assert.strictEqual(res.versionId, v1.versionId, 'Must deterministically select earliest created matching version')
			assert.strictEqual(mockS3Client.putCommandCalls.length, 0)
		})

		it('53. should fail closed when multiple versions contain conflicting evidence (Case D)', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
			const evidenceMatching = constructMatchingEvidenceDocument(checkpoint, testKeyPair)

			// Version 1 matches
			mockS3Client.addCustomVersion(key, {
				versionId: 'v_conflict_1',
				body: evidenceMatching,
				objectLockMode: 'COMPLIANCE',
				createdAt: new Date('2026-04-08T09:00:00.000Z'),
			})

			// Version 2 conflicts (different startSequence)
			const conflictingDoc = {
				...evidenceMatching,
				startSequence: 99,
			}
			mockS3Client.addCustomVersion(key, {
				versionId: 'v_conflict_2',
				body: conflictingDoc,
				objectLockMode: 'COMPLIANCE',
				createdAt: new Date('2026-04-08T09:05:00.000Z'),
			})

			const res = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, false)
			assert.strictEqual(res.reason, 'STORAGE_INTEGRITY_MISMATCH')
			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 0)
		})

		it('54. should prevent concurrent workers from creating unnecessary S3 versions', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)

			// Worker 1 acquires claim and uploads to S3, but its lease expires
			await acquireAnchoringClaim(checkpoint.checkpointId, 'worker-1', 10)
			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)
			const uploaded = mockS3Client.addCustomVersion(key, {
				versionId: 'v_worker1_uploaded',
				body: evidence,
				objectLockMode: 'COMPLIANCE',
			})

			// Wait for Worker 1 lease expiry
			await new Promise((r) => setTimeout(r, 25))

			// Worker 2 runs anchorNextCheckpoint
			const res = await anchorNextCheckpoint({
				workerId: 'worker-2',
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})

			assert.strictEqual(res.anchored, true)
			assert.strictEqual(res.reusedExisting, true)
			assert.strictEqual(res.versionId, uploaded.versionId)
			assert.strictEqual(mockS3Client.store.get(key).length, 1, 'Only 1 version must exist in S3!')
		})

		it('55. should reject expired lease owners attempting to commit recovered evidence', async () => {
			const checkpoint = await createPendingCheckpoint(3)
			const key = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
			const evidence = constructMatchingEvidenceDocument(checkpoint, testKeyPair)
			mockS3Client.addCustomVersion(key, {
				versionId: 'v_fencing_test',
				body: evidence,
				objectLockMode: 'COMPLIANCE',
			})

			// Worker 1 acquires claim with 10ms TTL
			const claim1 = await acquireAnchoringClaim(checkpoint.checkpointId, 'worker-1', 10)
			await new Promise((r) => setTimeout(r, 25)) // Expire claim 1

			// Worker 2 acquires replacement claim
			const claim2 = await acquireAnchoringClaim(checkpoint.checkpointId, 'worker-2', 5000)
			assert.strictEqual(claim2.claimed, true)

			// Worker 1 attempts to commit with expired leaseToken
			const mongoSession = await mongoose.startSession()
			await assert.rejects(
				async () => {
					await mongoSession.withTransaction(async () => {
						const docInTx = await AuditCheckpoint.findOne({
							_id: checkpoint._id,
							anchoringLeaseToken: claim1.leaseToken, // Expired token!
						}).session(mongoSession)

						if (!docInTx) {
							throw new Error('Fencing violation: checkpoint claim invalidated')
						}
					})
				},
				/Fencing violation/
			)
			await mongoSession.endSession()

			const head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 0)
		})

		it('56. should ensure recovery never regresses the external anchored watermark', async () => {
			await populateAuditEntries(8)

			// Generate Checkpoint 1 [1..4]
			await generateHourlyCheckpoint({
				batchLimit: 4,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T10:00:00.000Z'),
			})
			// Generate Checkpoint 2 [5..8]
			const gen2 = await generateHourlyCheckpoint({
				batchLimit: 4,
				scheduledHourUtc: normalizeToUtcHourString('2026-04-08T11:00:00.000Z'),
			})

			// Anchor Checkpoint 1
			const anchor1 = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})
			assert.strictEqual(anchor1.anchored, true)
			let head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 4)

			// Pre-populate Checkpoint 2 in S3 (crash recovery simulation)
			const key2 = buildS3ObjectKey(gen2.checkpoint.ledgerId, gen2.checkpoint.checkpointId)
			const chk2Doc = await AuditCheckpoint.findOne({ checkpointId: gen2.checkpoint.checkpointId })
			const evidence2 = constructMatchingEvidenceDocument(chk2Doc, testKeyPair)
			mockS3Client.addCustomVersion(key2, {
				versionId: 'v_chk2_recovered',
				body: evidence2,
				objectLockMode: 'COMPLIANCE',
			})

			// Recover Checkpoint 2
			const anchor2 = await anchorNextCheckpoint({
				storageAdapter,
				signingConfig: {
					privateKey: testKeyPair.privateKey,
					publicKey: testKeyPair.publicKey,
				},
			})
			assert.strictEqual(anchor2.anchored, true)
			assert.strictEqual(anchor2.reusedExisting, true)

			head = await AuditChainHead.findById(GLOBAL_HEAD_ID)
			assert.strictEqual(head.lastAnchoredSequence, 8, 'Watermark must advance to 8')

			// Verify that watermark can NEVER regress backwards
			assert.ok(head.lastAnchoredSequence >= 4)
		})
	})
})
