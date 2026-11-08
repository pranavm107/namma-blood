/**
 * Unified Invitation Model
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Phase 4.3.5)
 *
 * Supports secure, expiring, single-use token invitations for:
 * 1. DOCTOR_NOMINATION (Hospital Representative or Admin nominating a physician)
 * 2. HOSPITAL_REPRESENTATIVE (Platform Admin provisioning a Hospital Representative)
 *
 * Security Invariants:
 * - Raw invitation token is NEVER stored in database (only SHA-256 hash).
 * - Single-use token: invalidates upon acceptance or revocation.
 * - Enforces default 48-hour expiration.
 * - Recipient email normalized to lowercase and trimmed.
 */

const mongoose = require('mongoose')
const crypto = require('crypto')

const VALID_INVITATION_TYPES = ['DOCTOR_NOMINATION', 'HOSPITAL_REPRESENTATIVE']
const VALID_INVITATION_STATUSES = ['Pending', 'Accepted', 'Revoked', 'Expired']
const VALID_INVITED_BY_ROLES = ['ADMIN', 'HOSPITAL_ADMIN']

const invitationSchema = new mongoose.Schema(
	{
		invitationType: {
			type: String,
			enum: {
				values: VALID_INVITATION_TYPES,
				message:
					'{VALUE} is not a valid invitation type. Allowed: ' +
					VALID_INVITATION_TYPES.join(', '),
			},
			required: [true, 'Invitation type is required.'],
			index: true,
		},
		hospitalId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'hospital',
			required: [true, 'Hospital ID is required.'],
			index: true,
		},
		invitedByUserId: {
			type: mongoose.Schema.Types.ObjectId,
			required: [true, 'Invited-by user ID is required.'],
		},
		invitedByRole: {
			type: String,
			enum: {
				values: VALID_INVITED_BY_ROLES,
				message:
					'{VALUE} is not a valid invited-by role. Allowed: ' +
					VALID_INVITED_BY_ROLES.join(', '),
			},
			required: [true, 'Invited-by role is required.'],
		},
		recipientName: {
			type: String,
			required: [true, 'Recipient name is required.'],
			trim: true,
		},
		recipientEmail: {
			type: String,
			required: [true, 'Recipient email is required.'],
			lowercase: true,
			trim: true,
			index: true,
		},
		recipientPhone: {
			type: Number,
			required: [true, 'Recipient phone number is required.'],
		},
		invitationTokenHash: {
			type: String,
			required: [true, 'Invitation token hash is required.'],
			index: true,
		},
		tokenExpiresAt: {
			type: Date,
			required: [true, 'Token expiration timestamp is required.'],
			index: true,
		},
		status: {
			type: String,
			enum: {
				values: VALID_INVITATION_STATUSES,
				message:
					'{VALUE} is not a valid invitation status. Allowed: ' +
					VALID_INVITATION_STATUSES.join(', '),
			},
			default: 'Pending',
			index: true,
		},
		acceptedAt: {
			type: Date,
			default: null,
		},
		metadata: {
			type: mongoose.Schema.Types.Mixed,
			default: {},
		},
	},
	{ timestamps: true }
)

/**
 * Normalizes recipient email before validation and save
 */
invitationSchema.pre('validate', function (next) {
	if (this.recipientEmail) {
		this.recipientEmail = this.recipientEmail.trim().toLowerCase()
	}
	next()
})

invitationSchema.pre('save', function (next) {
	if (this.recipientEmail) {
		this.recipientEmail = this.recipientEmail.trim().toLowerCase()
	}
	next()
})

/**
 * Generates a cryptographically secure 32-byte hex token, hashes it with SHA-256,
 * sets the hash and 48-hour expiration on the document, and returns the raw token.
 * The raw token must only be sent to the recipient via secure channel (never saved to DB).
 */
invitationSchema.methods.createInvitationToken = function (expiryHours = 48) {
	const rawToken = crypto.randomBytes(32).toString('hex')
	this.invitationTokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
	this.tokenExpiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000)
	this.status = 'Pending'
	return rawToken
}

/**
 * Static helper: Hashes raw token for lookup
 */
invitationSchema.statics.hashToken = function (rawToken) {
	if (!rawToken || typeof rawToken !== 'string') return ''
	return crypto.createHash('sha256').update(rawToken.trim()).digest('hex')
}

// Compound Indexes for fast lookup & status tracking
invitationSchema.index({ invitationTokenHash: 1, status: 1 })
invitationSchema.index({ hospitalId: 1, invitationType: 1, status: 1 })

// Unique partial compound index: strictly one active 'Pending' invitation per (hospitalId, invitationType, recipientEmail)
// Allows a new invitation when prior invitations are Accepted, Revoked, or Expired.
invitationSchema.index(
	{ hospitalId: 1, invitationType: 1, recipientEmail: 1 },
	{
		unique: true,
		partialFilterExpression: { status: 'Pending' },
		name: 'uniq_pending_invitation_per_hospital_recipient',
	}
)

const Invitation = mongoose.model('invitation', invitationSchema)

module.exports = {
	Invitation,
	VALID_INVITATION_TYPES,
	VALID_INVITATION_STATUSES,
	VALID_INVITED_BY_ROLES,
}

