const mongoose = require('mongoose')

const VALID_ASSOCIATION_STATUSES = [
	'Pending',
	'Pending_Hospital_Confirmation',
	'Pending_Admin_Approval',
	'Active',
	'Suspended',
	'Revoked',
	'Expired',
	'Rejected',
]
const VALID_MO_PERMISSIONS = ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS']
const VALID_AVAILABILITY_STATUSES = ['Available', 'Unavailable']
const VALID_INITIATOR_ROLES = ['DOCTOR', 'HOSPITAL', 'ADMIN']

const medicalOfficerHospitalSchema = new mongoose.Schema(
	{
		medicalOfficerUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'user',
			required: [true, 'Medical Officer user ID is required.'],
			index: true,
		},
		hospitalId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'hospital',
			required: [true, 'Hospital ID is required.'],
			index: true,
		},
		associationStatus: {
			type: String,
			enum: {
				values: VALID_ASSOCIATION_STATUSES,
				message:
					'{VALUE} is not a valid association status. Allowed: ' +
					VALID_ASSOCIATION_STATUSES.join(', '),
			},
			default: 'Pending_Admin_Approval',
			index: true,
		},
		permissions: {
			type: [String],
			enum: {
				values: VALID_MO_PERMISSIONS,
				message:
					'{VALUE} is not a valid permission. Allowed: ' +
					VALID_MO_PERMISSIONS.join(', '),
			},
			default: ['VIEW_EMERGENCY_REQUESTS'],
		},
		// Hospital-Specific Medical Officer Availability
		availabilityStatus: {
			type: String,
			enum: {
				values: VALID_AVAILABILITY_STATUSES,
				message:
					'{VALUE} is not a valid availability status. Allowed: ' +
					VALID_AVAILABILITY_STATUSES.join(', '),
			},
			default: 'Unavailable',
			index: true,
		},
		availabilityLastUpdatedAt: {
			type: Date,
			default: Date.now,
		},
		// Initiation & Mutual Confirmation Metadata
		initiatedBy: {
			type: String,
			enum: {
				values: VALID_INITIATOR_ROLES,
				message:
					'{VALUE} is not a valid initiator role. Allowed: ' +
					VALID_INITIATOR_ROLES.join(', '),
			},
			default: 'ADMIN',
		},
		hospitalConfirmedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'user',
			default: null,
		},
		hospitalConfirmedAt: {
			type: Date,
			default: null,
		},
		adminApprovedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'admin',
			default: null,
		},
		adminApprovedAt: {
			type: Date,
			default: null,
		},
		// Preserved legacy fields
		approvedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'admin',
			default: null,
		},
		approvedAt: {
			type: Date,
			default: null,
		},
		rejectionReason: {
			type: String,
			trim: true,
			default: '',
		},
		effectiveFrom: {
			type: Date,
			default: Date.now,
		},
		expiresAt: {
			type: Date,
			default: null,
		},
	},
	{ timestamps: true }
)

// Ensure one association document per (medical officer, hospital) pair
medicalOfficerHospitalSchema.index(
	{ medicalOfficerUserId: 1, hospitalId: 1 },
	{ unique: true }
)
medicalOfficerHospitalSchema.index({ hospitalId: 1, associationStatus: 1 })
medicalOfficerHospitalSchema.index({ hospitalId: 1, associationStatus: 1, availabilityStatus: 1 })

const MedicalOfficerHospital = mongoose.model(
	'medicalofficerhospital',
	medicalOfficerHospitalSchema
)

module.exports = {
	MedicalOfficerHospital,
	VALID_ASSOCIATION_STATUSES,
	VALID_MO_PERMISSIONS,
	VALID_AVAILABILITY_STATUSES,
	VALID_INITIATOR_ROLES,
}

