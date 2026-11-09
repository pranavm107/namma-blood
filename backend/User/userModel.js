const mongoose = require('mongoose')
const bcryptjs = require('bcryptjs')
const crypto = require('crypto')

const schema = new mongoose.Schema(
	{
		firstName: {
			type: String,
			required: [true, 'First Name is required'],
			trim: true,
		},
		lastName: {
			type: String,
			required: [true, 'Last Name is required'],
			trim: true,
		},
		gender: {
			type: String,
			enum: ['Male', 'Female'],
			required: function () {
				return this.role === 'USER'
			},
			trim: true,
		},
		dob: {
			type: Date,
			required: function () {
				return this.role === 'USER'
			},
		},
		age: {
			type: Number,
			required: function () {
				return this.role === 'USER'
			},
			min: 18,
			max: 65,
		},
		phoneNo1: {
			type: Number,
			required: [true, 'Primary Phone number is required'],
			unique: true,
		},
		phoneNo2: {
			type: Number,
		},
		email: {
			type: String,
			required: [true, 'Email address is required'],
			unique: true,
			trim: true,
		},
		state: {
			type: String,
			required: function () {
				return this.role === 'USER'
			},
			trim: true,
		},
		city: {
			type: String,
			required: function () {
				return this.role === 'USER'
			},
			trim: true,
		},
		address: {
			type: String,
			required: function () {
				return this.role === 'USER'
			},
			trim: true,
		},
		pinCode: {
			type: Number,
			required: function () {
				return this.role === 'USER'
			},
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
		role: {
			type: String,
			enum: ['USER', 'MEDICAL_OFFICER', 'HOSPITAL_ADMIN'],
			default: 'USER',
			index: true,
		},
		// Decoupled Account Lifecycle
		accountStatus: {
			type: String,
			enum: ['Pending_Activation', 'Active', 'Suspended', 'Deactivated'],
			default: function () {
				if (this.isNew === false) return undefined
				return this.role === 'USER' ? 'Active' : 'Pending_Activation'
			},
			index: true,
		},
		// Decoupled Professional Medical Credential Lifecycle
		credentialStatus: {
			type: String,
			enum: [
				'Unsubmitted',
				'Pending_Verification',
				'Under_Review',
				'Verified',
				'Rejected',
				'Suspended',
			],
			default: function () {
				if (this.isNew === false) return undefined
				return this.role === 'MEDICAL_OFFICER' ? 'Unsubmitted' : 'Verified'
			},
			index: true,
		},
		credentialVerifiedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'admin',
			default: null,
		},
		credentialVerifiedAt: {
			type: Date,
			default: null,
		},
		credentialRejectionReason: {
			type: String,
			trim: true,
			default: '',
		},
		// Medical Officer Credential Review & Clarification Tracking (Stage B3.4)
		credentialClarificationRequested: {
			type: Boolean,
			default: false,
		},
		credentialClarificationNotes: {
			type: String,
			trim: true,
			default: '',
		},
		credentialClarificationRequestedAt: {
			type: Date,
			default: null,
		},
		credentialClarificationRequestedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'admin',
			default: null,
		},
		credentialResubmissionCount: {
			type: Number,
			default: 0,
		},
		credentialLastSubmittedAt: {
			type: Date,
			default: null,
		},
		credentialReviewStartedAt: {
			type: Date,
			default: null,
		},
		credentialReviewStartedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'admin',
			default: null,
		},
		credentialSuspendedAt: {
			type: Date,
			default: null,
		},
		credentialSuspendedBy: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'admin',
			default: null,
		},
		credentialSuspensionReason: {
			type: String,
			trim: true,
			default: '',
		},
		// Hospital Representative Fields
		hospitalId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'hospital',
			default: null,
			index: true,
		},
		representativeStatus: {
			type: String,
			enum: ['Pending', 'Active', 'Suspended', 'Revoked'],
			default: 'Pending',
			index: true,
		},
		medicalRegistrationNumber: {
			type: String,
			trim: true,
			default: '',
		},
		medicalCouncil: {
			type: String,
			trim: true,
			default: '',
		},
		registrationState: {
			type: String,
			trim: true,
			default: '',
		},
		registrationYear: {
			type: Number,
			default: null,
		},
		qualification: {
			type: String,
			trim: true,
			default: '',
		},
		specialization: {
			type: String,
			trim: true,
			default: '',
		},
		supportingEvidence: {
			type: String,
			trim: true,
			default: '',
		},
		// Preserved for backward compatibility
		verificationStatus: {
			type: String,
			enum: ['Pending', 'Verified', 'Rejected', 'Suspended'],
			default: function () {
				if (this.isNew === false) return undefined
				return this.role === 'MEDICAL_OFFICER' ? 'Pending' : 'Verified'
			},
			index: true,
		},
		rejectionReason: {
			type: String,
			trim: true,
			default: '',
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
		nominatedByHospital: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'hospital',
			default: null,
		},
		passwordChangedAt: Date,
		passwordResetToken: String,
		passwordResetExpires: Date,
		tokenVersion: {
			type: Number,
			default: 0,
		},
	},
	{ timestamps: true }
)

// Unique partial index: strictly one Medical Officer per non-empty medicalRegistrationNumber
schema.index(
	{ medicalRegistrationNumber: 1 },
	{
		unique: true,
		partialFilterExpression: {
			role: 'MEDICAL_OFFICER',
			medicalRegistrationNumber: { $type: 'string', $gt: '' },
		},
		name: 'uniq_medical_registration_number_per_doctor',
	}
)

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

const userSchema = mongoose.model('user', schema)

module.exports = userSchema
