/**
 * Audit Checkpoint Generation Service
 * Namma Blood — Stage B3.5.2 Hourly Audit Checkpoint Generation & Recovery
 *
 * Implements deterministic hourly checkpoint generation and transactional
 * persistence in local MongoDB.
 *
 * Architectural Invariants:
 * 1. Checks and verifies committed audit records in the range [cursor + 1, cursor + batchLimit].
 * 2. Deterministic payload generation and SHA-256 checkpoint hashing.
 * 3. Atomic state transitions: updates AuditCheckpointCursor only AFTER verified persistence.
 * 4. Operational Audit Chain Head (sequenceNumber, latestRecordHash, totalRecords) is NEVER mutated.
 * 5. External Anchored Watermark (lastAnchoredSequence, lastAnchoredHash) is NEVER advanced.
 * 6. Concurrency claims prevent overlapping workers or duplicate ranges.
 */

const crypto = require('crypto')
const mongoose = require('mongoose')
const {
	AuditCheckpoint,
	VALID_GENERATION_STATUSES,
} = require('./auditCheckpointModel')
const {
	AuditCheckpointCursor,
	GLOBAL_CHECKPOINT_CURSOR_ID,
	GENESIS_CHECKPOINT_HASH,
} = require('./auditCheckpointCursorModel')
const {
	AuditChainHead,
	GLOBAL_HEAD_ID,
	GENESIS_ANCHOR_HASH,
} = require('./auditChainHeadModel')
const {
	AdministrativeDecisionAudit,
} = require('./administrativeDecisionAuditModel')
const {
	calculateRecordHash,
	auditReaderService,
} = require('./auditIntegrityService')
const {
	constructCheckpointPayload,
	canonicalizeCheckpointPayload,
	calculateCheckpointHash,
	normalizeToUtcHourString,
	generateDeterministicCheckpointId,
} = require('./auditCheckpointPayloadService')
const { withTransaction } = require('../Utils/transactionHelper')

const DEFAULT_BATCH_LIMIT = 1000
const DEFAULT_CLAIM_TTL_MS = 60000 // 1 minute

/**
 * Retrieves or initializes the singleton AuditCheckpointCursor in MongoDB.
 *
 * @param {import('mongoose').ClientSession} [session=null]
 * @returns {Promise<Object>} Checkpoint cursor document
 */
async function getOrInitCheckpointCursor(session = null) {
	const options = { upsert: true, new: true, setDefaultsOnInsert: true }
	if (session) options.session = session

	return await AuditCheckpointCursor.findOneAndUpdate(
		{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
		{
			$setOnInsert: {
				ledgerId: GLOBAL_HEAD_ID,
				lastCheckpointedSequence: 0,
				lastCheckpointId: null,
				lastCheckpointHash: GENESIS_CHECKPOINT_HASH,
				lastCheckpointedAt: null,
				totalCheckpoints: 0,
				activeClaim: {
					claimId: null,
					leaseToken: null,
					workerId: null,
					startSequence: null,
					endSequence: null,
					claimedAt: null,
					expiresAt: null,
				},
			},
		},
		options
	)
}

/**
 * Determines the next eligible sequence range for checkpoint generation.
 *
 * @param {Object} [options={}]
 * @param {number} [options.batchLimit=DEFAULT_BATCH_LIMIT] - Maximum records per checkpoint
 * @param {string} [options.ledgerId=GLOBAL_HEAD_ID]
 * @param {import('mongoose').ClientSession} [options.session=null]
 * @returns {Promise<Object>} Range metadata
 */
async function determineEligibleSequenceRange(options = {}) {
	const ledgerId = options.ledgerId || GLOBAL_HEAD_ID
	const batchLimit = Math.max(1, Number(options.batchLimit || DEFAULT_BATCH_LIMIT))
	const session = options.session || null

	// 1. Read operational audit head
	const headQuery = AuditChainHead.findById(ledgerId)
	if (session) headQuery.session(session)
	const head = await headQuery.lean()

	const operationalSequence = head ? head.sequenceNumber : 0
	const operationalLatestHash = head ? head.latestRecordHash : GENESIS_ANCHOR_HASH

	// 2. Read checkpoint cursor
	const cursor = await getOrInitCheckpointCursor(session)
	const lastCheckpointedSequence = cursor.lastCheckpointedSequence

	if (operationalSequence <= lastCheckpointedSequence) {
		return {
			eligible: false,
			reason: 'NO_NEW_COMMITTED_RECORDS',
			lastCheckpointedSequence,
			operationalSequence,
			previousCheckpointHash: cursor.lastCheckpointHash,
		}
	}

	const startSequence = lastCheckpointedSequence + 1
	const endSequence = Math.min(operationalSequence, startSequence + batchLimit - 1)
	const recordCount = endSequence - startSequence + 1

	return {
		eligible: true,
		ledgerId,
		startSequence,
		endSequence,
		recordCount,
		previousCheckpointHash: cursor.lastCheckpointHash,
		operationalSequence,
		operationalLatestHash,
	}
}

/**
 * Verifies sequence continuity, cryptographic hash linkage, and content integrity
 * across the specified audit ledger range before checkpoint generation.
 *
 * @param {number} startSequence
 * @param {number} endSequence
 * @param {import('mongoose').ClientSession} [session=null]
 * @returns {Promise<{ verified: boolean, firstRecordHash: string, lastRecordHash: string, count: number }>}
 */
async function verifyAuditRangeIntegrity(startSequence, endSequence, session = null) {
	const expectedCount = endSequence - startSequence + 1

	const query = AdministrativeDecisionAudit.find({
		sequenceNumber: { $gte: startSequence, $lte: endSequence },
	})
		.sort({ sequenceNumber: 1 })
		.lean()
	if (session) query.session(session)

	const records = await query

	if (records.length !== expectedCount) {
		throw new Error(
			`Audit Ledger Incomplete: expected ${expectedCount} records in range [${startSequence}, ${endSequence}], but found ${records.length}. Gaps or missing records detected.`
		)
	}

	// Determine expected starting previousRecordHash
	let expectedPrevHash
	if (startSequence === 1) {
		expectedPrevHash = GENESIS_ANCHOR_HASH
	} else {
		// Fetch predecessor record
		const predQuery = AdministrativeDecisionAudit.findOne({
			sequenceNumber: startSequence - 1,
		}).lean()
		if (session) predQuery.session(session)
		const predecessor = await predQuery

		if (!predecessor) {
			throw new Error(
				`Audit Ledger Predecessor Missing: record at sequence ${startSequence - 1} could not be found to verify range start.`
			)
		}
		expectedPrevHash = predecessor.recordHash
	}

	let currentExpectedSeq = startSequence
	for (let i = 0; i < records.length; i++) {
		const rec = records[i]

		if (rec.sequenceNumber !== currentExpectedSeq) {
			throw new Error(
				`Sequence Discontinuity at index ${i}: expected sequenceNumber ${currentExpectedSeq}, found ${rec.sequenceNumber}.`
			)
		}

		if (rec.previousRecordHash !== expectedPrevHash) {
			throw new Error(
				`Hash Linkage Break at sequence ${rec.sequenceNumber}: expected previousRecordHash '${expectedPrevHash}', found '${rec.previousRecordHash}'.`
			)
		}

		const recomputedHash = calculateRecordHash(rec)
		if (rec.recordHash !== recomputedHash) {
			throw new Error(
				`Data Tampering Detected at sequence ${rec.sequenceNumber}: stored hash '${rec.recordHash}' does not match recomputed '${recomputedHash}'.`
			)
		}

		expectedPrevHash = rec.recordHash
		currentExpectedSeq++
	}

	return {
		verified: true,
		firstRecordHash: records[0].recordHash,
		lastRecordHash: records[records.length - 1].recordHash,
		count: records.length,
	}
}

/**
 * Acquires a distributed generation claim on the cursor with a time-to-live lease
 * and a cryptographically unpredictable lease token.
 *
 * @param {string} workerId
 * @param {number} claimTtlMs
 * @param {number} startSequence
 * @param {number} endSequence
 * @returns {Promise<{ acquired: boolean, claimId: string|null, leaseToken: string|null, currentClaim: Object|null }>}
 */
async function acquireGenerationClaim(workerId, claimTtlMs, startSequence, endSequence) {
	// Ensure cursor document exists
	await getOrInitCheckpointCursor()

	const now = new Date()
	const expiresAt = new Date(now.getTime() + claimTtlMs)
	const claimId = `claim-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
	const leaseToken = crypto.randomBytes(32).toString('hex')

	// Atomically claim if activeClaim is null OR expired
	const updatedCursor = await AuditCheckpointCursor.findOneAndUpdate(
		{
			_id: GLOBAL_CHECKPOINT_CURSOR_ID,
			$or: [
				{ 'activeClaim.claimId': null },
				{ 'activeClaim.leaseToken': null },
				{ 'activeClaim.expiresAt': { $lte: now } },
			],
		},
		{
			$set: {
				activeClaim: {
					claimId,
					leaseToken,
					workerId,
					startSequence,
					endSequence,
					claimedAt: now,
					expiresAt,
				},
			},
		},
		{ new: true }
	)

	if (updatedCursor && updatedCursor.activeClaim?.claimId === claimId) {
		return {
			acquired: true,
			claimId,
			leaseToken,
			currentClaim: updatedCursor.activeClaim,
		}
	}

	const currentCursor = await AuditCheckpointCursor.findById(
		GLOBAL_CHECKPOINT_CURSOR_ID
	).lean()
	return {
		acquired: false,
		claimId: null,
		leaseToken: null,
		currentClaim: currentCursor ? currentCursor.activeClaim : null,
	}
}

/**
 * Releases a distributed generation claim on the cursor.
 * Requires matching claimId and leaseToken to prevent an expired worker
 * from clearing a replacement worker's active lease.
 *
 * @param {string} claimId
 * @param {string} [leaseToken=null]
 * @param {import('mongoose').ClientSession} [session=null]
 */
async function releaseGenerationClaim(claimId, leaseToken = null, session = null) {
	const filter = {
		_id: GLOBAL_CHECKPOINT_CURSOR_ID,
		'activeClaim.claimId': claimId,
	}
	if (leaseToken) {
		filter['activeClaim.leaseToken'] = leaseToken
	}

	const query = AuditCheckpointCursor.findOneAndUpdate(
		filter,
		{
			$set: {
				activeClaim: {
					claimId: null,
					leaseToken: null,
					workerId: null,
					startSequence: null,
					endSequence: null,
					claimedAt: null,
					expiresAt: null,
				},
			},
		}
	)
	if (session) query.session(session)
	return await query
}

/**
 * Orchestrates deterministic hourly audit checkpoint generation and persistence.
 *
 * @param {Object} [options={}]
 * @param {string|Date} [options.scheduledHourUtc] - Target hour (normalized to UTC boundary)
 * @param {number} [options.batchLimit=DEFAULT_BATCH_LIMIT]
 * @param {string} [options.workerId]
 * @param {number} [options.claimTtlMs=DEFAULT_CLAIM_TTL_MS]
 * @param {string} [options.ledgerId=GLOBAL_HEAD_ID]
 * @returns {Promise<Object>} Generation result
 */
async function generateHourlyCheckpoint(options = {}) {
	const ledgerId = options.ledgerId || GLOBAL_HEAD_ID
	const batchLimit = Math.max(1, Number(options.batchLimit || DEFAULT_BATCH_LIMIT))
	const workerId =
		options.workerId || `worker-${process.pid}-${crypto.randomBytes(3).toString('hex')}`
	const claimTtlMs = Math.max(5000, Number(options.claimTtlMs || DEFAULT_CLAIM_TTL_MS))
	const scheduledHourUtc = normalizeToUtcHourString(options.scheduledHourUtc || new Date())

	// 1. Idempotency Check: Does a PENDING checkpoint already exist for this hour?
	const existingHourCheckpoint = await AuditCheckpoint.findOne({
		ledgerId,
		scheduledHourUtc,
		generationStatus: 'PENDING',
	}).lean()

	if (existingHourCheckpoint) {
		return {
			status: 'ALREADY_EXISTS',
			checkpoint: existingHourCheckpoint,
			idempotent: true,
			message: `Checkpoint already exists for scheduled hour ${scheduledHourUtc}.`,
		}
	}

	// 2. Determine eligible range from current cursor
	const range = await determineEligibleSequenceRange({ ledgerId, batchLimit })
	if (!range.eligible) {
		return {
			status: 'SKIPPED',
			reason: range.reason,
			lastCheckpointedSequence: range.lastCheckpointedSequence,
			operationalSequence: range.operationalSequence,
			message: 'No new committed audit records available for checkpointing.',
		}
	}

	// 3. Acquire Claim / Lease
	const claimResult = await acquireGenerationClaim(
		workerId,
		claimTtlMs,
		range.startSequence,
		range.endSequence
	)

	if (!claimResult.acquired) {
		return {
			status: 'CLAIM_ACTIVE',
			reason: 'CONCURRENT_WORKER_CLAIM_ACTIVE',
			claim: claimResult.currentClaim,
			message: 'Checkpoint generation claim is actively held by another worker.',
		}
	}

	const claimId = claimResult.claimId
	const leaseToken = claimResult.leaseToken

	try {
		// 4. Verify audit hash chain and record continuity across the range
		const verification = await verifyAuditRangeIntegrity(
			range.startSequence,
			range.endSequence
		)

		// 5. Construct deterministic checkpoint payload
		const checkpointId = generateDeterministicCheckpointId(
			ledgerId,
			range.startSequence,
			range.endSequence,
			scheduledHourUtc
		)

		// Check if checkpointId already exists in PENDING status
		const existingById = await AuditCheckpoint.findOne({ checkpointId }).lean()
		if (existingById && existingById.generationStatus === 'PENDING') {
			await releaseGenerationClaim(claimId, leaseToken)
			return {
				status: 'ALREADY_EXISTS',
				checkpoint: existingById,
				idempotent: true,
			}
		}

		const payload = constructCheckpointPayload({
			ledgerId,
			checkpointId,
			startSequence: range.startSequence,
			endSequence: range.endSequence,
			recordCount: range.recordCount,
			firstRecordHash: verification.firstRecordHash,
			lastRecordHash: verification.lastRecordHash,
			previousCheckpointHash: range.previousCheckpointHash,
			scheduledHourUtc,
		})

		const canonicalPayload = canonicalizeCheckpointPayload(payload)
		const checkpointHash = calculateCheckpointHash(payload)

		// 6. Transactional Persistence: Persist checkpoint document & advance cursor
		let createdCheckpoint
		let updatedCursor

		await withTransaction(async (session) => {
			// Record snapshot of operational head to verify it is NEVER touched
			const headBefore = await AuditChainHead.findById(ledgerId).session(session).lean()

			// 6a. FENCING CHECK: Verify this worker still holds the valid, unexpired lease token
			const commitNow = new Date()
			const leaseCheck = await AuditCheckpointCursor.findOne({
				_id: GLOBAL_CHECKPOINT_CURSOR_ID,
				'activeClaim.claimId': claimId,
				'activeClaim.leaseToken': leaseToken,
				'activeClaim.expiresAt': { $gt: commitNow },
			})
				.session(session)
				.lean()

			if (!leaseCheck) {
				const err = new Error(
					`Fencing Violation: Generation lease expired or ownership lost for claimId '${claimId}'. Checkpoint persistence and cursor advancement aborted.`
				)
				err.statusCode = 409
				err.name = 'FencingViolationError'
				throw err
			}

			// Check for any overlapping committed PENDING checkpoint in this ledger
			const overlapping = await AuditCheckpoint.findOne({
				ledgerId,
				generationStatus: 'PENDING',
				startSequence: { $lte: range.endSequence },
				endSequence: { $gte: range.startSequence },
			})
				.session(session)
				.lean()

			if (overlapping) {
				if (
					overlapping.startSequence === range.startSequence &&
					overlapping.endSequence === range.endSequence &&
					overlapping.checkpointId === checkpointId
				) {
					// Exact idempotent match already committed
					createdCheckpoint = overlapping
					return
				}
				const err = new Error(
					`Cannot persist checkpoint: sequence range [${range.startSequence}, ${range.endSequence}] overlaps with existing committed checkpoint ${overlapping.checkpointId} [${overlapping.startSequence}, ${overlapping.endSequence}].`
				)
				err.statusCode = 409
				err.name = 'OverlappingCheckpointRangeError'
				throw err
			}

			// Clean up any prior FAILED attempt for this range or ID
			await AuditCheckpoint.deleteMany(
				{
					ledgerId,
					startSequence: range.startSequence,
					endSequence: range.endSequence,
					generationStatus: 'FAILED',
				},
				{ session }
			)
			await AuditCheckpoint.deleteMany(
				{
					checkpointId,
					generationStatus: 'FAILED',
				},
				{ session }
			)

			// Create PENDING checkpoint document
			const [chk] = await AuditCheckpoint.create(
				[
					{
						ledgerId,
						checkpointId,
						formatVersion: payload.checkpointFormatVersion,
						startSequence: range.startSequence,
						endSequence: range.endSequence,
						recordCount: range.recordCount,
						firstRecordHash: verification.firstRecordHash,
						lastRecordHash: verification.lastRecordHash,
						previousCheckpointHash: range.previousCheckpointHash,
						checkpointHash,
						payload,
						canonicalPayload,
						generatedAt: new Date(),
						scheduledHourUtc,
						generationAttempt: 1,
						generationStatus: 'PENDING',
						claimedBy: workerId,
						claimExpiresAt: null,
						anchoringStatus: 'PENDING', // NEVER ANCHORED in B3.5.2
					},
				],
				{ session }
			)
			createdCheckpoint = chk

			// Advance AuditCheckpointCursor atomically with strict lease token fencing
			updatedCursor = await AuditCheckpointCursor.findOneAndUpdate(
				{
					_id: GLOBAL_CHECKPOINT_CURSOR_ID,
					'activeClaim.claimId': claimId,
					'activeClaim.leaseToken': leaseToken,
					'activeClaim.expiresAt': { $gt: commitNow },
				},
				{
					$set: {
						lastCheckpointedSequence: range.endSequence,
						lastCheckpointId: checkpointId,
						lastCheckpointHash: checkpointHash,
						lastCheckpointedAt: commitNow,
						activeClaim: {
							claimId: null,
							leaseToken: null,
							workerId: null,
							startSequence: null,
							endSequence: null,
							claimedAt: null,
							expiresAt: null,
						},
					},
					$inc: { totalCheckpoints: 1 },
				},
				{ session, new: true }
			)

			if (!updatedCursor) {
				const err = new Error(
					`Fencing Collision: Conditional cursor update failed for claimId '${claimId}'. Lease ownership was lost or expired during persistence.`
				)
				err.statusCode = 409
				err.name = 'FencingViolationError'
				throw err
			}

			// MANDATORY WATERMARK INVARIANT VERIFICATION:
			// Confirm that AuditChainHead was not modified
			const headAfter = await AuditChainHead.findById(ledgerId).session(session).lean()
			if (headBefore && headAfter) {
				if (headBefore.sequenceNumber !== headAfter.sequenceNumber) {
					throw new Error(
						'CRITICAL INTEGRITY VIOLATION: Operational audit sequenceNumber was mutated during checkpoint generation!'
					)
				}
				if (headBefore.lastAnchoredSequence !== headAfter.lastAnchoredSequence) {
					throw new Error(
						'CRITICAL INTEGRITY VIOLATION: External anchored watermark was mutated during local checkpoint generation!'
					)
				}
			}
		})

		return {
			status: 'CREATED',
			checkpoint: createdCheckpoint.toObject(),
			cursor: updatedCursor ? updatedCursor.toObject() : null,
			message: `Checkpoint ${checkpointId} generated successfully.`,
		}
	} catch (err) {
		// Release claim on failure only if we still own it
		await releaseGenerationClaim(claimId, leaseToken).catch(() => {})

		// Record failure record ONLY if this worker was NOT fenced out
		// (fenced-out workers must not overwrite replacement worker's state)
		if (
			err.name !== 'FencingViolationError' &&
			err.name !== 'OverlappingCheckpointRangeError'
		) {
			const failedCheckpointId = generateDeterministicCheckpointId(
				ledgerId,
				range.startSequence,
				range.endSequence,
				scheduledHourUtc
			)

			await AuditCheckpoint.findOneAndUpdate(
				{ checkpointId: failedCheckpointId },
				{
					$set: {
						generationStatus: 'FAILED',
						generationErrorCode: err.name || 'GENERATION_ERROR',
						generationErrorMessage: err.message,
						generationErrorAt: new Date(),
						claimExpiresAt: null,
					},
				},
				{ upsert: true }
			).catch(() => {})
		}

		throw err
	}
}

module.exports = {
	DEFAULT_BATCH_LIMIT,
	DEFAULT_CLAIM_TTL_MS,
	getOrInitCheckpointCursor,
	determineEligibleSequenceRange,
	verifyAuditRangeIntegrity,
	acquireGenerationClaim,
	releaseGenerationClaim,
	generateHourlyCheckpoint,
}
