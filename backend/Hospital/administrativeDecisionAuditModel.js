/**
 * Administrative Decision Audit Model
 * Namma Blood — Stage B3.4 Healthcare Governance & Tamper-Evident Ledger
 *
 * Implements an immutable, append-only administrative decision ledger with
 * cryptographic hash chaining (SHA-256) and sequence numbering.
 *
 * Security & Integrity Invariants:
 * 1. Monotonic sequence numbering preventing record omissions or sequence gaps.
 * 2. Deterministic canonical record serialization for SHA-256 hash generation.
 * 3. Cryptographic chaining: each record binds previousRecordHash to current recordHash.
 * 4. Mongoose lifecycle hooks reject any application-level update or deletion operations.
 * 5. Polymorphic actor reference accommodating both Platform Administrators (admin model)
 *    and Medical Officers / Representatives (user model).
 * 6. Zero patient-identifiable clinical remarks stored in audit payloads.
 */

const mongoose = require('mongoose')
const crypto = require('crypto')

const VALID_AUDIT_ENTITY_TYPES = ['CREDENTIAL', 'HOSPITAL_ASSOCIATION']

const VALID_AUDIT_DECISIONS = [
	'CREDENTIAL_SUBMITTED',
	'CREDENTIAL_REVIEW_STARTED',
	'CREDENTIAL_INFO_REQUESTED',
	'CREDENTIAL_RESUBMITTED',
	'CREDENTIAL_APPROVED',
	'CREDENTIAL_REJECTED',
	'CREDENTIAL_SUSPENDED',
	'ASSOCIATION_APPROVED',
	'ASSOCIATION_REJECTED',
	'ASSOCIATION_SUSPENDED',
	'ASSOCIATION_REACTIVATED',
	'ASSOCIATION_REVOKED',
	'ASSOCIATION_PERMISSIONS_UPDATED',
]

const VALID_ACTOR_MODELS = ['admin', 'user']
const VALID_ACTOR_ROLES = ['ADMIN', 'HOSPITAL_ADMIN', 'MEDICAL_OFFICER']

const administrativeDecisionAuditSchema = new mongoose.Schema(
	{
		sequenceNumber: {
			type: Number,
			required: [true, 'Sequence number is required.'],
			unique: true,
			index: true,
		},
		entityType: {
			type: String,
			enum: {
				values: VALID_AUDIT_ENTITY_TYPES,
				message: '{VALUE} is not a valid audit entity type.',
			},
			required: [true, 'Entity type is required.'],
			index: true,
		},
		entityId: {
			type: mongoose.Schema.Types.ObjectId,
			required: [true, 'Entity ID is required.'],
			index: true,
		},
		targetUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'user',
			required: [true, 'Target User ID is required.'],
			index: true,
		},
		hospitalAssociationId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'MedicalOfficerHospital',
			default: null,
			index: true,
		},
		hospitalId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'hospital',
			default: null,
			index: true,
		},
		decisionType: {
			type: String,
			enum: {
				values: VALID_AUDIT_DECISIONS,
				message: '{VALUE} is not a valid audit decision type.',
			},
			required: [true, 'Decision type is required.'],
			index: true,
		},
		previousStatus: {
			type: String,
			required: [true, 'Previous status is required.'],
			trim: true,
		},
		newStatus: {
			type: String,
			required: [true, 'New status is required.'],
			trim: true,
		},
		actorId: {
			type: mongoose.Schema.Types.ObjectId,
			required: [true, 'Actor ID is required.'],
			refPath: 'actorModel',
			index: true,
		},
		actorModel: {
			type: String,
			enum: {
				values: VALID_ACTOR_MODELS,
				message: '{VALUE} is not a valid actor model.',
			},
			required: [true, 'Actor model is required.'],
			default: 'admin',
		},
		actorRole: {
			type: String,
			enum: {
				values: VALID_ACTOR_ROLES,
				message: '{VALUE} is not a valid actor role.',
			},
			required: [true, 'Actor role is required.'],
		},
		reason: {
			type: String,
			trim: true,
			default: '',
		},
		notes: {
			type: String,
			trim: true,
			default: '',
		},
		evidenceReferences: {
			type: [String],
			default: [],
		},
		grantedPermissions: {
			type: [String],
			default: [],
		},
		requestIp: {
			type: String,
			default: '',
		},
		userAgent: {
			type: String,
			default: '',
		},
		metadata: {
			type: mongoose.Schema.Types.Mixed,
			default: {},
		},
		// Cryptographic Hash Chaining
		hashVersion: {
			type: String,
			required: [true, 'Hash version is required.'],
			default: 'v2',
		},
		previousRecordHash: {
			type: String,
			required: [true, 'Previous record hash is required.'],
		},
		recordHash: {
			type: String,
			required: [true, 'Record hash is required.'],
		},
	},
	{ timestamps: { createdAt: true, updatedAt: false } }
)

// Immutable Ledger Guards: Reject all application-level modifications and deletions
administrativeDecisionAuditSchema.pre(
	[
		'updateOne',
		'updateMany',
		'findOneAndUpdate',
		'findByIdAndUpdate',
		'replaceOne',
		'findOneAndReplace',
		'deleteOne',
		'deleteMany',
		'findOneAndDelete',
		'findOneAndRemove',
		'findByIdAndDelete',
		'findByIdAndRemove',
	],
	function (next) {
		const err = new Error(
			'AdministrativeDecisionAudit records are immutable and cannot be updated or deleted.'
		)
		err.statusCode = 403
		next(err)
	}
)

// Document-level delete guard: rejects doc.deleteOne()
administrativeDecisionAuditSchema.pre(
	'deleteOne',
	{ document: true, query: false },
	function (next) {
		const err = new Error(
			'AdministrativeDecisionAudit records are immutable and cannot be updated or deleted.'
		)
		err.statusCode = 403
		next(err)
	}
)

// Prevent doc.save() modifications on existing documents
administrativeDecisionAuditSchema.pre('save', function (next) {
	if (!this.isNew) {
		const err = new Error(
			'AdministrativeDecisionAudit records cannot be modified once created.'
		)
		err.statusCode = 403
		return next(err)
	}
	next()
})

// BulkWrite static guard: rejects all bulk write modifications and deletions
administrativeDecisionAuditSchema.statics.bulkWrite = function () {
	const err = new Error(
		'AdministrativeDecisionAudit records are immutable and bulk write operations are prohibited.'
	)
	err.statusCode = 403
	return Promise.reject(err)
}

// Query Optimization Indexes
administrativeDecisionAuditSchema.index({ entityType: 1, entityId: 1, sequenceNumber: 1 })
administrativeDecisionAuditSchema.index({ targetUserId: 1, sequenceNumber: -1 })
administrativeDecisionAuditSchema.index({ hospitalId: 1, sequenceNumber: -1 })

const AdministrativeDecisionAudit = mongoose.model(
	'administrativedecisionaudit',
	administrativeDecisionAuditSchema
)

module.exports = {
	AdministrativeDecisionAudit,
	VALID_AUDIT_ENTITY_TYPES,
	VALID_AUDIT_DECISIONS,
	VALID_ACTOR_MODELS,
	VALID_ACTOR_ROLES,
}
