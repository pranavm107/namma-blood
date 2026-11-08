const mongoose = require('mongoose')
const { isValidCoordinate } = require('../Emergency/geoValidation')

const VALID_HOSPITAL_TYPES = ['Government', 'Private', 'Trust', 'Autonomous']
const VALID_HOSPITAL_VERIFICATION_STATUSES = ['Pending', 'Verified', 'Rejected']

const hospitalSchema = new mongoose.Schema(
	{
		hospitalCode: {
			type: String,
			required: [true, 'Hospital code is required.'],
			unique: true,
			uppercase: true,
			trim: true,
			index: true,
		},
		hospitalName: {
			type: String,
			required: [true, 'Hospital name is required.'],
			trim: true,
			index: true,
		},
		hospitalType: {
			type: String,
			enum: {
				values: VALID_HOSPITAL_TYPES,
				message: '{VALUE} is not a valid hospital type. Allowed: ' + VALID_HOSPITAL_TYPES.join(', '),
			},
			default: 'Private',
		},
		address: {
			street: { type: String, required: [true, 'Street address is required.'], trim: true },
			city: { type: String, required: [true, 'City is required.'], trim: true, index: true },
			state: { type: String, required: [true, 'State is required.'], trim: true, index: true },
			pinCode: { type: String, required: [true, 'PIN Code is required.'], trim: true },
		},
		// Optional GeoJSON Point: supports City/State manual fallback if geolocation is unavailable
		location: {
			type: {
				type: String,
				enum: ['Point'],
				default: 'Point',
			},
			coordinates: {
				type: [Number], // [longitude, latitude]
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
		contactPhone: {
			type: String,
			required: [true, 'Contact phone is required.'],
			trim: true,
		},
		contactEmail: {
			type: String,
			required: [true, 'Contact email is required.'],
			trim: true,
			lowercase: true,
		},
		verificationStatus: {
			type: String,
			enum: {
				values: VALID_HOSPITAL_VERIFICATION_STATUSES,
				message: '{VALUE} is not a valid hospital verification status. Allowed: ' + VALID_HOSPITAL_VERIFICATION_STATUSES.join(', '),
			},
			default: 'Pending',
			index: true,
		},
		isActive: {
			type: Boolean,
			default: false,
			index: true,
		},
		verifiedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'admin',
			default: null,
		},
		verifiedAt: {
			type: Date,
			default: null,
		},
	},
	{ timestamps: true }
)

// Clean up empty location structure to undefined
hospitalSchema.pre('validate', function (next) {
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

// Ensure unique index on hospitalCode
hospitalSchema.index({ hospitalCode: 1 }, { unique: true })
// Sparse 2dsphere index: ignores documents where location is undefined
hospitalSchema.index({ location: '2dsphere' }, { sparse: true })
hospitalSchema.index({ 'address.city': 1, 'address.state': 1, isActive: 1 })

const Hospital = mongoose.model('hospital', hospitalSchema)

module.exports = {
	Hospital,
	VALID_HOSPITAL_TYPES,
	VALID_HOSPITAL_VERIFICATION_STATUSES,
}

