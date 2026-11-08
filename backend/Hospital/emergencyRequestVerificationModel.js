const mongoose = require('mongoose')

const VALID_VERIFICATION_ACTIONS = [
	'APPROVED',
	'REJECTED',
	'MORE_INFORMATION_REQUESTED',
	'RESUBMITTED',
]

const VALID_ACTOR_ROLES = ['USER', 'MEDICAL_OFFICER', 'ADMIN']
const VALID_ACTOR_MODELS = ['user', 'admin']

const ROLE_TO_MODEL_MAP = {
	USER: 'user',
	MEDICAL_OFFICER: 'user',
	ADMIN: 'admin',
}

const ACTION_PERMITTED_ROLES = {
	APPROVED: ['MEDICAL_OFFICER', 'ADMIN'],
	REJECTED: ['MEDICAL_OFFICER', 'ADMIN'],
	MORE_INFORMATION_REQUESTED: ['MEDICAL_OFFICER', 'ADMIN'],
	RESUBMITTED: ['USER'],
}

const emergencyRequestVerificationSchema = new mongoose.Schema(
	{
		emergencyRequestId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'emergencybloodrequest',
			required: [true, 'Emergency request ID is required.'],
			index: true,
		},
		// Nullable: legacy requests created without a hospitalId remain null (no invented associations)
		hospitalId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'hospital',
			default: null,
			index: true,
		},
		// Polymorphic actor reference: dynamically resolves to 'user' or 'admin' model
		actorUserId: {
			type: mongoose.Schema.Types.ObjectId,
			required: [true, 'Actor user ID is required.'],
			refPath: 'actorModel',
			index: true,
		},
		actorModel: {
			type: String,
			enum: {
				values: VALID_ACTOR_MODELS,
				message: '{VALUE} is not a valid actor model. Allowed: ' + VALID_ACTOR_MODELS.join(', '),
			},
			required: [true, 'Actor model is required.'],
			index: true,
		},
		actorRole: {
			type: String,
			enum: {
				values: VALID_ACTOR_ROLES,
				message: '{VALUE} is not a valid actor role. Allowed: ' + VALID_ACTOR_ROLES.join(', '),
			},
			required: [true, 'Actor role is required.'],
			index: true,
		},
		action: {
			type: String,
			enum: {
				values: VALID_VERIFICATION_ACTIONS,
				message: '{VALUE} is not a valid verification action. Allowed: ' + VALID_VERIFICATION_ACTIONS.join(', '),
			},
			required: [true, 'Verification action is required.'],
		},
		previousVerificationStatus: {
			type: String,
			required: [true, 'Previous verification status is required.'],
			trim: true,
		},
		newVerificationStatus: {
			type: String,
			required: [true, 'New verification status is required.'],
			trim: true,
		},
		remarks: {
			type: String,
			trim: true,
			default: '',
		},
		reasonCode: {
			type: String,
			trim: true,
			default: '',
		},
		requestedInformation: {
			type: String,
			trim: true,
			default: '',
		},
		additionalInformationResponse: {
			type: String,
			trim: true,
			default: '',
		},
		verificationVersion: {
			type: Number,
			required: [true, 'Verification version is required.'],
			min: [0, 'Verification version cannot be negative.'],
		},
	},
	{
		timestamps: { createdAt: true, updatedAt: false }, // Disables automatic updatedAt field
	}
)

// Invariant Validations: Polymorphic actor mapping and Action-Role permissions
emergencyRequestVerificationSchema.pre('validate', function (next) {
	// Auto-populate actorModel if not explicitly set based on actorRole
	if (this.actorRole && !this.actorModel) {
		this.actorModel = ROLE_TO_MODEL_MAP[this.actorRole]
	}

	// 1. Validate polymorphic actorRole -> actorModel mapping
	if (this.actorRole && this.actorModel) {
		const expectedModel = ROLE_TO_MODEL_MAP[this.actorRole]
		if (expectedModel && this.actorModel !== expectedModel) {
			this.invalidate(
				'actorModel',
				`Actor model mismatch: role '${this.actorRole}' must reference '${expectedModel}', but got '${this.actorModel}'.`
			)
		}
	}

	// 2. Validate action -> permitted actor roles
	if (this.action && this.actorRole) {
		const permitted = ACTION_PERMITTED_ROLES[this.action]
		if (permitted && !permitted.includes(this.actorRole)) {
			this.invalidate(
				'actorRole',
				`Action '${this.action}' cannot be performed by actor role '${this.actorRole}'. Permitted roles: ${permitted.join(', ')}.`
			)
		}
	}

	next()
})

// ============================================================================
// IMMUTABILITY SAFEGUARDS: Strict Append-Only Enforcement
// ============================================================================

// 1. Prevent updates to existing documents on .save()
emergencyRequestVerificationSchema.pre('save', function (next) {
	if (!this.isNew) {
		return next(new Error('Audit records are strictly append-only: updates and modifications are prohibited.'))
	}
	next()
})

// 2. Block document-level deletion
emergencyRequestVerificationSchema.pre(
	'deleteOne',
	{ document: true, query: false },
	function (next) {
		next(new Error('Audit records are strictly append-only: deletions are prohibited.'))
	}
)

// 3. Block all query-level update operations
const BLOCKED_UPDATE_OPERATIONS = [
	'updateOne',
	'updateMany',
	'findOneAndUpdate',
	'replaceOne',
	'findByIdAndUpdate',
]
BLOCKED_UPDATE_OPERATIONS.forEach(operation => {
	emergencyRequestVerificationSchema.pre(operation, function (next) {
		next(new Error(`Audit records are strictly append-only: '${operation}' is prohibited.`))
	})
})

// 4. Block all query-level delete operations
const BLOCKED_DELETE_OPERATIONS = [
	'deleteOne',
	'deleteMany',
	'findOneAndDelete',
	'findOneAndRemove',
	'findByIdAndDelete',
	'findByIdAndRemove',
]
BLOCKED_DELETE_OPERATIONS.forEach(operation => {
	emergencyRequestVerificationSchema.pre(operation, function (next) {
		next(new Error(`Audit records are strictly append-only: '${operation}' is prohibited.`))
	})
})

// Compound and lookup indexes
emergencyRequestVerificationSchema.index({ emergencyRequestId: 1, createdAt: -1 })
emergencyRequestVerificationSchema.index({ hospitalId: 1, createdAt: -1 })
emergencyRequestVerificationSchema.index({ actorUserId: 1, createdAt: -1 })
emergencyRequestVerificationSchema.index({ actorRole: 1, createdAt: -1 })
emergencyRequestVerificationSchema.index({ actorModel: 1, createdAt: -1 })

const EmergencyRequestVerification = mongoose.model(
	'emergencyrequestverification',
	emergencyRequestVerificationSchema
)

module.exports = {
	EmergencyRequestVerification,
	VALID_VERIFICATION_ACTIONS,
	VALID_ACTOR_ROLES,
	VALID_ACTOR_MODELS,
	ROLE_TO_MODEL_MAP,
	ACTION_PERMITTED_ROLES,
}
