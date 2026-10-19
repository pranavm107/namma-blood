const mongoose = require('mongoose')

const VALID_AUDIT_ACTIONS = [
	'UNIT_INTAKE_COLLECTED',
	'COMPONENT_SEPARATION',
	'TTI_TESTING_RECORDED',
	'MEDICAL_OFFICER_CLEARED',
	'UNIT_RESERVED',
	'RESERVATION_RELEASED',
	'CROSSMATCH_RECORDED',
	'UNIT_ISSUED',
	'UNIT_DISPATCHED',
	'UNIT_DISCARDED',
	'UNIT_EXPIRED',
	'LEGACY_RECONCILED',
]

const bloodUnitAuditSchema = new mongoose.Schema(
	{
		unitId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'bloodunit',
			required: [true, 'BloodUnit reference is required.'],
			index: true,
		},
		unitNumber: {
			type: String,
			required: [true, 'Unit DIN/Barcode is required.'],
			index: true,
		},
		bloodbankId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'bloodbank',
			required: [true, 'Blood Bank reference is required.'],
			index: true,
		},
		action: {
			type: String,
			enum: {
				values: VALID_AUDIT_ACTIONS,
				message: '{VALUE} is not a valid audit action.',
			},
			required: [true, 'Audit action is required.'],
			index: true,
		},
		previousStatus: {
			type: String,
			required: [true, 'Previous unit status is required.'],
		},
		newStatus: {
			type: String,
			required: [true, 'New unit status is required.'],
		},
		actor: {
			actorId: {
				type: mongoose.Schema.Types.ObjectId,
				required: [true, 'Actor ID is required.'],
			},
			actorModel: {
				type: String,
				enum: ['bloodbank', 'admin', 'system', 'user'],
				required: [true, 'Actor model type is required.'],
			},
			ipAddress: {
				type: String,
				default: null,
			},
		},
		reason: {
			type: String,
			trim: true,
			default: '',
		},
		metadata: {
			type: mongoose.Schema.Types.Mixed,
			default: {},
		},
		timestamp: {
			type: Date,
			default: Date.now,
			immutable: true,
		},
	},
	{
		timestamps: false,
		versionKey: false,
	}
)

// Immutable Ledger Guards: Prevent updates and deletions on audit records
function rejectMutation(next) {
	const err = new Error(
		'Security violation: BloodUnitAuditLog records are append-only and cannot be modified or deleted.'
	)
	if (typeof next === 'function') {
		return next(err)
	}
	throw err
}

bloodUnitAuditSchema.pre('updateOne', rejectMutation)
bloodUnitAuditSchema.pre('updateMany', rejectMutation)
bloodUnitAuditSchema.pre('findOneAndUpdate', rejectMutation)
bloodUnitAuditSchema.pre('replaceOne', rejectMutation)
bloodUnitAuditSchema.pre('findOneAndReplace', rejectMutation)
bloodUnitAuditSchema.pre('deleteOne', rejectMutation)
bloodUnitAuditSchema.pre('deleteMany', rejectMutation)
bloodUnitAuditSchema.pre('findOneAndDelete', rejectMutation)

const BloodUnitAuditLog = mongoose.model(
	'bloodunitauditlog',
	bloodUnitAuditSchema
)

/**
 * Transaction-safe audit helper
 */
async function recordAuditLog({
	unitId,
	unitNumber,
	bloodbankId,
	action,
	previousStatus,
	newStatus,
	actorId,
	actorModel = 'bloodbank',
	ipAddress = null,
	reason = '',
	metadata = {},
	session = null,
}) {
	const logDoc = new BloodUnitAuditLog({
		unitId,
		unitNumber,
		bloodbankId,
		action,
		previousStatus,
		newStatus,
		actor: {
			actorId,
			actorModel,
			ipAddress,
		},
		reason,
		metadata,
	})

	const opts = session ? { session } : {}
	return await logDoc.save(opts)
}

module.exports = {
	BloodUnitAuditLog,
	VALID_AUDIT_ACTIONS,
	recordAuditLog,
}
