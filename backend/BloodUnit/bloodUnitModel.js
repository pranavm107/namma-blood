const mongoose = require('mongoose')

const VALID_BLOOD_GROUPS = [
	'A_Positive',
	'A_Negative',
	'B_Positive',
	'B_Negative',
	'AB_Positive',
	'AB_Negative',
	'O_Positive',
	'O_Negative',
]

const VALID_COMPONENT_TYPES = [
	'Whole_Blood',
	'Packed_Red_Blood_Cells',
	'Fresh_Frozen_Plasma',
	'Platelet_Concentrate',
	'Cryoprecipitate',
]

const VALID_STATUSES = [
	'Quarantined',
	'Tested_Passed',
	'Available',
	'Reserved',
	'Issued',
	'Discarded',
	'Expired',
]

const MANDATORY_TTI_TESTS = ['hiv', 'hbv', 'hcv', 'syphilis', 'malaria']

const bloodUnitSchema = new mongoose.Schema(
	{
		// Unique Donation Identification Number (DIN / Barcode)
		unitNumber: {
			type: String,
			required: [true, 'Unique Unit Number (DIN) is required.'],
			unique: true,
			trim: true,
			uppercase: true,
			index: true,
		},

		// Blood bank that owns and stores this unit
		bloodbankId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'bloodbank',
			required: [true, 'Owning Blood Bank ID is required.'],
			index: true,
		},

		// Reference to original platform donation request (if collected through Namma Blood)
		donationRequestId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'blooddonate',
			default: null,
			index: true,
		},

		// Reference to registered donor user (if collected from platform user)
		donorUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'user',
			default: null,
			index: true,
		},

		// Confirmed blood group
		bloodGroup: {
			type: String,
			enum: {
				values: VALID_BLOOD_GROUPS,
				message: '{VALUE} is not a valid blood group.',
			},
			required: [true, 'Confirmed Blood Group is required.'],
			index: true,
		},

		// Component fraction type
		componentType: {
			type: String,
			enum: {
				values: VALID_COMPONENT_TYPES,
				message: '{VALUE} is not a valid component type.',
			},
			required: [true, 'Component type is required.'],
			default: 'Whole_Blood',
			index: true,
		},

		// Volume in milliliters
		volumeMl: {
			type: Number,
			required: [true, 'Volume in mL is required.'],
			min: [50, 'Minimum unit volume is 50 mL.'],
			max: [600, 'Maximum unit volume is 600 mL.'],
			default: 350,
		},

		// Date and time of collection
		collectionDate: {
			type: Date,
			required: [true, 'Collection date is required.'],
			default: Date.now,
			index: true,
		},

		// Clinical expiration date
		expiryDate: {
			type: Date,
			required: [true, 'Expiry date is required.'],
			index: true,
		},

		// Cold-chain storage coordinates
		storageLocation: {
			refrigeratorId: { type: String, trim: true, default: '' },
			shelfNumber: { type: String, trim: true, default: '' },
			compartment: { type: String, trim: true, default: '' },
		},

		// Lifecycle state machine — MUST default to Quarantined (non-issue-eligible)
		status: {
			type: String,
			enum: {
				values: VALID_STATUSES,
				message: '{VALUE} is not a valid blood unit status.',
			},
			default: 'Quarantined',
			required: [true, 'Status is required.'],
			index: true,
		},

		// Mandatory Transfusion Transmissible Infection (TTI) Screening Panel
		testing: {
			hiv: {
				type: String,
				enum: ['Pending', 'Non_Reactive', 'Reactive'],
				default: 'Pending',
			},
			hbv: {
				type: String,
				enum: ['Pending', 'Non_Reactive', 'Reactive'],
				default: 'Pending',
			},
			hcv: {
				type: String,
				enum: ['Pending', 'Non_Reactive', 'Reactive'],
				default: 'Pending',
			},
			syphilis: {
				type: String,
				enum: ['Pending', 'Non_Reactive', 'Reactive'],
				default: 'Pending',
			},
			malaria: {
				type: String,
				enum: ['Pending', 'Non_Reactive', 'Reactive'],
				default: 'Pending',
			},
			testedBy: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodbank',
				default: null,
			},
			testedAt: {
				type: Date,
				default: null,
			},
			testBatchId: {
				type: String,
				trim: true,
				default: null,
			},
		},

		// Quality Verification & Medical Officer Authorization
		clearance: {
			isVerified: {
				type: Boolean,
				default: false,
			},
			verifiedBy: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodbank',
				default: null,
			},
			verifiedByStaffId: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodbankstaff',
				default: null,
			},
			verifiedAt: {
				type: Date,
				default: null,
			},
			notes: {
				type: String,
				trim: true,
				default: '',
			},
		},

		// Allocation & Reservation details
		reservation: {
			receiveRequestId: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodreceiverequests',
				default: null,
			},
			reservedAt: {
				type: Date,
				default: null,
			},
			reservedExpiresAt: {
				type: Date,
				default: null,
			},
		},

		// Final Issuance / Dispensation metadata
		issuance: {
			issuedToReceiveRequestId: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodreceiverequests',
				default: null,
			},
			recipientPatientName: {
				type: String,
				trim: true,
				default: '',
			},
			hospitalName: {
				type: String,
				trim: true,
				default: '',
			},
			crossmatchResult: {
				type: String,
				enum: [
					'Pending',
					'Compatible',
					'Incompatible',
					'Emergency_Uncrossmatched',
				],
				default: 'Pending',
			},
			issuedAt: {
				type: Date,
				default: null,
			},
			issuedBy: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodbank',
				default: null,
			},
		},

		// Discard / Destruction audit info
		discard: {
			reason: {
				type: String,
				enum: [
					'',
					'TTI_Reactive',
					'Expired',
					'Hemolysis',
					'Bag_Leakage',
					'Clotted',
					'Temperature_Excursion',
					'Other',
				],
				default: '',
			},
			discardedAt: {
				type: Date,
				default: null,
			},
			discardedBy: {
				type: mongoose.Schema.Types.ObjectId,
				ref: 'bloodbank',
				default: null,
			},
			wasteManifestNumber: {
				type: String,
				trim: true,
				default: '',
			},
		},

		// Flag distinguishing units ingested from legacy shelf inventory
		isLegacyMigrated: {
			type: Boolean,
			default: false,
		},
	},
	{
		timestamps: true,
	}
)

// Compound Indexes for fast, indexed queries
bloodUnitSchema.index(
	{ bloodbankId: 1, status: 1, bloodGroup: 1, componentType: 1, expiryDate: 1 }
)
bloodUnitSchema.index(
	{ bloodbankId: 1, expiryDate: 1 },
	{ partialFilterExpression: { status: 'Available' } }
)
bloodUnitSchema.index(
	{ 'reservation.receiveRequestId': 1 },
	{ sparse: true }
)

/**
 * Pre-save validation: Enforce clinical safety rules before committing unit changes.
 */
bloodUnitSchema.pre('save', function (next) {
	// 1. Safety Gate: A unit CANNOT be Available unless it satisfies all clearance criteria
	if (this.status === 'Available') {
		// Must have explicit Medical Officer clearance
		if (!this.clearance?.isVerified) {
			return next(
				new Error(
					'Safety violation: BloodUnit cannot be Available without explicit Medical Officer clearance verification.'
				)
			)
		}

		// Must not be expired
		if (this.expiryDate && new Date(this.expiryDate) <= new Date()) {
			return next(
				new Error(
					'Safety violation: Expired BloodUnit cannot be marked Available.'
				)
			)
		}

		// All 5 mandatory TTI screening tests must be Non_Reactive
		for (const test of MANDATORY_TTI_TESTS) {
			const result = this.testing ? this.testing[test] : null
			if (result !== 'Non_Reactive') {
				return next(
					new Error(
						`Safety violation: BloodUnit cannot be Available: mandatory screening test '${test}' is '${result}'. Must be 'Non_Reactive'.`
					)
				)
			}
		}
	}

	// 2. Reactive units must never enter Tested_Passed or Available
	if (this.testing) {
		const isAnyReactive = MANDATORY_TTI_TESTS.some(
			(test) => this.testing[test] === 'Reactive'
		)
		if (
			isAnyReactive &&
			(this.status === 'Tested_Passed' || this.status === 'Available')
		) {
			return next(
				new Error(
					'Safety violation: BloodUnit with reactive screening results cannot be Tested_Passed or Available. It must be Discarded.'
				)
			)
		}
	}

	next()
})

/**
 * Helper to inspect any update operator ($set, $setOnInsert, direct) or raw replacement document.
 */
function extractTargetStatus(update) {
	if (!update || typeof update !== 'object') return null
	if (update.status !== undefined) return update.status
	if (update.$set && update.$set.status !== undefined) return update.$set.status
	if (update.$setOnInsert && update.$setOnInsert.status !== undefined) return update.$setOnInsert.status

	// Support dot-notation or custom keys
	for (const key of Object.keys(update)) {
		if (key === 'status' || key.endsWith('.status')) {
			return update[key]
		}
	}
	if (update.$set) {
		for (const key of Object.keys(update.$set)) {
			if (key === 'status' || key.endsWith('.status')) {
				return update.$set[key]
			}
		}
	}
	return null
}

/**
 * Query Middleware Guards: Block unsafe query-level status transitions.
 *
 * Clinical Safety Invariant:
 * Transitioning a unit to 'Available' or 'Tested_Passed' without document-level validation
 * bypasses infectious disease verification, expiry checks, and Medical Officer sign-off.
 * All status transitions into issue-eligible or cleared states MUST use document.save().
 */
function rejectUnsafeQueryStatus(next) {
	const update = typeof this.getUpdate === 'function' ? this.getUpdate() : null
	const targetStatus = extractTargetStatus(update)

	if (targetStatus === 'Available' || targetStatus === 'Tested_Passed') {
		const err = new Error(
			`Safety violation: Query-based transition to status '${targetStatus}' is strictly forbidden. Document .save() is required to enforce clinical safety and clearance gates.`
		)
		if (typeof next === 'function') return next(err)
		throw err
	}

	if (typeof next === 'function') next()
}

bloodUnitSchema.pre('updateOne', rejectUnsafeQueryStatus)
bloodUnitSchema.pre('updateMany', rejectUnsafeQueryStatus)
bloodUnitSchema.pre('findOneAndUpdate', rejectUnsafeQueryStatus)
bloodUnitSchema.pre('replaceOne', rejectUnsafeQueryStatus)
bloodUnitSchema.pre('findOneAndReplace', rejectUnsafeQueryStatus)

/**
 * Clinical issue-eligibility helper method.
 * Returns true ONLY if all quality and safety criteria are satisfied.
 */
bloodUnitSchema.methods.isIssueEligible = function () {
	if (this.status !== 'Available') return false
	if (!this.clearance?.isVerified) return false
	if (this.expiryDate && new Date(this.expiryDate) <= new Date()) return false

	if (!this.testing) return false
	for (const test of MANDATORY_TTI_TESTS) {
		if (this.testing[test] !== 'Non_Reactive') return false
	}

	return true
}

const BloodUnit = mongoose.model('bloodunit', bloodUnitSchema)

module.exports = {
	BloodUnit,
	VALID_BLOOD_GROUPS,
	VALID_COMPONENT_TYPES,
	VALID_STATUSES,
	MANDATORY_TTI_TESTS,
}
