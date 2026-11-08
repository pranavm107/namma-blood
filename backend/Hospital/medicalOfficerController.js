/**
 * Hospital Medical Officer Controller
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Implements clinical governance, multi-hospital BOLA defense,
 * optimistic concurrency control (OCC), and transactional audit logging.
 */

const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const { withTransaction } = require('../Utils/transactionHelper')
const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const { EmergencyRequestVerification } = require('./emergencyRequestVerificationModel')
const { Hospital } = require('./hospitalModel')
const { MedicalOfficerHospital } = require('./medicalOfficerHospitalModel')
const userModel = require('../User/userModel')
const {
	emailValidate,
	phoneNumberValidate,
	passwordLengthValidate,
} = require('../Common/Functions/validateInputs')

/**
 * Helper: Resolve and validate target hospital IDs for the authenticated Medical Officer
 */
function resolveAuthorizedHospitalScope(req) {
	const authorizedIds = req.authorizedHospitalIds || []
	const requestedHospitalId = req.query?.hospitalId || req.body?.hospitalId

	if (requestedHospitalId && typeof requestedHospitalId === 'string' && requestedHospitalId.trim() !== '') {
		const target = requestedHospitalId.trim()
		if (!authorizedIds.includes(target)) {
			const err = new Error('Access denied: You are not authorized for the requested hospital scope.')
			err.statusCode = 403
			throw err
		}
		return [target]
	}

	return authorizedIds
}

/**
 * Helper: Validate that a request belongs to an authorized hospital of this Medical Officer
 */
function validateRequestHospitalScope(request, req) {
	if (!request) {
		const err = new Error('Emergency blood request not found.')
		err.statusCode = 404
		throw err
	}

	// Legacy requests (hospitalId: null) are strictly excluded from MO queues
	if (!request.hospitalId) {
		const err = new Error('Emergency blood request not found.')
		err.statusCode = 404
		throw err
	}

	const reqHospitalId = request.hospitalId._id
		? request.hospitalId._id.toString()
		: request.hospitalId.toString()

	const authorizedIds = req.authorizedHospitalIds || []
	if (!authorizedIds.includes(reqHospitalId)) {
		const err = new Error('Access denied: You are not authorized to verify or view requests for this hospital facility.')
		err.statusCode = 403
		throw err
	}

	return reqHospitalId
}

/**
 * Medical Officer Dashboard Metrics
 * GET /api/medical-officer/dashboard
 */
exports.getMedicalOfficerDashboard = catchAsync(async (req, res, next) => {
	const targetHospitalIds = resolveAuthorizedHospitalScope(req)

	const [counts, hospitals] = await Promise.all([
		EmergencyBloodRequest.aggregate([
			{
				$match: {
					hospitalId: { $in: targetHospitalIds.map(id => new mongoose.Types.ObjectId(id)) },
				},
			},
			{
				$group: {
					_id: '$verificationStatus',
					count: { $sum: 1 },
				},
			},
		]),
		Hospital.find({ _id: { $in: targetHospitalIds } }).select('hospitalCode hospitalName address.city address.state'),
	])

	const metrics = {
		pendingCount: 0,
		moreInfoCount: 0,
		verifiedCount: 0,
		rejectedCount: 0,
		totalCount: 0,
	}

	counts.forEach(c => {
		if (c._id === 'Pending_Verification') metrics.pendingCount = c.count
		if (c._id === 'More_Information_Required') metrics.moreInfoCount = c.count
		if (c._id === 'Verified') metrics.verifiedCount = c.count
		if (c._id === 'Rejected') metrics.rejectedCount = c.count
		metrics.totalCount += c.count
	})

	// Also provide hospital-level breakdown when officer has multiple facilities
	let hospitalBreakdown = []
	if (targetHospitalIds.length > 1) {
		const perHospitalCounts = await EmergencyBloodRequest.aggregate([
			{
				$match: {
					hospitalId: { $in: targetHospitalIds.map(id => new mongoose.Types.ObjectId(id)) },
				},
			},
			{
				$group: {
					_id: { hospitalId: '$hospitalId', status: '$verificationStatus' },
					count: { $sum: 1 },
				},
			},
		])

		hospitalBreakdown = hospitals.map(h => {
			const hId = h._id.toString()
			const hCounts = { pending: 0, moreInfo: 0, verified: 0, rejected: 0 }
			perHospitalCounts.forEach(item => {
				if (item._id.hospitalId.toString() === hId) {
					if (item._id.status === 'Pending_Verification') hCounts.pending = item.count
					if (item._id.status === 'More_Information_Required') hCounts.moreInfo = item.count
					if (item._id.status === 'Verified') hCounts.verified = item.count
					if (item._id.status === 'Rejected') hCounts.rejected = item.count
				}
			})
			return {
				hospitalId: h._id,
				hospitalCode: h.hospitalCode,
				hospitalName: h.hospitalName,
				city: h.address.city,
				counts: hCounts,
			}
		})
	}

	res.status(200).json({
		status: 'success',
		data: {
			metrics,
			authorizedHospitals: hospitals,
			hospitalBreakdown,
		},
	})
})

/**
 * Paginated Assigned Emergency Blood Requests
 * GET /api/medical-officer/requests
 */
exports.getAssignedRequests = catchAsync(async (req, res, next) => {
	const targetHospitalIds = resolveAuthorizedHospitalScope(req)
	const page = parseInt(req.query.page, 10) || 1
	const limit = parseInt(req.query.limit, 10) || 15
	const skip = (page - 1) * limit

	const filter = {
		hospitalId: { $in: targetHospitalIds },
	}

	if (req.query.status) {
		filter.verificationStatus = req.query.status
	}
	if (req.query.urgencyLevel) {
		filter.urgencyLevel = req.query.urgencyLevel
	}
	if (req.query.requiredBloodGroup) {
		filter.requiredBloodGroup = req.query.requiredBloodGroup
	}
	if (req.query.search) {
		const searchRegex = new RegExp(req.query.search.trim(), 'i')
		filter.$or = [
			{ requestNumber: searchRegex },
			{ patientName: searchRegex },
		]
	}

	const [requests, total] = await Promise.all([
		EmergencyBloodRequest.find(filter)
			.populate('hospitalId', 'hospitalCode hospitalName address.city')
			.sort({ createdAt: -1 })
			.skip(skip)
			.limit(limit),
		EmergencyBloodRequest.countDocuments(filter),
	])

	res.status(200).json({
		status: 'success',
		results: requests.length,
		pagination: {
			page,
			limit,
			totalPages: Math.ceil(total / limit),
			totalRecords: total,
		},
		data: { requests },
	})
})

/**
 * Detailed Emergency Blood Request View
 * GET /api/medical-officer/requests/:id
 */
exports.getRequestDetails = catchAsync(async (req, res, next) => {
	const request = await EmergencyBloodRequest.findById(req.params.id)
		.populate('hospitalId', 'hospitalCode hospitalName hospitalType address contactPhone contactEmail')
		.populate('requesterUserId', 'firstName lastName email phoneNo1')
		.populate('verifiedBy', 'firstName lastName medicalRegistrationNumber')

	validateRequestHospitalScope(request, req)

	res.status(200).json({
		status: 'success',
		data: { request },
	})
})

/**
 * Chronological Verification Audit History
 * GET /api/medical-officer/requests/:id/verification-history
 */
exports.getVerificationHistory = catchAsync(async (req, res, next) => {
	const request = await EmergencyBloodRequest.findById(req.params.id)
	validateRequestHospitalScope(request, req)

	const history = await EmergencyRequestVerification.find({
		emergencyRequestId: request._id,
	})
		.populate('actorUserId', 'firstName lastName email medicalRegistrationNumber')
		.populate('hospitalId', 'hospitalCode hospitalName')
		.sort({ createdAt: -1 })

	res.status(200).json({
		status: 'success',
		results: history.length,
		data: { history },
	})
})

/**
 * Approve Emergency Blood Request
 * PATCH /api/medical-officer/requests/:id/verify
 */
exports.approveEmergencyRequest = catchAsync(async (req, res, next) => {
	const request = await EmergencyBloodRequest.findById(req.params.id)
	const hospitalId = validateRequestHospitalScope(request, req)

	// State machine guard: Pending_Verification only
	if (request.verificationStatus === 'Flagged_Suspicious') {
		return res.status(400).json({
			status: 'fail',
			message: 'Request is flagged suspicious and quarantined under clinical safety protocol. It cannot be approved by ordinary verification.',
		})
	}
	if (request.verificationStatus === 'Verified') {
		return res.status(400).json({
			status: 'fail',
			message: 'Emergency request is already verified.',
		})
	}
	if (request.verificationStatus === 'Rejected') {
		return res.status(400).json({
			status: 'fail',
			message: 'Emergency request is rejected and cannot be approved.',
		})
	}
	if (request.verificationStatus === 'More_Information_Required') {
		return res.status(400).json({
			status: 'fail',
			message: 'Emergency request is awaiting additional clinical information from requester before verification can proceed.',
		})
	}

	const remarks = req.body.remarks ? req.body.remarks.trim() : 'Clinically evaluated and approved for emergency processing.'
	const currentVersion = req.body.verificationVersion !== undefined
		? req.body.verificationVersion
		: (request.verificationVersion || 0)

	const result = await withTransaction(async (session) => {
		// Atomic OCC update
		const updated = await EmergencyBloodRequest.findOneAndUpdate(
			{ _id: request._id, verificationVersion: currentVersion },
			{
				$set: {
					verificationStatus: 'Verified',
					verifiedBy: req.user._id,
					verifiedAt: new Date(),
					verificationRemarks: remarks,
				},
				$inc: { verificationVersion: 1 },
			},
			{ new: true, session }
		)

		if (!updated) {
			const err = new Error('Conflict: Request was modified by another user. Please refresh and retry.')
			err.statusCode = 409
			throw err
		}

		// Append-only audit record within transaction
		const auditRecord = await EmergencyRequestVerification.create(
			[
				{
					emergencyRequestId: request._id,
					hospitalId: hospitalId,
					actorUserId: req.user._id,
					actorModel: 'user',
					actorRole: 'MEDICAL_OFFICER',
					action: 'APPROVED',
					previousVerificationStatus: 'Pending_Verification',
					newVerificationStatus: 'Verified',
					remarks,
					verificationVersion: currentVersion,
				},
			],
			{ session }
		)

		return { updated, audit: auditRecord[0] }
	})

	res.status(200).json({
		status: 'success',
		message: `Emergency request #${result.updated.requestNumber} successfully verified.`,
		data: {
			request: result.updated,
			verificationAudit: result.audit,
		},
	})
})

/**
 * Reject Emergency Blood Request
 * PATCH /api/medical-officer/requests/:id/reject
 */
exports.rejectEmergencyRequest = catchAsync(async (req, res, next) => {
	const request = await EmergencyBloodRequest.findById(req.params.id)
	const hospitalId = validateRequestHospitalScope(request, req)

	// State machine guard
	if (request.verificationStatus === 'Flagged_Suspicious') {
		return res.status(400).json({
			status: 'fail',
			message: 'Request is flagged suspicious and quarantined under clinical safety protocol.',
		})
	}
	if (request.verificationStatus === 'Verified') {
		return res.status(400).json({
			status: 'fail',
			message: 'Emergency request has already been verified and cannot be rejected.',
		})
	}
	if (request.verificationStatus === 'Rejected') {
		return res.status(400).json({
			status: 'fail',
			message: 'Emergency request is already rejected.',
		})
	}

	const rejectionReason = req.body.rejectionReason?.trim()
	const reasonCode = req.body.reasonCode?.trim() || 'CLINICALLY_INAPPROPRIATE'
	const remarks = req.body.remarks?.trim() || ''

	if (!rejectionReason || rejectionReason.length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'A detailed rejection reason (minimum 5 characters) is mandatory.',
		})
	}

	const currentVersion = req.body.verificationVersion !== undefined
		? req.body.verificationVersion
		: (request.verificationVersion || 0)

	const result = await withTransaction(async (session) => {
		const updated = await EmergencyBloodRequest.findOneAndUpdate(
			{ _id: request._id, verificationVersion: currentVersion },
			{
				$set: {
					verificationStatus: 'Rejected',
					verifiedBy: req.user._id,
					verifiedAt: new Date(),
					rejectionReason,
					verificationRemarks: remarks,
				},
				$inc: { verificationVersion: 1 },
			},
			{ new: true, session }
		)

		if (!updated) {
			const err = new Error('Conflict: Request was modified by another user. Please refresh and retry.')
			err.statusCode = 409
			throw err
		}

		const auditRecord = await EmergencyRequestVerification.create(
			[
				{
					emergencyRequestId: request._id,
					hospitalId: hospitalId,
					actorUserId: req.user._id,
					actorModel: 'user',
					actorRole: 'MEDICAL_OFFICER',
					action: 'REJECTED',
					previousVerificationStatus: request.verificationStatus,
					newVerificationStatus: 'Rejected',
					reasonCode,
					remarks: rejectionReason,
					verificationVersion: currentVersion,
				},
			],
			{ session }
		)

		return { updated, audit: auditRecord[0] }
	})

	res.status(200).json({
		status: 'success',
		message: `Emergency request #${result.updated.requestNumber} rejected.`,
		data: {
			request: result.updated,
			verificationAudit: result.audit,
		},
	})
})

/**
 * Request Additional Clinical Information
 * PATCH /api/medical-officer/requests/:id/request-information
 */
exports.requestAdditionalInformation = catchAsync(async (req, res, next) => {
	const request = await EmergencyBloodRequest.findById(req.params.id)
	const hospitalId = validateRequestHospitalScope(request, req)

	// State machine guard: Pending_Verification only
	if (request.verificationStatus === 'Flagged_Suspicious') {
		return res.status(400).json({
			status: 'fail',
			message: 'Request is flagged suspicious and quarantined under clinical safety protocol.',
		})
	}
	if (request.verificationStatus === 'Verified') {
		return res.status(400).json({
			status: 'fail',
			message: 'Emergency request has already been verified.',
		})
	}
	if (request.verificationStatus === 'Rejected') {
		return res.status(400).json({
			status: 'fail',
			message: 'Emergency request has been rejected.',
		})
	}

	const requestedInformation = req.body.requestedInformation?.trim()
	if (!requestedInformation || requestedInformation.length < 5) {
		return res.status(400).json({
			status: 'fail',
			message: 'Specific clinical information requested (minimum 5 characters) is mandatory.',
		})
	}

	const currentVersion = req.body.verificationVersion !== undefined
		? req.body.verificationVersion
		: (request.verificationVersion || 0)

	const result = await withTransaction(async (session) => {
		const updated = await EmergencyBloodRequest.findOneAndUpdate(
			{ _id: request._id, verificationVersion: currentVersion },
			{
				$set: {
					verificationStatus: 'More_Information_Required',
					additionalInformationRequested: requestedInformation,
				},
				$inc: { verificationVersion: 1 },
			},
			{ new: true, session }
		)

		if (!updated) {
			const err = new Error('Conflict: Request was modified by another user. Please refresh and retry.')
			err.statusCode = 409
			throw err
		}

		const auditRecord = await EmergencyRequestVerification.create(
			[
				{
					emergencyRequestId: request._id,
					hospitalId: hospitalId,
					actorUserId: req.user._id,
					actorModel: 'user',
					actorRole: 'MEDICAL_OFFICER',
					action: 'MORE_INFORMATION_REQUESTED',
					previousVerificationStatus: request.verificationStatus,
					newVerificationStatus: 'More_Information_Required',
					requestedInformation,
					verificationVersion: currentVersion,
				},
			],
			{ session }
		)

		return { updated, audit: auditRecord[0] }
	})

	res.status(200).json({
		status: 'success',
		message: `Additional information requested for emergency ticket #${result.updated.requestNumber}.`,
		data: {
			request: result.updated,
			verificationAudit: result.audit,
		},
	})
})

/**
 * Update Hospital-Specific Medical Officer Availability
 * PATCH /api/medical-officer/hospitals/:hospitalId/availability
 */
exports.updateAvailability = catchAsync(async (req, res, next) => {
	const { hospitalId } = req.params
	const { availabilityStatus } = req.body

	if (!['Available', 'Unavailable'].includes(availabilityStatus)) {
		return res.status(400).json({
			status: 'fail',
			message: "Invalid availability status. Allowed values: 'Available', 'Unavailable'.",
		})
	}

	const authorizedIds = req.authorizedHospitalIds || []
	if (!authorizedIds.includes(hospitalId)) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: You do not have an active authorized association with this hospital.',
		})
	}

	const association = await MedicalOfficerHospital.findOne({
		medicalOfficerUserId: req.user._id,
		hospitalId,
	}).populate('hospitalId', 'hospitalCode hospitalName')

	if (!association) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association not found.',
		})
	}

	association.availabilityStatus = availabilityStatus
	association.availabilityLastUpdatedAt = new Date()
	await association.save()

	res.status(200).json({
		status: 'success',
		message: `Availability status updated to '${availabilityStatus}' for ${association.hospitalId.hospitalName}.`,
		data: {
			hospitalId: association.hospitalId._id,
			hospitalName: association.hospitalId.hospitalName,
			availabilityStatus: association.availabilityStatus,
			availabilityLastUpdatedAt: association.availabilityLastUpdatedAt,
		},
	})
})

/**
 * Get Hospital-Specific Medical Officer Availability
 * GET /api/medical-officer/hospitals/:hospitalId/availability
 */
exports.getAvailability = catchAsync(async (req, res, next) => {
	const { hospitalId } = req.params

	const authorizedIds = req.authorizedHospitalIds || []
	if (!authorizedIds.includes(hospitalId)) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: You do not have an active authorized association with this hospital.',
		})
	}

	const association = await MedicalOfficerHospital.findOne({
		medicalOfficerUserId: req.user._id,
		hospitalId,
	}).populate('hospitalId', 'hospitalCode hospitalName')

	if (!association) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital association not found.',
		})
	}

	res.status(200).json({
		status: 'success',
		data: {
			hospitalId: association.hospitalId._id,
			hospitalName: association.hospitalId.hospitalName,
			availabilityStatus: association.availabilityStatus,
			availabilityLastUpdatedAt: association.availabilityLastUpdatedAt,
		},
	})
})

/**
 * Independent Medical Officer Self-Registration (Stage B3.3)
 * POST /api/medical-officers/register & POST /api/medical-officer/register
 *
 * Public access: creates a MEDICAL_OFFICER account in Active account status,
 * but with Unsubmitted credentials and NO hospital associations.
 */
exports.registerMedicalOfficer = catchAsync(async (req, res, next) => {
	// 1. Name Parsing & Validation
	let firstName = (req.body.firstName || '').trim()
	let lastName = (req.body.lastName || '').trim()
	if (!firstName && req.body.name) {
		const parts = String(req.body.name).trim().split(/\s+/)
		firstName = parts[0] || ''
		lastName = parts.length > 1 ? parts.slice(1).join(' ') : 'Doctor'
	} else if (!firstName && req.body.fullName) {
		const parts = String(req.body.fullName).trim().split(/\s+/)
		firstName = parts[0] || ''
		lastName = parts.length > 1 ? parts.slice(1).join(' ') : 'Doctor'
	}

	const missing = []
	if (!firstName) missing.push('firstName')
	if (!lastName) missing.push('lastName')

	// 2. Email Validation & Normalization
	const rawEmail = (req.body.email || '').trim()
	if (!rawEmail) {
		missing.push('email')
	} else if (!emailValidate(rawEmail)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Please provide a valid email address.',
			field: 'email',
		})
	}
	const cleanEmail = rawEmail.toLowerCase()

	// 3. Contact Number Validation
	const rawPhone =
		req.body.phoneNo1 !== undefined
			? req.body.phoneNo1
			: req.body.phone !== undefined
			? req.body.phone
			: req.body.phoneNo

	if (rawPhone === undefined || rawPhone === null || String(rawPhone).trim() === '') {
		missing.push('phone')
	}
	const cleanPhone = parseInt(String(rawPhone).replace(/\D/g, ''), 10)
	if (rawPhone !== undefined && rawPhone !== null && String(rawPhone).trim() !== '') {
		if (isNaN(cleanPhone) || !phoneNumberValidate(cleanPhone)) {
			return res.status(400).json({
				status: 'fail',
				message: 'Contact number must be a valid 10-digit phone number.',
				field: 'phone',
			})
		}
	}

	// 4. Password Validation
	const password = req.body.password
	if (!password || typeof password !== 'string') {
		missing.push('password')
	} else if (!passwordLengthValidate(password)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Password must be between 8 and 20 characters.',
			field: 'password',
		})
	}

	// 5. Professional Information Validation
	const medicalRegistrationNumber = (
		req.body.medicalRegistrationNumber ||
		req.body.regNo ||
		req.body.registrationNumber ||
		''
	).trim()
	if (!medicalRegistrationNumber) {
		missing.push('medicalRegistrationNumber')
	}
	const cleanRegNo = medicalRegistrationNumber.toUpperCase()

	if (medicalRegistrationNumber) {
		const regNoRegex = /^[A-Z0-9\/\-_ ]{3,50}$/
		if (!regNoRegex.test(cleanRegNo)) {
			return res.status(400).json({
				status: 'fail',
				message:
					'Medical Registration Number must be between 3 and 50 characters and contain only letters, numbers, hyphens, spaces, or slashes.',
				field: 'medicalRegistrationNumber',
			})
		}
	}

	const medicalCouncil = (
		req.body.medicalCouncil ||
		req.body.registrationAuthority ||
		req.body.council ||
		''
	).trim()
	if (!medicalCouncil) {
		missing.push('medicalCouncil')
	}

	if (missing.length > 0) {
		return res.status(400).json({
			status: 'fail',
			message: `Missing required registration field(s): ${missing.join(', ')}.`,
			fields: missing,
		})
	}

	// 6. Pre-flight Duplicate Conflict Checks
	// A. Check email
	const existingUserByEmail = await userModel.findOne({ email: cleanEmail })
	if (existingUserByEmail) {
		return res.status(409).json({
			status: 'fail',
			message: `An account with email '${cleanEmail}' is already registered in the platform.`,
			field: 'email',
		})
	}

	// B. Check phone
	const existingUserByPhone = await userModel.findOne({ phoneNo1: cleanPhone })
	if (existingUserByPhone) {
		return res.status(409).json({
			status: 'fail',
			message: `An account with phone number '${cleanPhone}' is already registered.`,
			field: 'phone',
		})
	}

	// C. Check Medical Registration Number
	const existingDoctorByRegNo = await userModel.findOne({
		role: 'MEDICAL_OFFICER',
		medicalRegistrationNumber: cleanRegNo,
	})
	if (existingDoctorByRegNo) {
		return res.status(409).json({
			status: 'fail',
			message: `Medical Registration Number '${cleanRegNo}' is already registered in the platform.`,
			field: 'medicalRegistrationNumber',
		})
	}

	// 7. Optional Professional Fields (Sanitized & Validated)
	const registrationState = (req.body.registrationState || req.body.state || '').trim()
	const qualification = (req.body.qualification || '').trim()
	const specialization = (req.body.specialization || '').trim()

	let cleanSupportingEvidence = ''
	if (req.body.supportingEvidence && typeof req.body.supportingEvidence === 'string') {
		const rawEvidence = req.body.supportingEvidence.trim()
		if (rawEvidence) {
			try {
				const parsedUrl = new URL(rawEvidence)
				if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
					return res.status(400).json({
						status: 'fail',
						message: 'Supporting evidence must be a valid HTTP or HTTPS web URL.',
						field: 'supportingEvidence',
					})
				}
				cleanSupportingEvidence = parsedUrl.href
			} catch (urlErr) {
				return res.status(400).json({
					status: 'fail',
					message: 'Supporting evidence must be a valid, well-formed URL.',
					field: 'supportingEvidence',
				})
			}
		}
	}

	// 8. Server-Enforced Authoritative Lifecycle State (Mass-Assignment Protection)
	// - role: strictly MEDICAL_OFFICER (client-supplied role ignored)
	// - accountStatus: Active (account created and password set)
	// - credentialStatus: Unsubmitted (Gate 2 fails closed until Stage B3.4 verification)
	// - verificationStatus: Pending (legacy backwards compatibility)
	// - hospitalId: null (NO hospital association is granted or inferred)
	// - status: true
	// - tokenVersion: 0
	let newDoctor
	try {
		newDoctor = await userModel.create({
			firstName,
			lastName,
			email: cleanEmail,
			phoneNo1: cleanPhone,
			password, // hashed automatically by userModel.pre('save')
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: 'Unsubmitted',
			verificationStatus: 'Pending',
			status: true,
			hospitalId: null,
			medicalRegistrationNumber: cleanRegNo,
			medicalCouncil,
			registrationState,
			qualification,
			specialization,
			supportingEvidence: cleanSupportingEvidence,
			tokenVersion: 0,
		})
	} catch (err) {
		if (err.code === 11000) {
			const field = err.keyPattern ? Object.keys(err.keyPattern)[0] : 'field'
			let message = 'An account with these details already exists.'
			if (field === 'email') {
				message = `An account with email '${cleanEmail}' is already registered in the platform.`
			} else if (field === 'phoneNo1') {
				message = `An account with phone number '${cleanPhone}' is already registered.`
			} else if (field === 'medicalRegistrationNumber') {
				message = `Medical Registration Number '${cleanRegNo}' is already registered in the platform.`
			}
			return res.status(409).json({
				status: 'fail',
				message,
				field,
			})
		}
		throw err
	}

	// 9. Safe Response (Never expose password, hash, token, or internal fields)
	const safeDoctor = {
		id: newDoctor._id,
		firstName: newDoctor.firstName,
		lastName: newDoctor.lastName,
		email: newDoctor.email,
		phoneNo1: newDoctor.phoneNo1,
		role: newDoctor.role,
		accountStatus: newDoctor.accountStatus,
		credentialStatus: newDoctor.credentialStatus,
		verificationStatus: newDoctor.verificationStatus,
		medicalRegistrationNumber: newDoctor.medicalRegistrationNumber,
		medicalCouncil: newDoctor.medicalCouncil,
		registrationState: newDoctor.registrationState,
		qualification: newDoctor.qualification,
		specialization: newDoctor.specialization,
		supportingEvidence: newDoctor.supportingEvidence,
		hospitalId: null,
		associations: [],
		createdAt: newDoctor.createdAt,
	}

	return res.status(201).json({
		status: 'success',
		message:
			'Medical Officer registered successfully. Your account is active, but professional credentials must be submitted and verified, and a hospital affiliation established before clinical verification access is permitted.',
		data: {
			medicalOfficer: safeDoctor,
		},
	})
})
