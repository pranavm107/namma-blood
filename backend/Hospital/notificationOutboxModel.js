/**
 * Notification Outbox Model
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Phase 4.3.5)
 *
 * Implements a durable transactional outbox pattern to decouple database mutations
 * from asynchronous email dispatch.
 *
 * Reliability & Concurrency Safeguards:
 * - Event-level and recipient-level idempotency via compound unique index.
 * - Atomic worker claiming with distributed processing lease (processingLeaseExpiresAt).
 * - Worker fencing token (claimToken) protecting against stale workers after lease expiry.
 * - Bounded retry counting (deliveryAttempts) incremented atomically on claim.
 * - Dead-letter quarantine (Dead_Letter) once maxAttempts exhausted.
 * - Channel restricted strictly to EMAIL (SMS explicitly deferred).
 * - Zero patient-sensitive clinical remarks stored in notification bodies.
 */

const mongoose = require('mongoose')

const VALID_OUTBOX_EVENT_TYPES = [
	'DOCTOR_NOMINATED',
	'REPRESENTATIVE_INVITED',
	'INVITATION_ACCEPTED',
	'CREDENTIALS_REVIEWED',
	'AFFILIATION_REQUESTED',
	'AFFILIATION_CONFIRMED',
	'ASSOCIATION_APPROVED',
	'EMERGENCY_REQUEST_SUBMITTED',
	'EMERGENCY_DECISION_RECORDED',
	'ALL_DOCTORS_UNAVAILABLE_ALERT',
]

const VALID_OUTBOX_DELIVERY_STATUSES = [
	'Pending',
	'Processing',
	'Sent',
	'Failed',
	'Dead_Letter',
]

const VALID_OUTBOX_CHANNELS = ['EMAIL']

const notificationOutboxSchema = new mongoose.Schema(
	{
		eventId: {
			type: String,
			required: [true, 'Event ID is required.'],
			index: true,
			trim: true,
		},
		eventType: {
			type: String,
			enum: {
				values: VALID_OUTBOX_EVENT_TYPES,
				message:
					'{VALUE} is not a valid outbox event type. Allowed: ' +
					VALID_OUTBOX_EVENT_TYPES.join(', '),
			},
			required: [true, 'Event type is required.'],
			index: true,
		},
		hospitalId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'hospital',
			required: [true, 'Hospital ID is required.'],
			index: true,
		},
		recipientKey: {
			type: String,
			required: [true, 'Recipient key is required.'],
			index: true,
			trim: true,
		},
		recipientUserId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: 'user',
			default: null,
			index: true,
		},
		recipientEmail: {
			type: String,
			required: [true, 'Recipient email is required.'],
			lowercase: true,
			trim: true,
			index: true,
		},
		recipientRole: {
			type: String,
			required: [true, 'Recipient role is required.'],
			trim: true,
		},
		channel: {
			type: String,
			enum: {
				values: VALID_OUTBOX_CHANNELS,
				message:
					'{VALUE} is not a valid notification channel. Allowed: ' +
					VALID_OUTBOX_CHANNELS.join(', '),
			},
			default: 'EMAIL',
			required: true,
		},
		deliveryStatus: {
			type: String,
			enum: {
				values: VALID_OUTBOX_DELIVERY_STATUSES,
				message:
					'{VALUE} is not a valid delivery status. Allowed: ' +
					VALID_OUTBOX_DELIVERY_STATUSES.join(', '),
			},
			default: 'Pending',
			index: true,
		},
		deliveryAttempts: {
			type: Number,
			default: 0,
			min: 0,
			index: true,
		},
		maxAttempts: {
			type: Number,
			default: 5,
			min: 1,
		},
		nextAttemptAt: {
			type: Date,
			default: Date.now,
			index: true,
		},
		processingStartedAt: {
			type: Date,
			default: null,
		},
		processingLeaseExpiresAt: {
			type: Date,
			default: null,
			index: true,
		},
		claimedByWorkerId: {
			type: String,
			default: null,
			trim: true,
		},
		claimToken: {
			type: String,
			default: null,
			index: true,
		},
		lastAttemptAt: {
			type: Date,
			default: null,
		},
		sentAt: {
			type: Date,
			default: null,
		},
		lastErrorMessage: {
			type: String,
			default: null,
			trim: true,
		},
		subject: {
			type: String,
			required: [true, 'Notification subject is required.'],
			trim: true,
		},
		sanitizedBody: {
			type: String,
			required: [true, 'Sanitized notification body is required.'],
			trim: true,
		},
	},
	{ timestamps: true }
)

// Normalize recipientEmail on validate
notificationOutboxSchema.pre('validate', function (next) {
	if (this.recipientEmail) {
		this.recipientEmail = this.recipientEmail.trim().toLowerCase()
	}
	next()
})

// Enforce event-level & recipient-level uniqueness (Idempotency)
notificationOutboxSchema.index(
	{ eventId: 1, recipientKey: 1 },
	{ unique: true, name: 'idx_outbox_event_recipient_unique' }
)

// Optimized compound index for worker polling of claimable / retryable records
notificationOutboxSchema.index(
	{ deliveryStatus: 1, nextAttemptAt: 1, processingLeaseExpiresAt: 1, deliveryAttempts: 1 },
	{ name: 'idx_outbox_claimable_poll' }
)

const NotificationOutbox = mongoose.model(
	'notificationoutbox',
	notificationOutboxSchema
)

module.exports = {
	NotificationOutbox,
	VALID_OUTBOX_EVENT_TYPES,
	VALID_OUTBOX_DELIVERY_STATUSES,
	VALID_OUTBOX_CHANNELS,
}

