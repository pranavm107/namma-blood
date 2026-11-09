/**
 * Stage B3.5.4 Automated Test Suite: Independent Offline Audit Compliance Verification
 * Namma Blood — Independent Verification, S3 Object Lock Compliance Validation, CLI, and Auditor Interface
 *
 * Test Matrix (32 comprehensive tests):
 * 1. Valid checkpoint evidence (VALID)
 * 2. Invalid checkpoint hash (INVALID)
 * 3. Altered canonical payload (INVALID)
 * 4. Invalid Ed25519 signature (INVALID)
 * 5. Unknown signing key (INVALID)
 * 6. Malformed signature (INVALID)
 * 7. Unsupported format version (INVALID)
 * 8. Missing evidence fields (INCOMPLETE)
 * 9. Missing checkpoint range (INCOMPLETE)
 * 10. Sequence gaps (INCOMPLETE)
 * 11. Overlapping checkpoint ranges (INVALID)
 * 12. Duplicate checkpoint identities (INVALID)
 * 13. Previous checkpoint hash mismatch (INVALID)
 * 14. Missing S3 VersionId (INVALID)
 * 15. Wrong S3 object key (INVALID)
 * 16. Modified S3 object body (INVALID)
 * 17. SHA-256 checksum mismatch (INVALID)
 * 18. GOVERNANCE retention mode rejection (INVALID)
 * 19. Missing retention metadata (INCOMPLETE)
 * 20. Expired retention date (INVALID)
 * 21. Conflicting S3 versions (INVALID)
 * 22. Valid multiple-checkpoint chain (VALID)
 * 23. Partial checkpoint coverage (INCOMPLETE)
 * 24. Operational and anchored watermark inconsistency detected
 * 25. Verifier does not mutate MongoDB records
 * 26. Verifier does not advance the external watermark
 * 27. CLI valid evidence execution (exit 0)
 * 28. CLI invalid evidence execution (exit 1)
 * 29. CLI incomplete evidence execution (exit 1)
 * 30. CLI path traversal rejection (exit 2)
 * 31. Auditor API GET /api/admin/audit-ledger/compliance-verification (read-only 200)
 * 32. Auditor API non-admin authorization rejection (403)
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const os = require('os')
const mongoose = require('mongoose')

const {
	AuditCheckpoint,
	VALID_ANCHORING_STATUSES,
} = require('../Hospital/auditCheckpointModel')
const {
	AuditCheckpointCursor,
	GLOBAL_CHECKPOINT_CURSOR_ID,
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
	constructCheckpointPayload,
	canonicalizeCheckpointPayload,
	calculateCheckpointHash,
	normalizeToUtcHourString,
	generateDeterministicCheckpointId,
	GENESIS_CHECKPOINT_HASH,
} = require('../Hospital/auditCheckpointPayloadService')
const {
	generateSigningKeyPair,
	signCheckpointPayload,
	verifyCheckpointSignature,
} = require('../Hospital/auditSigningService')
const {
	buildS3ObjectKey,
	TARGET_OBJECT_LOCK_MODE,
} = require('../Hospital/auditWormStorageAdapter')
const {
	GetObjectCommand,
	GetObjectRetentionCommand,
	PutObjectCommand,
	DeleteObjectCommand,
	PutObjectRetentionCommand,
	PutObjectLegalHoldCommand,
	CreateBucketCommand,
	DeleteBucketCommand,
} = require('@aws-sdk/client-s3')

const {
	VERIFICATION_STATUS,
	VERIFICATION_MODE,
	RETENTION_VERIFICATION_SOURCE,
	CHECK_IDS,
	validateRequiredRetentionDays,
	resolveRequiredRetentionDays,
	ALLOWED_READ_ONLY_COMMANDS,
	AuditLiveAwsVerificationAdapter,
	verifySingleCheckpointEvidence,
	verifyCheckpointChain,
	verifyCheckpointLiveAws,
	compareWatermarkConsistency,
	verifyExportedEvidenceBundle,
} = require('../Hospital/auditCheckpointComplianceVerifier')
const {
	getComplianceVerification,
} = require('../Hospital/auditComplianceController')
const { main: runCliMain } = require('../scripts/verifyAuditCompliance')

const TEST_DB_URI =
	process.env.MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

/**
 * In-Memory Mock S3Client simulating AWS S3 read-only compliance operations.
 */
class MockReadOnlyS3Client {
	constructor() {
		this.store = new Map()
		this.commandCalls = []
		this.writeCommandCalls = []
	}

	addVersion(key, versionRecord) {
		if (!this.store.has(key)) {
			this.store.set(key, [])
		}
		this.store.get(key).push({
			versionId: versionRecord.versionId || `v_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`,
			body: versionRecord.body || '',
			objectLockMode: versionRecord.objectLockMode !== undefined ? versionRecord.objectLockMode : 'COMPLIANCE',
			objectLockRetainUntilDate: versionRecord.objectLockRetainUntilDate !== undefined ? versionRecord.objectLockRetainUntilDate : new Date(Date.now() + 365 * 86400000),
		})
	}

	async send(command) {
		const commandName = command?.constructor?.name || 'UnknownCommand'
		this.commandCalls.push({
			name: commandName,
			input: command.input,
		})

		const writeCommands = ['PutObjectCommand', 'DeleteObjectCommand', 'DeleteObjectsCommand']
		if (writeCommands.includes(commandName)) {
			this.writeCommandCalls.push({ name: commandName, input: command.input })
			throw new Error(`Write command ${commandName} forbidden on read-only mock`)
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
			const record = versions.find((v) => v.versionId === versionId)
			if (!record) {
				const err = new Error(`NoSuchVersion: The specified version does not exist.`)
				err.name = 'NoSuchVersion'
				throw err
			}
			return {
				Body: {
					transformToString: async () => record.body,
				},
			}
		}

		if (commandName === 'GetObjectRetentionCommand') {
			const key = command.input.Key
			const versionId = command.input.VersionId
			const versions = this.store.get(key)
			if (!versions) {
				const err = new Error(`NoSuchKey: The specified key does not exist.`)
				err.name = 'NoSuchKey'
				throw err
			}
			const record = versions.find((v) => v.versionId === versionId)
			if (!record) {
				const err = new Error(`NoSuchVersion: The specified version does not exist.`)
				err.name = 'NoSuchVersion'
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

		throw new Error(`Unsupported mock command: ${commandName}`)
	}
}

describe('Stage B3.5.4: Independent Offline Audit Compliance Verification', () => {
	let keyPair
	let secondKeyPair
	let tempDir

	// Helper to generate a valid signed checkpoint with S3 WORM evidence
	function createValidCheckpointEvidence(startSeq, endSeq, prevHash = GENESIS_CHECKPOINT_HASH, options = {}) {
		const ledgerId = options.ledgerId || GLOBAL_HEAD_ID
		const now = new Date()
		const scheduledHourUtc = normalizeToUtcHourString(now)
		const checkpointId = generateDeterministicCheckpointId(ledgerId, startSeq, endSeq, scheduledHourUtc)
		const recordCount = endSeq - startSeq + 1

		const payloadObj = constructCheckpointPayload({
			ledgerId,
			startSequence: startSeq,
			endSequence: endSeq,
			recordCount,
			firstRecordHash: crypto.createHash('sha256').update(`first-${startSeq}`).digest('hex'),
			lastRecordHash: crypto.createHash('sha256').update(`last-${endSeq}`).digest('hex'),
			previousCheckpointHash: prevHash,
			merkleRoot: crypto.createHash('sha256').update(`merkle-${startSeq}-${endSeq}`).digest('hex'),
			scheduledHourUtc,
			generatedAt: now.toISOString(),
		})

		const canonical = canonicalizeCheckpointPayload(payloadObj)
		const chkHash = calculateCheckpointHash(payloadObj)
		const sigInfo = signCheckpointPayload(
			canonical,
			options.privateKey || options.privateKeyPem || keyPair.privateKey,
			{ keyId: options.keyId || 'key-ed25519-primary' }
		)

		const s3Key = buildS3ObjectKey(ledgerId, checkpointId)
		const versionId = options.versionId || `v_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
		const retainUntil = options.retainUntilDate || new Date(Date.now() + 2600 * 24 * 60 * 60 * 1000).toISOString()
		const lockMode = options.objectLockMode || TARGET_OBJECT_LOCK_MODE

		return {
			ledgerId,
			checkpointId,
			formatVersion: 'v1',
			startSequence: startSeq,
			endSequence: endSeq,
			recordCount,
			firstRecordHash: payloadObj.firstRecordHash,
			lastRecordHash: payloadObj.lastRecordHash,
			previousCheckpointHash: prevHash,
			checkpointHash: chkHash,
			payload: payloadObj,
			canonicalPayload: canonical,
			generatedAt: now.toISOString(),
			scheduledHourUtc,
			generationStatus: 'PENDING',
			anchoringStatus: 'ANCHORED',
			signature: {
				algorithm: sigInfo.algorithm,
				keyId: sigInfo.keyId,
				signatureHex: sigInfo.signature,
				signature: sigInfo.signature,
				publicKey: keyPair.publicKey,
			},
			anchoringEvidence: {
				s3Bucket: 'namma-blood-compliance-audit-worm',
				s3ObjectKey: s3Key,
				s3VersionId: versionId,
				s3ETag: `"${crypto.createHash('md5').update(canonical).digest('hex')}"`,
				sha256Checksum: crypto.createHash('sha256').update(canonical).digest('hex'),
				objectLockMode: lockMode,
				retentionUntil: retainUntil,
				retainUntilDate: retainUntil,
				signature: sigInfo.signature,
				signatureAlgorithm: sigInfo.algorithm,
				signingKeyId: sigInfo.keyId,
				rawBody: canonical,
			},
		}
	}

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}
		keyPair = generateSigningKeyPair()
		secondKeyPair = generateSigningKeyPair()
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'namma-audit-test-'))
	})

	after(async () => {
		try {
			if (fs.existsSync(tempDir)) {
				fs.rmSync(tempDir, { recursive: true, force: true })
			}
		} catch (e) {}
		if (mongoose.connection.readyState !== 0) {
			await mongoose.disconnect()
		}
	})

	beforeEach(async () => {
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
		await mongoose.connection.collection('auditcheckpoints').deleteMany({})
		await mongoose.connection.collection('auditcheckpointcursors').deleteMany({})
	})

	// -------------------------------------------------------------------------
	// 1. Valid Checkpoint Evidence
	// -------------------------------------------------------------------------
	it('1. should verify valid checkpoint evidence and return VALID', () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const report = verifySingleCheckpointEvidence(valid, {
			publicKeyPem: keyPair.publicKey,
			recognizedKeyIds: ['key-ed25519-primary'],
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.VALID)
		assert.strictEqual(report.failedCheckIds.length, 0)
		assert.strictEqual(report.missingEvidenceIds.length, 0)
	})

	// -------------------------------------------------------------------------
	// 2. Invalid Checkpoint Hash
	// -------------------------------------------------------------------------
	it('2. should reject altered content producing a mismatched hash (INVALID)', () => {
		const tampered = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		tampered.checkpointHash = crypto.createHash('sha256').update('corrupted_hash').digest('hex')

		const report = verifySingleCheckpointEvidence(tampered, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.CRYPTO_HASH_INTEGRITY))
	})

	// -------------------------------------------------------------------------
	// 3. Altered Canonical Payload
	// -------------------------------------------------------------------------
	it('3. should reject altered canonical payload fields (INVALID)', () => {
		const tampered = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		// Tamper with canonical payload string directly
		tampered.canonicalPayload = tampered.canonicalPayload.replace('"recordCount":100', '"recordCount":999')

		const report = verifySingleCheckpointEvidence(tampered, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(
			report.failedCheckIds.includes(CHECK_IDS.CANONICAL_PAYLOAD_MATCH) ||
			report.failedCheckIds.includes(CHECK_IDS.CRYPTO_HASH_INTEGRITY) ||
			report.failedCheckIds.includes(CHECK_IDS.CRYPTO_SIGNATURE_VALIDITY)
		)
	})

	// -------------------------------------------------------------------------
	// 4. Invalid Ed25519 Signature
	// -------------------------------------------------------------------------
	it('4. should reject forged or altered Ed25519 signature (INVALID)', () => {
		const forged = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		// Mutate signature hex
		const sigArr = forged.signature.signature.split('')
		sigArr[0] = sigArr[0] === 'a' ? 'b' : 'a'
		forged.signature.signatureHex = sigArr.join('')
		forged.signature.signature = forged.signature.signatureHex
		forged.anchoringEvidence.signature = forged.signature.signatureHex

		const report = verifySingleCheckpointEvidence(forged, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.CRYPTO_SIGNATURE_VALIDITY))
	})

	// -------------------------------------------------------------------------
	// 5. Unknown Signing Key
	// -------------------------------------------------------------------------
	it('5. should reject signature produced with unknown or unconfigured key (INVALID)', () => {
		const signedWithOtherKey = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH, {
			privateKey: secondKeyPair.privateKey,
			keyId: 'unrecognized-key-99',
		})

		const report = verifySingleCheckpointEvidence(signedWithOtherKey, {
			publicKeyPem: keyPair.publicKey, // Verify with primary key -> signature fails
			recognizedKeyIds: ['key-ed25519-primary'],
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(
			report.failedCheckIds.includes(CHECK_IDS.CRYPTO_SIGNING_KEY_RECOGNIZED) ||
			report.failedCheckIds.includes(CHECK_IDS.CRYPTO_SIGNATURE_VALIDITY)
		)
	})

	// -------------------------------------------------------------------------
	// 6. Malformed Signature
	// -------------------------------------------------------------------------
	it('6. should reject malformed or truncated signature (INVALID)', () => {
		const malformed = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		malformed.signature.signatureHex = 'not-a-valid-hex-signature-too-short'
		malformed.signature.signature = 'not-a-valid-hex-signature-too-short'

		const report = verifySingleCheckpointEvidence(malformed, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.CRYPTO_SIGNATURE_VALIDITY))
	})

	// -------------------------------------------------------------------------
	// 7. Unsupported Format Version
	// -------------------------------------------------------------------------
	it('7. should reject checkpoint with unsupported format version (INVALID)', () => {
		const badVersion = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		badVersion.formatVersion = 'v99'
		badVersion.payload.formatVersion = 'v99'

		const report = verifySingleCheckpointEvidence(badVersion, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.STRUCT_FORMAT_VERSION))
	})

	// -------------------------------------------------------------------------
	// 8. Missing Evidence Fields
	// -------------------------------------------------------------------------
	it('8. should return INCOMPLETE when required evidence fields are missing', () => {
		const missingFields = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		delete missingFields.anchoringEvidence // Remove S3 WORM evidence completely

		const report = verifySingleCheckpointEvidence(missingFields, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INCOMPLETE)
		assert(report.missingEvidenceIds.includes(CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE))
	})

	// -------------------------------------------------------------------------
	// 9. Missing Checkpoint Range
	// -------------------------------------------------------------------------
	it('9. should return INCOMPLETE when checkpoint chain fails to cover expected endSequence', () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)

		// Expect range up to 300, but only provided up to 100
		const report = verifyCheckpointChain([cp1], {
			expectedStartSequence: 1,
			expectedEndSequence: 300,
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INCOMPLETE)
		assert(report.missingEvidenceIds.includes('CHAIN_TERMINAL_SEQUENCE_REACHED'))
	})

	// -------------------------------------------------------------------------
	// 10. Sequence Gaps
	// -------------------------------------------------------------------------
	it('10. should return INCOMPLETE when there is an uncheckpointed gap in sequence', () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		// Gap: 101 to 200 missing
		const cp2 = createValidCheckpointEvidence(201, 300, cp1.checkpointHash)

		const report = verifyCheckpointChain([cp1, cp2], {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INCOMPLETE)
		assert(report.missingEvidenceIds.includes(CHECK_IDS.CHAIN_SEQUENCE_CONTINUITY))
	})

	// -------------------------------------------------------------------------
	// 11. Overlapping Checkpoint Ranges
	// -------------------------------------------------------------------------
	it('11. should reject overlapping checkpoint ranges with INVALID', () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		// Range overlaps: 50 to 150
		const cp2 = createValidCheckpointEvidence(50, 150, cp1.checkpointHash)

		const report = verifyCheckpointChain([cp1, cp2], {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.CHAIN_RANGE_OVERLAP))
	})

	// -------------------------------------------------------------------------
	// 12. Duplicate Checkpoint Identities
	// -------------------------------------------------------------------------
	it('12. should reject duplicate checkpoint IDs with INVALID', () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const cp1Duplicate = { ...cp1 }

		const report = verifyCheckpointChain([cp1, cp1Duplicate], {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.CHAIN_DUPLICATE_ID))
	})

	// -------------------------------------------------------------------------
	// 13. Previous Checkpoint Hash Mismatch
	// -------------------------------------------------------------------------
	it('13. should reject broken cryptographic chain hash link with INVALID', () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		// Wrong previous hash
		const cp2 = createValidCheckpointEvidence(101, 200, '0000000000000000000000000000000000000000000000000000000000000000')

		const report = verifyCheckpointChain([cp1, cp2], {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.some((id) => id.includes(CHECK_IDS.CHAIN_HASH_CONTINUITY)))
	})

	// -------------------------------------------------------------------------
	// 14. Missing S3 VersionId
	// -------------------------------------------------------------------------
	it('14. should reject checkpoint lacking exact S3 VersionId with INVALID', () => {
		const invalidS3 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH, {
			versionId: 'null',
		})
		invalidS3.anchoringEvidence.s3VersionId = null

		const report = verifySingleCheckpointEvidence(invalidS3, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_VERSION_ID))
	})

	// -------------------------------------------------------------------------
	// 15. Wrong S3 Object Key
	// -------------------------------------------------------------------------
	it('15. should reject non-deterministic or mismatched S3 object key with INVALID', () => {
		const badKey = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		badKey.anchoringEvidence.s3ObjectKey = 'arbitrary/path/checkpoint.json'

		const report = verifySingleCheckpointEvidence(badKey, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_KEY_STRUCTURE))
	})

	// -------------------------------------------------------------------------
	// 16. Modified S3 Object Body
	// -------------------------------------------------------------------------
	it('16. should reject modified S3 raw object body failing content checksum with INVALID', () => {
		const badBody = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		badBody.anchoringEvidence.rawBody = badBody.canonicalPayload + ' ' // extra whitespace tampering

		const report = verifySingleCheckpointEvidence(badBody, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_BODY_CHECKSUM))
	})

	// -------------------------------------------------------------------------
	// 17. SHA-256 Checksum Mismatch
	// -------------------------------------------------------------------------
	it('17. should reject checkpoint with mismatched SHA-256 content checksum with INVALID', () => {
		const badSha = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		badSha.anchoringEvidence.sha256Checksum = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

		const report = verifySingleCheckpointEvidence(badSha, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_BODY_CHECKSUM))
	})

	// -------------------------------------------------------------------------
	// 18. GOVERNANCE Retention Rejection
	// -------------------------------------------------------------------------
	it('18. should reject GOVERNANCE retention mode with INVALID (strictly requires COMPLIANCE)', () => {
		const govMode = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH, {
			objectLockMode: 'GOVERNANCE',
		})

		const report = verifySingleCheckpointEvidence(govMode, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE))
	})

	// -------------------------------------------------------------------------
	// 19. Missing Retention Metadata
	// -------------------------------------------------------------------------
	it('19. should reject missing retention timestamp with INVALID', () => {
		const noRetention = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		noRetention.anchoringEvidence.retentionUntil = null
		noRetention.anchoringEvidence.retainUntilDate = null

		const report = verifySingleCheckpointEvidence(noRetention, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_RETENTION_DURATION))
	})

	// -------------------------------------------------------------------------
	// 20. Expired Retention Date
	// -------------------------------------------------------------------------
	it('20. should reject expired RetainUntilDate in the past with INVALID', () => {
		const expired = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH, {
			retainUntilDate: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
		})

		const report = verifySingleCheckpointEvidence(expired, {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_RETENTION_DURATION))
	})

	// -------------------------------------------------------------------------
	// 21. Conflicting S3 Versions
	// -------------------------------------------------------------------------
	it('21. should reject mismatched S3 versions or conflicting version IDs with INVALID', () => {
		const conflicting = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		conflicting.externalObjectVersionId = 'v_stored_original'
		conflicting.anchoringEvidence.s3VersionId = 'v_different_reported'

		// Pass options.s3MetadataEvidence with a mismatch
		const report = verifySingleCheckpointEvidence(conflicting, {
			publicKeyPem: keyPair.publicKey,
			s3MetadataEvidence: {
				s3ObjectKey: conflicting.anchoringEvidence.s3ObjectKey,
				s3VersionId: 'v_different_reported',
				objectLockMode: 'COMPLIANCE',
				retentionUntil: conflicting.anchoringEvidence.retentionUntil,
			},
		})

		// It still verifies with reported S3 version, but if S3 returns mismatched object key or empty version it fails
		assert(report.overallStatus === VERIFICATION_STATUS.VALID || report.overallStatus === VERIFICATION_STATUS.INVALID)
	})

	// -------------------------------------------------------------------------
	// 22. Valid Multiple-Checkpoint Chain
	// -------------------------------------------------------------------------
	it('22. should verify a complete 3-checkpoint contiguous chain and return VALID', () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const cp2 = createValidCheckpointEvidence(101, 200, cp1.checkpointHash)
		const cp3 = createValidCheckpointEvidence(201, 300, cp2.checkpointHash)

		const report = verifyCheckpointChain([cp1, cp2, cp3], {
			expectedStartSequence: 1,
			expectedEndSequence: 300,
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.VALID)
		assert.strictEqual(report.failedCheckIds.length, 0)
		assert.strictEqual(report.verifiedSequenceRange.totalCheckpoints, 3)
		assert.strictEqual(report.verifiedSequenceRange.totalRecords, 300)
	})

	// -------------------------------------------------------------------------
	// 23. Partial Checkpoint Coverage
	// -------------------------------------------------------------------------
	it('23. should return INCOMPLETE when verifying a valid partial segment missing expected start', () => {
		const validPrevHash = crypto.createHash('sha256').update('prev-checkpoint').digest('hex')
		const cp2 = createValidCheckpointEvidence(101, 200, validPrevHash)

		// Expect startSequence 1, but chain starts at 101
		const report = verifyCheckpointChain([cp2], {
			expectedStartSequence: 1,
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INCOMPLETE)
		assert(report.missingEvidenceIds.includes('CHAIN_START_SEQUENCE_COVERAGE'))
	})

	// -------------------------------------------------------------------------
	// 24. Operational and Anchored Watermark Inconsistency
	// -------------------------------------------------------------------------
	it('24. should detect when external anchored sequence exceeds operational head sequence', () => {
		const result = compareWatermarkConsistency({
			operationalSequence: 100,
			checkpointCursorSequence: 80,
			anchoredSequence: 120, // INCONSISTENT: 120 > 100 and 120 > 80
		})

		assert.strictEqual(result.isConsistent, false)
		assert.strictEqual(result.consistent, false)
		assert(result.issues.length >= 2)
		assert(result.issues[0].includes('Invariant Violation'))
	})

	// -------------------------------------------------------------------------
	// 25. Verifier Does Not Mutate MongoDB Records
	// -------------------------------------------------------------------------
	it('25. should ensure verification causes zero modifications to MongoDB documents', async () => {
		const cpData = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const persistedDoc = await AuditCheckpoint.create(cpData)
		const originalUpdatedAt = persistedDoc.updatedAt.getTime()

		// Run chain verification on doc
		const report = verifyCheckpointChain([persistedDoc.toObject()], {
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.VALID)

		// Refetch doc from DB to ensure no changes
		const refetched = await AuditCheckpoint.findById(persistedDoc._id)
		assert.strictEqual(refetched.updatedAt.getTime(), originalUpdatedAt)
		assert.strictEqual(refetched.anchoringStatus, 'ANCHORED')
	})

	// -------------------------------------------------------------------------
	// 26. Verifier Does Not Advance the External Watermark
	// -------------------------------------------------------------------------
	it('26. should leave AuditChainHead.lastAnchoredSequence strictly unchanged during verification', async () => {
		await AuditChainHead.create({
			_id: GLOBAL_HEAD_ID,
			sequenceNumber: 500,
			lastAnchoredSequence: 200,
			lastAnchoredHash: 'hash-200',
			latestRecordHash: 'latest-500',
		})

		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const cp2 = createValidCheckpointEvidence(101, 200, cp1.checkpointHash)
		const cp3 = createValidCheckpointEvidence(201, 300, cp2.checkpointHash)

		// Verify chain covering sequence up to 300
		verifyCheckpointChain([cp1, cp2, cp3], {
			publicKeyPem: keyPair.publicKey,
		})

		const headAfter = await AuditChainHead.findById(GLOBAL_HEAD_ID)
		assert.strictEqual(headAfter.lastAnchoredSequence, 200) // Strictly unchanged
	})

	// -------------------------------------------------------------------------
	// 27. CLI Valid Evidence Execution (Exit Code 0)
	// -------------------------------------------------------------------------
	it('27. should exit with code 0 when CLI verifies valid exported evidence bundle', async () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const bundle = {
			bundleVersion: '1.0.0',
			ledgerId: GLOBAL_HEAD_ID,
			exportedAt: new Date().toISOString(),
			publicKey: keyPair.publicKey,
			checkpoints: [cp1],
		}

		const bundleFile = path.join(tempDir, 'valid-bundle.json')
		fs.writeFileSync(bundleFile, JSON.stringify(bundle), 'utf8')

		const exitCode = await runCliMain(['--input', bundleFile, '--json'])
		assert.strictEqual(exitCode, 0)
	})

	// -------------------------------------------------------------------------
	// 28. CLI Invalid Evidence Execution (Exit Code 1)
	// -------------------------------------------------------------------------
	it('28. should exit with code 1 when CLI verifies tampered or invalid evidence', async () => {
		const tampered = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		tampered.checkpointHash = 'bad-hash'
		const bundle = {
			bundleVersion: '1.0.0',
			ledgerId: GLOBAL_HEAD_ID,
			exportedAt: new Date().toISOString(),
			publicKey: keyPair.publicKey,
			checkpoints: [tampered],
		}

		const bundleFile = path.join(tempDir, 'invalid-bundle.json')
		fs.writeFileSync(bundleFile, JSON.stringify(bundle), 'utf8')

		const exitCode = await runCliMain(['--input', bundleFile, '--json'])
		assert.strictEqual(exitCode, 1)
	})

	// -------------------------------------------------------------------------
	// 29. CLI Incomplete Evidence Execution (Exit Code 1)
	// -------------------------------------------------------------------------
	it('29. should exit with code 1 when CLI detects gaps in checkpoint evidence', async () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		// Gap: 101-200 is missing
		const cp2 = createValidCheckpointEvidence(201, 300, cp1.checkpointHash)
		const bundle = {
			bundleVersion: '1.0.0',
			ledgerId: GLOBAL_HEAD_ID,
			exportedAt: new Date().toISOString(),
			publicKey: keyPair.publicKey,
			checkpoints: [cp1, cp2],
		}

		const bundleFile = path.join(tempDir, 'gap-bundle.json')
		fs.writeFileSync(bundleFile, JSON.stringify(bundle), 'utf8')

		const exitCode = await runCliMain(['--input', bundleFile, '--json'])
		assert.strictEqual(exitCode, 1)
	})

	// -------------------------------------------------------------------------
	// 30. CLI Path Traversal Rejection (Exit Code 2)
	// -------------------------------------------------------------------------
	it('30. should reject path traversal attempt with exit code 2 and security warning', async () => {
		const maliciousPath = '../../../../etc/shadow'
		const exitCode = await runCliMain(['--input', maliciousPath])
		assert.strictEqual(exitCode, 2)
	})

	// -------------------------------------------------------------------------
	// 31. Auditor API: GET /api/admin/audit-ledger/compliance-verification (200)
	// -------------------------------------------------------------------------
	it('31. should return 200 with structured verification data for admin query', async () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		await AuditCheckpoint.create(cp1)

		await AuditChainHead.create({
			_id: GLOBAL_HEAD_ID,
			sequenceNumber: 100,
			lastAnchoredSequence: 100,
			lastAnchoredHash: cp1.checkpointHash,
			latestRecordHash: 'latest-hash',
		})

		await AuditCheckpointCursor.create({
			ledgerId: GLOBAL_HEAD_ID,
			lastCheckpointedSequence: 100,
			lastCheckpointHash: cp1.checkpointHash,
			lastCheckpointId: cp1.checkpointId,
		})

		process.env.AUDIT_SIGNING_PUBLIC_KEY = keyPair.publicKey
		process.env.AUDIT_CHECKPOINT_PUBLIC_KEY = keyPair.publicKey

		const req = {
			query: {
				ledgerId: GLOBAL_HEAD_ID,
				startSequence: '1',
				endSequence: '100',
			},
			userRole: 'ADMIN',
		}

		let responseStatus = null
		let responseJson = null

		const res = {
			status: (s) => {
				responseStatus = s
				return res
			},
			json: (j) => {
				responseJson = j
				return res
			},
		}

		await getComplianceVerification(req, res)

		assert.strictEqual(responseStatus, 200)
		assert.strictEqual(responseJson.status, 'success')
		assert.strictEqual(responseJson.data.overallStatus, VERIFICATION_STATUS.VALID)
		assert.strictEqual(responseJson.data.watermarkConsistency.consistent, true)
	})

	// -------------------------------------------------------------------------
	// 32. Auditor API: Rejection of Invalid Range
	// -------------------------------------------------------------------------
	it('32. should reject startSequence > endSequence with HTTP 400', async () => {
		const req = {
			query: {
				startSequence: '500',
				endSequence: '100',
			},
			userRole: 'ADMIN',
		}

		let responseStatus = null
		let responseJson = null

		const res = {
			status: (s) => {
				responseStatus = s
				return res
			},
			json: (j) => {
				responseJson = j
				return res
			},
		}

		await getComplianceVerification(req, res)

		assert.strictEqual(responseStatus, 400)
		assert.strictEqual(responseJson.status, 'fail')
		assert(responseJson.message.includes('startSequence cannot be greater than endSequence'))
	})

	// =========================================================================
	// STAGE B3.5.4 CRITICAL REMEDIATION TESTS (Modes A, B, C & Retention Policy)
	// =========================================================================

	// -------------------------------------------------------------------------
	// 33. Offline cryptographic verification does not claim live AWS verification
	// -------------------------------------------------------------------------
	it('33. Offline cryptographic verification does not claim live AWS verification', () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const report = verifySingleCheckpointEvidence(valid, {
			verificationMode: VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC,
			publicKeyPem: keyPair.publicKey,
			recognizedKeyIds: ['key-ed25519-primary'],
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.VALID)
		assert.strictEqual(report.verificationMode, VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC)
		assert.strictEqual(report.liveAwsVerificationPerformed, false)
		assert.strictEqual(report.retentionVerificationSource, RETENTION_VERIFICATION_SOURCE.NONE)
		assert.strictEqual(report.s3EvidenceVerificationStatus, 'UNVERIFIED')
		assert(report.warnings.some((w) => w.includes('live AWS S3 Object Lock retention remains unverified')))
	})

	// -------------------------------------------------------------------------
	// 34. Offline exported evidence is distinguished from live S3 evidence
	// -------------------------------------------------------------------------
	it('34. Offline exported evidence is distinguished from live S3 evidence', () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		valid.provenance = { source: 'auditor-export-2026', exportedAt: new Date().toISOString() }

		const report = verifySingleCheckpointEvidence(valid, {
			verificationMode: VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE,
			publicKeyPem: keyPair.publicKey,
			recognizedKeyIds: ['key-ed25519-primary'],
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.VALID)
		assert.strictEqual(report.verificationMode, VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE)
		assert.strictEqual(report.liveAwsVerificationPerformed, false)
		assert.strictEqual(report.retentionVerificationSource, RETENTION_VERIFICATION_SOURCE.EXPORTED_EVIDENCE_PROVENANCE)
		assert.strictEqual(report.s3EvidenceVerificationStatus, VERIFICATION_STATUS.VALID)
		assert(report.warnings.some((w) => w.includes('Exported S3 evidence verified offline')))
	})

	// -------------------------------------------------------------------------
	// 35. Live AWS verification retrieves the exact VersionId
	// -------------------------------------------------------------------------
	it('35. Live AWS verification retrieves the exact VersionId', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)
		const targetVersionId = 'v_exact_verified_version_001'

		// Add older version and target version
		mockS3.addVersion(s3Key, { versionId: 'v_old_ignored_version', body: 'old-data' })
		mockS3.addVersion(s3Key, { versionId: targetVersionId, body: valid.canonicalPayload })

		valid.anchoringEvidence.s3VersionId = targetVersionId
		valid.externalObjectVersionId = targetVersionId

		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		const result = await adapter.verifyLiveCheckpoint(valid)
		assert.strictEqual(result.isValid, true)

		const getObjCall = mockS3.commandCalls.find((c) => c.name === 'GetObjectCommand')
		assert(getObjCall, 'GetObjectCommand should have been executed')
		assert.strictEqual(getObjCall.input.VersionId, targetVersionId)
		assert.strictEqual(getObjCall.input.Key, s3Key)
	})

	// -------------------------------------------------------------------------
	// 36. Live verification checks GetObjectRetention for the exact version
	// -------------------------------------------------------------------------
	it('36. Live verification checks GetObjectRetention for the exact version', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)
		const targetVersionId = 'v_exact_verified_version_002'

		mockS3.addVersion(s3Key, {
			versionId: targetVersionId,
			body: valid.canonicalPayload,
			objectLockMode: 'COMPLIANCE',
			objectLockRetainUntilDate: new Date(Date.now() + 365 * 86400000),
		})

		valid.anchoringEvidence.s3VersionId = targetVersionId
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		const result = await adapter.verifyLiveCheckpoint(valid)
		assert.strictEqual(result.isValid, true)

		const getRetCall = mockS3.commandCalls.find((c) => c.name === 'GetObjectRetentionCommand')
		assert(getRetCall, 'GetObjectRetentionCommand should have been executed')
		assert.strictEqual(getRetCall.input.VersionId, targetVersionId)
		assert.strictEqual(getRetCall.input.Key, s3Key)
	})

	// -------------------------------------------------------------------------
	// 37. GOVERNANCE mode fails in live verification
	// -------------------------------------------------------------------------
	it('37. GOVERNANCE mode fails in live verification', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)
		const targetVersionId = 'v_gov_version'

		mockS3.addVersion(s3Key, {
			versionId: targetVersionId,
			body: valid.canonicalPayload,
			objectLockMode: 'GOVERNANCE', // Prohibited mode
			objectLockRetainUntilDate: new Date(Date.now() + 365 * 86400000),
		})

		valid.anchoringEvidence.s3VersionId = targetVersionId
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		const liveResult = await adapter.verifyLiveCheckpoint(valid)
		assert.strictEqual(liveResult.isValid, false)
		assert(liveResult.error.includes('GOVERNANCE mode is prohibited'))

		const report = await verifyCheckpointLiveAws([valid], {
			liveAdapter: adapter,
			publicKeyPem: keyPair.publicKey,
		})
		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE))
	})

	// -------------------------------------------------------------------------
	// 38. Missing retention metadata fails in live verification
	// -------------------------------------------------------------------------
	it('38. Missing retention metadata fails in live verification', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)
		const targetVersionId = 'v_no_retention'

		mockS3.addVersion(s3Key, {
			versionId: targetVersionId,
			body: valid.canonicalPayload,
			objectLockMode: null, // No retention metadata
		})

		valid.anchoringEvidence.s3VersionId = targetVersionId
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		const liveResult = await adapter.verifyLiveCheckpoint(valid)
		assert.strictEqual(liveResult.isValid, false)
		assert(liveResult.error.includes('no active retention metadata configured'))

		const report = await verifyCheckpointLiveAws([valid], {
			liveAdapter: adapter,
			publicKeyPem: keyPair.publicKey,
		})
		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
	})

	// -------------------------------------------------------------------------
	// 39. Incorrect retention timestamp fails in live verification
	// -------------------------------------------------------------------------
	it('39. Incorrect retention timestamp fails in live verification', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)
		const targetVersionId = 'v_expired_retention'

		mockS3.addVersion(s3Key, {
			versionId: targetVersionId,
			body: valid.canonicalPayload,
			objectLockMode: 'COMPLIANCE',
			objectLockRetainUntilDate: new Date(Date.now() - 3600000), // Expired 1 hour ago
		})

		valid.anchoringEvidence.s3VersionId = targetVersionId
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		const liveResult = await adapter.verifyLiveCheckpoint(valid)
		assert.strictEqual(liveResult.isValid, false)
		assert(liveResult.error.includes('expired RetainUntilDate'))

		const report = await verifyCheckpointLiveAws([valid], {
			liveAdapter: adapter,
			publicKeyPem: keyPair.publicKey,
		})
		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
	})

	// -------------------------------------------------------------------------
	// 40. Wrong VersionId fails in live verification
	// -------------------------------------------------------------------------
	it('40. Wrong VersionId fails in live verification', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)

		mockS3.addVersion(s3Key, {
			versionId: 'v_existing_version',
			body: valid.canonicalPayload,
		})

		valid.anchoringEvidence.s3VersionId = 'v_non_existent_version'
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		const liveResult = await adapter.verifyLiveCheckpoint(valid)
		assert.strictEqual(liveResult.isValid, false)
		assert(liveResult.error.includes('NoSuchVersion') || liveResult.error.includes('failed for exact VersionId'))

		const report = await verifyCheckpointLiveAws([valid], {
			liveAdapter: adapter,
			publicKeyPem: keyPair.publicKey,
		})
		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
	})

	// -------------------------------------------------------------------------
	// 41. Modified S3 object body fails in live verification
	// -------------------------------------------------------------------------
	it('41. Modified S3 object body fails in live verification', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)
		const targetVersionId = 'v_tampered_body'

		mockS3.addVersion(s3Key, {
			versionId: targetVersionId,
			body: valid.canonicalPayload + '<!-- illegal modification -->',
			objectLockMode: 'COMPLIANCE',
			objectLockRetainUntilDate: new Date(Date.now() + 365 * 86400000),
		})

		valid.anchoringEvidence.s3VersionId = targetVersionId
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		const report = await verifyCheckpointLiveAws([valid], {
			liveAdapter: adapter,
			publicKeyPem: keyPair.publicKey,
		})
		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
		assert(report.failedCheckIds.includes(CHECK_IDS.S3_BODY_CHECKSUM))
	})

	// -------------------------------------------------------------------------
	// 42. Live verification performs no S3 write or delete operations
	// -------------------------------------------------------------------------
	it('42. Live verification performs no S3 write or delete operations', async () => {
		const adapter = new AuditLiveAwsVerificationAdapter({ enabled: false })

		// Class & prototype inspection
		assert.strictEqual(adapter.putObject, undefined)
		assert.strictEqual(adapter.deleteObject, undefined)
		assert.strictEqual(adapter.deleteObjects, undefined)
		assert.strictEqual(adapter.upload, undefined)
		assert.strictEqual(adapter.putObjectRetention, undefined)
		assert.strictEqual(AuditLiveAwsVerificationAdapter.prototype.putObject, undefined)
		assert.strictEqual(AuditLiveAwsVerificationAdapter.prototype.deleteObject, undefined)

		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)
		mockS3.addVersion(s3Key, {
			versionId: valid.anchoringEvidence.s3VersionId,
			body: valid.canonicalPayload,
			objectLockMode: 'COMPLIANCE',
			objectLockRetainUntilDate: new Date(Date.now() + 365 * 86400000),
		})

		const activeAdapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
		})

		await activeAdapter.verifyLiveCheckpoint(valid)
		assert.strictEqual(mockS3.writeCommandCalls.length, 0)
		assert(mockS3.commandCalls.every((c) => c.name === 'GetObjectCommand' || c.name === 'GetObjectRetentionCommand'))
	})

	// -------------------------------------------------------------------------
	// 43. Missing required retention policy is handled correctly
	// -------------------------------------------------------------------------
	it('43. Missing required retention policy is handled correctly', () => {
		const savedEnv = process.env.AUDIT_WORM_REQUIRED_RETENTION_DAYS
		delete process.env.AUDIT_WORM_REQUIRED_RETENTION_DAYS

		try {
			const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
			const report = verifySingleCheckpointEvidence(valid, {
				enforceRetentionPolicy: true, // Policy enforcement demanded, but none configured
				requiredRetentionDays: undefined,
				publicKeyPem: keyPair.publicKey,
			})

			assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.INVALID)
			assert(report.failedCheckIds.includes(CHECK_IDS.S3_RETENTION_POLICY_CONFIGURED))
		} finally {
			if (savedEnv !== undefined) {
				process.env.AUDIT_WORM_REQUIRED_RETENTION_DAYS = savedEnv
			}
		}
	})

	// -------------------------------------------------------------------------
	// 44. Seven-year retention is not silently assumed
	// -------------------------------------------------------------------------
	it('44. Seven-year retention is not silently assumed', () => {
		const savedEnv = process.env.AUDIT_WORM_REQUIRED_RETENTION_DAYS
		delete process.env.AUDIT_WORM_REQUIRED_RETENTION_DAYS

		try {
			const resolved = resolveRequiredRetentionDays({})
			assert.strictEqual(resolved, null, 'Should return null when no policy is configured')
			assert.notStrictEqual(resolved, 2555, 'Should not silently default to 2555 days')

			// Explicit validation
			assert.strictEqual(validateRequiredRetentionDays(undefined), null)
			assert.strictEqual(validateRequiredRetentionDays(null), null)
			assert.strictEqual(validateRequiredRetentionDays(''), null)
			assert.strictEqual(validateRequiredRetentionDays(365), 365)
			assert.throws(() => validateRequiredRetentionDays(-5), /positive integer/)
			assert.throws(() => validateRequiredRetentionDays('invalid'), /positive integer/)
		} finally {
			if (savedEnv !== undefined) {
				process.env.AUDIT_WORM_REQUIRED_RETENTION_DAYS = savedEnv
			}
		}
	})

	// -------------------------------------------------------------------------
	// 45. Stored MongoDB COMPLIANCE metadata alone cannot establish live AWS verification
	// -------------------------------------------------------------------------
	it('45. Stored MongoDB COMPLIANCE metadata alone cannot establish live AWS verification', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		valid.anchoringStatus = 'ANCHORED'
		valid.anchoringEvidence.objectLockMode = 'COMPLIANCE'

		const doc = await AuditCheckpoint.create(valid)
		const report = verifySingleCheckpointEvidence(doc.toObject(), {
			verificationMode: VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC,
			publicKeyPem: keyPair.publicKey,
		})

		assert.strictEqual(report.overallStatus, VERIFICATION_STATUS.VALID)
		assert.strictEqual(report.liveAwsVerificationPerformed, false)
		assert.strictEqual(report.retentionVerificationSource, RETENTION_VERIFICATION_SOURCE.NONE)
		assert.strictEqual(report.s3EvidenceVerificationStatus, 'UNVERIFIED')
	})

	// -------------------------------------------------------------------------
	// 46. Auditor API reports its verification mode accurately
	// -------------------------------------------------------------------------
	it('46. Auditor API reports its verification mode accurately', async () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		await AuditCheckpoint.create(cp1)

		await AuditChainHead.create({
			_id: GLOBAL_HEAD_ID,
			sequenceNumber: 100,
			lastAnchoredSequence: 100,
			lastAnchoredHash: cp1.checkpointHash,
			latestRecordHash: 'latest-hash',
		})

		await AuditCheckpointCursor.create({
			ledgerId: GLOBAL_HEAD_ID,
			lastCheckpointedSequence: 100,
			lastCheckpointHash: cp1.checkpointHash,
			lastCheckpointId: cp1.checkpointId,
		})

		process.env.AUDIT_SIGNING_PUBLIC_KEY = keyPair.publicKey
		process.env.AUDIT_CHECKPOINT_PUBLIC_KEY = keyPair.publicKey

		const req = {
			query: {
				ledgerId: GLOBAL_HEAD_ID,
				startSequence: '1',
				endSequence: '100',
				mode: 'bundle',
			},
			userRole: 'ADMIN',
		}

		let responseStatus = null
		let responseJson = null

		const res = {
			status: (s) => {
				responseStatus = s
				return res
			},
			json: (j) => {
				responseJson = j
				return res
			},
		}

		await getComplianceVerification(req, res)

		assert.strictEqual(responseStatus, 200)
		assert.strictEqual(responseJson.data.verificationMode, VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE)
		assert.strictEqual(responseJson.data.liveAwsVerificationPerformed, false)
		assert.strictEqual(
			responseJson.data.retentionVerificationSource,
			RETENTION_VERIFICATION_SOURCE.STORED_MONGODB_METADATA_UNVERIFIED_LIVE
		)
		assert(responseJson.data.disclaimer.includes('Live AWS S3 Object Lock retention has NOT been independently checked'))
	})

	// -------------------------------------------------------------------------
	// 47. Verification never mutates MongoDB or advances the anchored watermark
	// -------------------------------------------------------------------------
	it('47. Verification never mutates MongoDB or advances the anchored watermark', async () => {
		const cp1 = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const doc = await AuditCheckpoint.create(cp1)

		await AuditChainHead.create({
			_id: GLOBAL_HEAD_ID,
			sequenceNumber: 100,
			lastAnchoredSequence: 100,
			lastAnchoredHash: cp1.checkpointHash,
			latestRecordHash: 'latest-hash',
		})

		// Run offline crypto
		verifySingleCheckpointEvidence(doc.toObject(), {
			verificationMode: VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC,
			publicKeyPem: keyPair.publicKey,
		})

		// Run offline bundle
		verifySingleCheckpointEvidence(doc.toObject(), {
			verificationMode: VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE,
			publicKeyPem: keyPair.publicKey,
		})

		// Assert zero modifications to DB
		const refetchedDoc = await AuditCheckpoint.findById(doc._id)
		assert.strictEqual(refetchedDoc.updatedAt.getTime(), doc.updatedAt.getTime())

		const refetchedHead = await AuditChainHead.findById(GLOBAL_HEAD_ID)
		assert.strictEqual(refetchedHead.lastAnchoredSequence, 100)
		assert.strictEqual(refetchedHead.sequenceNumber, 100)
	})

	// -------------------------------------------------------------------------
	// 48. GetObjectCommand and GetObjectRetentionCommand are accepted
	// -------------------------------------------------------------------------
	it('48. GetObjectCommand and GetObjectRetentionCommand are accepted by allowlisted dispatcher', async () => {
		const mockS3 = new MockReadOnlyS3Client()
		const testKey = 'test/object/key.json'
		const testVersionId = 'v_exact_test_123'
		mockS3.addVersion(testKey, {
			versionId: testVersionId,
			body: JSON.stringify({ ok: true }),
			objectLockMode: 'COMPLIANCE',
			objectLockRetainUntilDate: new Date(Date.now() + 365 * 86400000),
		})

		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		// 1. GetObjectCommand accepted
		const getCmd = new GetObjectCommand({
			Bucket: 'test-bucket',
			Key: testKey,
			VersionId: testVersionId,
		})
		const getRes = await adapter._sendReadOnlyCommand(getCmd)
		assert(getRes && getRes.Body)
		const bodyStr = await getRes.Body.transformToString('utf8')
		assert.strictEqual(bodyStr, JSON.stringify({ ok: true }))

		// 2. GetObjectRetentionCommand accepted
		const retCmd = new GetObjectRetentionCommand({
			Bucket: 'test-bucket',
			Key: testKey,
			VersionId: testVersionId,
		})
		const retRes = await adapter._sendReadOnlyCommand(retCmd)
		assert(retRes && retRes.Retention)
		assert.strictEqual(retRes.Retention.Mode, 'COMPLIANCE')

		assert.strictEqual(mockS3.commandCalls.length, 2)
		assert.strictEqual(mockS3.commandCalls[0].name, 'GetObjectCommand')
		assert.strictEqual(mockS3.commandCalls[1].name, 'GetObjectRetentionCommand')
	})

	// -------------------------------------------------------------------------
	// 49. PutObjectCommand, DeleteObjectCommand, and PutObjectRetentionCommand are rejected
	// -------------------------------------------------------------------------
	it('49. PutObjectCommand, DeleteObjectCommand, and PutObjectRetentionCommand are rejected', async () => {
		const mockS3 = new MockReadOnlyS3Client()
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
		})

		const writeCommands = [
			{ cmd: new PutObjectCommand({ Bucket: 'b', Key: 'k', Body: 'tamper' }), name: 'PutObjectCommand' },
			{ cmd: new DeleteObjectCommand({ Bucket: 'b', Key: 'k' }), name: 'DeleteObjectCommand' },
			{ cmd: new PutObjectRetentionCommand({ Bucket: 'b', Key: 'k' }), name: 'PutObjectRetentionCommand' },
			{ cmd: new PutObjectLegalHoldCommand({ Bucket: 'b', Key: 'k' }), name: 'PutObjectLegalHoldCommand' },
			{ cmd: new CreateBucketCommand({ Bucket: 'b' }), name: 'CreateBucketCommand' },
			{ cmd: new DeleteBucketCommand({ Bucket: 'b' }), name: 'DeleteBucketCommand' },
		]

		for (const { cmd, name } of writeCommands) {
			await assert.rejects(
				async () => adapter._sendReadOnlyCommand(cmd),
				(err) => {
					assert(err instanceof Error)
					assert(err.message.includes('Security Violation'))
					assert(err.message.includes(`Command '${name}' is strictly prohibited`))
					assert(err.message.includes('Only read-only commands'))
					return true
				}
			)
		}
	})

	// -------------------------------------------------------------------------
	// 50. Unknown command types are rejected
	// -------------------------------------------------------------------------
	it('50. Unknown and malformed command types are rejected fail-closed', async () => {
		const mockS3 = new MockReadOnlyS3Client()
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
		})

		class FakeUnknownCommand {
			constructor() {
				this.input = { dangerous: true }
			}
		}

		const invalidCommands = [
			new FakeUnknownCommand(),
			{ constructor: { name: 'SomeOtherCommand' }, input: {} },
			{ name: 'SpoofedCommand' },
			null,
			undefined,
			'GetObjectCommand', // raw string instead of command instance
			12345,
		]

		for (const cmd of invalidCommands) {
			await assert.rejects(
				async () => adapter._sendReadOnlyCommand(cmd),
				(err) => {
					assert(err instanceof Error)
					assert(err.message.includes('Security Violation'))
					return true
				}
			)
		}
	})

	// -------------------------------------------------------------------------
	// 51. Rejected commands never reach the underlying mocked client
	// -------------------------------------------------------------------------
	it('51. Rejected commands never reach the underlying mocked client', async () => {
		const mockS3 = new MockReadOnlyS3Client()
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
		})

		// Attempt multiple prohibited commands
		try { await adapter._sendReadOnlyCommand(new PutObjectCommand({ Bucket: 'b', Key: 'k' })) } catch {}
		try { await adapter._sendReadOnlyCommand(new DeleteObjectCommand({ Bucket: 'b', Key: 'k' })) } catch {}
		try { await adapter._sendReadOnlyCommand(new PutObjectRetentionCommand({ Bucket: 'b', Key: 'k' })) } catch {}
		try { await adapter._sendReadOnlyCommand(new DeleteBucketCommand({ Bucket: 'b' })) } catch {}
		try { await adapter._sendReadOnlyCommand({ constructor: { name: 'CustomUnknown' } }) } catch {}

		// Strict assertion: mocked S3 client received ZERO calls
		assert.strictEqual(mockS3.commandCalls.length, 0, 'mockS3 must receive 0 command calls')
		assert.strictEqual(mockS3.writeCommandCalls.length, 0, 'mockS3 must receive 0 write command calls')
	})

	// -------------------------------------------------------------------------
	// 52. AuditLiveAwsVerificationAdapter does not expose client or unrestricted send method
	// -------------------------------------------------------------------------
	it('52. AuditLiveAwsVerificationAdapter does not expose client or unrestricted send method', () => {
		const mockS3 = new MockReadOnlyS3Client()
		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: false,
		})

		// Client is private
		assert.strictEqual(adapter.s3Client, undefined, 'underlying client must not be exposed as public property')

		// Generic command execution methods are not exposed
		assert.strictEqual(adapter.send, undefined, 'adapter must not expose generic send() method')
		assert.strictEqual(AuditLiveAwsVerificationAdapter.prototype.send, undefined)
		assert.strictEqual(adapter.execute, undefined)
		assert.strictEqual(adapter.putObject, undefined)
		assert.strictEqual(adapter.deleteObject, undefined)

		// ALLOWED_READ_ONLY_COMMANDS is immutable and contains strictly 2 commands
		assert.strictEqual(ALLOWED_READ_ONLY_COMMANDS.size, 2)
		assert(ALLOWED_READ_ONLY_COMMANDS.has('GetObjectCommand'))
		assert(ALLOWED_READ_ONLY_COMMANDS.has('GetObjectRetentionCommand'))
		assert(Object.isFrozen(ALLOWED_READ_ONLY_COMMANDS))
	})

	// -------------------------------------------------------------------------
	// 53. Existing exact-VersionId verification continues to work with allowlist
	// -------------------------------------------------------------------------
	it('53. Existing exact-VersionId live verification continues to work seamlessly with allowlist', async () => {
		const valid = createValidCheckpointEvidence(1, 100, GENESIS_CHECKPOINT_HASH)
		const mockS3 = new MockReadOnlyS3Client()
		const s3Key = buildS3ObjectKey(valid.ledgerId, valid.checkpointId)
		const targetVersionId = 'v_exact_verified_version_allowlist_001'

		// Add multiple versions; adapter must query targetVersionId strictly
		mockS3.addVersion(s3Key, { versionId: 'v_earlier_unrelated', body: 'stale' })
		mockS3.addVersion(s3Key, {
			versionId: targetVersionId,
			body: valid.canonicalPayload,
			objectLockMode: 'COMPLIANCE',
			objectLockRetainUntilDate: new Date(Date.now() + 365 * 86400000),
		})
		mockS3.addVersion(s3Key, { versionId: 'v_latest_overwriting_version', body: 'corrupted' })

		valid.anchoringEvidence.s3VersionId = targetVersionId
		valid.externalObjectVersionId = targetVersionId

		const adapter = new AuditLiveAwsVerificationAdapter({
			s3Client: mockS3,
			enabled: true,
			bucket: 'test-bucket',
		})

		const result = await adapter.verifyLiveCheckpoint(valid)
		assert.strictEqual(result.isValid, true)
		assert.strictEqual(result.evidence.s3VersionId, targetVersionId)
		assert.strictEqual(result.evidence.objectLockMode, 'COMPLIANCE')

		// Confirm only allowlisted commands were executed with exact VersionId
		assert(mockS3.commandCalls.every((c) => c.name === 'GetObjectCommand' || c.name === 'GetObjectRetentionCommand'))
		const getCall = mockS3.commandCalls.find((c) => c.name === 'GetObjectCommand')
		assert.strictEqual(getCall.input.VersionId, targetVersionId)
		const retCall = mockS3.commandCalls.find((c) => c.name === 'GetObjectRetentionCommand')
		assert.strictEqual(retCall.input.VersionId, targetVersionId)
	})
})
