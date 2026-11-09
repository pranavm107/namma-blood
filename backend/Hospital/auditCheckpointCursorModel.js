/**
 * Audit Checkpoint Cursor Model
 * Namma Blood — Stage B3.5.2 Hourly Audit Checkpoint Generation & Recovery
 *
 * Implements a singleton checkpoint coverage tracker document protecting
 * the checkpoint generation lifecycle from race conditions, gaps, and overlaps.
 *
 * Watermark Separation Invariant:
 * - `lastCheckpointedSequence` represents the highest operational sequence covered
 *   by a successfully persisted generated checkpoint in local MongoDB.
 * - It is strictly independent from the operational audit chain head (`sequenceNumber`)
 *   and from the external WORM anchored watermark (`lastAnchoredSequence`).
 */

const mongoose = require('mongoose')

const GENESIS_CHECKPOINT_HASH =
	'GENESIS_CHECKPOINT_0000000000000000000000000000000000000000000000000000000000000000'

const GLOBAL_CHECKPOINT_CURSOR_ID = 'GLOBAL_ADMIN_CHECKPOINT_CURSOR'

const auditCheckpointCursorSchema = new mongoose.Schema(
	{
		_id: {
			type: String,
			required: true,
			default: GLOBAL_CHECKPOINT_CURSOR_ID,
		},
		ledgerId: {
			type: String,
			required: true,
			default: 'GLOBAL_ADMIN_AUDIT_HEAD',
		},
		lastCheckpointedSequence: {
			type: Number,
			required: true,
			default: 0,
			min: 0,
		},
		lastCheckpointId: {
			type: String,
			default: null,
		},
		lastCheckpointHash: {
			type: String,
			required: true,
			default: GENESIS_CHECKPOINT_HASH,
		},
		lastCheckpointedAt: {
			type: Date,
			default: null,
		},
		totalCheckpoints: {
			type: Number,
			required: true,
			default: 0,
			min: 0,
		},
		activeClaim: {
			claimId: { type: String, default: null },
			leaseToken: { type: String, default: null },
			workerId: { type: String, default: null },
			startSequence: { type: Number, default: null },
			endSequence: { type: Number, default: null },
			claimedAt: { type: Date, default: null },
			expiresAt: { type: Date, default: null },
		},
	},
	{ timestamps: true }
)

// Protected Cursor Guards: Reject deletion of singleton tracker
auditCheckpointCursorSchema.pre(
	[
		'deleteOne',
		'deleteMany',
		'findOneAndDelete',
		'findOneAndRemove',
		'findByIdAndDelete',
		'findByIdAndRemove',
	],
	function (next) {
		const err = new Error(
			'AuditCheckpointCursor singleton document is protected against deletion and cannot be removed.'
		)
		err.statusCode = 403
		next(err)
	}
)

auditCheckpointCursorSchema.pre('deleteOne', { document: true, query: false }, function (next) {
	const err = new Error(
		'AuditCheckpointCursor singleton document is protected against deletion and cannot be removed.'
	)
	err.statusCode = 403
	next(err)
})

const AuditCheckpointCursor = mongoose.model(
	'auditcheckpointcursor',
	auditCheckpointCursorSchema
)

module.exports = {
	AuditCheckpointCursor,
	GLOBAL_CHECKPOINT_CURSOR_ID,
	GENESIS_CHECKPOINT_HASH,
}
