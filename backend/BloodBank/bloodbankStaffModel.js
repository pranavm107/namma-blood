const mongoose = require('mongoose')
const bcryptjs = require('bcryptjs')
const crypto = require('crypto')

const VALID_STAFF_ROLES = ['Medical_Officer', 'Lab_Technician', 'Staff_Admin']
const VALID_STAFF_STATUSES = ['Active', 'Suspended', 'Revoked']

const staffSchema = new mongoose.Schema(
	{
		fullName: {
			type: String,
			required: [true, 'Full name is required.'],
			trim: true,
		},
		email: {
			type: String,
			required: [true, 'Email address is required.'],
			unique: true,
			lowercase: true,
			trim: true,
			index: true,
		},
		phoneNo: {
			type: String,
			required: [true, 'Phone number is required.'],
			trim: true,
		},
		bloodbankId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'bloodbank',
			required: [true, 'Owning blood bank ID is required.'],
			index: true,
		},
		role: {
			type: String,
			enum: {
				values: VALID_STAFF_ROLES,
				message: '{VALUE} is not a valid staff role. Allowed: ' + VALID_STAFF_ROLES.join(', '),
			},
			required: [true, 'Staff role is required.'],
			index: true,
		},
		medicalLicense: {
			licenseNumber: {
				type: String,
				trim: true,
				default: null,
			},
			issuingCouncil: {
				type: String,
				trim: true,
				default: null,
			},
			isVerified: {
				type: Boolean,
				default: false,
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
			verificationNotes: {
				type: String,
				trim: true,
				default: '',
			},
		},
		status: {
			type: String,
			enum: {
				values: VALID_STAFF_STATUSES,
				message: '{VALUE} is not a valid status. Allowed: ' + VALID_STAFF_STATUSES.join(', '),
			},
			default: 'Active',
			index: true,
		},
		password: {
			type: String,
			required: [true, 'Password is required.'],
			select: false,
			trim: true,
			minlength: [8, 'Password must be at least 8 characters.'],
		},
		mustChangePassword: {
			type: Boolean,
			default: true,
			index: true,
		},
		setupToken: {
			type: String,
			select: false,
			default: null,
		},
		setupExpires: {
			type: Date,
			select: false,
			default: null,
		},
		passwordChangedAt: {
			type: Date,
		},
		tokenVersion: {
			type: Number,
			default: 0,
		},
		createdBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'bloodbank',
			required: [true, 'Provisioning blood bank ID is required.'],
		},
	},
	{
		timestamps: true,
	}
)

// Compound Index: Fast lookup of staff by blood bank and role
staffSchema.index({ bloodbankId: 1, role: 1, status: 1 })

// Pre-save validation and hashing
staffSchema.pre('save', async function (next) {
	// Medical Officer governance check: license number is required for Medical Officers
	if (this.role === 'Medical_Officer') {
		if (!this.medicalLicense?.licenseNumber || !this.medicalLicense.licenseNumber.trim()) {
			return next(new Error('Medical Officer must have a non-empty medical license number.'))
		}
	}

	if (!this.isModified('password')) return next()

	this.password = await bcryptjs.hash(
		this.password,
		Number(process.env.PASSWORD_ENCRYPT_LEVEL || 12)
	)

	if (!this.isNew) {
		this.passwordChangedAt = new Date()
		this.tokenVersion = (this.tokenVersion || 0) + 1
	}

	next()
})

staffSchema.methods.correctPassword = async function (candidatePassword, userPassword) {
	return await bcryptjs.compare(candidatePassword, userPassword)
}

staffSchema.methods.changedPasswordAfter = function (JWTTimestamp, tokenVersion) {
	if (!JWTTimestamp || typeof JWTTimestamp !== 'number' || isNaN(JWTTimestamp) || JWTTimestamp <= 0) {
		return true
	}

	// 1) Strict tokenVersion check: if current tokenVersion is greater than token claim, token is invalidated
	if (typeof tokenVersion === 'number' && typeof this.tokenVersion === 'number') {
		return tokenVersion < this.tokenVersion
	}

	// 2) Fallback to timestamp comparison
	if (this.passwordChangedAt) {
		const changedTimestamp = parseInt(this.passwordChangedAt.getTime() / 1000, 10)
		return JWTTimestamp <= changedTimestamp
	}

	return false
}

/**
 * Creates a cryptographically secure one-time setup token for staff invitation/activation.
 */
staffSchema.methods.createSetupToken = function () {
	const rawToken = crypto.randomBytes(32).toString('hex')
	this.setupToken = crypto
		.createHash('sha256')
		.update(rawToken)
		.digest('hex')
	this.setupExpires = Date.now() + 72 * 60 * 60 * 1000 // Valid for 72 hours
	return rawToken
}

const BloodbankStaff = mongoose.model('bloodbankstaff', staffSchema)

module.exports = {
	BloodbankStaff,
	VALID_STAFF_ROLES,
	VALID_STAFF_STATUSES,
}
