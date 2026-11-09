/**
 * Audit Chain Head Model
 * Namma Blood — Stage B3.4 Healthcare Governance & Tamper-Evident Ledger
 *
 * Implements a singleton sequence and chain-head tracker document protecting
 * the Administrative Decision Audit Ledger from fork hazards, sequence gaps,
 * and competing transaction histories.
 */

const mongoose = require('mongoose')

const GENESIS_ANCHOR_HASH =
	'GENESIS_ANCHOR_0000000000000000000000000000000000000000000000000000000000000000'

const GLOBAL_HEAD_ID = 'GLOBAL_ADMIN_AUDIT_HEAD'

const auditChainHeadSchema = new mongoose.Schema(
	{
		_id: {
			type: String,
			required: true,
			default: 'GLOBAL_ADMIN_AUDIT_HEAD',
		},
		sequenceNumber: {
			type: Number,
			required: true,
			default: 0,
		},
		latestRecordId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'administrativedecisionaudit',
			default: null,
		},
		latestRecordHash: {
			type: String,
			required: true,
			default: GENESIS_ANCHOR_HASH,
		},
		totalRecords: {
			type: Number,
			required: true,
			default: 0,
		},
		// External WORM Anchored Watermark (AWS S3 Object Lock compliance verification)
		// CRITICAL: MUST NEVER be modified or advanced during local checkpoint generation.
		// Local checkpoint coverage is strictly tracked by AuditCheckpointCursor.
		lastAnchoredSequence: {
			type: Number,
			default: 0,
		},
		lastAnchoredHash: {
			type: String,
			default: '',
		},
		lastAnchoredAt: {
			type: Date,
			default: null,
		},
	},
	{ timestamps: true }
)

// Protected Chain Head Guards: Reject deletion of singleton tracker
auditChainHeadSchema.pre(
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
			'AuditChainHead singleton document is protected against deletion and cannot be removed.'
		)
		err.statusCode = 403
		next(err)
	}
)

auditChainHeadSchema.pre('deleteOne', { document: true, query: false }, function (next) {
	const err = new Error(
		'AuditChainHead singleton document is protected against deletion and cannot be removed.'
	)
	err.statusCode = 403
	next(err)
})

const AuditChainHead = mongoose.model('auditchainhead', auditChainHeadSchema)

module.exports = {
	AuditChainHead,
	GENESIS_ANCHOR_HASH,
	GLOBAL_HEAD_ID,
}
