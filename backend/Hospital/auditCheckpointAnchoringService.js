/**
 * Audit Checkpoint External WORM Anchoring Service
 * Namma Blood — Stage B3.5.3 External WORM Anchoring & S3 Object Lock
 *
 * Implements the external anchoring pipeline taking locally persisted PENDING
 * checkpoints and anchoring them into AWS S3 Object Lock in COMPLIANCE mode.
 *
 * Security & Architectural Invariants:
 * 1. Sequential anchoring: checkpoints must be anchored strictly in monotonic order.
 * 2. Watermark Decoupling: AuditChainHead.lastAnchoredSequence advances ONLY after
 *    successful post-upload verification of the exact S3 version.
 * 3. Never touches or mutates AuditChainHead.sequenceNumber or hash.
 * 4. Detached cryptographic signatures using RFC 8032 Ed25519.
 * 5. Strictly enforces Object Lock COMPLIANCE mode and positive retention duration.
 * 6. Distributed claim & lease fencing prevents race conditions and split-brain uploads.
 * 7. 14-point independent post-upload verification pipeline before any MongoDB commit.
 * 8. Complete rollback and fail-closed behavior on signature, upload, or verification errors.
 */

const crypto = require('crypto')
const mongoose = require('mongoose')
const { AuditCheckpoint } = require('./auditCheckpointModel')
const { AuditChainHead, GLOBAL_HEAD_ID } = require('./auditChainHeadModel')
const {
	AuditWormStorageAdapter,
	buildS3ObjectKey,
	TARGET_OBJECT_LOCK_MODE,
} = require('./auditWormStorageAdapter')
const {
	signCheckpointPayload,
	verifyCheckpointSignature,
	resolvePrivateKey,
	resolvePublicKey,
	parseSigningConfig,
} = require('./auditSigningService')

const DEFAULT_CLAIM_TTL_MS = 60 * 1000 // 60 seconds
const DEFAULT_MAX_STALE_AGE_MS = 2 * 60 * 1000 // 120 seconds

/**
 * Custom error class for anchoring pipeline failures.
 */
class AnchoringPipelineError extends Error {
	constructor(message, code, details = {}) {
		super(message)
		this.name = 'AnchoringPipelineError'
		this.code = code
		this.details = details
		this.statusCode = details.statusCode || 500
	}
}

/**
 * Determines the next eligible checkpoint awaiting external WORM anchoring.
 * Checkpoints must be anchored sequentially without sequence gaps.
 *
 * @param {string} [ledgerId=GLOBAL_HEAD_ID]
 * @param {Object} [options={}]
 * @returns {Promise<Object|null>} Next eligible AuditCheckpoint document or null
 */
async function determineNextEligibleAnchoringCheckpoint(ledgerId = GLOBAL_HEAD_ID, options = {}) {
	const session = options.session || null

	// 1. Fetch current external watermark from AuditChainHead
	const headQuery = AuditChainHead.findById(ledgerId)
	if (session) headQuery.session(session)
	const head = await headQuery.lean()

	const currentAnchoredSequence = head ? head.lastAnchoredSequence || 0 : 0
	const expectedStartSequence = currentAnchoredSequence + 1

	// 2. Query for next contiguous checkpoint starting at expectedStartSequence
	const checkpointQuery = AuditCheckpoint.findOne({
		ledgerId,
		startSequence: expectedStartSequence,
		generationStatus: 'PENDING',
		anchoringStatus: { $ne: 'ANCHORED' },
	}).sort({ startSequence: 1 })

	if (session) checkpointQuery.session(session)
	const candidate = await checkpointQuery.exec()

	if (!candidate) {
		return null
	}

	// 3. Verify sequence continuity invariant
	if (candidate.startSequence !== expectedStartSequence) {
		throw new AnchoringPipelineError(
			`Sequence continuity broken: expected startSequence ${expectedStartSequence}, found ${candidate.startSequence}.`,
			'ANCHORING_SEQUENCE_GAP',
			{ expectedStartSequence, foundStartSequence: candidate.startSequence }
		)
	}

	// 4. Verify previous checkpoint hash continuity if previous checkpoint was anchored
	if (currentAnchoredSequence > 0 && head.lastAnchoredHash) {
		if (candidate.previousCheckpointHash !== head.lastAnchoredHash) {
			throw new AnchoringPipelineError(
				`Previous checkpoint hash mismatch: expected '${head.lastAnchoredHash}', found '${candidate.previousCheckpointHash}'.`,
				'ANCHORING_HASH_DISCONTINUITY',
				{
					expectedHash: head.lastAnchoredHash,
					foundHash: candidate.previousCheckpointHash,
				}
			)
		}
	}

	return candidate
}

/**
 * Acquires an exclusive distributed anchoring claim on a checkpoint.
 *
 * @param {string} checkpointId
 * @param {string} workerId
 * @param {number} [claimTtlMs=DEFAULT_CLAIM_TTL_MS]
 * @param {Object} [options={}]
 * @returns {Promise<{ claimed: boolean, checkpoint?: Object, leaseToken?: string, reason?: string }>}
 */
async function acquireAnchoringClaim(
	checkpointId,
	workerId,
	claimTtlMs = DEFAULT_CLAIM_TTL_MS,
	options = {}
) {
	if (!checkpointId || typeof checkpointId !== 'string') {
		throw new TypeError('checkpointId must be a non-empty string.')
	}
	if (!workerId || typeof workerId !== 'string') {
		throw new TypeError('workerId must be a non-empty string.')
	}

	const now = new Date()
	const claimExpiresAt = new Date(now.getTime() + claimTtlMs)
	const leaseToken = crypto.randomBytes(32).toString('hex')

	const filter = {
		checkpointId,
		anchoringStatus: { $ne: 'ANCHORED' },
		$or: [
			{
				anchoringStatus: { $in: ['PENDING', 'FAILED'] },
				$or: [
					{ anchoringClaimExpiresAt: null },
					{ anchoringClaimExpiresAt: { $lt: now } },
				],
			},
			{
				anchoringStatus: { $in: ['SIGNING', 'UPLOADING', 'UPLOADED', 'VERIFYING'] },
				anchoringClaimExpiresAt: { $lt: now },
			},
		],
	}

	const update = {
		$set: {
			anchoringStatus: 'SIGNING',
			anchoringClaimedBy: workerId,
			anchoringClaimExpiresAt: claimExpiresAt,
			anchoringLeaseToken: leaseToken,
			anchoringErrorCode: null,
			anchoringErrorMessage: null,
			anchoringErrorAt: null,
		},
		$inc: { anchoringAttempt: 1 },
	}

	const findOptions = { new: true }
	if (options.session) findOptions.session = options.session

	const checkpoint = await AuditCheckpoint.findOneAndUpdate(filter, update, findOptions).exec()

	if (!checkpoint) {
		return {
			claimed: false,
			reason: 'Checkpoint is already claimed by an active worker or not in PENDING/FAILED status.',
		}
	}

	return {
		claimed: true,
		checkpoint,
		leaseToken,
		claimExpiresAt,
	}
}

/**
 * Releases an anchoring claim on error or cancellation.
 *
 * @param {string} checkpointId
 * @param {string} leaseToken
 * @param {Object} [errorDetails=null]
 * @param {Object} [options={}]
 * @returns {Promise<boolean>}
 */
async function releaseAnchoringClaim(
	checkpointId,
	leaseToken,
	errorDetails = null,
	options = {}
) {
	const filter = {
		checkpointId,
		anchoringLeaseToken: leaseToken,
		anchoringStatus: { $ne: 'ANCHORED' },
	}

	const update = {
		$set: {
			anchoringStatus: 'FAILED',
			anchoringClaimedBy: null,
			anchoringClaimExpiresAt: null,
			anchoringLeaseToken: null,
			anchoringErrorCode: errorDetails?.code || 'ANCHORING_RELEASED',
			anchoringErrorMessage: errorDetails?.message || 'Anchoring claim released.',
			anchoringErrorAt: new Date(),
		},
	}

	const findOptions = {}
	if (options.session) findOptions.session = options.session

	const res = await AuditCheckpoint.updateOne(filter, update, findOptions).exec()
	return res.modifiedCount > 0
}

/**
 * Reconciles expired stale anchoring claims, marking them FAILED so they can be retried.
 *
 * @param {Object} [options={}]
 * @param {number} [options.maxStaleAgeMs=DEFAULT_MAX_STALE_AGE_MS]
 * @returns {Promise<{ staleCount: number, reconciledCheckpoints: string[] }>}
 */
async function reconcileStaleAnchoringClaims(options = {}) {
	const maxStaleAgeMs = options.maxStaleAgeMs || DEFAULT_MAX_STALE_AGE_MS
	const staleThreshold = new Date(Date.now() - maxStaleAgeMs)

	const filter = {
		anchoringStatus: { $in: ['SIGNING', 'UPLOADING', 'UPLOADED', 'VERIFYING'] },
		$or: [
			{ anchoringClaimExpiresAt: { $lt: new Date() } },
			{ updatedAt: { $lt: staleThreshold } },
		],
	}

	const staleDocs = await AuditCheckpoint.find(filter).select('checkpointId').lean()
	if (staleDocs.length === 0) {
		return { staleCount: 0, reconciledCheckpoints: [] }
	}

	const checkpointIds = staleDocs.map((d) => d.checkpointId)

	await AuditCheckpoint.updateMany(
		{ checkpointId: { $in: checkpointIds } },
		{
			$set: {
				anchoringStatus: 'FAILED',
				anchoringClaimedBy: null,
				anchoringClaimExpiresAt: null,
				anchoringLeaseToken: null,
				anchoringErrorCode: 'STALE_ANCHORING_CLAIM_EXPIRED',
				anchoringErrorMessage: 'Anchoring worker lease expired before completion.',
				anchoringErrorAt: new Date(),
			},
		}
	)

	return {
		staleCount: checkpointIds.length,
		reconciledCheckpoints: checkpointIds,
	}
}

/**
 * Performs strict, independent 14-point post-upload verification on the S3 Object Lock version.
 *
 * @param {Object} checkpoint - The local AuditCheckpoint document
 * @param {Object} s3Evidence - Upload receipt containing bucket, objectKey, versionId, sha256Checksum, retentionUntil
 * @param {Object} options - Options including storageAdapter, publicKeyPem, signingConfig, head
 * @returns {Promise<{ verified: boolean, details: Object }>}
 */
async function verifyAnchoredCheckpointVersion(checkpoint, s3Evidence, options = {}) {
	const { storageAdapter, publicKeyPem, signingConfig, head } = options

	if (!storageAdapter) {
		throw new TypeError('storageAdapter is required for post-upload verification.')
	}
	if (!publicKeyPem) {
		throw new TypeError('publicKeyPem is required for detached signature verification.')
	}

	// 1. Verify exact S3 Object Key format and match
	const expectedObjectKey = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
	if (s3Evidence.objectKey !== expectedObjectKey) {
		throw new AnchoringPipelineError(
			`S3 Object Key mismatch: expected '${expectedObjectKey}', found '${s3Evidence.objectKey}'.`,
			'KEY_MISMATCH'
		)
	}

	// 2. Verify exact S3 VersionId exists and is non-empty string
	if (
		!s3Evidence.versionId ||
		typeof s3Evidence.versionId !== 'string' ||
		s3Evidence.versionId.trim() === '' ||
		s3Evidence.versionId === 'null'
	) {
		throw new AnchoringPipelineError(
			'Missing or invalid S3 VersionId on upload receipt. Bucket versioning must be enabled.',
			'MISSING_VERSION_ID'
		)
	}

	// 3. Fetch exact version body independently from S3
	const retrieved = await storageAdapter.getObjectVersion({
		bucket: s3Evidence.bucket,
		objectKey: s3Evidence.objectKey,
		versionId: s3Evidence.versionId,
	})

	if (!retrieved || !retrieved.body) {
		throw new AnchoringPipelineError(
			`Failed to retrieve body for S3 object '${s3Evidence.objectKey}' version '${s3Evidence.versionId}'.`,
			'S3_GET_FAILED'
		)
	}

	// 4. Verify retrieved body byte-for-byte checksum matches upload receipt
	const retrievedSha256 = crypto.createHash('sha256').update(retrieved.body, 'utf8').digest('hex')
	if (retrievedSha256 !== s3Evidence.sha256Checksum) {
		throw new AnchoringPipelineError(
			`Body checksum mismatch: expected '${s3Evidence.sha256Checksum}', calculated '${retrievedSha256}'.`,
			'CHECKSUM_MISMATCH'
		)
	}

	// 5. Parse retrieved JSON body
	let parsedEvidence
	try {
		parsedEvidence = JSON.parse(retrieved.body)
	} catch (err) {
		throw new AnchoringPipelineError(
			`Retrieved S3 object body is not valid JSON: ${err.message}`,
			'INVALID_JSON'
		)
	}

	// 6. Verify core metadata fields match local checkpoint
	if (parsedEvidence.checkpointId !== checkpoint.checkpointId) {
		throw new AnchoringPipelineError(
			`Retrieved checkpointId '${parsedEvidence.checkpointId}' does not match expected '${checkpoint.checkpointId}'.`,
			'METADATA_MISMATCH'
		)
	}
	if (parsedEvidence.startSequence !== checkpoint.startSequence) {
		throw new AnchoringPipelineError(
			`Retrieved startSequence '${parsedEvidence.startSequence}' does not match expected '${checkpoint.startSequence}'.`,
			'METADATA_MISMATCH'
		)
	}
	if (parsedEvidence.endSequence !== checkpoint.endSequence) {
		throw new AnchoringPipelineError(
			`Retrieved endSequence '${parsedEvidence.endSequence}' does not match expected '${checkpoint.endSequence}'.`,
			'METADATA_MISMATCH'
		)
	}
	if (parsedEvidence.checkpointHash !== checkpoint.checkpointHash) {
		throw new AnchoringPipelineError(
			`Retrieved checkpointHash '${parsedEvidence.checkpointHash}' does not match expected '${checkpoint.checkpointHash}'.`,
			'METADATA_MISMATCH'
		)
	}

	// 7. Verify retrieved canonical payload matches local canonical payload
	if (parsedEvidence.canonicalPayload !== checkpoint.canonicalPayload) {
		throw new AnchoringPipelineError(
			'Retrieved canonicalPayload does not match local canonicalPayload byte-for-byte.',
			'PAYLOAD_MISMATCH'
		)
	}

	// 8. Re-hash retrieved canonical payload and verify equals checkpointHash
	const calculatedHash = crypto
		.createHash('sha256')
		.update(parsedEvidence.canonicalPayload, 'utf8')
		.digest('hex')
	if (calculatedHash !== checkpoint.checkpointHash) {
		throw new AnchoringPipelineError(
			`Canonical payload hash mismatch: calculated '${calculatedHash}', expected '${checkpoint.checkpointHash}'.`,
			'HASH_MISMATCH'
		)
	}

	// 9. Verify detached Ed25519 signature on canonical payload
	if (!parsedEvidence.signature || !parsedEvidence.signature.signature) {
		throw new AnchoringPipelineError(
			'Missing detached cryptographic signature on retrieved S3 evidence document.',
			'MISSING_SIGNATURE'
		)
	}

	const sigVerifyResult = verifyCheckpointSignature(
		parsedEvidence.canonicalPayload,
		parsedEvidence.signature.signature,
		publicKeyPem,
		signingConfig
	)

	if (!sigVerifyResult.isValid) {
		throw new AnchoringPipelineError(
			`Detached signature verification failed: ${sigVerifyResult.error}`,
			'SIGNATURE_VERIFICATION_FAILED'
		)
	}

	// 10. Query S3 Object Lock retention metadata independently
	const retentionMeta = await storageAdapter.getObjectRetention({
		bucket: s3Evidence.bucket,
		objectKey: s3Evidence.objectKey,
		versionId: s3Evidence.versionId,
	})

	// 11. Verify Object Lock mode is strictly COMPLIANCE
	if (retentionMeta.mode !== TARGET_OBJECT_LOCK_MODE) {
		throw new AnchoringPipelineError(
			`Security Violation: Object Lock mode is '${retentionMeta.mode}', expected strictly '${TARGET_OBJECT_LOCK_MODE}'.`,
			'INVALID_OBJECT_LOCK_MODE'
		)
	}

	// 12. Verify RetainUntilDate is strictly in the future
	const now = new Date()
	if (retentionMeta.retainUntilDate <= now) {
		throw new AnchoringPipelineError(
			`RetainUntilDate '${retentionMeta.retainUntilDate.toISOString()}' is not in the future.`,
			'EXPIRED_RETENTION_DATE'
		)
	}

	// 13. Verify sequence continuity against current ledger chain head
	if (head) {
		const currentAnchored = head.lastAnchoredSequence || 0

		if (checkpoint.anchoringStatus === 'ANCHORED') {
			// For an already anchored checkpoint, it must lie within the anchored watermark
			if (checkpoint.endSequence > currentAnchored) {
				throw new AnchoringPipelineError(
					`Sequence boundary violation: anchored checkpoint endSequence (${checkpoint.endSequence}) exceeds head.lastAnchoredSequence (${currentAnchored}).`,
					'SEQUENCE_BOUNDARY_VIOLATION'
				)
			}
		} else {
			// For a pending/in-flight checkpoint being verified prior to watermark advancement:
			if (checkpoint.startSequence !== currentAnchored + 1) {
				throw new AnchoringPipelineError(
					`Sequence continuity violation: checkpoint startSequence (${checkpoint.startSequence}) must equal head.lastAnchoredSequence + 1 (${currentAnchored + 1}).`,
					'SEQUENCE_CONTINUITY_VIOLATION'
				)
			}

			// Hash chain continuity
			if (currentAnchored > 0 && head.lastAnchoredHash) {
				if (checkpoint.previousCheckpointHash !== head.lastAnchoredHash) {
					throw new AnchoringPipelineError(
						`Hash chain continuity violation: checkpoint previousCheckpointHash does not match head.lastAnchoredHash.`,
						'HASH_CONTINUITY_VIOLATION'
					)
				}
			}
		}

		// Ledger head sequence upper bound
		if (checkpoint.endSequence > head.sequenceNumber) {
			throw new AnchoringPipelineError(
				`Ledger boundary violation: checkpoint endSequence (${checkpoint.endSequence}) exceeds operational head sequenceNumber (${head.sequenceNumber}).`,
				'LEDGER_BOUNDARY_VIOLATION'
			)
		}
	}

	return {
		verified: true,
		details: {
			objectKey: s3Evidence.objectKey,
			versionId: s3Evidence.versionId,
			sha256Checksum: retrievedSha256,
			objectLockMode: retentionMeta.mode,
			retentionUntil: retentionMeta.retainUntilDate,
			signature: parsedEvidence.signature.signature,
			signatureAlgorithm: sigVerifyResult.algorithm,
			signingKeyId: sigVerifyResult.keyId,
		},
	}
}

/**
 * Mandatory pre-upload reconciliation workflow:
 * Inspects deterministic object key in S3 before issuing PutObjectCommand.
 *
 * Case A: No existing object -> uploads signed evidence with ObjectLock COMPLIANCE.
 * Case B: Existing object with matching content -> retrieves, verifies, and reuses VersionId WITHOUT PutObject.
 * Case C: Existing object with mismatched content -> fails closed, no PutObject, no watermark advancement.
 * Case D: Multiple versions -> inspects all versions, reuses if unambiguous and matching, fails closed if conflicting.
 *
 * @param {Object} params
 * @param {AuditWormStorageAdapter} params.storageAdapter
 * @param {Object} params.checkpoint
 * @param {Object} params.expectedEvidenceDocument
 * @param {string} params.publicKeyPem
 * @param {Object} params.signingConfig
 * @param {number} [params.retentionDays]
 * @returns {Promise<{ receipt: Object, reusedExisting: boolean }>}
 */
async function reconcileStorageBeforeUpload(params) {
	const {
		storageAdapter,
		checkpoint,
		expectedEvidenceDocument,
		publicKeyPem,
		signingConfig,
		retentionDays,
	} = params

	const objectKey = buildS3ObjectKey(checkpoint.ledgerId, checkpoint.checkpointId)
	const existingVersions = await storageAdapter.listObjectVersions({ objectKey })

	// Case A: No existing object found in S3
	if (!existingVersions || existingVersions.length === 0) {
		const uploadReceipt = await storageAdapter.uploadCheckpointEvidence({
			ledgerId: checkpoint.ledgerId,
			checkpointId: checkpoint.checkpointId,
			evidenceDocument: expectedEvidenceDocument,
			retentionDays,
		})
		return {
			receipt: uploadReceipt,
			reusedExisting: false,
		}
	}

	// S3 already holds one or more versions for this deterministic key!
	// Inspect every available version candidate against expected evidence.
	const validMatchingVersions = []
	const conflictingOrInvalidVersions = []

	for (const v of existingVersions) {
		try {
			if (!v.versionId || typeof v.versionId !== 'string' || v.versionId === 'null') {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: 'MISSING_OR_NULL_VERSION_ID',
				})
				continue
			}

			// 1. Retrieve exact version
			const retrieved = await storageAdapter.getObjectVersion({
				objectKey,
				versionId: v.versionId,
			})

			// 2. Verify SHA-256 content checksum of body
			const calculatedSha256 = crypto
				.createHash('sha256')
				.update(retrieved.body, 'utf8')
				.digest('hex')

			if (calculatedSha256 !== retrieved.sha256Checksum) {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: 'CHECKSUM_MISMATCH',
				})
				continue
			}

			// 3. Parse JSON body
			let parsed
			try {
				parsed = JSON.parse(retrieved.body)
			} catch (parseErr) {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: 'INVALID_JSON_BODY',
				})
				continue
			}

			// 4. Verify complete evidence envelope against local checkpoint
			const envelopeMatches =
				parsed.checkpointId === checkpoint.checkpointId &&
				parsed.ledgerId === checkpoint.ledgerId &&
				parsed.startSequence === checkpoint.startSequence &&
				parsed.endSequence === checkpoint.endSequence &&
				parsed.recordCount === checkpoint.recordCount &&
				parsed.firstRecordHash === checkpoint.firstRecordHash &&
				parsed.lastRecordHash === checkpoint.lastRecordHash &&
				parsed.previousCheckpointHash === checkpoint.previousCheckpointHash &&
				parsed.checkpointHash === checkpoint.checkpointHash &&
				parsed.canonicalPayload === checkpoint.canonicalPayload

			if (!envelopeMatches) {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: 'ENVELOPE_METADATA_OR_PAYLOAD_MISMATCH',
				})
				continue
			}

			// 5. Recompute and verify checkpoint hash
			const recomputedCheckpointHash = crypto
				.createHash('sha256')
				.update(parsed.canonicalPayload, 'utf8')
				.digest('hex')

			if (recomputedCheckpointHash !== checkpoint.checkpointHash) {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: 'CHECKPOINT_HASH_MISMATCH',
				})
				continue
			}

			// 6. Verify Ed25519 signature
			if (!parsed.signature || !parsed.signature.signature) {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: 'MISSING_DETACHED_SIGNATURE',
				})
				continue
			}

			const sigResult = verifyCheckpointSignature(
				parsed.canonicalPayload,
				parsed.signature.signature,
				publicKeyPem,
				signingConfig
			)

			if (!sigResult.isValid) {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: `SIGNATURE_VERIFICATION_FAILED: ${sigResult.error}`,
				})
				continue
			}

			// 7. Verify S3 Object Lock retention metadata
			const retentionMeta = await storageAdapter.getObjectRetention({
				objectKey,
				versionId: v.versionId,
			})

			// 8. Verify mode is strictly COMPLIANCE
			if (retentionMeta.mode !== TARGET_OBJECT_LOCK_MODE) {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: `NON_COMPLIANCE_MODE_${retentionMeta.mode}`,
				})
				continue
			}

			// 9. Verify RetainUntilDate is strictly in the future
			if (!retentionMeta.retainUntilDate || retentionMeta.retainUntilDate <= new Date()) {
				conflictingOrInvalidVersions.push({
					versionId: v.versionId,
					reason: 'EXPIRED_OR_MISSING_RETENTION_DATE',
				})
				continue
			}

			validMatchingVersions.push({
				versionId: v.versionId,
				eTag: retrieved.eTag || v.eTag,
				sha256Checksum: retrieved.sha256Checksum,
				retentionUntil: retentionMeta.retainUntilDate,
				objectLockMode: retentionMeta.mode,
				lastModified: v.lastModified,
			})
		} catch (err) {
			conflictingOrInvalidVersions.push({
				versionId: v.versionId,
				reason: err.message || 'VERSION_VERIFICATION_ERROR',
			})
		}
	}

	// Case C & Case D: Fail closed if ANY version contains conflicting, mismatched, or illegal evidence
	if (conflictingOrInvalidVersions.length > 0) {
		const incidentDetails = {
			incident: 'STORAGE_INTEGRITY_MISMATCH',
			ledgerId: checkpoint.ledgerId,
			checkpointId: checkpoint.checkpointId,
			objectKey,
			totalVersionsFound: existingVersions.length,
			conflictingCount: conflictingOrInvalidVersions.length,
			reasons: conflictingOrInvalidVersions.map((c) => c.reason),
			timestamp: new Date().toISOString(),
		}

		console.error(
			`[AUDIT_WORM_INCIDENT] ${JSON.stringify({
				incident: incidentDetails.incident,
				ledgerId: incidentDetails.ledgerId,
				checkpointId: incidentDetails.checkpointId,
				objectKey: incidentDetails.objectKey,
				totalVersions: incidentDetails.totalVersionsFound,
				conflictingCount: incidentDetails.conflictingCount,
				reasons: incidentDetails.reasons,
			})}`
		)

		throw new AnchoringPipelineError(
			`Storage reconciliation failed: existing S3 object '${objectKey}' contains mismatched or conflicting version(s): [${conflictingOrInvalidVersions.map((c) => c.reason).join(', ')}].`,
			'STORAGE_INTEGRITY_MISMATCH',
			incidentDetails
		)
	}

	if (validMatchingVersions.length === 0) {
		throw new AnchoringPipelineError(
			`Storage reconciliation failed: no authoritative matching version found for S3 object '${objectKey}'.`,
			'NO_MATCHING_VERSION'
		)
	}

	// Case B & Case D (Multiple unambiguous matching versions):
	// Sort deterministically by lastModified ascending (earliest created version is authoritative)
	validMatchingVersions.sort((a, b) => a.lastModified.getTime() - b.lastModified.getTime())
	const authoritative = validMatchingVersions[0]

	const reusedReceipt = {
		bucket: storageAdapter.bucket,
		objectKey,
		versionId: authoritative.versionId,
		eTag: authoritative.eTag,
		sha256Checksum: authoritative.sha256Checksum,
		retentionUntil: authoritative.retentionUntil,
		objectLockMode: authoritative.objectLockMode,
		reusedExisting: true,
	}

	return {
		receipt: reusedReceipt,
		reusedExisting: true,
	}
}

/**
 * Anchors the next eligible local PENDING checkpoint into AWS S3 Object Lock.
 *
 * Orchestration steps:
 * 1. Find next eligible contiguous checkpoint.
 * 2. Acquire distributed claim and lease.
 * 3. Sign canonical payload using detached Ed25519 signature.
 * 4. Upload evidence document to AWS S3 Object Lock in COMPLIANCE mode.
 * 5. Retrieve exact S3 VersionId and execute independent 14-point verification pipeline.
 * 6. In a single MongoDB transaction:
 *    - Update AuditCheckpoint to ANCHORED with evidence.
 *    - Advance AuditChainHead.lastAnchoredSequence and lastAnchoredHash.
 *    - Assert AuditChainHead.sequenceNumber was NOT modified.
 *
 * @param {Object} [options={}]
 * @returns {Promise<{ anchored: boolean, checkpointId?: string, versionId?: string, reason?: string, error?: string }>}
 */
async function anchorNextCheckpoint(options = {}) {
	const ledgerId = options.ledgerId || GLOBAL_HEAD_ID
	const workerId = options.workerId || `anchoring-worker-${crypto.randomBytes(4).toString('hex')}`
	const claimTtlMs = options.claimTtlMs || DEFAULT_CLAIM_TTL_MS

	// Initialize or resolve storage adapter
	const storageAdapter =
		options.storageAdapter ||
		new AuditWormStorageAdapter({
			bucket: options.bucket,
			region: options.region,
			retentionDays: options.retentionDays,
			s3Client: options.s3Client,
		})

	// Resolve signing keys
	const signingConfig = parseSigningConfig(options.signingConfig || options)
	let privateKeyPem
	let publicKeyPem
	try {
		privateKeyPem = resolvePrivateKey(options.signingConfig || options)
		publicKeyPem = resolvePublicKey(options.signingConfig || options)
	} catch (err) {
		return {
			anchored: false,
			reason: 'SIGNING_KEY_ERROR',
			error: err.message,
		}
	}

	// 1. Determine next eligible checkpoint
	let candidate
	try {
		candidate = await determineNextEligibleAnchoringCheckpoint(ledgerId)
	} catch (err) {
		return {
			anchored: false,
			reason: err.code || 'DETERMINE_ELIGIBLE_ERROR',
			error: err.message,
		}
	}

	if (!candidate) {
		return {
			anchored: false,
			reason: 'NO_ELIGIBLE_CHECKPOINTS',
		}
	}

	// 2. Acquire distributed claim & lease
	const claimResult = await acquireAnchoringClaim(candidate.checkpointId, workerId, claimTtlMs)
	if (!claimResult.claimed) {
		return {
			anchored: false,
			reason: 'CLAIM_FAILED',
			error: claimResult.reason,
		}
	}

	const leaseToken = claimResult.leaseToken
	let currentCheckpoint = claimResult.checkpoint

	try {
		// 3. Detached Ed25519 Cryptographic Signing
		await AuditCheckpoint.updateOne(
			{ _id: currentCheckpoint._id, anchoringLeaseToken: leaseToken },
			{ $set: { anchoringStatus: 'SIGNING' } }
		)

		const signResult = signCheckpointPayload(
			currentCheckpoint.canonicalPayload,
			privateKeyPem,
			signingConfig
		)

		// 4. Construct S3 Evidence Document
		const evidenceDocument = {
			formatVersion: currentCheckpoint.formatVersion || 'v1',
			ledgerId: currentCheckpoint.ledgerId,
			checkpointId: currentCheckpoint.checkpointId,
			startSequence: currentCheckpoint.startSequence,
			endSequence: currentCheckpoint.endSequence,
			recordCount: currentCheckpoint.recordCount,
			firstRecordHash: currentCheckpoint.firstRecordHash,
			lastRecordHash: currentCheckpoint.lastRecordHash,
			previousCheckpointHash: currentCheckpoint.previousCheckpointHash,
			checkpointHash: currentCheckpoint.checkpointHash,
			payload: currentCheckpoint.payload,
			canonicalPayload: currentCheckpoint.canonicalPayload,
			generatedAt: currentCheckpoint.generatedAt
				? new Date(currentCheckpoint.generatedAt).toISOString()
				: new Date().toISOString(),
			scheduledHourUtc: currentCheckpoint.scheduledHourUtc,
			signature: {
				algorithm: signResult.algorithm,
				keyId: signResult.keyId,
				publicKey: publicKeyPem,
				signature: signResult.signature,
			},
		}

		// 5. Pre-upload storage reconciliation: inspect existing S3 object versions
		await AuditCheckpoint.updateOne(
			{ _id: currentCheckpoint._id, anchoringLeaseToken: leaseToken },
			{ $set: { anchoringStatus: 'UPLOADING' } }
		)

		const { receipt: uploadReceipt, reusedExisting } = await reconcileStorageBeforeUpload({
			storageAdapter,
			checkpoint: currentCheckpoint,
			expectedEvidenceDocument: evidenceDocument,
			publicKeyPem,
			signingConfig,
			retentionDays: options.retentionDays,
		})

		// 6. Transition to VERIFYING (recording exact S3 VersionId)
		await AuditCheckpoint.updateOne(
			{ _id: currentCheckpoint._id, anchoringLeaseToken: leaseToken },
			{
				$set: {
					anchoringStatus: 'VERIFYING',
					externalObjectKey: uploadReceipt.objectKey,
					externalObjectVersionId: uploadReceipt.versionId,
				},
			}
		)

		// 7. Independent Post-Upload Verification Pipeline
		const head = await AuditChainHead.findById(ledgerId).lean()
		const verification = await verifyAnchoredCheckpointVersion(
			currentCheckpoint,
			uploadReceipt,
			{
				storageAdapter,
				publicKeyPem,
				signingConfig,
				head,
			}
		)

		if (!verification.verified) {
			throw new AnchoringPipelineError(
				'Post-upload independent verification pipeline failed.',
				'VERIFICATION_FAILED'
			)
		}

		// 8. Commit: Transactional Watermark Advancement and Checkpoint ANCHORED Transition
		const mongoSession = await mongoose.startSession()
		try {
			await mongoSession.withTransaction(async () => {
				// Re-verify lease and doc under session
				const docInTx = await AuditCheckpoint.findOne({
					_id: currentCheckpoint._id,
					anchoringLeaseToken: leaseToken,
					anchoringStatus: { $ne: 'ANCHORED' },
				}).session(mongoSession)

				if (!docInTx) {
					throw new AnchoringPipelineError(
						'Fencing violation: checkpoint claim was invalidated or lease token expired.',
						'LEASE_FENCING_ERROR'
					)
				}

				// Check lease expiry
				if (docInTx.anchoringClaimExpiresAt && docInTx.anchoringClaimExpiresAt < new Date()) {
					throw new AnchoringPipelineError(
						'Lease expired before transactional commit.',
						'LEASE_EXPIRED'
					)
				}

				// Re-verify head under session
				const headInTx = await AuditChainHead.findById(ledgerId).session(mongoSession)
				if (!headInTx) {
					throw new AnchoringPipelineError(
						`AuditChainHead '${ledgerId}' not found.`,
						'HEAD_NOT_FOUND'
					)
				}

				const currentHeadSequence = headInTx.sequenceNumber
				const currentAnchored = headInTx.lastAnchoredSequence || 0

				// Verify monotonic continuity
				if (docInTx.startSequence !== currentAnchored + 1) {
					throw new AnchoringPipelineError(
						`Sequence continuity violated in transaction: expected ${currentAnchored + 1}, found ${docInTx.startSequence}.`,
						'TRANSACTION_SEQUENCE_GAP'
					)
				}

				const now = new Date()

				// Update AuditCheckpoint to ANCHORED
				docInTx.anchoringStatus = 'ANCHORED'
				docInTx.anchoredAt = now
				docInTx.externalObjectKey = uploadReceipt.objectKey
				docInTx.externalObjectVersionId = uploadReceipt.versionId
				docInTx.retentionUntil = uploadReceipt.retentionUntil
				docInTx.anchoringClaimedBy = null
				docInTx.anchoringClaimExpiresAt = null
				docInTx.anchoringLeaseToken = null
				docInTx.anchoringEvidence = {
					s3Bucket: uploadReceipt.bucket,
					s3ObjectKey: uploadReceipt.objectKey,
					s3VersionId: uploadReceipt.versionId,
					s3ETag: uploadReceipt.eTag,
					sha256Checksum: uploadReceipt.sha256Checksum,
					objectLockMode: uploadReceipt.objectLockMode,
					retentionUntil: uploadReceipt.retentionUntil,
					signature: signResult.signature,
					signatureAlgorithm: signResult.algorithm,
					signingKeyId: signResult.keyId,
					verifiedAt: now,
					anchoredAt: now,
					verificationStatus: 'VERIFIED',
				}

				await docInTx.save({ session: mongoSession })

				// Advance AuditChainHead anchored watermark ONLY
				headInTx.lastAnchoredSequence = docInTx.endSequence
				headInTx.lastAnchoredHash = docInTx.checkpointHash
				headInTx.lastAnchoredAt = now

				// Strict invariant: verify sequenceNumber was NOT changed
				if (headInTx.sequenceNumber !== currentHeadSequence) {
					throw new AnchoringPipelineError(
						'Invariant Violation: AuditChainHead sequenceNumber was modified during anchoring!',
						'HEAD_CORRUPTION_ERROR'
					)
				}

				await headInTx.save({ session: mongoSession })
			})
		} finally {
			await mongoSession.endSession()
		}

		return {
			anchored: true,
			checkpointId: currentCheckpoint.checkpointId,
			startSequence: currentCheckpoint.startSequence,
			endSequence: currentCheckpoint.endSequence,
			versionId: uploadReceipt.versionId,
			objectKey: uploadReceipt.objectKey,
			retentionUntil: uploadReceipt.retentionUntil,
			objectLockMode: uploadReceipt.objectLockMode,
			reusedExisting: Boolean(reusedExisting),
		}
	} catch (err) {
		// Fail-closed error handling: release claim and set FAILED
		await releaseAnchoringClaim(currentCheckpoint.checkpointId, leaseToken, {
			code: err.code || 'ANCHORING_ERROR',
			message: err.message,
		}).catch(() => {})

		return {
			anchored: false,
			checkpointId: currentCheckpoint.checkpointId,
			reason: err.code || 'ANCHORING_FAILED',
			error: err.message,
		}
	}
}

/**
 * Returns comprehensive anchoring telemetry and status for a ledger.
 *
 * @param {string} [ledgerId=GLOBAL_HEAD_ID]
 * @param {Object} [options={}]
 * @returns {Promise<Object>}
 */
async function getAnchoringStatus(ledgerId = GLOBAL_HEAD_ID, options = {}) {
	const session = options.session || null

	const headQuery = AuditChainHead.findById(ledgerId)
	if (session) headQuery.session(session)
	const head = await headQuery.lean()

	const counts = await AuditCheckpoint.aggregate([
		{ $match: { ledgerId } },
		{ $group: { _id: '$anchoringStatus', count: { $sum: 1 } } },
	])

	const statusCounts = {
		PENDING: 0,
		SIGNING: 0,
		UPLOADING: 0,
		UPLOADED: 0,
		VERIFYING: 0,
		ANCHORED: 0,
		FAILED: 0,
	}

	for (const row of counts) {
		if (row._id in statusCounts) {
			statusCounts[row._id] = row.count
		}
	}

	const nextEligible = await determineNextEligibleAnchoringCheckpoint(ledgerId, options).catch(
		() => null
	)

	return {
		ledgerId,
		headSequence: head?.sequenceNumber || 0,
		lastAnchoredSequence: head?.lastAnchoredSequence || 0,
		lastAnchoredHash: head?.lastAnchoredHash || '',
		lastAnchoredAt: head?.lastAnchoredAt || null,
		statusCounts,
		nextEligibleCheckpointId: nextEligible?.checkpointId || null,
		nextEligibleStartSequence: nextEligible?.startSequence || null,
	}
}

module.exports = {
	DEFAULT_CLAIM_TTL_MS,
	DEFAULT_MAX_STALE_AGE_MS,
	AnchoringPipelineError,
	determineNextEligibleAnchoringCheckpoint,
	acquireAnchoringClaim,
	releaseAnchoringClaim,
	reconcileStaleAnchoringClaims,
	verifyAnchoredCheckpointVersion,
	reconcileStorageBeforeUpload,
	anchorNextCheckpoint,
	getAnchoringStatus,
}
