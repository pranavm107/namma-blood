/**
 * Audit Checkpoint Recovery Service
 * Namma Blood — Stage B3.5.2 Hourly Audit Checkpoint Generation & Recovery
 *
 * Implements crash recovery, stale claim cleanup, cursor reconciliation,
 * and checkpoint chain integrity verification.
 *
 * Safety Invariants:
 * 1. Automatically cleans up abandoned or expired worker leases.
 * 2. Reconciles cursor sequence strictly to the highest contiguous verified PENDING checkpoint.
 * 3. Never skips missing sequence ranges during recovery.
 * 4. Never touches or alters operational audit records or external anchored watermarks.
 */

const {
	AuditCheckpoint,
} = require('./auditCheckpointModel')
const {
	AuditCheckpointCursor,
	GLOBAL_CHECKPOINT_CURSOR_ID,
	GENESIS_CHECKPOINT_HASH,
} = require('./auditCheckpointCursorModel')
const {
	GLOBAL_HEAD_ID,
} = require('./auditChainHeadModel')
const {
	verifyCheckpointPayload,
} = require('./auditCheckpointPayloadService')
const {
	getOrInitCheckpointCursor,
	DEFAULT_CLAIM_TTL_MS,
} = require('./auditCheckpointGenerationService')

/**
 * Reconciles and releases expired or stale generation claims on the cursor and checkpoint models.
 *
 * @param {number} [claimTtlMs=DEFAULT_CLAIM_TTL_MS]
 * @returns {Promise<{ recoveredCursorClaims: number, recoveredCheckpoints: number }>}
 */
async function reconcileStaleClaims(claimTtlMs = DEFAULT_CLAIM_TTL_MS) {
	const now = new Date()
	let recoveredCursorClaims = 0
	let recoveredCheckpoints = 0

	// 1. Clear expired claim on singleton cursor
	const cursorWithExpiredClaim = await AuditCheckpointCursor.findOneAndUpdate(
		{
			_id: GLOBAL_CHECKPOINT_CURSOR_ID,
			'activeClaim.expiresAt': { $lte: now },
		},
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
		},
		{ new: true }
	)

	if (cursorWithExpiredClaim) {
		recoveredCursorClaims = 1
	}

	// 2. Mark orphaned GENERATING checkpoints whose lease expired as FAILED
	const staleCheckpoints = await AuditCheckpoint.updateMany(
		{
			generationStatus: 'GENERATING',
			$or: [
				{ claimExpiresAt: { $lte: now } },
				{ createdAt: { $lte: new Date(now.getTime() - claimTtlMs) } },
			],
		},
		{
			$set: {
				generationStatus: 'FAILED',
				generationErrorCode: 'CLAIM_EXPIRED',
				generationErrorMessage: 'Generation claim expired before completion.',
				generationErrorAt: now,
			},
		}
	)

	recoveredCheckpoints = staleCheckpoints.modifiedCount || 0

	return {
		recoveredCursorClaims,
		recoveredCheckpoints,
	}
}

/**
 * Reconciles the AuditCheckpointCursor with the highest contiguous, cryptographically
 * valid PENDING checkpoint.
 *
 * Safety Invariants:
 * 1. Cannot move a valid cursor backwards (monotonic advancement only: contiguousMaxEnd > previousSequence).
 * 2. Cannot advance beyond a missing sequence range (breaks on first gap).
 * 3. Cannot accept overlapping checkpoint ranges (breaks on first overlap).
 * 4. Verifies checkpoint hash-chain continuity across all evaluated checkpoints.
 * 5. Verifies the checkpoint payload hash and canonical structure before accepting a checkpoint.
 * 6. Does not treat an incomplete or invalid checkpoint as successfully covered.
 * 7. Never mutates the external anchoring watermark (AuditChainHead.lastAnchoredSequence).
 * 8. Interrupted generation and repeated invocations are completely idempotent and safe.
 *
 * @param {string} [ledgerId=GLOBAL_HEAD_ID]
 * @returns {Promise<{ reconciled: boolean, previousSequence: number, currentSequence: number, totalCheckpoints: number, reason?: string }>}
 */
async function reconcileCursorWithPersistedCheckpoints(ledgerId = GLOBAL_HEAD_ID) {
	const cursor = await getOrInitCheckpointCursor()
	const previousSequence = cursor.lastCheckpointedSequence

	// Fetch all PENDING checkpoints in sequence order
	const checkpoints = await AuditCheckpoint.find({
		ledgerId,
		generationStatus: 'PENDING',
	})
		.sort({ startSequence: 1 })
		.lean()

	if (checkpoints.length === 0) {
		return {
			reconciled: false,
			previousSequence,
			currentSequence: previousSequence,
			totalCheckpoints: 0,
			reason: 'NO_PENDING_CHECKPOINTS',
		}
	}

	// Verify contiguous sequence continuity, non-overlap, hash linkage, and payload integrity
	let expectedStart = 1
	let contiguousMaxEnd = 0
	let lastValidHash = GENESIS_CHECKPOINT_HASH
	let lastValidId = null
	let lastValidAt = null
	let contiguousCount = 0

	for (let i = 0; i < checkpoints.length; i++) {
		const cp = checkpoints[i]

		// 1. Range Validation: Check for gaps or overlaps
		if (cp.startSequence !== expectedStart) {
			// If cp.startSequence < expectedStart -> OVERLAP detected
			// If cp.startSequence > expectedStart -> GAP detected
			break
		}

		if (cp.endSequence < cp.startSequence) {
			// Malformed checkpoint range
			break
		}

		// 2. Hash-Chain Continuity Check
		if (cp.previousCheckpointHash !== lastValidHash) {
			// Hash chain link broken; stop at last valid contiguous checkpoint
			break
		}

		// 3. Payload Integrity and Hash Verification
		const payloadVerification = verifyCheckpointPayload(cp.payload, cp.checkpointHash)
		if (!payloadVerification.isValid) {
			// Corrupted payload or hash mismatch; reject checkpoint
			break
		}

		contiguousMaxEnd = cp.endSequence
		lastValidHash = cp.checkpointHash
		lastValidId = cp.checkpointId
		lastValidAt = cp.generatedAt
		expectedStart = cp.endSequence + 1
		contiguousCount++
	}

	// INVARIANT 1: Monotonic Advancement Only — NEVER move a valid cursor backwards!
	if (contiguousMaxEnd > previousSequence) {
		const updatedCursor = await AuditCheckpointCursor.findOneAndUpdate(
			{ _id: GLOBAL_CHECKPOINT_CURSOR_ID },
			{
				$set: {
					lastCheckpointedSequence: contiguousMaxEnd,
					lastCheckpointId: lastValidId,
					lastCheckpointHash: lastValidHash,
					lastCheckpointedAt: lastValidAt,
					totalCheckpoints: contiguousCount,
				},
			},
			{ new: true }
		)

		return {
			reconciled: true,
			previousSequence,
			currentSequence: updatedCursor.lastCheckpointedSequence,
			totalCheckpoints: contiguousCount,
		}
	}

	return {
		reconciled: false,
		previousSequence,
		currentSequence: previousSequence,
		totalCheckpoints: contiguousCount,
		reason: contiguousMaxEnd < previousSequence ? 'CURSOR_REGRESSION_PREVENTED' : 'CURSOR_ALREADY_SYNCHRONIZED',
	}
}

/**
 * Verifies cryptographic continuity, non-overlap, and payload integrity across all PENDING checkpoints.
 *
 * @param {string} [ledgerId=GLOBAL_HEAD_ID]
 * @returns {Promise<{ isValid: boolean, totalCheckpoints: number, errors: string[] }>}
 */
async function verifyCheckpointChainIntegrity(ledgerId = GLOBAL_HEAD_ID) {
	const errors = []
	const checkpoints = await AuditCheckpoint.find({
		ledgerId,
		generationStatus: 'PENDING',
	})
		.sort({ startSequence: 1 })
		.lean()

	if (checkpoints.length === 0) {
		return { isValid: true, totalCheckpoints: 0, errors: [] }
	}

	let expectedPrevHash = GENESIS_CHECKPOINT_HASH
	let expectedStartSeq = 1

	for (let i = 0; i < checkpoints.length; i++) {
		const cp = checkpoints[i]

		// 1. Sequence Continuity & Overlap Check
		if (cp.startSequence < expectedStartSeq) {
			errors.push(
				`Overlapping checkpoint sequence range at ${cp.checkpointId}: startSequence ${cp.startSequence} overlaps with prior range ending at ${expectedStartSeq - 1}.`
			)
		} else if (cp.startSequence > expectedStartSeq) {
			errors.push(
				`Checkpoint sequence gap at index ${i}: expected startSequence ${expectedStartSeq}, found ${cp.startSequence}.`
			)
			expectedStartSeq = cp.startSequence
		}

		if (cp.endSequence < cp.startSequence) {
			errors.push(
				`Malformed checkpoint range at ${cp.checkpointId}: startSequence ${cp.startSequence} exceeds endSequence ${cp.endSequence}.`
			)
		}

		// 2. Hash Linkage Check
		if (cp.previousCheckpointHash !== expectedPrevHash) {
			errors.push(
				`Previous checkpoint hash mismatch at ${cp.checkpointId}: expected '${expectedPrevHash}', found '${cp.previousCheckpointHash}'.`
			)
		}

		// 3. Payload Integrity Check
		const payloadVerification = verifyCheckpointPayload(cp.payload, cp.checkpointHash)
		if (!payloadVerification.isValid) {
			errors.push(
				`Payload verification failure at ${cp.checkpointId}: ${payloadVerification.errors.join(', ')}`
			)
		}

		expectedPrevHash = cp.checkpointHash
		expectedStartSeq = cp.endSequence + 1
	}

	return {
		isValid: errors.length === 0,
		totalCheckpoints: checkpoints.length,
		errors,
	}
}

module.exports = {
	reconcileStaleClaims,
	reconcileCursorWithPersistedCheckpoints,
	verifyCheckpointChainIntegrity,
}
