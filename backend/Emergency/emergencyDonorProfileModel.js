/**
 * Emergency Donor Profile Model
 * Namma Blood — Emergency Blood Connection (Milestone 4.1)
 *
 * Clinical Governance Note:
 * This model strictly records donor registration, voluntary opt-in preferences,
 * and historical donation timestamps. It DOES NOT make automated clinical eligibility
 * or deferral decisions without authorized clinical review.
 */

const mongoose = require('mongoose')
const { VALID_BLOOD_GROUPS } = require('../BloodUnit/bloodUnitModel')
const { isValidCoordinate } = require('./geoValidation')

// Self-reported availability intent (communication preference only, NOT medical clearance)
const VALID_DONOR_AVAILABILITY = [
	'Ready',
	'Busy_Temporarily',
	'Opted_Out',
]

// Clinical eligibility governance statuses
const VALID_CLINICAL_ELIGIBILITY_STATUSES = [
	'Pending_Clinical_Evaluation', // Default: eligibility must be evaluated by qualified transfusion personnel
	'Clinically_Cleared',          // Verified by certified clinical review
	'Temporarily_Deferred',        // Deferred based on clinical review or medical interval
	'Permanently_Deferred',        // Deferred permanently due to medical contraindication
]

const VALID_DONATION_COMPONENTS = [
	'Whole_Blood',
	'Packed_Red_Blood_Cells',
	'Platelet_Concentrate',
	'Fresh_Frozen_Plasma',
	'Cryoprecipitate',
	null,
]

// Embedded GeoJSON Point Schema for approximate discovery location
const pointSchema = new mongoose.Schema(
	{
		type: {
			type: String,
			enum: ['Point'],
			default: 'Point',
			required: true,
		},
		coordinates: {
			type: [Number], // [fuzzedLongitude, fuzzedLatitude]
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

const emergencyDonorProfileSchema = new mongoose.Schema(
	{
		// Platform User Reference (1-to-1 linkage)
		userId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'user',
			required: [true, 'User ID is required.'],
			unique: true,
			index: true,
		},

		// Blood Group for Emergency Matching
		bloodGroup: {
			type: String,
			enum: {
				values: VALID_BLOOD_GROUPS,
				message: '{VALUE} is not a valid blood group.',
			},
			required: [true, 'Blood group is required for donor profile.'],
			index: true,
		},

		// Voluntary Opt-in Status for Emergency Notifications
		isEmergencyDonor: {
			type: Boolean,
			default: false,
			index: true,
		},

		// Self-reported availability intent (communication preference only)
		availabilityStatus: {
			type: String,
			enum: {
				values: VALID_DONOR_AVAILABILITY,
				message: '{VALUE} is not a valid availability status. Allowed: ' + VALID_DONOR_AVAILABILITY.join(', '),
			},
			default: 'Ready',
			index: true,
		},

		// Clinical Eligibility Governance
		// Invariant: Eligibility is NEVER automatically assumed. Requires qualified clinical review.
		clinicalEligibilityStatus: {
			type: String,
			enum: {
				values: VALID_CLINICAL_ELIGIBILITY_STATUSES,
				message: '{VALUE} is not a valid clinical eligibility status.',
			},
			default: 'Pending_Clinical_Evaluation',
			required: true,
			index: true,
		},

		// Donation History (Preserved for Clinical Evaluation)
		lastDonationDate: {
			type: Date,
			default: null,
		},
		lastDonationComponent: {
			type: String,
			enum: {
				values: VALID_DONATION_COMPONENTS,
				message: '{VALUE} is not a valid donation component.',
			},
			default: null,
		},
		// Clinically established eligibility date (set by qualified personnel, NEVER by hardcoded platform assumptions)
		eligibleToDonateAfter: {
			type: Date,
			default: null,
			index: true,
		},
		clinicalReviewNotes: {
			type: String,
			trim: true,
			default: '',
		},
		reviewedByStaffId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'bloodbankstaff',
			default: null,
		},
		reviewedAt: {
			type: Date,
			default: null,
		},

		/**
		 * Approximate Fuzzed GeoJSON Location (Strictly for Privacy-Preserving Discovery Only)
		 *
		 * PRIVACY & SAFETY INVARIANTS:
		 * 1. These coordinates are deliberately fuzzed with random jitter (500m-1km) and MUST NEVER
		 *    be interpreted as verified physical location, proof of residence, or dispatch destination.
		 * 2. Exact residential addresses are NEVER stored in this emergency profile.
		 * 3. These approximate coordinates MUST NEVER be used as the basis for final clinical eligibility
		 *    or dispatch decisions.
		 * 4. Public API responses MUST strip these coordinates via toDiscoverySafeObject().
		 */
		location: {
			type: pointSchema,
			required: false,
			default: undefined,
		},

		// Broad Administrative Geography (Used for coarse location filtering and fallback)
		state: {
			type: String,
			required: [true, 'State is required.'],
			trim: true,
		},
		city: {
			type: String,
			required: [true, 'City is required.'],
			trim: true,
		},
		pinCode: {
			type: Number,
			required: [true, 'PIN Code is required.'],
		},

		// Distance & Alert Preferences
		maxTravelDistanceKm: {
			type: Number,
			default: 15,
			min: [2, 'Minimum travel distance is 2 km.'],
			max: [50, 'Maximum emergency travel distance is 50 km.'],
		},
		notificationPreferences: {
			email: {
				type: Boolean,
				default: true,
			},
			webPush: {
				type: Boolean,
				default: true,
			},
			inApp: {
				type: Boolean,
				default: true,
			},
		},

		// Anti-Spam & Notification Velocity Tracking
		lastAlertReceivedAt: {
			type: Date,
			default: null,
		},
		alertsReceivedInLast24h: {
			type: Number,
			default: 0,
			min: 0,
		},

		// Web Push VAPID Subscription Details
		pushSubscription: {
			endpoint: {
				type: String,
				default: null,
			},
			keys: {
				p256dh: {
					type: String,
					default: null,
				},
				auth: {
					type: String,
					default: null,
				},
			},
		},
	},
	{ timestamps: true }
)

// Pre-validate hook: clean up empty or malformed location structures
emergencyDonorProfileSchema.pre('validate', function (next) {
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

/**
 * Privacy Shield: Sanitizes the donor profile for emergency discovery and matching responses.
 * Guarantees that internal location coordinates, push keys, and PII are stripped.
 *
 * @returns {Object} Safe discovery descriptor
 */
emergencyDonorProfileSchema.methods.toDiscoverySafeObject = function () {
	return {
		profileId: this._id,
		bloodGroup: this.bloodGroup,
		state: this.state,
		city: this.city,
		maxTravelDistanceKm: this.maxTravelDistanceKm,
		availabilityStatus: this.availabilityStatus,
		clinicalEligibilityStatus: this.clinicalEligibilityStatus,
		isEmergencyDonor: this.isEmergencyDonor,
		hasLocation: Boolean(this.location && this.location.coordinates),
	}
}

// Sparse 2dsphere index: ignores documents where location is undefined
emergencyDonorProfileSchema.index({ location: '2dsphere' }, { sparse: true })

// Compound query indexes for rapid emergency matching
emergencyDonorProfileSchema.index({
	isEmergencyDonor: 1,
	availabilityStatus: 1,
	clinicalEligibilityStatus: 1,
	bloodGroup: 1,
})
emergencyDonorProfileSchema.index({ city: 1, state: 1 })

const EmergencyDonorProfile = mongoose.model('emergencydonorprofile', emergencyDonorProfileSchema)

module.exports = {
	EmergencyDonorProfile,
	VALID_DONOR_AVAILABILITY,
	VALID_CLINICAL_ELIGIBILITY_STATUSES,
	VALID_DONATION_COMPONENTS,
}
