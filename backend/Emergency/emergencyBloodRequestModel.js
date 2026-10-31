const mongoose = require('mongoose')
const crypto = require('crypto')
const { VALID_BLOOD_GROUPS, VALID_COMPONENT_TYPES } = require('../BloodUnit/bloodUnitModel')
const { isValidCoordinate } = require('./geoValidation')

const VALID_URGENCY_LEVELS = ['Critical', 'Urgent', 'High_Priority']
const VALID_VERIFICATION_STATUSES = [
	'Pending_Verification',
	'Verified',
	'Flagged_Suspicious',
	'Rejected',
]
const VALID_EMERGENCY_STATUSES = [
	'Active',
	'Partially_Reserved',
	'Fully_Reserved',
	'In_Transit',
	'Fulfilled',
	'Expired',
	'Cancelled',
]

// Embedded GeoJSON Point Schema for Hospital Coordinates
const pointSchema = new mongoose.Schema(
	{
		type: {
			type: String,
			enum: ['Point'],
			default: 'Point',
			required: true,
		},
		coordinates: {
			type: [Number], // [longitude, latitude]
			required: true,
			validate: {
				validator: function (val) {
					if (!val || val.length === 0) return true
					return isValidCoordinate(val)
				},
				message:
					'Coordinates must be valid [longitude, latitude] where longitude is between -180 and 180 and latitude is between -90 and 90.',
			},
		},
	},
	{ _id: false }
)

const emergencyBloodRequestSchema = new mongoose.Schema(
	{
		// Unique Human-Readable Emergency Request Identifier
		requestNumber: {
			type: String,
			unique: true,
			trim: true,
			uppercase: true,
			index: true,
		},

		// Authenticated Requester
		requesterUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'user',
			required: [true, 'Requester user ID is required.'],
			index: true,
		},

		// Patient Demographics
		patientName: {
			type: String,
			required: [true, 'Patient name is required.'],
			trim: true,
		},
		patientAge: {
			type: Number,
			required: [true, 'Patient age is required.'],
			min: [0, 'Patient age cannot be negative.'],
			max: [120, 'Patient age cannot exceed 120.'],
		},
		patientGender: {
			type: String,
			enum: {
				values: ['Male', 'Female', 'Other'],
				message: '{VALUE} is not a valid gender.',
			},
			required: [true, 'Patient gender is required.'],
		},

		// Clinical Blood Specifications
		requiredBloodGroup: {
			type: String,
			enum: {
				values: VALID_BLOOD_GROUPS,
				message: '{VALUE} is not a valid blood group.',
			},
			required: [true, 'Required blood group is mandatory.'],
			index: true,
		},
		requiredComponent: {
			type: String,
			enum: {
				values: VALID_COMPONENT_TYPES,
				message: '{VALUE} is not a valid component type.',
			},
			default: 'Packed_Red_Blood_Cells',
			required: [true, 'Component type is required.'],
			index: true,
		},
		unitsRequested: {
			type: Number,
			required: [true, 'Units requested is required.'],
			min: [1, 'Minimum 1 unit must be requested.'],
			max: [10, 'Maximum 10 units can be requested in a single emergency ticket.'],
		},
		unitsReserved: {
			type: Number,
			default: 0,
			min: 0,
		},
		unitsFulfilled: {
			type: Number,
			default: 0,
			min: 0,
		},

		// Urgency & Criticality Windows
		urgencyLevel: {
			type: String,
			enum: {
				values: VALID_URGENCY_LEVELS,
				message: '{VALUE} is not a valid urgency level. Allowed: ' + VALID_URGENCY_LEVELS.join(', '),
			},
			default: 'Urgent',
			required: [true, 'Urgency level is required.'],
			index: true,
		},
		requiredWithinHours: {
			type: Number,
			default: 4,
			min: [1, 'Minimum response window is 1 hour.'],
			max: [48, 'Maximum response window is 48 hours.'],
		},
		expiresAt: {
			type: Date,
			required: true,
			index: true,
		},

		// Hospital Details & Geospatial Coordinates
		hospitalName: {
			type: String,
			required: [true, 'Hospital name is required.'],
			trim: true,
		},
		hospitalAddress: {
			type: String,
			required: [true, 'Hospital address is required.'],
			trim: true,
		},
		hospitalCity: {
			type: String,
			required: [true, 'Hospital city is required.'],
			trim: true,
		},
		hospitalState: {
			type: String,
			required: [true, 'Hospital state is required.'],
			trim: true,
		},
		hospitalPinCode: {
			type: Number,
			required: [true, 'Hospital PIN Code is required.'],
		},
		// Optional GeoJSON Point: supports City/State manual fallback if geolocation is unavailable
		location: {
			type: pointSchema,
			required: false,
			default: undefined,
		},

		// Medical Oversight & Clinical Contact
		attendingDoctor: {
			doctorName: {
				type: String,
				required: [true, 'Attending doctor name is required.'],
				trim: true,
			},
			doctorPhone: {
				type: String,
				required: [true, 'Attending doctor phone number is required.'],
				trim: true,
			},
			registrationNumber: {
				type: String,
				trim: true,
				default: '',
			},
		},
		hospitalWardBed: {
			type: String,
			trim: true,
			default: '',
		},
		clinicalJustification: {
			type: String,
			trim: true,
			default: '',
		},

		// Verification State — Strictly defaults to Pending_Verification (Safety Requirement)
		verificationStatus: {
			type: String,
			enum: {
				values: VALID_VERIFICATION_STATUSES,
				message: '{VALUE} is not a valid verification status.',
			},
			default: 'Pending_Verification',
			required: true,
			index: true,
		},

		// Emergency Request Lifecycle
		status: {
			type: String,
			enum: {
				values: VALID_EMERGENCY_STATUSES,
				message: '{VALUE} is not a valid emergency status.',
			},
			default: 'Active',
			required: true,
			index: true,
		},

		// Linked Resources
		matchedBloodbankIds: [
			{
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodbank',
			},
		],
		reservedUnitIds: [
			{
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodunit',
			},
		],
		notifiedDonorCount: {
			type: Number,
			default: 0,
			min: 0,
		},
		confirmedDonorCount: {
			type: Number,
			default: 0,
			min: 0,
		},
		cancellationReason: {
			type: String,
			trim: true,
			default: '',
		},
	},
	{ timestamps: true }
)

// Pre-save Lifecycle Hooks
emergencyBloodRequestSchema.pre('validate', function (next) {
	// Auto-generate request identifier if not provided
	if (!this.requestNumber) {
		const dateSegment = new Date().toISOString().slice(0, 10).replace(/-/g, '')
		const randomSegment = crypto.randomBytes(3).toString('hex').toUpperCase()
		this.requestNumber = `EMG-${dateSegment}-${randomSegment}`
	}

	// Auto-compute expiration date based on requiredWithinHours if not set
	if (!this.expiresAt) {
		const hours = this.requiredWithinHours && this.requiredWithinHours >= 1 ? this.requiredWithinHours : 4
		this.expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000)
	}

	// Clean up empty location structure to undefined
	if (
		this.location &&
		(!this.location.coordinates ||
			this.location.coordinates.length === 0 ||
			!Array.isArray(this.location.coordinates))
	) {
		this.set('location', undefined)
	}

	next()
})

// Geospatial 2dsphere index for radius matching (sparse for city/state fallback requests)
emergencyBloodRequestSchema.index({ location: '2dsphere' }, { sparse: true })

// Compound query indexes for active dispatch queues
emergencyBloodRequestSchema.index({ status: 1, requiredBloodGroup: 1, urgencyLevel: 1 })
emergencyBloodRequestSchema.index({ requesterUserId: 1, createdAt: -1 })
emergencyBloodRequestSchema.index({ hospitalCity: 1, hospitalState: 1 })

const EmergencyBloodRequest = mongoose.model('emergencybloodrequest', emergencyBloodRequestSchema)

module.exports = {
	EmergencyBloodRequest,
	VALID_URGENCY_LEVELS,
	VALID_VERIFICATION_STATUSES,
	VALID_EMERGENCY_STATUSES,
}
