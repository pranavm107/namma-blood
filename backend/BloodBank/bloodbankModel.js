const mongoose = require('mongoose')
const bcryptjs = require('bcryptjs')
const crypto = require('crypto')
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
					return (
						Array.isArray(val) &&
						val.length === 2 &&
						typeof val[0] === 'number' &&
						!isNaN(val[0]) &&
						val[0] >= -180 &&
						val[0] <= 180 &&
						typeof val[1] === 'number' &&
						!isNaN(val[1]) &&
						val[1] >= -90 &&
						val[1] <= 90
					)
				},
				message:
					'Coordinates must be valid [longitude, latitude] where longitude is between -180 and 180 and latitude is between -90 and 90.',
			},
		},
	},
	{ _id: false }
)

const schema = new mongoose.Schema(
	{
		state: {
			type: String,
			required: [true, 'State name is required'],
			trim: true,
		},
		city: {
			type: String,
			required: [true, 'City name is required'],
			trim: true,
		},
		bloodbankName: {
			type: String,
			required: [true, 'Blood Bank Name is required'],
			trim: true,
		},
		category: {
			type: String,
			enum: ['Government', 'RedCross', 'Private', 'Charitable'],
			required: [true, 'Category is required'],
			trim: true,
		},
		contactPerson: {
			type: String,
			required: [true, 'Contact Person Name is required'],
			trim: true,
		},
		address1: {
			type: String,
			required: [true, 'Blood Bank Address 2 is required'],
			trim: true,
		},
		address2: {
			type: String,
			required: [true, 'Blood Bank Address 2 is required'],
			trim: true,
		},
		pinCode: {
			type: Number,
			required: [true, 'Blood Bank Pin code is required'],
			trim: true,
		},
		phoneNo1: {
			type: String,
			required: [true, 'Blood Bank primary Phone number is required'],
			unique: true,
		},
		phoneNo2: {
			type: String,
			required: [true, 'Blood Bank alternate Phone number is required'],
			unique: true,
		},
		email: {
			type: String,
			required: [true, 'Blood Bank Email is required'],
			unique: true,
			trim: true,
		},
		openingDate: {
			type: Date,
			default: Date.now(),
		},
		password: {
			type: String,
			required: [true, 'Password is required'],
			select: false,
			trim: true,
			min: 8,
			max: 20,
		},
		status: {
			type: Boolean,
			default: true,
		},
		passwordChangedAt: Date,
		passwordResetToken: String,
		passwordResetExpires: Date,
		tokenVersion: {
			type: Number,
			default: 0,
		},
		location: {
			type: pointSchema,
			required: false,
			default: undefined,
		},
	},
	{ timestamps: true }
)

// Clean up incomplete location structures before validation for existing record compatibility
schema.pre('validate', function (next) {
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

// Sparse 2dsphere index for optional geospatial matching
schema.index({ location: '2dsphere' }, { sparse: true })

schema.pre('save', async function (next) {
	if (!this.isModified('password')) return next()

	this.password = await bcryptjs.hash(
		this.password,
		Number(process.env.PASSWORD_ENCRYPT_LEVEL || 12)
	)

	if (!this.isNew) {
		this.passwordChangedAt = Date.now()
		this.tokenVersion = (this.tokenVersion || 0) + 1
	}

	next()
})

schema.methods.correctPassword = async function (
	candidatePassword,
	userPassword
) {
	return await bcryptjs.compare(candidatePassword, userPassword)
}

schema.methods.changedPasswordAfter = function (JWTTimestamp, tokenVersion) {
	// Reject missing, non-numeric, NaN, or non-positive iat claims unconditionally
	if (!JWTTimestamp || typeof JWTTimestamp !== 'number' || isNaN(JWTTimestamp) || JWTTimestamp <= 0) {
		return true
	}

	// 1) If token contains tokenVersion, use strict version validation
	if (typeof tokenVersion === 'number' && typeof this.tokenVersion === 'number') {
		return tokenVersion < this.tokenVersion
	}

	// 2) Fallback to timestamp comparison for legacy tokens without tokenVersion
	if (this.passwordChangedAt) {
		const changedTimestamp = parseInt(
			this.passwordChangedAt.getTime() / 1000,
			10
		)
		return JWTTimestamp <= changedTimestamp
	}

	return false
}

schema.methods.createPasswordResetToken = function () {
	const resetToken = crypto.randomBytes(32).toString('hex')

	this.passwordResetToken = crypto
		.createHash(process.env.CREATEHASH_KEY || 'sha256')
		.update(resetToken)
		.digest('hex')

	this.passwordResetExpires = Date.now() + 10 * 60 * 1000

	return resetToken
}

const bloodbankSchema = mongoose.model('bloodbank', schema)

module.exports = bloodbankSchema
