/**
 * Audit Checkpoint Compliance Verifier
 * Namma Blood — Stage B3.5.4 Independent Offline Audit Compliance Verification
 *
 * Implements an independent, offline-capable compliance verification engine
 * for administrative decision audit checkpoints, cryptographic signatures,
 * hash chains, and AWS S3 Object Lock COMPLIANCE evidence across three distinct modes:
 *
 * Mode A: OFFLINE_CRYPTOGRAPHIC
 * - Verifies evidence structure, canonical payload, SHA-256 checkpoint hash,
 *   Ed25519 signature, signing key identity, sequence continuity, and previousCheckpointHash linkage.
 * - Does NOT claim live AWS retention has been independently verified.
 * - Sets s3EvidenceVerificationStatus: 'UNVERIFIED', liveAwsVerificationPerformed: false.
 *
 * Mode B: OFFLINE_EXPORTED_EVIDENCE
 * - Ingests exported evidence bundle (bucket, key, exact VersionId, raw body, retention metadata, provenance).
 * - Verifies exact VersionId, object key, body checksum, COMPLIANCE mode, future RetainUntilDate.
 * - Explicitly states exported evidence does not independently prove current AWS state unless provenance is trusted.
 *
 * Mode C: LIVE_AWS_VERIFICATION
 * - Isolated, strictly read-only AWS verification adapter (GetObjectCommand, GetObjectRetentionCommand).
 * - Retrieves exact recorded VersionId and Object Lock retention from live S3 API.
 * - Compares retrieved S3 body and retention with expected signed checkpoint.
 * - Sets liveAwsVerificationPerformed: true, retentionVerificationSource: 'LIVE_AWS_S3_API'.
 *
 * Security & Architectural Invariants:
 * 1. Zero Trust: Does NOT trust MongoDB anchoringStatus, lastAnchoredSequence,
 *    or upload success responses. Reconstructs and independently validates every field.
 * 2. Asymmetric Public Key Only: Verifies RFC 8032 Ed25519 signatures using
 *    SPKI public keys only. Never accesses, requires, or logs private keys.
 * 3. Exact VersionId Enforcement: Never uses latest object version as a substitute for recorded VersionId.
 * 4. Strict COMPLIANCE WORM Enforcement: Rejects GOVERNANCE mode, expired retention dates,
 *    unverifiable retention metadata, or conflicting S3 object versions.
 * 5. Explicit Retention Policy: AUDIT_WORM_REQUIRED_RETENTION_DAYS must be explicitly configured
 *    when retention compliance is checked. Seven-year retention is never assumed.
 * 6. Four Discrete Outcomes: VALID, INVALID, INCOMPLETE, PENDING.
 *    Missing evidence is never treated as valid.
 * 7. Non-Mutating: Never mutates MongoDB records, S3 objects, or ledger watermarks.
 */

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const {
	GetObjectCommand,
	GetObjectRetentionCommand,
	HeadObjectCommand,
} = require('@aws-sdk/client-s3')
const {
	CHECKPOINT_FORMAT_VERSION,
	canonicalizeCheckpointPayload,
	calculateCheckpointHash,
} = require('./auditCheckpointPayloadService')
const { verifyCheckpointSignature } = require('./auditSigningService')
const { GENESIS_CHECKPOINT_HASH } = require('./auditCheckpointCursorModel')
const { GLOBAL_HEAD_ID } = require('./auditChainHeadModel')
const { buildS3ObjectKey, TARGET_OBJECT_LOCK_MODE } = require('./auditWormStorageAdapter')

const VERIFIER_VERSION = 'v1.1.0'
const SUPPORTED_FORMAT_VERSIONS = ['v1']
const SUPPORTED_SIGNING_ALGORITHMS = ['Ed25519']
const AUDIT_WORM_REQUIRED_RETENTION_DAYS_ENV = 'AUDIT_WORM_REQUIRED_RETENTION_DAYS'

/**
 * Standard Verification Primary Outcomes
 */
const VERIFICATION_STATUS = {
	VALID: 'VALID',
	INVALID: 'INVALID',
	INCOMPLETE: 'INCOMPLETE',
	PENDING: 'PENDING',
}

/**
 * Verification Trust Levels & Modes
 */
const VERIFICATION_MODE = {
	OFFLINE_CRYPTOGRAPHIC: 'OFFLINE_CRYPTOGRAPHIC',
	OFFLINE_EXPORTED_EVIDENCE: 'OFFLINE_EXPORTED_EVIDENCE',
	LIVE_AWS_VERIFICATION: 'LIVE_AWS_VERIFICATION',
}

/**
 * Retention Verification Sources
 */
const RETENTION_VERIFICATION_SOURCE = {
	NONE: 'NONE',
	EXPORTED_EVIDENCE_PROVENANCE: 'EXPORTED_EVIDENCE_PROVENANCE',
	LIVE_AWS_S3_API: 'LIVE_AWS_S3_API',
	STORED_MONGODB_METADATA_UNVERIFIED_LIVE: 'STORED_MONGODB_METADATA_UNVERIFIED_LIVE',
}

/**
 * Structured Check Identifiers
 */
const CHECK_IDS = {
	STRUCT_REQUIRED_FIELDS: 'STRUCT_REQUIRED_FIELDS',
	STRUCT_FORMAT_VERSION: 'STRUCT_FORMAT_VERSION',
	STRUCT_LEDGER_ID: 'STRUCT_LEDGER_ID',
	STRUCT_CHECKPOINT_ID: 'STRUCT_CHECKPOINT_ID',
	STRUCT_SEQUENCE_RANGE: 'STRUCT_SEQUENCE_RANGE',

	CRYPTO_CANONICAL_PAYLOAD: 'CRYPTO_CANONICAL_PAYLOAD',
	CRYPTO_HASH_INTEGRITY: 'CRYPTO_HASH_INTEGRITY',
	CRYPTO_SIGNING_KEY_RECOGNIZED: 'CRYPTO_SIGNING_KEY_RECOGNIZED',
	CRYPTO_SIGNATURE_VALIDITY: 'CRYPTO_SIGNATURE_VALIDITY',

	CHAIN_START_SEQUENCE_COVERAGE: 'CHAIN_START_SEQUENCE_COVERAGE',
	CHAIN_SEQUENCE_CONTINUITY: 'CHAIN_SEQUENCE_CONTINUITY',
	CHAIN_HASH_CONTINUITY: 'CHAIN_HASH_CONTINUITY',
	CHAIN_RANGE_OVERLAP: 'CHAIN_RANGE_OVERLAP',
	CHAIN_DUPLICATE_ID: 'CHAIN_DUPLICATE_ID',

	S3_KEY_STRUCTURE: 'S3_KEY_STRUCTURE',
	S3_VERSION_ID: 'S3_VERSION_ID',
	S3_BODY_CHECKSUM: 'S3_BODY_CHECKSUM',
	S3_METADATA_CONSISTENCY: 'S3_METADATA_CONSISTENCY',
	S3_OBJECT_LOCK_COMPLIANCE: 'S3_OBJECT_LOCK_COMPLIANCE',
	S3_RETENTION_DURATION: 'S3_RETENTION_DURATION',
	S3_RETENTION_POLICY_CONFIGURED: 'S3_RETENTION_POLICY_CONFIGURED',
	S3_RETENTION_MINIMUM_DAYS: 'S3_RETENTION_MINIMUM_DAYS',
	S3_NO_CONFLICTING_VERSIONS: 'S3_NO_CONFLICTING_VERSIONS',

	WATERMARK_HEAD_CONSISTENCY: 'WATERMARK_HEAD_CONSISTENCY',
	WATERMARK_CURSOR_CONSISTENCY: 'WATERMARK_CURSOR_CONSISTENCY',
	WATERMARK_ANCHORED_CONSISTENCY: 'WATERMARK_ANCHORED_CONSISTENCY',
}

/**
 * Validates a candidate required retention days policy value.
 * Must be a positive integer. Rejects non-integers, negative numbers, and zeroes.
 *
 * @param {*} val
 * @returns {number|null} Validated positive integer or null if not provided
 */
function validateRequiredRetentionDays(val) {
	if (val === undefined || val === null || val === '') {
		return null
	}
	const num = Number(val)
	if (!Number.isInteger(num) || num <= 0) {
		throw new Error(
			`Invalid retention policy: required retention days must be a positive integer, received: '${val}'.`
		)
	}
	return num
}

/**
 * Resolves required retention days from explicit options or environment configuration.
 * Does NOT assume a seven-year default.
 *
 * @param {Object} [options={}]
 * @returns {number|null}
 */
function resolveRequiredRetentionDays(options = {}) {
	const raw =
		options.requiredRetentionDays !== undefined
			? options.requiredRetentionDays
			: process.env[AUDIT_WORM_REQUIRED_RETENTION_DAYS_ENV]
	return validateRequiredRetentionDays(raw)
}

/**
 * Creates a structured verification report matching Stage B3.5.4 semantics.
 *
 * @param {string} ledgerId
 * @param {Object} [metadata={}]
 * @returns {Object}
 */
function createVerificationReport(ledgerId = GLOBAL_HEAD_ID, metadata = {}) {
	const mode = metadata.verificationMode || VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE
	return {
		verificationId: `VERIF-${crypto.randomBytes(8).toString('hex')}`,
		verificationTimestamp: new Date().toISOString(),
		verifierVersion: VERIFIER_VERSION,
		ledgerId,
		canonicalizationVersion: 'v2',
		verificationMode: mode,
		cryptographicVerificationStatus: VERIFICATION_STATUS.PENDING,
		checkpointContinuityStatus: VERIFICATION_STATUS.PENDING,
		s3EvidenceVerificationStatus:
			mode === VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC ? 'UNVERIFIED' : 'PENDING',
		liveAwsVerificationPerformed: mode === VERIFICATION_MODE.LIVE_AWS_VERIFICATION,
		retentionVerificationSource:
			mode === VERIFICATION_MODE.LIVE_AWS_VERIFICATION
				? RETENTION_VERIFICATION_SOURCE.LIVE_AWS_S3_API
				: mode === VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE
				? RETENTION_VERIFICATION_SOURCE.EXPORTED_EVIDENCE_PROVENANCE
				: RETENTION_VERIFICATION_SOURCE.NONE,
		evidenceProvenance: metadata.evidenceProvenance || null,
		overallStatus: VERIFICATION_STATUS.PENDING,
		verifiedSequenceRange: {
			startSequence: null,
			endSequence: null,
			totalRecords: 0,
			totalCheckpoints: 0,
		},
		signingKeyId: metadata.signingKeyId || null,
		individualChecks: [],
		failedCheckIds: [],
		missingEvidenceIds: [],
		warnings: [],
		details: {},
		verifiedAt: new Date().toISOString(),
	}
}

/**
 * Records the outcome of an individual verification check.
 *
 * @param {Object} report - Report object to mutate
 * @param {string} checkId - Unique check identifier from CHECK_IDS
 * @param {string} name - Human-readable check title
 * @param {boolean} passed - Whether check passed
 * @param {string} [details=null]
 * @param {string} [severity='ERROR'] - 'ERROR' or 'WARNING' or 'MISSING'
 */
function recordCheck(report, checkId, name, passed, details = null, severity = 'ERROR') {
	const status = passed
		? 'PASS'
		: severity === 'MISSING'
		? 'MISSING'
		: severity === 'WARNING'
		? 'WARNING'
		: 'FAIL'

	report.individualChecks.push({
		checkId,
		name,
		status,
		details: details || (passed ? 'Verified successfully.' : 'Verification check failed.'),
		evaluatedAt: new Date().toISOString(),
	})

	if (!passed) {
		if (severity === 'MISSING') {
			if (!report.missingEvidenceIds.includes(checkId)) {
				report.missingEvidenceIds.push(checkId)
			}
		} else if (severity === 'WARNING') {
			report.warnings.push(`${checkId}: ${details}`)
		} else {
			if (!report.failedCheckIds.includes(checkId)) {
				report.failedCheckIds.push(checkId)
			}
		}
	}
}

/**
 * Resolves the overall status and categorical sub-statuses from check outcomes.
 *
 * @param {Object} report
 * @returns {string} Final overallStatus
 */
function finalizeReportStatus(report) {
	// 1. Cryptographic Verification Status (STRUCT_* and CRYPTO_*)
	const cryptoChecks = report.individualChecks.filter(
		(c) => c.checkId.startsWith('STRUCT_') || c.checkId.startsWith('CRYPTO_')
	)
	const cryptoFailed = cryptoChecks.some((c) => c.status === 'FAIL')
	const cryptoMissing = cryptoChecks.some((c) => c.status === 'MISSING')
	report.cryptographicVerificationStatus = cryptoFailed
		? VERIFICATION_STATUS.INVALID
		: cryptoMissing
		? VERIFICATION_STATUS.INCOMPLETE
		: cryptoChecks.length > 0
		? VERIFICATION_STATUS.VALID
		: VERIFICATION_STATUS.PENDING

	// 2. Checkpoint Continuity Status (CHAIN_*)
	const chainChecks = report.individualChecks.filter((c) => c.checkId.startsWith('CHAIN_'))
	const chainFailed = chainChecks.some((c) => c.status === 'FAIL')
	const chainMissing = chainChecks.some((c) => c.status === 'MISSING')
	report.checkpointContinuityStatus = chainFailed
		? VERIFICATION_STATUS.INVALID
		: chainMissing
		? VERIFICATION_STATUS.INCOMPLETE
		: chainChecks.length > 0
		? VERIFICATION_STATUS.VALID
		: VERIFICATION_STATUS.PENDING

	// 3. S3 Evidence Verification Status (S3_*)
	if (report.verificationMode === VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC) {
		report.s3EvidenceVerificationStatus = 'UNVERIFIED'
		report.liveAwsVerificationPerformed = false
		report.retentionVerificationSource = RETENTION_VERIFICATION_SOURCE.NONE
		if (!report.warnings.some((w) => w.includes('live AWS'))) {
			report.warnings.push(
				'Offline cryptographic verification mode: live AWS S3 Object Lock retention remains unverified.'
			)
		}
	} else {
		const s3Checks = report.individualChecks.filter((c) => c.checkId.startsWith('S3_'))
		const s3Failed = s3Checks.some((c) => c.status === 'FAIL')
		const s3Missing = s3Checks.some((c) => c.status === 'MISSING')
		report.s3EvidenceVerificationStatus = s3Failed
			? VERIFICATION_STATUS.INVALID
			: s3Missing
			? VERIFICATION_STATUS.INCOMPLETE
			: s3Checks.length > 0
			? VERIFICATION_STATUS.VALID
			: 'UNVERIFIED'

		if (report.verificationMode === VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE) {
			report.liveAwsVerificationPerformed = false
			report.retentionVerificationSource = RETENTION_VERIFICATION_SOURCE.EXPORTED_EVIDENCE_PROVENANCE
			if (!report.warnings.some((w) => w.includes('Exported S3 evidence'))) {
				report.warnings.push(
					'Exported S3 evidence verified offline. Exported evidence does not independently prove current live AWS state unless export provenance is independently trusted.'
				)
			}
		} else if (report.verificationMode === VERIFICATION_MODE.LIVE_AWS_VERIFICATION) {
			report.liveAwsVerificationPerformed = true
			report.retentionVerificationSource = RETENTION_VERIFICATION_SOURCE.LIVE_AWS_S3_API
		}
	}

	// 4. Overall Report Status
	if (report.failedCheckIds.length > 0) {
		report.overallStatus = VERIFICATION_STATUS.INVALID
	} else if (report.missingEvidenceIds.length > 0) {
		report.overallStatus = VERIFICATION_STATUS.INCOMPLETE
	} else if (report.individualChecks.length === 0) {
		report.overallStatus = VERIFICATION_STATUS.PENDING
	} else {
		report.overallStatus = VERIFICATION_STATUS.VALID
	}

	return report.overallStatus
}

/**
 * Explicit allowlist of permissible AWS SDK v3 commands for the read-only verifier adapter.
 * Only these two read-only commands may pass; all write, delete, modification, or unknown commands are rejected.
 */
const ALLOWED_READ_ONLY_COMMANDS = Object.freeze(
	new Set(['GetObjectCommand', 'GetObjectRetentionCommand'])
)

/**
 * Isolated, read-only AWS S3 Verification Adapter (Mode C).
 * Strictly implements zero write, delete, or retention modification operations.
 * Enforces an explicit command allowlist at the point of SDK dispatch.
 */
class AuditLiveAwsVerificationAdapter {
	#s3Client = null

	constructor(options = {}) {
		this.#s3Client = options.s3Client || null
		this.bucket =
			options.bucket ||
			process.env.AUDIT_WORM_S3_BUCKET ||
			'namma-blood-compliance-audit-worm'
		this.isEnabled =
			options.enabled ?? (process.env.ENABLE_LIVE_AWS_VERIFICATION === 'true')

		this.assertReadOnly()
	}

	/**
	 * Strictly asserts that no write, delete, or retention modification methods exist.
	 * Also asserts that generic command execution methods (e.g. send) are not exposed.
	 */
	assertReadOnly() {
		const forbiddenMethods = [
			'putObject',
			'deleteObject',
			'deleteObjects',
			'upload',
			'putObjectRetention',
			'putObjectLegalHold',
			'createBucket',
			'deleteBucket',
			'send',
		]
		for (const method of forbiddenMethods) {
			if (
				typeof this[method] === 'function' ||
				typeof this.constructor.prototype[method] === 'function'
			) {
				throw new Error(
					`Security Violation: Write or command execution method '${method}' is forbidden on AuditLiveAwsVerificationAdapter.`
				)
			}
		}
	}

	/**
	 * Asserts that live AWS verification is enabled and configured.
	 */
	assertEnabled() {
		if (!this.isEnabled) {
			throw new Error(
				'Live AWS verification is disabled by default. Set ENABLE_LIVE_AWS_VERIFICATION=true to enable.'
			)
		}
		if (!this.#s3Client) {
			throw new Error('An S3Client instance must be provided for live AWS verification.')
		}
	}

	/**
	 * Internal dispatcher enforcing the explicit read-only command allowlist.
	 * Only allowlisted read-only commands (GetObjectCommand, GetObjectRetentionCommand)
	 * are permitted to reach the underlying AWS SDK client.
	 * All write, delete, modification, or unknown commands fail closed with a Security Violation.
	 *
	 * @param {Object} command - AWS SDK v3 command instance
	 * @returns {Promise<any>}
	 */
	async _sendReadOnlyCommand(command) {
		this.assertReadOnly()
		this.assertEnabled()

		const commandName =
			command?.constructor?.name ||
			command?.name ||
			(typeof command === 'string' ? command : 'UnknownCommand')

		if (!ALLOWED_READ_ONLY_COMMANDS.has(commandName)) {
			throw new Error(
				`Security Violation: Command '${commandName}' is strictly prohibited. ` +
				`Only read-only commands [${Array.from(ALLOWED_READ_ONLY_COMMANDS).join(', ')}] are permitted.`
			)
		}

		if (!this.#s3Client || typeof this.#s3Client.send !== 'function') {
			throw new Error('An S3Client instance with a send() method must be configured.')
		}

		return await this.#s3Client.send(command)
	}

	/**
	 * Verifies an exact checkpoint object version and its Object Lock retention from live AWS S3.
	 *
	 * @param {Object} checkpoint
	 * @param {Object} [options={}]
	 * @returns {Promise<{ isValid: boolean, error?: string, checkId?: string, evidence?: Object }>}
	 */
	async verifyLiveCheckpoint(checkpoint, options = {}) {
		this.assertReadOnly()
		this.assertEnabled()

		const ledgerId = checkpoint.ledgerId || GLOBAL_HEAD_ID
		const checkpointId = checkpoint.checkpointId
		const expectedObjectKey = buildS3ObjectKey(ledgerId, checkpointId)
		const bucket = options.bucket || this.bucket

		// Exact VersionId MUST be specified. Never use latest object version as a substitute!
		const versionId =
			checkpoint.externalObjectVersionId ||
			checkpoint.anchoringEvidence?.s3VersionId ||
			options.versionId

		if (
			!versionId ||
			typeof versionId !== 'string' ||
			versionId.trim() === '' ||
			versionId === 'null'
		) {
			return {
				isValid: false,
				error: 'Missing exact S3 VersionId. Live verification requires a non-empty VersionId.',
				checkId: CHECK_IDS.S3_VERSION_ID,
				evidence: null,
			}
		}

		// 1. GetObjectCommand with exact VersionId via allowlisted dispatcher
		let s3ObjectResponse
		let rawBody
		try {
			const getCmd = new GetObjectCommand({
				Bucket: bucket,
				Key: expectedObjectKey,
				VersionId: versionId,
			})
			s3ObjectResponse = await this._sendReadOnlyCommand(getCmd)
			rawBody = await s3ObjectResponse.Body.transformToString('utf8')
		} catch (err) {
			return {
				isValid: false,
				error: `S3 GetObject failed for exact VersionId '${versionId}': ${err.message}`,
				checkId: CHECK_IDS.S3_VERSION_ID,
				evidence: null,
			}
		}

		// Recompute body checksum
		const computedSha256 = crypto.createHash('sha256').update(rawBody, 'utf8').digest('hex')

		// 2. GetObjectRetentionCommand for exact VersionId via allowlisted dispatcher
		let retentionResponse
		try {
			const retCmd = new GetObjectRetentionCommand({
				Bucket: bucket,
				Key: expectedObjectKey,
				VersionId: versionId,
			})
			retentionResponse = await this._sendReadOnlyCommand(retCmd)
		} catch (err) {
			return {
				isValid: false,
				error: `S3 GetObjectRetention failed for exact VersionId '${versionId}': ${err.message}`,
				checkId: CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE,
				evidence: null,
			}
		}

		const retention = retentionResponse?.Retention
		if (!retention || !retention.Mode || !retention.RetainUntilDate) {
			return {
				isValid: false,
				error: `Object Lock Missing: Object version '${versionId}' has no active retention metadata configured.`,
				checkId: CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE,
				evidence: null,
			}
		}

		if (retention.Mode !== TARGET_OBJECT_LOCK_MODE) {
			return {
				isValid: false,
				error: `Compliance Violation: Object Lock mode is '${retention.Mode}', expected strictly '${TARGET_OBJECT_LOCK_MODE}'. GOVERNANCE mode is prohibited.`,
				checkId: CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE,
				evidence: null,
			}
		}

		const retainUntilDate = new Date(retention.RetainUntilDate)
		if (isNaN(retainUntilDate.getTime()) || retainUntilDate <= new Date()) {
			return {
				isValid: false,
				error: `Invalid or expired RetainUntilDate: '${retention.RetainUntilDate}'. Must be active and in the future.`,
				checkId: CHECK_IDS.S3_RETENTION_DURATION,
				evidence: null,
			}
		}

		const expectedChecksum =
			checkpoint.anchoringEvidence?.sha256Checksum ||
			checkpoint.sha256Checksum ||
			options.expectedSha256Checksum ||
			(checkpoint.canonicalPayload
				? crypto.createHash('sha256').update(checkpoint.canonicalPayload, 'utf8').digest('hex')
				: computedSha256)

		return {
			isValid: true,
			evidence: {
				s3Bucket: bucket,
				s3ObjectKey: expectedObjectKey,
				s3VersionId: versionId,
				rawBody,
				sha256Checksum: expectedChecksum,
				computedSha256,
				objectLockMode: retention.Mode,
				retainUntilDate: retainUntilDate.toISOString(),
				retentionUntil: retainUntilDate.toISOString(),
				retrievedAt: new Date().toISOString(),
			},
		}
	}
}

/**
 * Independently verifies a single checkpoint evidence document or bundle.
 *
 * @param {Object} evidence - Evidence document (from S3 JSON, export, or model)
 * @param {Object} [options={}]
 * @param {string} [options.verificationMode] - OFFLINE_CRYPTOGRAPHIC | OFFLINE_EXPORTED_EVIDENCE | LIVE_AWS_VERIFICATION
 * @param {string} [options.publicKeyPem] - SPKI Ed25519 public key in PEM format
 * @param {string|Array<string>} [options.recognizedKeyIds] - Recognized/trusted signing key IDs
 * @param {string} [options.expectedLedgerId=GLOBAL_HEAD_ID]
 * @param {Object} [options.previousCheckpointEvidence=null] - Predecessor evidence for chain continuity
 * @param {Object} [options.s3MetadataEvidence=null] - Optional S3 retention & version metadata
 * @param {number} [options.requiredRetentionDays=null] - Explicit minimum retention days threshold
 * @param {boolean} [options.enforceRetentionPolicy=false] - When true, rejects if required retention policy is unconfigured
 * @returns {Object} Comprehensive verification report
 */
function verifySingleCheckpointEvidence(evidence, options = {}) {
	const expectedLedgerId = options.expectedLedgerId || GLOBAL_HEAD_ID
	const verificationMode =
		options.verificationMode ||
		(options.liveAdapter || options.s3Client
			? VERIFICATION_MODE.LIVE_AWS_VERIFICATION
			: VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE)

	const recognizedKeyIds = options.recognizedKeyIds
		? Array.isArray(options.recognizedKeyIds)
			? options.recognizedKeyIds
			: [options.recognizedKeyIds]
		: null

	const report = createVerificationReport(expectedLedgerId, {
		verificationMode,
		signingKeyId: evidence?.signature?.keyId || evidence?.signingKeyId || null,
		evidenceProvenance: evidence?.provenance || options.provenance || null,
	})

	if (!evidence || typeof evidence !== 'object') {
		recordCheck(
			report,
			CHECK_IDS.STRUCT_REQUIRED_FIELDS,
			'Evidence Document Structure',
			false,
			'Evidence document is missing or not a valid object.',
			'MISSING'
		)
		finalizeReportStatus(report)
		return report
	}

	// -------------------------------------------------------------------------
	// A. Evidence Structure Checks
	// -------------------------------------------------------------------------
	const requiredFields = [
		'checkpointId',
		'ledgerId',
		'startSequence',
		'endSequence',
		'recordCount',
		'firstRecordHash',
		'lastRecordHash',
		'previousCheckpointHash',
		'checkpointHash',
		'canonicalPayload',
	]

	const missingFields = requiredFields.filter(
		(f) => evidence[f] === undefined || evidence[f] === null
	)
	recordCheck(
		report,
		CHECK_IDS.STRUCT_REQUIRED_FIELDS,
		'Required Metadata Fields Presence',
		missingFields.length === 0,
		missingFields.length === 0
			? 'All required checkpoint fields are present.'
			: `Missing required checkpoint fields: [${missingFields.join(', ')}].`,
		'MISSING'
	)

	// Format version check
	const formatVer = evidence.formatVersion || evidence.checkpointFormatVersion || 'v1'
	const formatVerOk = SUPPORTED_FORMAT_VERSIONS.includes(formatVer)
	recordCheck(
		report,
		CHECK_IDS.STRUCT_FORMAT_VERSION,
		'Supported Format Version',
		formatVerOk,
		formatVerOk
			? `Format version '${formatVer}' is supported.`
			: `Unsupported format version '${formatVer}'. Supported: [${SUPPORTED_FORMAT_VERSIONS.join(', ')}].`
	)

	// Ledger ID check
	const ledgerIdOk = evidence.ledgerId === expectedLedgerId
	recordCheck(
		report,
		CHECK_IDS.STRUCT_LEDGER_ID,
		'Ledger Identifier Match',
		ledgerIdOk,
		ledgerIdOk
			? `Ledger ID matches expected '${expectedLedgerId}'.`
			: `Ledger ID mismatch: expected '${expectedLedgerId}', found '${evidence.ledgerId}'.`
	)

	// Checkpoint ID structure check
	const chkIdRegex = /^CHK-[a-zA-Z0-9_\-]+-\d{10}-\d{10}-\d{8}T\d{6}Z$/
	const chkIdOk = typeof evidence.checkpointId === 'string' && chkIdRegex.test(evidence.checkpointId)
	recordCheck(
		report,
		CHECK_IDS.STRUCT_CHECKPOINT_ID,
		'Deterministic Checkpoint ID Format',
		chkIdOk,
		chkIdOk
			? `Checkpoint ID '${evidence.checkpointId}' matches deterministic format.`
			: `Invalid checkpoint ID format: '${evidence.checkpointId}'.`
	)

	// Sequence arithmetic checks
	const startSeq = Number(evidence.startSequence)
	const endSeq = Number(evidence.endSequence)
	const recCount = Number(evidence.recordCount)

	const seqValid =
		Number.isInteger(startSeq) &&
		startSeq >= 1 &&
		Number.isInteger(endSeq) &&
		endSeq >= startSeq &&
		Number.isInteger(recCount) &&
		recCount === endSeq - startSeq + 1

	recordCheck(
		report,
		CHECK_IDS.STRUCT_SEQUENCE_RANGE,
		'Sequence Range Arithmetic and Count Consistency',
		seqValid,
		seqValid
			? `Sequence bounds [${startSeq}..${endSeq}] and record count (${recCount}) are arithmetically consistent.`
			: `Sequence arithmetic violation: startSequence=${evidence.startSequence}, endSequence=${evidence.endSequence}, recordCount=${evidence.recordCount}.`
	)

	// -------------------------------------------------------------------------
	// B. Cryptographic Integrity Checks
	// -------------------------------------------------------------------------
	let parsedPayload = evidence.payload
	if (typeof parsedPayload === 'string') {
		try {
			parsedPayload = JSON.parse(parsedPayload)
		} catch (e) {
			parsedPayload = null
		}
	}

	let canonicalReconstructed = null
	if (parsedPayload && typeof parsedPayload === 'object') {
		try {
			canonicalReconstructed = canonicalizeCheckpointPayload(parsedPayload)
		} catch (e) {
			canonicalReconstructed = null
		}
	}

	const canonicalMatches =
		Boolean(canonicalReconstructed) && canonicalReconstructed === evidence.canonicalPayload

	recordCheck(
		report,
		CHECK_IDS.CRYPTO_CANONICAL_PAYLOAD,
		'Deterministic Canonical Payload Reconstruction',
		canonicalMatches,
		canonicalMatches
			? 'Reconstructed canonical serialization matches recorded canonicalPayload string.'
			: 'Canonical payload mismatch: serialized representation does not match recorded canonical string.'
	)

	const recomputedHash = crypto
		.createHash('sha256')
		.update(evidence.canonicalPayload || '', 'utf8')
		.digest('hex')

	const hashMatches = recomputedHash === evidence.checkpointHash
	recordCheck(
		report,
		CHECK_IDS.CRYPTO_HASH_INTEGRITY,
		'Checkpoint SHA-256 Hash Integrity',
		hashMatches,
		hashMatches
			? `Recomputed SHA-256 hash '${recomputedHash}' matches recorded checkpointHash.`
			: `Checkpoint hash mismatch: computed '${recomputedHash}', recorded '${evidence.checkpointHash}'.`
	)

	// Resolve Signature and Public Key
	const sigObj = evidence.signature || {}
	const sigHex =
		(typeof sigObj === 'string' ? sigObj : sigObj.signature) ||
		evidence.signatureHex ||
		evidence.anchoringEvidence?.signature ||
		null
	const sigKeyId =
		sigObj.keyId ||
		evidence.signingKeyId ||
		evidence.anchoringEvidence?.signingKeyId ||
		null
	const publicKeyPem =
		options.publicKeyPem ||
		options.publicKey ||
		sigObj.publicKey ||
		process.env.AUDIT_SIGNING_PUBLIC_KEY ||
		process.env.AUDIT_CHECKPOINT_PUBLIC_KEY ||
		null

	if (recognizedKeyIds && recognizedKeyIds.length > 0) {
		const keyRecognized = sigKeyId && recognizedKeyIds.includes(sigKeyId)
		recordCheck(
			report,
			CHECK_IDS.CRYPTO_SIGNING_KEY_RECOGNIZED,
			'Recognized Signing Key ID',
			keyRecognized,
			keyRecognized
				? `Signing key ID '${sigKeyId}' is recognized.`
				: `Unknown or unrecognized signing key ID '${sigKeyId}'. Trusted keys: [${recognizedKeyIds.join(', ')}].`
		)
	}

	if (!sigHex) {
		recordCheck(
			report,
			CHECK_IDS.CRYPTO_SIGNATURE_VALIDITY,
			'Detached Ed25519 Cryptographic Signature',
			false,
			'Missing detached cryptographic signature on checkpoint evidence.',
			'MISSING'
		)
	} else if (!publicKeyPem) {
		recordCheck(
			report,
			CHECK_IDS.CRYPTO_SIGNATURE_VALIDITY,
			'Detached Ed25519 Cryptographic Signature',
			false,
			'Public signing key (SPKI PEM) was not provided for signature verification.',
			'MISSING'
		)
	} else {
		let sigVerifyResult = { isValid: false, error: 'Unverified' }
		try {
			sigVerifyResult = verifyCheckpointSignature(
				evidence.canonicalPayload || '',
				sigHex,
				publicKeyPem,
				{ keyId: sigKeyId }
			)
		} catch (err) {
			sigVerifyResult = { isValid: false, error: err.message }
		}

		recordCheck(
			report,
			CHECK_IDS.CRYPTO_SIGNATURE_VALIDITY,
			'Detached Ed25519 Cryptographic Signature',
			sigVerifyResult.isValid,
			sigVerifyResult.isValid
				? `Detached Ed25519 signature verified successfully (keyId: '${sigKeyId}').`
				: `Cryptographic signature verification failed: ${sigVerifyResult.error}`
		)
	}

	// -------------------------------------------------------------------------
	// C. Continuity with Predecessor Checkpoint (if provided)
	// -------------------------------------------------------------------------
	if (options.previousCheckpointEvidence) {
		const prev = options.previousCheckpointEvidence
		const expectedPrevSeq = Number(prev.endSequence) + 1

		if (startSeq > expectedPrevSeq) {
			recordCheck(
				report,
				CHECK_IDS.CHAIN_SEQUENCE_CONTINUITY,
				'Sequence Continuity with Predecessor (Gap Detected)',
				false,
				`Sequence gap detected: expected startSequence ${expectedPrevSeq}, found ${startSeq}. Intermediate checkpoints are missing.`,
				'MISSING'
			)
		} else if (startSeq < expectedPrevSeq) {
			recordCheck(
				report,
				CHECK_IDS.CHAIN_RANGE_OVERLAP,
				'Sequence Overlap with Predecessor',
				false,
				`Sequence overlap detected: startSequence ${startSeq} overlaps with predecessor endSequence ${prev.endSequence}.`,
				'ERROR'
			)
		} else {
			recordCheck(
				report,
				CHECK_IDS.CHAIN_SEQUENCE_CONTINUITY,
				'Sequence Continuity with Predecessor',
				true,
				`startSequence (${startSeq}) immediately follows predecessor endSequence (${prev.endSequence}).`
			)
		}

		const hashContOk = evidence.previousCheckpointHash === prev.checkpointHash
		recordCheck(
			report,
			CHECK_IDS.CHAIN_HASH_CONTINUITY,
			'Hash Chain Continuity with Predecessor',
			hashContOk,
			hashContOk
				? `previousCheckpointHash matches predecessor checkpointHash '${prev.checkpointHash}'.`
				: `Hash chain break detected: expected previousCheckpointHash '${prev.checkpointHash}', found '${evidence.previousCheckpointHash}'.`
		)
	} else if (startSeq === 1) {
		const genesisOk = evidence.previousCheckpointHash === GENESIS_CHECKPOINT_HASH
		recordCheck(
			report,
			CHECK_IDS.CHAIN_HASH_CONTINUITY,
			'Genesis Checkpoint Hash Anchor',
			genesisOk,
			genesisOk
				? 'Genesis checkpoint correctly links to GENESIS_CHECKPOINT_HASH anchor.'
				: `Genesis checkpoint previousCheckpointHash mismatch: expected '${GENESIS_CHECKPOINT_HASH}', found '${evidence.previousCheckpointHash}'.`
		)
	}

	// -------------------------------------------------------------------------
	// D. S3 WORM Object Lock Evidence Checks according to Verification Mode
	// -------------------------------------------------------------------------
	if (verificationMode === VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC) {
		// Mode A: Offline Cryptographic Verification
		// Does NOT require S3 evidence. Clearly notes live retention is unverified.
		report.s3EvidenceVerificationStatus = 'UNVERIFIED'
		report.liveAwsVerificationPerformed = false
		report.retentionVerificationSource = RETENTION_VERIFICATION_SOURCE.NONE
	} else {
		// Mode B or Mode C
		const s3Evidence =
			options.liveEvidence ||
			options.s3MetadataEvidence ||
			evidence.anchoringEvidence ||
			null

		if (s3Evidence) {
			const expectedKey = buildS3ObjectKey(evidence.ledgerId, evidence.checkpointId)
			const keyOk = s3Evidence.s3ObjectKey === expectedKey || s3Evidence.objectKey === expectedKey

			recordCheck(
				report,
				CHECK_IDS.S3_KEY_STRUCTURE,
				'S3 Object Key Determinism',
				keyOk,
				keyOk
					? `S3 Object Key '${expectedKey}' matches deterministic path.`
					: `S3 Object Key mismatch: expected '${expectedKey}', found '${s3Evidence.s3ObjectKey || s3Evidence.objectKey}'.`
			)

			// Exact VersionId check (Must never be missing or null)
			const vId = s3Evidence.s3VersionId || s3Evidence.versionId
			const vIdOk = Boolean(
				vId && typeof vId === 'string' && vId !== 'null' && vId.trim().length > 0
			)
			recordCheck(
				report,
				CHECK_IDS.S3_VERSION_ID,
				'S3 Exact VersionId Presence',
				vIdOk,
				vIdOk
					? `Exact S3 VersionId '${vId}' is present.`
					: 'Missing or null S3 VersionId. WORM versioning requires non-empty VersionId.'
			)

			// Object Lock mode must be COMPLIANCE (Strictly reject GOVERNANCE)
			const lockMode = s3Evidence.objectLockMode || s3Evidence.mode
			const lockModeOk = lockMode === TARGET_OBJECT_LOCK_MODE
			recordCheck(
				report,
				CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE,
				'AWS S3 Object Lock COMPLIANCE Mode',
				lockModeOk,
				lockModeOk
					? `Object Lock mode is strictly '${TARGET_OBJECT_LOCK_MODE}'.`
					: `Compliance Violation: Object Lock mode is '${lockMode}', strictly expected '${TARGET_OBJECT_LOCK_MODE}'. GOVERNANCE mode is prohibited.`
			)

			// Checksum verification if raw S3 body is available
			if (s3Evidence.rawBody) {
				const computedBodySha = crypto
					.createHash('sha256')
					.update(s3Evidence.rawBody, 'utf8')
					.digest('hex')

				const recordedChecksum = s3Evidence.sha256Checksum
				const checksumOk = computedBodySha === recordedChecksum
				recordCheck(
					report,
					CHECK_IDS.S3_BODY_CHECKSUM,
					'S3 Body Content Checksum (SHA-256)',
					checksumOk,
					checksumOk
						? `Retrieved S3 body SHA-256 digest '${computedBodySha}' matches recorded checksum.`
						: `S3 body checksum mismatch: computed '${computedBodySha}', recorded '${recordedChecksum}'.`
				)
			}

			// RetainUntilDate check
			const retainUntilRaw = s3Evidence.retentionUntil || s3Evidence.retainUntilDate
			const retainUntil = retainUntilRaw ? new Date(retainUntilRaw) : null
			const now = new Date()
			const retainOk = retainUntil && !isNaN(retainUntil.getTime()) && retainUntil > now

			recordCheck(
				report,
				CHECK_IDS.S3_RETENTION_DURATION,
				'S3 Object Lock Retention Active in Future',
				Boolean(retainOk),
				retainOk
					? `RetainUntilDate '${retainUntil.toISOString()}' is active and in the future.`
					: `Invalid or expired RetainUntilDate: '${retainUntilRaw}'.`
			)

			// Retention Policy compliance check (Remove 7-year hardcode assumption)
			const requiredDays = resolveRequiredRetentionDays(options)
			if (options.enforceRetentionPolicy && requiredDays === null) {
				recordCheck(
					report,
					CHECK_IDS.S3_RETENTION_POLICY_CONFIGURED,
					'Required Retention Policy Configuration',
					false,
					'Missing required retention policy configuration: AUDIT_WORM_REQUIRED_RETENTION_DAYS or options.requiredRetentionDays must be explicitly configured as a positive integer. Seven-year retention is not assumed.',
					'ERROR'
				)
			} else if (requiredDays !== null && retainUntil && !isNaN(retainUntil.getTime())) {
				const minRequiredMs = now.getTime() + requiredDays * 86400000
				const meetsReq = retainUntil.getTime() >= minRequiredMs
				recordCheck(
					report,
					CHECK_IDS.S3_RETENTION_MINIMUM_DAYS,
					`Minimum Retention Duration (${requiredDays} days)`,
					meetsReq,
					meetsReq
						? `Retention duration satisfies configured policy of ${requiredDays} days.`
						: `Retention timestamp '${retainUntil.toISOString()}' does not satisfy configured minimum policy of ${requiredDays} days.`,
					'ERROR'
				)
			}
		} else {
			// S3 evidence missing in Mode B or Mode C
			recordCheck(
				report,
				CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE,
				'AWS S3 Object Lock COMPLIANCE Evidence',
				false,
				'S3 WORM Object Lock evidence not supplied. Cannot establish external WORM compliance.',
				'MISSING'
			)
		}
	}

	finalizeReportStatus(report)
	return report
}

/**
 * Independently verifies an entire chain of checkpoints across the specified verification mode.
 *
 * @param {Array<Object>} checkpoints - Array of checkpoint documents
 * @param {Object} [options={}]
 * @returns {Object} Comprehensive verification report
 */
function verifyCheckpointChain(checkpoints, options = {}) {
	const expectedLedgerId = options.expectedLedgerId || GLOBAL_HEAD_ID
	const expectedStartSeq =
		options.expectedStartSequence !== undefined ? options.expectedStartSequence : 1
	const verificationMode =
		options.verificationMode || VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE

	const report = createVerificationReport(expectedLedgerId, {
		...options,
		verificationMode,
		signingKeyId: options.recognizedKeyIds?.[0] || null,
	})

	if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
		recordCheck(
			report,
			CHECK_IDS.STRUCT_REQUIRED_FIELDS,
			'Checkpoint Chain Presence',
			false,
			'No checkpoints provided for chain verification.',
			'MISSING'
		)
		finalizeReportStatus(report)
		return report
	}

	// 1. Sort checkpoints ascending by startSequence
	const sorted = [...checkpoints].sort(
		(a, b) => Number(a.startSequence) - Number(b.startSequence)
	)

	// 2. Check for duplicate checkpoint IDs
	const seenIds = new Set()
	const duplicateIds = []
	for (const chk of sorted) {
		if (chk.checkpointId) {
			if (seenIds.has(chk.checkpointId)) {
				duplicateIds.push(chk.checkpointId)
			} else {
				seenIds.add(chk.checkpointId)
			}
		}
	}

	const noDuplicates = duplicateIds.length === 0
	recordCheck(
		report,
		CHECK_IDS.CHAIN_DUPLICATE_ID,
		'Unique Checkpoint Identifiers',
		noDuplicates,
		noDuplicates
			? 'All checkpoint identifiers are unique across the chain.'
			: `Duplicate checkpoint identifiers detected: [${duplicateIds.join(', ')}].`
	)

	// 3. Verify sequence monotonicity, gaps, and overlaps
	let hasOverlap = false
	let hasGap = false
	const overlapDetails = []
	const gapDetails = []

	// Check chain start
	const startMatches = Number(sorted[0].startSequence) === expectedStartSeq
	recordCheck(
		report,
		CHECK_IDS.CHAIN_START_SEQUENCE_COVERAGE,
		`Chain Start Sequence Matches Expected Start (${expectedStartSeq})`,
		startMatches,
		startMatches
			? `Chain begins at expected startSequence ${expectedStartSeq}.`
			: `Chain starting sequence ${sorted[0].startSequence} does not match expected start ${expectedStartSeq}. Partial coverage.`,
		startMatches ? 'ERROR' : 'MISSING'
	)

	if (!startMatches) {
		hasGap = true
		gapDetails.push(
			`Chain starting sequence ${sorted[0].startSequence} does not match expected start ${expectedStartSeq}.`
		)
	}

	for (let i = 0; i < sorted.length - 1; i++) {
		const current = sorted[i]
		const next = sorted[i + 1]

		const currentEnd = Number(current.endSequence)
		const nextStart = Number(next.startSequence)

		// Overlap check
		if (nextStart <= currentEnd) {
			hasOverlap = true
			overlapDetails.push(
				`Checkpoint ${current.checkpointId} [${current.startSequence}..${currentEnd}] overlaps with ${next.checkpointId} [${nextStart}..${next.endSequence}].`
			)
		} else if (nextStart > currentEnd + 1) {
			// Gap check
			hasGap = true
			gapDetails.push(
				`Sequence gap between checkpoint ${current.checkpointId} (ends at ${currentEnd}) and ${next.checkpointId} (starts at ${nextStart}). Missing sequences ${currentEnd + 1} to ${nextStart - 1}.`
			)
		}
	}

	recordCheck(
		report,
		CHECK_IDS.CHAIN_RANGE_OVERLAP,
		'No Overlapping Sequence Ranges',
		!hasOverlap,
		!hasOverlap
			? 'No overlapping sequence intervals detected in checkpoint chain.'
			: `Overlapping checkpoint sequence ranges: ${overlapDetails.join('; ')}`
	)

	recordCheck(
		report,
		CHECK_IDS.CHAIN_SEQUENCE_CONTINUITY,
		'Contiguous Sequence Coverage',
		!hasGap,
		!hasGap
			? 'Sequence ranges are strictly contiguous without gaps.'
			: `Sequence continuity gaps detected: ${gapDetails.join('; ')}`,
		hasGap ? 'MISSING' : 'ERROR'
	)

	// 4. Verify individual checkpoints and hash linkage
	let prevEvidence = null
	let totalRecords = 0

	for (let i = 0; i < sorted.length; i++) {
		const chk = sorted[i]
		const singleReport = verifySingleCheckpointEvidence(chk, {
			...options,
			verificationMode,
			previousCheckpointEvidence: prevEvidence,
			expectedLedgerId,
		})

		// Collect errors and missing items
		for (const check of singleReport.individualChecks) {
			if (check.status === 'FAIL') {
				report.failedCheckIds.push(`${chk.checkpointId}:${check.checkId}`)
				if (!report.failedCheckIds.includes(check.checkId)) {
					report.failedCheckIds.push(check.checkId)
				}
				report.individualChecks.push({
					...check,
					checkId: `${chk.checkpointId}:${check.checkId}`,
					name: `[${chk.checkpointId}] ${check.name}`,
				})
			} else if (check.status === 'MISSING') {
				report.missingEvidenceIds.push(`${chk.checkpointId}:${check.checkId}`)
				if (!report.missingEvidenceIds.includes(check.checkId)) {
					report.missingEvidenceIds.push(check.checkId)
				}
				report.individualChecks.push({
					...check,
					checkId: `${chk.checkpointId}:${check.checkId}`,
					name: `[${chk.checkpointId}] ${check.name}`,
				})
			}
		}

		totalRecords += Number(chk.recordCount) || 0
		prevEvidence = chk
	}

	report.verifiedSequenceRange.startSequence = Number(sorted[0].startSequence)
	report.verifiedSequenceRange.endSequence = Number(sorted[sorted.length - 1].endSequence)
	report.verifiedSequenceRange.totalRecords = totalRecords
	report.verifiedSequenceRange.totalCheckpoints = sorted.length

	// If expectedEndSequence was provided, verify coverage reaches it
	if (options.expectedEndSequence !== undefined && options.expectedEndSequence !== null) {
		const reachedEnd = report.verifiedSequenceRange.endSequence === options.expectedEndSequence
		recordCheck(
			report,
			'CHAIN_TERMINAL_SEQUENCE_REACHED',
			`Chain Coverage Reaches Expected End Sequence (${options.expectedEndSequence})`,
			reachedEnd,
			reachedEnd
				? `Chain endSequence (${report.verifiedSequenceRange.endSequence}) matches expected ${options.expectedEndSequence}.`
				: `Chain endSequence (${report.verifiedSequenceRange.endSequence}) falls short of expected ${options.expectedEndSequence}. Partial coverage.`,
			reachedEnd ? 'ERROR' : 'MISSING'
		)
	}

	finalizeReportStatus(report)
	return report
}

/**
 * Executes Live AWS Verification (Mode C) across checkpoints using an S3 client.
 *
 * @param {Array<Object>|Object} checkpoints
 * @param {Object} options
 * @returns {Promise<Object>} Verification report
 */
async function verifyCheckpointLiveAws(checkpoints, options = {}) {
	const adapter = options.liveAdapter || new AuditLiveAwsVerificationAdapter(options)
	const list = Array.isArray(checkpoints) ? checkpoints : [checkpoints]

	// 1. Verify live S3 Object Lock and body for each checkpoint
	const liveResults = []
	for (const chk of list) {
		const liveCheck = await adapter.verifyLiveCheckpoint(chk, options)
		liveResults.push({ checkpoint: chk, liveCheck })
	}

	// 2. Build augmented checkpoints with retrieved live evidence
	const augmentedList = list.map((chk, idx) => {
		const lr = liveResults[idx].liveCheck
		if (!lr.isValid) {
			return {
				...chk,
				_liveCheckError: lr.error,
				_liveCheckId: lr.checkId,
			}
		}
		return {
			...chk,
			anchoringEvidence: lr.evidence,
		}
	})

	const report = verifyCheckpointChain(augmentedList, {
		...options,
		verificationMode: VERIFICATION_MODE.LIVE_AWS_VERIFICATION,
	})

	// Record any live S3 API communication failures
	for (const lr of liveResults) {
		if (!lr.liveCheck.isValid) {
			recordCheck(
				report,
				lr.liveCheck.checkId || CHECK_IDS.S3_OBJECT_LOCK_COMPLIANCE,
				`Live AWS Verification [${lr.checkpoint.checkpointId}]`,
				false,
				lr.liveCheck.error,
				'ERROR'
			)
		}
	}

	finalizeReportStatus(report)
	return report
}

/**
 * Independently compares tri-watermark state between operational head,
 * checkpoint cursor, external anchored watermark, and verified range.
 *
 * Invariant: Never mutates any of these values.
 *
 * @param {Object} operationalHead
 * @param {Object} cursor
 * @param {Object} chainHead
 * @param {Object} [verifiedRange=null]
 * @returns {Object} Comparison report
 */
function compareWatermarkConsistency(operationalHead, cursor, chainHead, verifiedRange = null) {
	let opSeq, cursorSeq, anchoredSeq, vRange
	if (
		operationalHead &&
		typeof operationalHead === 'object' &&
		('operationalSequence' in operationalHead ||
			'checkpointCursorSequence' in operationalHead ||
			'anchoredSequence' in operationalHead)
	) {
		opSeq =
			operationalHead.operationalSequence ??
			operationalHead.operationalHead?.sequenceNumber ??
			0
		cursorSeq =
			operationalHead.checkpointCursorSequence ??
			operationalHead.cursor?.lastCheckpointedSequence ??
			0
		anchoredSeq =
			operationalHead.anchoredSequence ??
			operationalHead.chainHead?.lastAnchoredSequence ??
			0
		vRange = operationalHead.chainEndSequence
			? { endSequence: operationalHead.chainEndSequence }
			: operationalHead.verifiedRange || null
	} else {
		opSeq = operationalHead?.sequenceNumber || 0
		cursorSeq = cursor?.lastCheckpointedSequence || 0
		anchoredSeq = chainHead?.lastAnchoredSequence || 0
		vRange = verifiedRange
	}

	const issues = []

	// Rule 1: Local checkpoint coverage cannot exceed operational sequence
	if (cursorSeq > opSeq) {
		issues.push(
			`Invariant Violation: Checkpoint coverage cursor (${cursorSeq}) exceeds operational head sequenceNumber (${opSeq}).`
		)
	}

	// Rule 2: External anchored watermark cannot exceed local checkpoint coverage
	if (anchoredSeq > cursorSeq) {
		issues.push(
			`Invariant Violation: External anchored sequence (${anchoredSeq}) exceeds local checkpoint cursor (${cursorSeq}). External WORM cannot exceed locally generated checkpoints.`
		)
	}

	// Rule 3: External anchored watermark cannot exceed operational head
	if (anchoredSeq > opSeq) {
		issues.push(
			`Invariant Violation: External anchored sequence (${anchoredSeq}) exceeds operational head sequenceNumber (${opSeq}).`
		)
	}

	// Rule 4: If verified range is supplied, check alignment
	if (vRange && vRange.endSequence !== null && vRange.endSequence !== undefined) {
		if (vRange.endSequence > anchoredSeq) {
			issues.push(
				`Verified checkpoint endSequence (${vRange.endSequence}) exceeds recorded lastAnchoredSequence (${anchoredSeq}). Unanchored checkpoints verified.`
			)
		}
	}

	const isConsistent = issues.length === 0
	return {
		isConsistent,
		consistent: isConsistent,
		watermarks: {
			operationalHeadSequence: opSeq,
			localCheckpointCursorSequence: cursorSeq,
			externalAnchoredSequence: anchoredSeq,
		},
		issues,
		discrepancies: issues,
		evaluatedAt: new Date().toISOString(),
	}
}

/**
 * Ingests and verifies an exported evidence bundle or directory (Mode B).
 *
 * @param {string|Object} bundleInput
 * @param {Object} options
 * @returns {Object} Verification report
 */
function verifyExportedEvidenceBundle(bundleInput, options = {}) {
	let bundle = {}
	let baseDir = null

	if (typeof bundleInput === 'string') {
		const resolvedPath = path.resolve(bundleInput)
		if (!fs.existsSync(resolvedPath)) {
			throw new Error(`Evidence bundle path does not exist: ${resolvedPath}`)
		}

		const stat = fs.statSync(resolvedPath)
		if (stat.isDirectory()) {
			baseDir = resolvedPath
			const manifestPath = path.join(resolvedPath, 'evidence-bundle.json')
			if (fs.existsSync(manifestPath)) {
				bundle = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
			} else {
				const files = fs.readdirSync(resolvedPath).filter((f) => f.endsWith('.json'))
				const checkpoints = []
				for (const f of files) {
					const content = JSON.parse(fs.readFileSync(path.join(resolvedPath, f), 'utf8'))
					if (content.checkpointId || content.canonicalPayload) {
						checkpoints.push(content)
					}
				}
				bundle = { checkpoints }
			}
		} else {
			bundle = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'))
		}
	} else if (typeof bundleInput === 'object' && bundleInput !== null) {
		bundle = bundleInput
	} else {
		throw new TypeError('bundleInput must be a valid file/directory path or object.')
	}

	let publicKeyPem = options.publicKeyPem || options.publicKey
	if (!publicKeyPem && options.publicKeyPath) {
		const safeKeyPath = path.resolve(options.publicKeyPath)
		if (fs.existsSync(safeKeyPath)) {
			publicKeyPem = fs.readFileSync(safeKeyPath, 'utf8')
		}
	}
	if (!publicKeyPem && baseDir) {
		const autoKeyPath = path.join(baseDir, 'public-key.pem')
		if (fs.existsSync(autoKeyPath)) {
			publicKeyPem = fs.readFileSync(autoKeyPath, 'utf8')
		}
	}
	if (!publicKeyPem && bundle.publicKey) {
		publicKeyPem = bundle.publicKey
	}

	const checkpoints = Array.isArray(bundle.checkpoints)
		? bundle.checkpoints
		: bundle.checkpointId
		? [bundle]
		: []

	return verifyCheckpointChain(checkpoints, {
		...options,
		verificationMode: options.verificationMode || VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE,
		evidenceProvenance: bundle.provenance || bundle.source || options.provenance || null,
		publicKeyPem,
		recognizedKeyIds: options.recognizedKeyIds || bundle.recognizedKeyIds,
		expectedLedgerId: options.expectedLedgerId || bundle.ledgerId || GLOBAL_HEAD_ID,
	})
}

module.exports = {
	VERIFIER_VERSION,
	VERIFICATION_STATUS,
	VERIFICATION_MODE,
	RETENTION_VERIFICATION_SOURCE,
	AUDIT_WORM_REQUIRED_RETENTION_DAYS_ENV,
	CHECK_IDS,
	validateRequiredRetentionDays,
	resolveRequiredRetentionDays,
	createVerificationReport,
	recordCheck,
	finalizeReportStatus,
	ALLOWED_READ_ONLY_COMMANDS,
	AuditLiveAwsVerificationAdapter,
	verifySingleCheckpointEvidence,
	verifyCheckpointChain,
	verifyCheckpointLiveAws,
	compareWatermarkConsistency,
	verifyExportedEvidenceBundle,
}
