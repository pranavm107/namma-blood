/**
 * Admin Credential Review Controller
 * Namma Blood — Stage B3.4.3 Healthcare Governance & Administrative Credential Review
 *
 * Implements secure, auditable, administrator-only APIs for reviewing
 * Medical Officer professional credentials:
 * - GET   /api/admin/medical-officers/credentials                 (Read-only credential review queue)
 * - GET   /api/admin/medical-officers/:id/credentials             (Individual credential dossier details)
 * - PATCH /api/admin/medical-officers/:id/credentials/review-start(Pending_Verification -> Under_Review)
 * - PATCH /api/admin/medical-officers/:id/credentials/request-info(Under_Review -> Pending_Verification with clarification)
 * - PATCH /api/admin/medical-officers/:id/credentials/approve     (Under_Review -> Verified)
 * - PATCH /api/admin/medical-officers/:id/credentials/reject      (Under_Review -> Rejected)
 * - PATCH /api/admin/medical-officers/:id/credentials/suspend     (Verified -> Suspended)
 *
 * Security & Governance Invariants:
 * 1. Platform ADMIN Authorization: Every endpoint strictly requires req.userRole === 'ADMIN'.
 * 2. Self-Review Prevention: Administrators cannot review or approve their own credentials if also a doctor.
 * 3. Hospital Admin Denial: HOSPITAL_ADMIN role is explicitly blocked from credential review.
 * 4. Anti-SSRF: Backend never fetches, downloads, or pings submitted evidence URLs.
 * 5. Deterministic State Machine: Transitions strictly enforced via atomic conditional database queries.
 * 6. Audit & Outbox Transactionality: State mutation, SHA-256 audit entry, and notification outbox
 *    share a single atomic MongoDB multi-document transaction boundary.
 * 7. Privacy Preservation: Passwords, tokens, and raw evidence contents are excluded from projections and audit.
 */

const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const userModel = require('../User/userModel')
const { withTransaction } = require('../Utils/transactionHelper')
const { appendAuditRecordTransactional } = require('./auditIntegrityService')
const { NotificationOutbox } = require('./notificationOutboxModel')

// Explicit list of forbidden mass-assignment fields in administrative action payloads
const FORBIDDEN_ADMIN_PAYLOAD_FIELDS = [
	'role',
	'accountStatus',
	'status',
	'credentialStatus',
	'verificationStatus',
	'tokenVersion',
	'isVerified',
	'permissions',
	'hospitalId',
	'associationStatus',
	'actorId',
	'actorModel',
	'actorRole',
	'sequenceNumber',
	'recordHash',
	'previousRecordHash',
	'credentialVerifiedBy',
	'credentialVerifiedAt',
	'credentialReviewStartedBy',
	'credentialReviewStartedAt',
	'credentialClarificationRequested',
	'credentialClarificationRequestedBy',
	'credentialClarificationRequestedAt',
	'credentialSuspendedBy',
	'credentialSuspendedAt',
]

/**
 * Mask sensitive medical registration numbers for privacy-preserving audit storage
 */
function maskRegistrationNumber(regNo) {
	if (!regNo || typeof regNo !== 'string') return ''
	const clean = regNo.trim()
	if (clean.length <= 4) return '***'
	const prefix = clean.slice(0, 2)
	const suffix = clean.slice(-4)
	return `${prefix}****${suffix}`
}

/**
 * Helper to validate MongoDB ObjectId
 */
function isValidObjectId(id) {
	return mongoose.Types.ObjectId.isValid(id) && String(new mongoose.Types.ObjectId(id)) === String(id)
}

/**
 * Helper to validate body against forbidden mass-assignment fields
 */
function checkForbiddenFields(body) {
	if (!body || typeof body !== 'object') return null
	for (const field of FORBIDDEN_ADMIN_PAYLOAD_FIELDS) {
		if (Object.prototype.hasOwnProperty.call(body, field)) {
			return `Mass-assignment violation: parameter '${field}' cannot be modified by client request.`
		}
	}
	return null
}

/**
 * 1. Credential Review Queue (Read-Only)
 * GET /api/admin/medical-officers/credentials
 */
exports.getCredentialReviewQueue = catchAsync(async (req, res, next) => {
	// Parse pagination
	const page = Math.max(1, parseInt(req.query.page, 10) || 1)
	const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 10))
	const skip = (page - 1) * limit

	// Build query filter
	const query = { role: 'MEDICAL_OFFICER' }

	// Status filter: defaults to active review queue ['Pending_Verification', 'Under_Review']
	if (req.query.status) {
		const rawStatus = String(req.query.status).trim()
		if (rawStatus.toLowerCase() === 'all') {
			// No credentialStatus filter: return all Medical Officers
		} else if (rawStatus.includes(',')) {
			const statuses = rawStatus
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean)
			query.credentialStatus = { $in: statuses }
		} else {
			query.credentialStatus = rawStatus
		}
	} else if (req.query.credentialStatus) {
		query.credentialStatus = String(req.query.credentialStatus).trim()
	} else {
		// Default: active queue
		query.credentialStatus = { $in: ['Pending_Verification', 'Under_Review'] }
	}

	// Medical Council filter
	if (req.query.medicalCouncil) {
		query.medicalCouncil = {
			$regex: String(req.query.medicalCouncil).trim(),
			$options: 'i',
		}
	}

	// Registration State filter
	if (req.query.registrationState) {
		query.registrationState = {
			$regex: `^${String(req.query.registrationState).trim()}$`,
			$options: 'i',
		}
	}

	// Submission Date range filter
	if (req.query.submittedFrom || req.query.submittedTo) {
		query.credentialLastSubmittedAt = {}
		if (req.query.submittedFrom) {
			const fromDate = new Date(req.query.submittedFrom)
			if (!isNaN(fromDate.getTime())) {
				query.credentialLastSubmittedAt.$gte = fromDate
			}
		}
		if (req.query.submittedTo) {
			const toDate = new Date(req.query.submittedTo)
			if (!isNaN(toDate.getTime())) {
				query.credentialLastSubmittedAt.$lte = toDate
			}
		}
	}

	// General Search filter (name, email, registration number)
	if (req.query.search) {
		const searchRegex = { $regex: String(req.query.search).trim(), $options: 'i' }
		query.$or = [
			{ firstName: searchRegex },
			{ lastName: searchRegex },
			{ email: searchRegex },
			{ medicalRegistrationNumber: searchRegex },
		]
	}

	// Sorting: default to oldest pending submission first (deterministic queue order)
	let sort = { credentialLastSubmittedAt: 1, createdAt: 1, _id: 1 }
	if (req.query.sortBy) {
		const order = req.query.sortOrder === 'desc' ? -1 : 1
		sort = { [req.query.sortBy]: order, _id: 1 }
	}

	// Execute efficient count and paginated query
	const [totalRecords, medicalOfficers] = await Promise.all([
		userModel.countDocuments(query),
		userModel
			.find(query)
			.select(
				'firstName lastName name email phoneNo1 role accountStatus credentialStatus verificationStatus ' +
					'medicalRegistrationNumber medicalCouncil registrationState registrationYear qualification ' +
					'specialization credentialLastSubmittedAt credentialResubmissionCount ' +
					'credentialClarificationRequested credentialClarificationNotes credentialClarificationRequestedAt ' +
					'credentialReviewStartedAt credentialRejectionReason credentialSuspendedAt createdAt'
			)
			.sort(sort)
			.skip(skip)
			.limit(limit)
			.lean(),
	])

	const totalPages = Math.ceil(totalRecords / limit) || 1

	return res.status(200).json({
		status: 'success',
		data: {
			totalRecords,
			page,
			limit,
			totalPages,
			medicalOfficers,
		},
	})
})

/**
 * 2. Credential Review Details (Read-Only)
 * GET /api/admin/medical-officers/:id/credentials
 */
exports.getDoctorCredentialDetails = catchAsync(async (req, res, next) => {
	const doctorId = req.params.id

	if (!isValidObjectId(doctorId)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid Medical Officer ID format '${doctorId}'.`,
		})
	}

	const doctor = await userModel
		.findOne({ _id: doctorId, role: 'MEDICAL_OFFICER' })
		.select('-password -tokenVersion -passwordResetToken -passwordResetExpires')
		.lean()

	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	return res.status(200).json({
		status: 'success',
		data: {
			medicalOfficerId: doctor._id,
			name: doctor.name || `${doctor.firstName || ''} ${doctor.lastName || ''}`.trim(),
			email: doctor.email,
			phone: doctor.phoneNo1,
			accountStatus: doctor.accountStatus,
			credentialStatus: doctor.credentialStatus,
			verificationStatus: doctor.verificationStatus,
			medicalRegistrationNumber: doctor.medicalRegistrationNumber || '',
			medicalCouncil: doctor.medicalCouncil || '',
			registrationState: doctor.registrationState || '',
			registrationYear: doctor.registrationYear || null,
			qualification: doctor.qualification || '',
			specialization: doctor.specialization || '',
			supportingEvidence: doctor.supportingEvidence || '',
			credentialLastSubmittedAt: doctor.credentialLastSubmittedAt || null,
			credentialResubmissionCount: doctor.credentialResubmissionCount || 0,
			credentialClarificationRequested: Boolean(doctor.credentialClarificationRequested),
			credentialClarificationNotes: doctor.credentialClarificationNotes || '',
			credentialClarificationRequestedAt: doctor.credentialClarificationRequestedAt || null,
			credentialClarificationRequestedBy: doctor.credentialClarificationRequestedBy || null,
			credentialReviewStartedAt: doctor.credentialReviewStartedAt || null,
			credentialReviewStartedBy: doctor.credentialReviewStartedBy || null,
			credentialVerifiedAt: doctor.credentialVerifiedAt || null,
			credentialVerifiedBy: doctor.credentialVerifiedBy || null,
			credentialRejectionReason: doctor.credentialRejectionReason || doctor.rejectionReason || '',
			credentialSuspendedAt: doctor.credentialSuspendedAt || null,
			credentialSuspensionReason: doctor.credentialSuspensionReason || '',
			createdAt: doctor.createdAt,
		},
	})
})

/**
 * 3. Start Credential Review
 * PATCH /api/admin/medical-officers/:id/credentials/review-start
 * Explicit transition: Pending_Verification -> Under_Review
 */
exports.startCredentialReview = catchAsync(async (req, res, next) => {
	const doctorId = req.params.id
	const adminId = req.user._id

	if (!isValidObjectId(doctorId)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid Medical Officer ID format '${doctorId}'.`,
		})
	}

	// Mass-assignment check
	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	// Self-review prevention: administrator cannot review own profile
	if (String(doctorId) === String(adminId)) {
		return res.status(403).json({
			status: 'fail',
			message: 'Self-review violation: administrators cannot claim or review their own professional credentials.',
		})
	}

	// Pre-flight target inspection
	const targetDoctor = await userModel.findOne({ _id: doctorId, role: 'MEDICAL_OFFICER' })
	if (!targetDoctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	if (targetDoctor.credentialStatus === 'Under_Review') {
		return res.status(409).json({
			status: 'fail',
			message: 'Credential dossier is already under active administrative review.',
			credentialStatus: targetDoctor.credentialStatus,
		})
	}

	if (targetDoctor.credentialStatus !== 'Pending_Verification') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot start review for credentials in status '${targetDoctor.credentialStatus}'. Only credentials in 'Pending_Verification' can be claimed for review.`,
			credentialStatus: targetDoctor.credentialStatus,
		})
	}

	let updatedDoctor = null

	// Atomic multi-document transaction
	await withTransaction(async (session) => {
		// Atomic conditional update: lock target doctor and ensure state has not shifted
		const doctor = await userModel
			.findOne({
				_id: doctorId,
				role: 'MEDICAL_OFFICER',
				credentialStatus: 'Pending_Verification',
			})
			.session(session)

		if (!doctor) {
			const conflictErr = new Error(
				'Concurrent review conflict: credential status changed or review already started by another administrator.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		doctor.credentialStatus = 'Under_Review'
		doctor.credentialReviewStartedAt = new Date()
		doctor.credentialReviewStartedBy = adminId

		updatedDoctor = await doctor.save({ session })

		// Append immutable audit record in same transaction
		await appendAuditRecordTransactional(session, {
			entityType: 'CREDENTIAL',
			entityId: doctor._id,
			targetUserId: doctor._id,
			hospitalId: doctor.hospitalId || null,
			decisionType: 'CREDENTIAL_REVIEW_STARTED',
			previousStatus: 'Pending_Verification',
			newStatus: 'Under_Review',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: (req.body && req.body.reason) ? String(req.body.reason).trim() : 'Administrator started credential dossier review',
			metadata: {
				registrationNumberMasked: maskRegistrationNumber(doctor.medicalRegistrationNumber),
				medicalCouncil: doctor.medicalCouncil || '',
				registrationYear: doctor.registrationYear || null,
			},
		})

		// Enqueue notification outbox event in same transaction
		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-CRED-REV-START-${doctor._id}-${Date.now()}`,
					eventType: 'CREDENTIALS_REVIEW_STARTED',
					hospitalId: doctor.hospitalId || null,
					recipientKey: `MO-CRED-REV-${doctor._id}`,
					recipientUserId: doctor._id,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Professional Credentials Review Started',
					sanitizedBody:
						'Your professional credential dossier has been claimed by an administrator and is now under active review.',
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Credential dossier claimed successfully. Status updated to Under_Review.',
		data: {
			medicalOfficerId: updatedDoctor._id,
			credentialStatus: updatedDoctor.credentialStatus,
			credentialReviewStartedAt: updatedDoctor.credentialReviewStartedAt,
			credentialReviewStartedBy: updatedDoctor.credentialReviewStartedBy,
		},
	})
})

/**
 * 4. Request Additional Information / Clarification
 * PATCH /api/admin/medical-officers/:id/credentials/request-info
 * Explicit transition: Under_Review -> Pending_Verification (with clarification flag)
 */
exports.requestAdditionalInfo = catchAsync(async (req, res, next) => {
	const doctorId = req.params.id
	const adminId = req.user._id

	if (!isValidObjectId(doctorId)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid Medical Officer ID format '${doctorId}'.`,
		})
	}

	// Mass-assignment check
	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	// Validate clarification notes
	const rawNotes = req.body.notes || req.body.reason
	if (!rawNotes || typeof rawNotes !== 'string' || rawNotes.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific clarification note or reason of at least 5 characters is required.',
			field: 'notes',
		})
	}
	const cleanNotes = rawNotes.trim()

	// Self-review prevention
	if (String(doctorId) === String(adminId)) {
		return res.status(403).json({
			status: 'fail',
			message: 'Self-review violation: administrators cannot request clarification on their own account.',
		})
	}

	// Pre-flight target inspection
	const targetDoctor = await userModel.findOne({ _id: doctorId, role: 'MEDICAL_OFFICER' })
	if (!targetDoctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	if (targetDoctor.credentialStatus !== 'Under_Review') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot request clarification for credentials in status '${targetDoctor.credentialStatus}'. Dossier must be in 'Under_Review' status.`,
			credentialStatus: targetDoctor.credentialStatus,
		})
	}

	let updatedDoctor = null

	await withTransaction(async (session) => {
		const doctor = await userModel
			.findOne({
				_id: doctorId,
				role: 'MEDICAL_OFFICER',
				credentialStatus: 'Under_Review',
			})
			.session(session)

		if (!doctor) {
			const conflictErr = new Error(
				'Concurrent modification conflict: credential status changed while preparing clarification request.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		doctor.credentialStatus = 'Pending_Verification'
		doctor.credentialClarificationRequested = true
		doctor.credentialClarificationNotes = cleanNotes
		doctor.credentialClarificationRequestedAt = new Date()
		doctor.credentialClarificationRequestedBy = adminId

		updatedDoctor = await doctor.save({ session })

		// Append immutable audit record in same transaction
		await appendAuditRecordTransactional(session, {
			entityType: 'CREDENTIAL',
			entityId: doctor._id,
			targetUserId: doctor._id,
			hospitalId: doctor.hospitalId || null,
			decisionType: 'CREDENTIAL_INFO_REQUESTED',
			previousStatus: 'Under_Review',
			newStatus: 'Pending_Verification',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: cleanNotes,
			notes: cleanNotes,
			metadata: {
				registrationNumberMasked: maskRegistrationNumber(doctor.medicalRegistrationNumber),
				clarificationNotes: cleanNotes,
			},
		})

		// Enqueue notification outbox event in same transaction
		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-CRED-CLARIF-${doctor._id}-${Date.now()}`,
					eventType: 'CREDENTIALS_INFO_REQUESTED',
					hospitalId: doctor.hospitalId || null,
					recipientKey: `MO-CRED-CLARIF-${doctor._id}`,
					recipientUserId: doctor._id,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Additional Information Requested for Professional Credentials',
					sanitizedBody: cleanNotes,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Clarification request issued successfully. Medical Officer notified for resubmission.',
		data: {
			medicalOfficerId: updatedDoctor._id,
			credentialStatus: updatedDoctor.credentialStatus,
			credentialClarificationRequested: updatedDoctor.credentialClarificationRequested,
			credentialClarificationNotes: updatedDoctor.credentialClarificationNotes,
			credentialClarificationRequestedAt: updatedDoctor.credentialClarificationRequestedAt,
		},
	})
})

/**
 * 5. Approve Credentials
 * PATCH /api/admin/medical-officers/:id/credentials/approve
 * Explicit transition: Under_Review -> Verified
 */
exports.approveCredentials = catchAsync(async (req, res, next) => {
	const doctorId = req.params.id
	const adminId = req.user._id

	if (!isValidObjectId(doctorId)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid Medical Officer ID format '${doctorId}'.`,
		})
	}

	// Mass-assignment check
	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	// Self-review prevention
	if (String(doctorId) === String(adminId)) {
		return res.status(403).json({
			status: 'fail',
			message: 'Self-review violation: administrators cannot approve their own professional credentials.',
		})
	}

	// Pre-flight target inspection
	const targetDoctor = await userModel.findOne({ _id: doctorId, role: 'MEDICAL_OFFICER' })
	if (!targetDoctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	if (targetDoctor.credentialStatus === 'Verified') {
		return res.status(409).json({
			status: 'fail',
			message: 'Credentials have already been approved and verified.',
			credentialStatus: targetDoctor.credentialStatus,
		})
	}

	if (targetDoctor.credentialStatus !== 'Under_Review') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot approve credentials in status '${targetDoctor.credentialStatus}'. Dossier must be in 'Under_Review' status before approval.`,
			credentialStatus: targetDoctor.credentialStatus,
		})
	}

	let updatedDoctor = null

	await withTransaction(async (session) => {
		const doctor = await userModel
			.findOne({
				_id: doctorId,
				role: 'MEDICAL_OFFICER',
				credentialStatus: 'Under_Review',
			})
			.session(session)

		if (!doctor) {
			const conflictErr = new Error(
				'Concurrent modification conflict: credential status changed while executing approval.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		doctor.credentialStatus = 'Verified'
		doctor.verificationStatus = 'Verified' // Legacy compatibility
		doctor.credentialVerifiedAt = new Date()
		doctor.credentialVerifiedBy = adminId
		doctor.verifiedAt = new Date()
		doctor.verifiedBy = adminId

		// Clear clarification fields
		doctor.credentialClarificationRequested = false
		doctor.credentialClarificationNotes = ''
		doctor.credentialClarificationRequestedAt = null
		doctor.credentialClarificationRequestedBy = null

		updatedDoctor = await doctor.save({ session })

		// Append immutable audit record in same transaction
		await appendAuditRecordTransactional(session, {
			entityType: 'CREDENTIAL',
			entityId: doctor._id,
			targetUserId: doctor._id,
			hospitalId: doctor.hospitalId || null,
			decisionType: 'CREDENTIAL_APPROVED',
			previousStatus: 'Under_Review',
			newStatus: 'Verified',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: (req.body && req.body.reason) ? String(req.body.reason).trim() : 'Medical Officer professional credentials approved after administrative review',
			metadata: {
				registrationNumberMasked: maskRegistrationNumber(doctor.medicalRegistrationNumber),
				medicalCouncil: doctor.medicalCouncil || '',
				registrationYear: doctor.registrationYear || null,
			},
		})

		// Enqueue notification outbox event in same transaction
		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-CRED-APPROVE-${doctor._id}-${Date.now()}`,
					eventType: 'CREDENTIALS_APPROVED',
					hospitalId: doctor.hospitalId || null,
					recipientKey: `MO-CRED-APPROVE-${doctor._id}`,
					recipientUserId: doctor._id,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Medical Officer Professional Credentials Approved',
					sanitizedBody:
						'Your professional medical credentials have been successfully verified and approved by the platform administration.',
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Professional credentials approved successfully. Medical Officer credential status is now Verified.',
		data: {
			medicalOfficerId: updatedDoctor._id,
			credentialStatus: updatedDoctor.credentialStatus,
			verificationStatus: updatedDoctor.verificationStatus,
			credentialVerifiedAt: updatedDoctor.credentialVerifiedAt,
			credentialVerifiedBy: updatedDoctor.credentialVerifiedBy,
		},
	})
})

/**
 * 6. Reject Credentials
 * PATCH /api/admin/medical-officers/:id/credentials/reject
 * Explicit transition: Under_Review -> Rejected
 */
exports.rejectCredentials = catchAsync(async (req, res, next) => {
	const doctorId = req.params.id
	const adminId = req.user._id

	if (!isValidObjectId(doctorId)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid Medical Officer ID format '${doctorId}'.`,
		})
	}

	// Mass-assignment check
	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	// Rejection reason check
	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific rejection reason of at least 5 characters is required.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	// Self-review prevention
	if (String(doctorId) === String(adminId)) {
		return res.status(403).json({
			status: 'fail',
			message: 'Self-review violation: administrators cannot reject their own account.',
		})
	}

	// Pre-flight target inspection
	const targetDoctor = await userModel.findOne({ _id: doctorId, role: 'MEDICAL_OFFICER' })
	if (!targetDoctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	if (targetDoctor.credentialStatus !== 'Under_Review') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot reject credentials in status '${targetDoctor.credentialStatus}'. Dossier must be in 'Under_Review' status before rejection.`,
			credentialStatus: targetDoctor.credentialStatus,
		})
	}

	let updatedDoctor = null

	await withTransaction(async (session) => {
		const doctor = await userModel
			.findOne({
				_id: doctorId,
				role: 'MEDICAL_OFFICER',
				credentialStatus: 'Under_Review',
			})
			.session(session)

		if (!doctor) {
			const conflictErr = new Error(
				'Concurrent modification conflict: credential status changed while executing rejection.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		doctor.credentialStatus = 'Rejected'
		doctor.verificationStatus = 'Rejected' // Legacy compatibility
		doctor.credentialRejectionReason = cleanReason
		doctor.rejectionReason = cleanReason

		// Clear active clarification flag
		doctor.credentialClarificationRequested = false
		doctor.credentialClarificationNotes = ''
		doctor.credentialClarificationRequestedAt = null
		doctor.credentialClarificationRequestedBy = null

		updatedDoctor = await doctor.save({ session })

		// Append immutable audit record in same transaction
		await appendAuditRecordTransactional(session, {
			entityType: 'CREDENTIAL',
			entityId: doctor._id,
			targetUserId: doctor._id,
			hospitalId: doctor.hospitalId || null,
			decisionType: 'CREDENTIAL_REJECTED',
			previousStatus: 'Under_Review',
			newStatus: 'Rejected',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: cleanReason,
			metadata: {
				registrationNumberMasked: maskRegistrationNumber(doctor.medicalRegistrationNumber),
				rejectionReason: cleanReason,
			},
		})

		// Enqueue notification outbox event in same transaction
		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-CRED-REJECT-${doctor._id}-${Date.now()}`,
					eventType: 'CREDENTIALS_REJECTED',
					hospitalId: doctor.hospitalId || null,
					recipientKey: `MO-CRED-REJECT-${doctor._id}`,
					recipientUserId: doctor._id,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Medical Officer Professional Credentials Rejected',
					sanitizedBody: cleanReason,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Credentials rejected. Medical Officer is eligible to resubmit corrected credentials.',
		data: {
			medicalOfficerId: updatedDoctor._id,
			credentialStatus: updatedDoctor.credentialStatus,
			verificationStatus: updatedDoctor.verificationStatus,
			credentialRejectionReason: updatedDoctor.credentialRejectionReason,
		},
	})
})

/**
 * 7. Suspend Credentials
 * PATCH /api/admin/medical-officers/:id/credentials/suspend
 * Explicit transition: Verified -> Suspended
 */
exports.suspendCredentials = catchAsync(async (req, res, next) => {
	const doctorId = req.params.id
	const adminId = req.user._id

	if (!isValidObjectId(doctorId)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid Medical Officer ID format '${doctorId}'.`,
		})
	}

	// Mass-assignment check
	const forbiddenErr = checkForbiddenFields(req.body)
	if (forbiddenErr) {
		return res.status(400).json({ status: 'fail', message: forbiddenErr })
	}

	// Suspension reason check
	const rawReason = req.body.reason
	if (!rawReason || typeof rawReason !== 'string' || rawReason.trim().length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A specific suspension reason of at least 5 characters is required.',
			field: 'reason',
		})
	}
	const cleanReason = rawReason.trim()

	// Self-review prevention
	if (String(doctorId) === String(adminId)) {
		return res.status(403).json({
			status: 'fail',
			message: 'Self-review violation: administrators cannot suspend their own account.',
		})
	}

	// Pre-flight target inspection
	const targetDoctor = await userModel.findOne({ _id: doctorId, role: 'MEDICAL_OFFICER' })
	if (!targetDoctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	if (targetDoctor.credentialStatus === 'Suspended') {
		return res.status(409).json({
			status: 'fail',
			message: 'Credentials are already suspended.',
			credentialStatus: targetDoctor.credentialStatus,
		})
	}

	if (targetDoctor.credentialStatus !== 'Verified') {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot suspend credentials in status '${targetDoctor.credentialStatus}'. Only 'Verified' credentials can be suspended.`,
			credentialStatus: targetDoctor.credentialStatus,
		})
	}

	let updatedDoctor = null

	await withTransaction(async (session) => {
		const doctor = await userModel
			.findOne({
				_id: doctorId,
				role: 'MEDICAL_OFFICER',
				credentialStatus: 'Verified',
			})
			.session(session)

		if (!doctor) {
			const conflictErr = new Error(
				'Concurrent modification conflict: credential status changed while executing suspension.'
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		doctor.credentialStatus = 'Suspended'
		doctor.verificationStatus = 'Suspended' // Legacy compatibility
		doctor.credentialSuspendedAt = new Date()
		doctor.credentialSuspendedBy = adminId
		doctor.credentialSuspensionReason = cleanReason

		updatedDoctor = await doctor.save({ session })

		// Append immutable audit record in same transaction
		await appendAuditRecordTransactional(session, {
			entityType: 'CREDENTIAL',
			entityId: doctor._id,
			targetUserId: doctor._id,
			hospitalId: doctor.hospitalId || null,
			decisionType: 'CREDENTIAL_SUSPENDED',
			previousStatus: 'Verified',
			newStatus: 'Suspended',
			actorId: adminId,
			actorModel: 'admin',
			actorRole: 'ADMIN',
			reason: cleanReason,
			metadata: {
				registrationNumberMasked: maskRegistrationNumber(doctor.medicalRegistrationNumber),
				suspensionReason: cleanReason,
			},
		})

		// Enqueue notification outbox event in same transaction
		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-CRED-SUSPEND-${doctor._id}-${Date.now()}`,
					eventType: 'CREDENTIALS_SUSPENDED',
					hospitalId: doctor.hospitalId || null,
					recipientKey: `MO-CRED-SUSPEND-${doctor._id}`,
					recipientUserId: doctor._id,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Medical Officer Credentials Suspended',
					sanitizedBody: cleanReason,
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message: 'Professional credentials suspended successfully. Account will fail Gate 2 clinical verification.',
		data: {
			medicalOfficerId: updatedDoctor._id,
			credentialStatus: updatedDoctor.credentialStatus,
			verificationStatus: updatedDoctor.verificationStatus,
			credentialSuspendedAt: updatedDoctor.credentialSuspendedAt,
			credentialSuspendedBy: updatedDoctor.credentialSuspendedBy,
			credentialSuspensionReason: updatedDoctor.credentialSuspensionReason,
		},
	})
})
