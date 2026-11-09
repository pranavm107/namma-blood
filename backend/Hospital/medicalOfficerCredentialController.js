/**
 * Medical Officer Credential Controller
 * Namma Blood — Stage B3.4 Healthcare Governance & Credential Lifecycle
 *
 * Implements secure professional credential management APIs:
 * - POST  /api/medical-officers/credentials/submit   (Initial credential submission)
 * - GET   /api/medical-officers/credentials/status   (Read-only status inspection)
 * - PATCH /api/medical-officers/credentials/resubmit (Clarification & rejection resubmission)
 *
 * Security & Governance Invariants:
 * 1. Zero Trust: Doctor identity resolved strictly from authenticated req.user (Gate 1 active).
 * 2. Strict State Machine: Transitions strictly enforced (Unsubmitted -> Pending_Verification,
 *    Rejected/Clarification -> Pending_Verification). No self-verification permitted.
 * 3. Anti-SSRF: Supporting evidence restricted to HTTPS URLs. Backend never downloads/fetches URLs.
 * 4. Mass-Assignment Defense: Explicit field allowlist; client-supplied lifecycle fields rejected (400).
 * 5. BOLA Defense: Doctors can only inspect and submit credentials for their own account.
 * 6. Audit Integrity: Doctor actions logged with actorModel: 'user' without fabricating ADMIN actor.
 * 7. Transactional Consistency: Doctor updates, audit append, and outbox creation share atomic boundary.
 */

const { URL } = require('url')
const catchAsync = require('../Utils/catchAsync')
const userModel = require('../User/userModel')
const { withTransaction } = require('../Utils/transactionHelper')
const { appendAuditRecordTransactional } = require('./auditIntegrityService')
const { NotificationOutbox } = require('./notificationOutboxModel')

// Explicit allowlist of fields permitted in credential submission payloads
const ALLOWED_CREDENTIAL_FIELDS = new Set([
	'medicalRegistrationNumber',
	'regNo',
	'registrationNumber',
	'medicalCouncil',
	'registrationAuthority',
	'council',
	'registrationState',
	'state',
	'registrationYear',
	'qualification',
	'specialization',
	'supportingEvidence',
])

const FORBIDDEN_LIFECYCLE_FIELDS = [
	'role',
	'credentialStatus',
	'verificationStatus',
	'accountStatus',
	'status',
	'credentialVerifiedBy',
	'credentialVerifiedAt',
	'credentialClarificationRequestedBy',
	'credentialReviewStartedBy',
	'permissions',
	'associationStatus',
	'hospitalId',
	'tokenVersion',
	'isVerified',
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
 * Validates and sanitizes professional credential fields
 */
function validateCredentialFields(body, isResubmission = false, existingDoctor = null) {
	const errors = []

	// 1. Mass-assignment / Forbidden field check
	if (body && typeof body === 'object') {
		for (const field of FORBIDDEN_LIFECYCLE_FIELDS) {
			if (Object.prototype.hasOwnProperty.call(body, field)) {
				return {
					isValid: false,
					errorStatus: 400,
					message: `Mass-assignment violation: direct client modification of protected security field '${field}' is strictly prohibited.`,
					field,
				}
			}
		}

		// Reject unknown/unexpected fields
		for (const key of Object.keys(body)) {
			if (!ALLOWED_CREDENTIAL_FIELDS.has(key)) {
				return {
					isValid: false,
					errorStatus: 400,
					message: `Unrecognized or unauthorized parameter '${key}' in credential submission.`,
					field: key,
				}
			}
		}
	}

	// 2. Medical Registration Number
	let rawRegNo =
		body.medicalRegistrationNumber ||
		body.regNo ||
		body.registrationNumber ||
		(isResubmission && existingDoctor ? existingDoctor.medicalRegistrationNumber : '')

	if (!rawRegNo || typeof rawRegNo !== 'string' || rawRegNo.trim() === '') {
		errors.push('medicalRegistrationNumber')
	}
	const cleanRegNo = String(rawRegNo || '').trim().toUpperCase()
	if (cleanRegNo) {
		const regNoRegex = /^[A-Z0-9\/\-_ ]{3,50}$/
		if (!regNoRegex.test(cleanRegNo)) {
			return {
				isValid: false,
				errorStatus: 400,
				message:
					'Medical Registration Number must be between 3 and 50 characters and contain only alphanumeric characters, hyphens, spaces, or slashes.',
				field: 'medicalRegistrationNumber',
			}
		}
	}

	// 3. Medical Council
	let rawCouncil =
		body.medicalCouncil ||
		body.registrationAuthority ||
		body.council ||
		(isResubmission && existingDoctor ? existingDoctor.medicalCouncil : '')

	if (!rawCouncil || typeof rawCouncil !== 'string' || rawCouncil.trim() === '') {
		errors.push('medicalCouncil')
	}
	const cleanCouncil = String(rawCouncil || '').trim()
	if (cleanCouncil && (cleanCouncil.length < 3 || cleanCouncil.length > 150)) {
		return {
			isValid: false,
			errorStatus: 400,
			message: 'Medical Council name must be between 3 and 150 characters.',
			field: 'medicalCouncil',
		}
	}

	// 4. Registration State
	let rawState =
		body.registrationState ||
		body.state ||
		(isResubmission && existingDoctor ? existingDoctor.registrationState : '')

	if (!rawState || typeof rawState !== 'string' || rawState.trim() === '') {
		errors.push('registrationState')
	}
	const cleanState = String(rawState || '').trim()
	if (cleanState && (cleanState.length < 2 || cleanState.length > 100)) {
		return {
			isValid: false,
			errorStatus: 400,
			message: 'Registration state must be between 2 and 100 characters.',
			field: 'registrationState',
		}
	}

	// 5. Registration Year
	let rawYear =
		body.registrationYear !== undefined
			? body.registrationYear
			: isResubmission && existingDoctor
				? existingDoctor.registrationYear
				: undefined

	const currentYear = new Date().getFullYear()

	let cleanYear = null
	if (
		rawYear === undefined ||
		rawYear === null ||
		rawYear === '' ||
		(typeof rawYear === 'string' && rawYear.trim() === '')
	) {
		errors.push('registrationYear')
	} else {
		const yearNum = typeof rawYear === 'number' ? rawYear : Number(String(rawYear).trim())
		if (
			typeof rawYear === 'boolean' ||
			!Number.isInteger(yearNum) ||
			yearNum < 1950 ||
			yearNum > currentYear
		) {
			return {
				isValid: false,
				errorStatus: 400,
				message: `Registration Year must be a valid 4-digit integer between 1950 and ${currentYear}.`,
				field: 'registrationYear',
			}
		}
		cleanYear = yearNum
	}

	// 6. Qualification
	let rawQualification =
		body.qualification ||
		(isResubmission && existingDoctor ? existingDoctor.qualification : '')

	if (!rawQualification || typeof rawQualification !== 'string' || rawQualification.trim() === '') {
		errors.push('qualification')
	}
	const cleanQualification = String(rawQualification || '').trim()
	if (cleanQualification && (cleanQualification.length < 2 || cleanQualification.length > 100)) {
		return {
			isValid: false,
			errorStatus: 400,
			message: 'Qualification must be between 2 and 100 characters.',
			field: 'qualification',
		}
	}

	// 7. Specialization (Optional)
	const rawSpecialization =
		body.specialization !== undefined
			? body.specialization
			: isResubmission && existingDoctor
				? existingDoctor.specialization
				: ''
	const cleanSpecialization = String(rawSpecialization || '').trim()
	if (cleanSpecialization && cleanSpecialization.length > 100) {
		return {
			isValid: false,
			errorStatus: 400,
			message: 'Specialization cannot exceed 100 characters.',
			field: 'specialization',
		}
	}

	// 8. Supporting Evidence URL (Strict HTTPS, anti-SSRF)
	let rawEvidence =
		body.supportingEvidence !== undefined
			? body.supportingEvidence
			: isResubmission && existingDoctor
				? existingDoctor.supportingEvidence
				: ''

	if (!rawEvidence || typeof rawEvidence !== 'string' || rawEvidence.trim() === '') {
		errors.push('supportingEvidence')
	}

	let cleanEvidence = ''
	if (rawEvidence && typeof rawEvidence === 'string' && rawEvidence.trim() !== '') {
		const trimmedEvidence = rawEvidence.trim()
		try {
			const parsedUrl = new URL(trimmedEvidence)
			if (parsedUrl.protocol !== 'https:') {
				return {
					isValid: false,
					errorStatus: 400,
					message: 'Supporting evidence URL must strictly use the secure HTTPS protocol.',
					field: 'supportingEvidence',
				}
			}
			cleanEvidence = parsedUrl.href
		} catch (err) {
			return {
				isValid: false,
				errorStatus: 400,
				message: 'Supporting evidence must be a valid, well-formed HTTPS URL.',
				field: 'supportingEvidence',
			}
		}
	}

	// Check missing required fields
	if (errors.length > 0) {
		return {
			isValid: false,
			errorStatus: 400,
			message: `Missing required credential field(s): ${errors.join(', ')}.`,
			fields: errors,
		}
	}

	return {
		isValid: true,
		data: {
			medicalRegistrationNumber: cleanRegNo,
			medicalCouncil: cleanCouncil,
			registrationState: cleanState,
			registrationYear: cleanYear,
			qualification: cleanQualification,
			specialization: cleanSpecialization,
			supportingEvidence: cleanEvidence,
		},
	}
}

/**
 * A. Submit Initial Credentials
 * POST /api/medical-officers/credentials/submit
 */
exports.submitCredentials = catchAsync(async (req, res, next) => {
	const doctorId = req.user._id

	// 1. Pre-flight state validation: only Unsubmitted credentials may be submitted initially
	const currentStatus = req.user.credentialStatus
	if (currentStatus === 'Verified') {
		return res.status(409).json({
			status: 'fail',
			message: 'Credentials have already been verified. Verified credentials cannot be modified.',
			credentialStatus: currentStatus,
		})
	}

	if (currentStatus === 'Suspended') {
		return res.status(409).json({
			status: 'fail',
			message: 'Medical Officer account credentials are suspended.',
			credentialStatus: currentStatus,
		})
	}

	if (currentStatus === 'Pending_Verification' || currentStatus === 'Under_Review') {
		return res.status(409).json({
			status: 'fail',
			message:
				'Credentials have already been submitted and are pending administrative verification.',
			credentialStatus: currentStatus,
		})
	}

	if (currentStatus === 'Rejected') {
		return res.status(409).json({
			status: 'fail',
			message:
				'Credentials were previously rejected. Please use the resubmission endpoint (PATCH /api/medical-officers/credentials/resubmit).',
			credentialStatus: currentStatus,
		})
	}

	if (currentStatus !== 'Unsubmitted') {
		return res.status(409).json({
			status: 'fail',
			message: `Invalid credential status for initial submission: '${currentStatus}'. Expected 'Unsubmitted'.`,
			credentialStatus: currentStatus,
		})
	}

	// 2. Validate input fields
	const validation = validateCredentialFields(req.body, false)
	if (!validation.isValid) {
		return res.status(validation.errorStatus).json({
			status: 'fail',
			message: validation.message,
			...(validation.field ? { field: validation.field } : {}),
			...(validation.fields ? { fields: validation.fields } : {}),
		})
	}
	const credData = validation.data

	// 3. Pre-flight Duplicate Registration Number Check (excluding self)
	const duplicateDoctor = await userModel.findOne({
		role: 'MEDICAL_OFFICER',
		medicalRegistrationNumber: credData.medicalRegistrationNumber,
		_id: { $ne: doctorId },
	})
	if (duplicateDoctor) {
		return res.status(409).json({
			status: 'fail',
			message: `Medical Registration Number '${credData.medicalRegistrationNumber}' is already registered to another Medical Officer.`,
			field: 'medicalRegistrationNumber',
		})
	}

	// 4. Atomic Transaction: User Update + Audit Ledger Append + Notification Outbox
	let updatedDoctor = null
	await withTransaction(async (session) => {
		// Load doctor atomically inside transaction
		const doctor = await userModel.findById(doctorId).session(session)
		if (!doctor) {
			const notFoundErr = new Error('Medical Officer account not found.')
			notFoundErr.statusCode = 404
			throw notFoundErr
		}

		if (doctor.credentialStatus !== 'Unsubmitted') {
			const conflictErr = new Error(
				`Concurrent update conflict: doctor credential status is already '${doctor.credentialStatus}'.`
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		// Update professional fields and lifecycle state
		doctor.medicalRegistrationNumber = credData.medicalRegistrationNumber
		doctor.medicalCouncil = credData.medicalCouncil
		doctor.registrationState = credData.registrationState
		doctor.registrationYear = credData.registrationYear
		doctor.qualification = credData.qualification
		doctor.specialization = credData.specialization
		doctor.supportingEvidence = credData.supportingEvidence
		doctor.credentialStatus = 'Pending_Verification'
		doctor.verificationStatus = 'Pending' // Legacy compatibility
		doctor.credentialLastSubmittedAt = new Date()
		doctor.credentialClarificationRequested = false
		doctor.credentialClarificationNotes = ''
		doctor.credentialClarificationRequestedAt = null
		doctor.credentialClarificationRequestedBy = null

		updatedDoctor = await doctor.save({ session })

		// Append audit record within same transaction (doctor is the actor, role: MEDICAL_OFFICER)
		await appendAuditRecordTransactional(session, {
			entityType: 'CREDENTIAL',
			entityId: doctor._id,
			targetUserId: doctor._id,
			hospitalId: doctor.hospitalId || null,
			decisionType: 'CREDENTIAL_SUBMITTED',
			previousStatus: 'Unsubmitted',
			newStatus: 'Pending_Verification',
			actorId: doctor._id,
			actorModel: 'user',
			actorRole: 'MEDICAL_OFFICER',
			reason: 'Doctor submitted professional registration and qualification credentials',
			metadata: {
				registrationNumberMasked: maskRegistrationNumber(credData.medicalRegistrationNumber),
				medicalCouncil: credData.medicalCouncil,
				registrationYear: credData.registrationYear,
				hasSupportingEvidence: Boolean(credData.supportingEvidence),
			},
		})

		// Enqueue notification outbox event within same transaction
		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-CRED-SUB-${doctor._id}-${Date.now()}`,
					eventType: 'CREDENTIALS_SUBMITTED',
					hospitalId: doctor.hospitalId || null,
					recipientKey: `MO-CRED-SUB-${doctor._id}`,
					recipientUserId: doctor._id,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Medical Officer Professional Credentials Submitted',
					sanitizedBody:
						'Your professional credentials have been successfully submitted and queued for administrative verification.',
				},
			],
			{ session }
		)
	})

	return res.status(201).json({
		status: 'success',
		message:
			'Professional credentials submitted successfully. Your dossier is now pending administrative verification.',
		data: {
			credentialStatus: updatedDoctor.credentialStatus,
			verificationStatus: updatedDoctor.verificationStatus,
			medicalRegistrationNumber: updatedDoctor.medicalRegistrationNumber,
			medicalCouncil: updatedDoctor.medicalCouncil,
			registrationState: updatedDoctor.registrationState,
			registrationYear: updatedDoctor.registrationYear,
			qualification: updatedDoctor.qualification,
			specialization: updatedDoctor.specialization,
			supportingEvidence: updatedDoctor.supportingEvidence,
			credentialLastSubmittedAt: updatedDoctor.credentialLastSubmittedAt,
			credentialResubmissionCount: updatedDoctor.credentialResubmissionCount,
		},
	})
})

/**
 * B. Retrieve Credential Status (Read-Only)
 * GET /api/medical-officers/credentials/status
 */
exports.getCredentialStatus = catchAsync(async (req, res, next) => {
	const doctorId = req.user._id

	// Read authoritative record from database
	const doctor = await userModel.findById(doctorId).lean()
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	// Compute review status and available next actions based on state machine
	let reviewStatus = 'Unknown'
	const availableActions = []

	switch (doctor.credentialStatus) {
		case 'Unsubmitted':
			reviewStatus = 'Not Submitted'
			availableActions.push('SUBMIT_CREDENTIALS')
			break
		case 'Pending_Verification':
			if (doctor.credentialClarificationRequested) {
				reviewStatus = 'Action Required: Clarification Requested'
				availableActions.push('RESUBMIT_CREDENTIALS')
			} else {
				reviewStatus = 'Pending Administrative Review'
			}
			break
		case 'Under_Review':
			reviewStatus = 'Under Administrative Review'
			break
		case 'Rejected':
			reviewStatus = 'Rejected'
			availableActions.push('RESUBMIT_CREDENTIALS')
			break
		case 'Verified':
			reviewStatus = 'Verified'
			break
		case 'Suspended':
			reviewStatus = 'Suspended'
			break
		default:
			reviewStatus = doctor.credentialStatus || 'Unknown'
	}

	return res.status(200).json({
		status: 'success',
		data: {
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
			credentialClarificationNotes: doctor.credentialClarificationRequested
				? doctor.credentialClarificationNotes || ''
				: '',
			credentialClarificationRequestedAt: doctor.credentialClarificationRequested
				? doctor.credentialClarificationRequestedAt || null
				: null,
			credentialReviewStartedAt: doctor.credentialReviewStartedAt || null,
			credentialRejectionReason:
				doctor.credentialStatus === 'Rejected'
					? doctor.credentialRejectionReason || doctor.rejectionReason || ''
					: '',
			reviewStatus,
			availableActions,
		},
	})
})

/**
 * C. Resubmit Credentials
 * PATCH /api/medical-officers/credentials/resubmit
 */
exports.resubmitCredentials = catchAsync(async (req, res, next) => {
	const doctorId = req.user._id

	// 1. Pre-flight State Machine Guard:
	// Resubmission is permitted ONLY when:
	// - credentialStatus is 'Rejected', OR
	// - credentialStatus is 'Pending_Verification' with clarification requested
	const currentStatus = req.user.credentialStatus
	const clarificationActive = Boolean(req.user.credentialClarificationRequested)

	if (currentStatus === 'Verified') {
		return res.status(409).json({
			status: 'fail',
			message: 'Credentials have already been verified. Verified credentials cannot be modified.',
			credentialStatus: currentStatus,
		})
	}

	if (currentStatus === 'Suspended') {
		return res.status(409).json({
			status: 'fail',
			message: 'Medical Officer account credentials are suspended.',
			credentialStatus: currentStatus,
		})
	}

	if (currentStatus === 'Unsubmitted') {
		return res.status(409).json({
			status: 'fail',
			message:
				'Credentials have not been submitted yet. Please use initial submission (POST /api/medical-officers/credentials/submit).',
			credentialStatus: currentStatus,
		})
	}

	if (currentStatus === 'Under_Review') {
		return res.status(409).json({
			status: 'fail',
			message:
				'Credentials are currently under active administrative review. Modifications are locked until reviewer issues a decision or clarification.',
			credentialStatus: currentStatus,
		})
	}

	if (currentStatus === 'Pending_Verification' && !clarificationActive) {
		return res.status(409).json({
			status: 'fail',
			message:
				'Credentials have already been submitted and are pending review without outstanding clarification requests.',
			credentialStatus: currentStatus,
		})
	}

	const isAllowedResubmit =
		currentStatus === 'Rejected' ||
		(currentStatus === 'Pending_Verification' && clarificationActive)

	if (!isAllowedResubmit) {
		return res.status(409).json({
			status: 'fail',
			message: `Cannot resubmit credentials from status '${currentStatus}'. Resubmission permitted only from 'Rejected' or with active clarification.`,
			credentialStatus: currentStatus,
		})
	}

	// 2. Validate input fields against current user record as fallback for partial updates
	const validation = validateCredentialFields(req.body, true, req.user)
	if (!validation.isValid) {
		return res.status(validation.errorStatus).json({
			status: 'fail',
			message: validation.message,
			...(validation.field ? { field: validation.field } : {}),
			...(validation.fields ? { fields: validation.fields } : {}),
		})
	}
	const credData = validation.data

	// 3. Pre-flight Duplicate Registration Number Check (excluding self)
	const duplicateDoctor = await userModel.findOne({
		role: 'MEDICAL_OFFICER',
		medicalRegistrationNumber: credData.medicalRegistrationNumber,
		_id: { $ne: doctorId },
	})
	if (duplicateDoctor) {
		return res.status(409).json({
			status: 'fail',
			message: `Medical Registration Number '${credData.medicalRegistrationNumber}' is already registered to another Medical Officer.`,
			field: 'medicalRegistrationNumber',
		})
	}

	// 4. Atomic Transaction: User Update + Audit Ledger Append + Notification Outbox
	let updatedDoctor = null
	await withTransaction(async (session) => {
		const doctor = await userModel.findById(doctorId).session(session)
		if (!doctor) {
			const notFoundErr = new Error('Medical Officer account not found.')
			notFoundErr.statusCode = 404
			throw notFoundErr
		}

		// Re-verify state atomically
		const isStateValid =
			doctor.credentialStatus === 'Rejected' ||
			(doctor.credentialStatus === 'Pending_Verification' &&
				doctor.credentialClarificationRequested === true)

		if (!isStateValid) {
			const conflictErr = new Error(
				`Concurrent update conflict: doctor credential status is '${doctor.credentialStatus}' (clarification: ${doctor.credentialClarificationRequested}).`
			)
			conflictErr.statusCode = 409
			throw conflictErr
		}

		const previousStatus = doctor.credentialStatus

		// Update fields
		doctor.medicalRegistrationNumber = credData.medicalRegistrationNumber
		doctor.medicalCouncil = credData.medicalCouncil
		doctor.registrationState = credData.registrationState
		doctor.registrationYear = credData.registrationYear
		doctor.qualification = credData.qualification
		doctor.specialization = credData.specialization
		doctor.supportingEvidence = credData.supportingEvidence

		// State Machine Transitions
		doctor.credentialStatus = 'Pending_Verification'
		doctor.verificationStatus = 'Pending' // Legacy compatibility
		doctor.credentialLastSubmittedAt = new Date()
		doctor.credentialResubmissionCount = (doctor.credentialResubmissionCount || 0) + 1

		// Clear active clarification flag
		doctor.credentialClarificationRequested = false
		doctor.credentialClarificationNotes = ''
		doctor.credentialClarificationRequestedAt = null
		doctor.credentialClarificationRequestedBy = null

		updatedDoctor = await doctor.save({ session })

		// Append audit record within same transaction (actor is doctor, role: MEDICAL_OFFICER)
		await appendAuditRecordTransactional(session, {
			entityType: 'CREDENTIAL',
			entityId: doctor._id,
			targetUserId: doctor._id,
			hospitalId: doctor.hospitalId || null,
			decisionType: 'CREDENTIAL_RESUBMITTED',
			previousStatus,
			newStatus: 'Pending_Verification',
			actorId: doctor._id,
			actorModel: 'user',
			actorRole: 'MEDICAL_OFFICER',
			reason:
				previousStatus === 'Rejected'
					? 'Doctor resubmitted professional credentials following rejection'
					: 'Doctor resubmitted professional credentials responding to administrative clarification',
			metadata: {
				resubmissionCount: doctor.credentialResubmissionCount,
				registrationNumberMasked: maskRegistrationNumber(credData.medicalRegistrationNumber),
				medicalCouncil: credData.medicalCouncil,
				previousState: previousStatus,
				isClarificationResponse: previousStatus === 'Pending_Verification',
				hasSupportingEvidence: Boolean(credData.supportingEvidence),
			},
		})

		// Enqueue notification outbox event within same transaction
		await NotificationOutbox.create(
			[
				{
					eventId: `EVT-CRED-RESUB-${doctor._id}-${Date.now()}`,
					eventType: 'CREDENTIALS_RESUBMITTED',
					hospitalId: doctor.hospitalId || null,
					recipientKey: `MO-CRED-RESUB-${doctor._id}`,
					recipientUserId: doctor._id,
					recipientEmail: doctor.email,
					recipientRole: 'MEDICAL_OFFICER',
					subject: 'Medical Officer Credentials Resubmitted',
					sanitizedBody:
						'Your updated credentials have been successfully resubmitted and queued for administrative review.',
				},
			],
			{ session }
		)
	})

	return res.status(200).json({
		status: 'success',
		message:
			'Credentials resubmitted successfully. Your dossier is now pending administrative review.',
		data: {
			credentialStatus: updatedDoctor.credentialStatus,
			verificationStatus: updatedDoctor.verificationStatus,
			medicalRegistrationNumber: updatedDoctor.medicalRegistrationNumber,
			medicalCouncil: updatedDoctor.medicalCouncil,
			registrationState: updatedDoctor.registrationState,
			registrationYear: updatedDoctor.registrationYear,
			qualification: updatedDoctor.qualification,
			specialization: updatedDoctor.specialization,
			supportingEvidence: updatedDoctor.supportingEvidence,
			credentialLastSubmittedAt: updatedDoctor.credentialLastSubmittedAt,
			credentialResubmissionCount: updatedDoctor.credentialResubmissionCount,
			credentialClarificationRequested: updatedDoctor.credentialClarificationRequested,
		},
	})
})
