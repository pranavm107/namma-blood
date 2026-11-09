/**
 * Audit Checkpoint Model
 * Namma Blood — Stage B3.5.2 Hourly Audit Checkpoint Generation & Recovery
 *
 * Implements a persistent, tamper-evident checkpoint data model for local
 * hourly anchoring of the administrative decision audit ledger.
 *
 * Security & Integrity Invariants:
 * 1. Checkpoint generation status is strictly tracked (GENERATING, PENDING, FAILED).
 * 2. PENDING checkpoints represent locally verified and persisted checkpoints
 *    awaiting future independent external WORM anchoring.
 * 3. Checkpoints are strictly distinct from external WORM anchoring (anchoringStatus
 *    defaults to PENDING and is NEVER set to ANCHORED in this stage).
 * 4. PENDING checkpoints are guarded against modification or deletion at the Mongoose ORM layer.
 * 5. Unique compound index { ledgerId: 1, startSequence: 1, endSequence: 1 } prevents overlapping ranges.
 */

const mongoose = require('mongoose')

const VALID_GENERATION_STATUSES = ['GENERATING', 'PENDING', 'FAILED']
const VALID_ANCHORING_STATUSES = [
	'PENDING',
	'SIGNING',
	'UPLOADING',
	'UPLOADED',
	'VERIFYING',
	'ANCHORED',
	'FAILED',
]

const anchoringEvidenceSchema = new mongoose.Schema(
	{
		s3Bucket: {
			type: String,
			required: [true, 'S3 bucket is required.'],
		},
		s3ObjectKey: {
			type: String,
			required: [true, 'S3 object key is required.'],
		},
		s3VersionId: {
			type: String,
			required: [true, 'S3 version ID is required.'],
		},
		s3ETag: {
			type: String,
			default: null,
		},
		sha256Checksum: {
			type: String,
			required: [true, 'SHA-256 checksum is required.'],
			length: 64,
		},
		objectLockMode: {
			type: String,
			enum: ['COMPLIANCE'],
			default: 'COMPLIANCE',
			required: [true, 'Object lock mode is required.'],
		},
		retentionUntil: {
			type: Date,
			required: [true, 'Retention until timestamp is required.'],
		},
		signature: {
			type: String,
			required: [true, 'Detached signature is required.'],
		},
		signatureAlgorithm: {
			type: String,
			default: 'Ed25519',
			required: true,
		},
		signingKeyId: {
			type: String,
			required: [true, 'Signing key ID is required.'],
		},
		verifiedAt: {
			type: Date,
			default: Date.now,
			required: true,
		},
		anchoredAt: {
			type: Date,
			default: Date.now,
			required: true,
		},
		verificationStatus: {
			type: String,
			enum: ['VERIFIED', 'FAILED'],
			default: 'VERIFIED',
			required: true,
		},
	},
	{ _id: false }
)

const auditCheckpointSchema = new mongoose.Schema(
	{
		ledgerId: {
			type: String,
			required: [true, 'Ledger ID is required.'],
			default: 'GLOBAL_ADMIN_AUDIT_HEAD',
			index: true,
		},
		checkpointId: {
			type: String,
			required: [true, 'Checkpoint ID is required.'],
		},
		formatVersion: {
			type: String,
			required: [true, 'Format version is required.'],
			default: 'v1',
		},
		startSequence: {
			type: Number,
			required: [true, 'Start sequence is required.'],
			min: [1, 'Start sequence must be greater than or equal to 1.'],
			index: true,
		},
		endSequence: {
			type: Number,
			required: [true, 'End sequence is required.'],
			min: [1, 'End sequence must be greater than or equal to 1.'],
			index: true,
		},
		recordCount: {
			type: Number,
			required: [true, 'Record count is required.'],
			min: [1, 'Record count must be at least 1.'],
		},
		firstRecordHash: {
			type: String,
			required: [true, 'First record hash is required.'],
			length: 64,
		},
		lastRecordHash: {
			type: String,
			required: [true, 'Last record hash is required.'],
			length: 64,
		},
		previousCheckpointHash: {
			type: String,
			required: [true, 'Previous checkpoint hash is required.'],
		},
		checkpointHash: {
			type: String,
			required: [true, 'Checkpoint hash is required.'],
			length: 64,
			index: true,
		},
		payload: {
			type: mongoose.Schema.Types.Mixed,
			required: [true, 'Checkpoint payload is required.'],
		},
		canonicalPayload: {
			type: String,
			required: [true, 'Canonical payload is required.'],
		},
		generatedAt: {
			type: Date,
			required: [true, 'Generated timestamp is required.'],
			default: Date.now,
		},
		scheduledHourUtc: {
			type: String,
			required: [true, 'Scheduled hour in UTC ISO representation is required.'],
			index: true,
		},
		generationAttempt: {
			type: Number,
			default: 1,
			min: 1,
		},
		generationStatus: {
			type: String,
			enum: {
				values: VALID_GENERATION_STATUSES,
				message: '{VALUE} is not a valid checkpoint generation status.',
			},
			default: 'GENERATING',
			index: true,
		},
		generationErrorCode: {
			type: String,
			default: null,
		},
		generationErrorAt: {
			type: Date,
			default: null,
		},
		generationErrorMessage: {
			type: String,
			default: null,
		},
		claimedBy: {
			type: String,
			default: null,
		},
		claimExpiresAt: {
			type: Date,
			default: null,
		},
		// External WORM Anchoring fields (Stage B3.5.3)
		anchoringStatus: {
			type: String,
			enum: {
				values: VALID_ANCHORING_STATUSES,
				message: '{VALUE} is not a valid anchoring status.',
			},
			default: 'PENDING',
			index: true,
		},
		anchoringEvidence: {
			type: anchoringEvidenceSchema,
			default: null,
		},
		anchoringClaimedBy: {
			type: String,
			default: null,
		},
		anchoringClaimExpiresAt: {
			type: Date,
			default: null,
		},
		anchoringLeaseToken: {
			type: String,
			default: null,
		},
		anchoringAttempt: {
			type: Number,
			default: 0,
			min: 0,
		},
		anchoringErrorCode: {
			type: String,
			default: null,
		},
		anchoringErrorMessage: {
			type: String,
			default: null,
		},
		anchoringErrorAt: {
			type: Date,
			default: null,
		},
		anchoredAt: {
			type: Date,
			default: null,
		},
		externalObjectVersionId: {
			type: String,
			default: null,
		},
		externalObjectKey: {
			type: String,
			default: null,
		},
		retentionUntil: {
			type: Date,
			default: null,
		},
	},
	{ timestamps: true }
)

// Unique index on checkpointId
auditCheckpointSchema.index({ checkpointId: 1 }, { unique: true })

// Compound Index: Enforce uniqueness of sequence ranges for active/pending checkpoints
auditCheckpointSchema.index(
	{ ledgerId: 1, startSequence: 1, endSequence: 1 },
	{
		unique: true,
		partialFilterExpression: { generationStatus: { $in: ['GENERATING', 'PENDING'] } },
	}
)

// Index for locating stale claims
auditCheckpointSchema.index({ generationStatus: 1, claimExpiresAt: 1 })
auditCheckpointSchema.index({ anchoringStatus: 1, anchoringClaimExpiresAt: 1 })

// Immutability Guard: Reject deletion of PENDING or ANCHORED checkpoints via query middleware
auditCheckpointSchema.pre(
	[
		'deleteOne',
		'deleteMany',
		'findOneAndDelete',
		'findOneAndRemove',
		'findByIdAndDelete',
		'findByIdAndRemove',
	],
	function (next) {
		const filter = this.getFilter() || {}
		// Allow cleanup of transient FAILED generation attempts (as long as not anchored)
		if (filter.generationStatus === 'FAILED' && filter.anchoringStatus !== 'ANCHORED') {
			return next()
		}
		const err = new Error(
			'AuditCheckpoint records in PENDING or ANCHORED status are immutable and cannot be deleted.'
		)
		err.statusCode = 403
		next(err)
	}
)

// Immutability Guard: Reject mutation of core cryptographic fields or already ANCHORED checkpoints via query middleware
auditCheckpointSchema.pre(
	['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace'],
	async function (next) {
		const update = this.getUpdate() || {}
		const setObj = update.$set || update
		const protectedFields = [
			'checkpointHash',
			'startSequence',
			'endSequence',
			'recordCount',
			'firstRecordHash',
			'lastRecordHash',
			'previousCheckpointHash',
			'canonicalPayload',
			'payload',
		]
		const attemptedFields = protectedFields.filter((f) => f in setObj)
		if (attemptedFields.length > 0) {
			const err = new Error(
				`AuditCheckpoint cryptographic fields [${attemptedFields.join(', ')}] are immutable and cannot be updated.`
			)
			err.statusCode = 403
			return next(err)
		}

		// Check if target document is already ANCHORED
		try {
			const filter = this.getFilter() || {}
			const existing = await this.model.findOne(filter).select('anchoringStatus').lean()
			if (existing && existing.anchoringStatus === 'ANCHORED') {
				const err = new Error(
					'AuditCheckpoint records in ANCHORED status are immutable and cannot be updated.'
				)
				err.statusCode = 403
				return next(err)
			}
		} catch (e) {
			if (e.statusCode === 403) return next(e)
		}

		next()
	}
)

// Document-level deletion guard
auditCheckpointSchema.pre('deleteOne', { document: true, query: false }, function (next) {
	if (this.generationStatus === 'PENDING' || this.anchoringStatus === 'ANCHORED') {
		const err = new Error(
			'AuditCheckpoint records in PENDING or ANCHORED status are immutable and cannot be deleted.'
		)
		err.statusCode = 403
		return next(err)
	}
	next()
})

// Immutability Guard: Prevent modification of core cryptographic fields on PENDING checkpoints
auditCheckpointSchema.pre('save', async function (next) {
	// 1. Validation for sequence ranges
	if (this.startSequence > this.endSequence) {
		const err = new Error(
			`Invalid sequence range: startSequence (${this.startSequence}) cannot exceed endSequence (${this.endSequence}).`
		)
		err.statusCode = 400
		err.name = 'InvalidCheckpointRangeError'
		return next(err)
	}

	// 2. Prevent overlapping sequence ranges for active/pending checkpoints
	if (
		(this.isNew || this.isModified('startSequence') || this.isModified('endSequence')) &&
		(this.generationStatus === 'PENDING' || this.generationStatus === 'GENERATING')
	) {
		const overlapQuery = {
			ledgerId: this.ledgerId,
			_id: { $ne: this._id },
			generationStatus: { $in: ['GENERATING', 'PENDING'] },
			startSequence: { $lte: this.endSequence },
			endSequence: { $gte: this.startSequence },
		}

		const query = this.constructor.findOne(overlapQuery)
		if (this.$session()) {
			query.session(this.$session())
		}
		const overlappingDoc = await query.lean()

		if (overlappingDoc) {
			const err = new Error(
				`Overlapping checkpoint sequence range detected: requested range [${this.startSequence}, ${this.endSequence}] overlaps with existing checkpoint ${overlappingDoc.checkpointId} [${overlappingDoc.startSequence}, ${overlappingDoc.endSequence}].`
			)
			err.statusCode = 409
			err.name = 'OverlappingCheckpointRangeError'
			return next(err)
		}
	}

	// 3. Immutability check on existing PENDING records
	if (!this.isNew && this.generationStatus === 'PENDING') {
		const modifiedCoreFields = [
			'checkpointHash',
			'startSequence',
			'endSequence',
			'recordCount',
			'firstRecordHash',
			'lastRecordHash',
			'previousCheckpointHash',
			'canonicalPayload',
		].filter((field) => this.isModified(field))

		if (modifiedCoreFields.length > 0) {
			const err = new Error(
				`AuditCheckpoint cryptographic fields [${modifiedCoreFields.join(', ')}] are immutable once generated in PENDING status.`
			)
			err.statusCode = 403
			return next(err)
		}
	}

	// 4. Immutability check on existing ANCHORED records
	if (!this.isNew) {
		const query = this.constructor.findById(this._id).select('anchoringStatus')
		if (this.$session()) {
			query.session(this.$session())
		}
		const existingDoc = await query.lean()
		if (existingDoc && existingDoc.anchoringStatus === 'ANCHORED') {
			const err = new Error(
				'AuditCheckpoint records in ANCHORED status are immutable and cannot be updated.'
			)
			err.statusCode = 403
			return next(err)
		}
	}
	next()
})

// Model Static Guard: Reject bulkWrite operations
auditCheckpointSchema.statics.bulkWrite = function () {
	const err = new Error(
		'AuditCheckpoint records are protected and bulk write operations are prohibited.'
	)
	err.statusCode = 403
	return Promise.reject(err)
}

const AuditCheckpoint = mongoose.model('auditcheckpoint', auditCheckpointSchema)

module.exports = {
	AuditCheckpoint,
	VALID_GENERATION_STATUSES,
	VALID_ANCHORING_STATUSES,
}
