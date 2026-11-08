/**
 * Emergency Request Creation Controller
 * Namma Blood — Pre-Phase 4.4 Emergency Connection API
 *
 * Handles creation and server-side validation of emergency blood requests.
 *
 * Clinical & Security Invariants:
 * 1. Server-controlled requester identity derived from verified JWT (req.user._id).
 * 2. Mandatory Pending_Verification initial status: client can NEVER self-verify.
 * 3. Mass-assignment defense: lifecycle, reservation, and audit counters are locked.
 * 4. Collision-safe request identifier generation with duplicate key retry.
 * 5. Strict input validation across enums, numeric bounds, text sanitization, and GeoJSON.
 */

const crypto = require('crypto')
const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const { withTransaction } = require('../Utils/transactionHelper')
const {
	EmergencyBloodRequest,
	VALID_URGENCY_LEVELS,
	VALID_VERIFICATION_STATUSES,
} = require('./emergencyBloodRequestModel')
const { EmergencyRequestVerification } = require('../Hospital/emergencyRequestVerificationModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { VALID_BLOOD_GROUPS, VALID_COMPONENT_TYPES } = require('../BloodUnit/bloodUnitModel')
const { isValidCoordinate } = require('./geoValidation')

/**
 * Sanitizes and strips HTML / script injection characters from text input.
 */
function sanitizeText(val) {
	if (typeof val !== 'string') return ''
	return val.trim().replace(/[<>]/g, '')
}

/**
 * Normalizes component type aliases (e.g. 'PRBC' -> 'Packed_Red_Blood_Cells').
 */
function normalizeComponentType(component) {
	if (!component || typeof component !== 'string') return ''
	const trimmed = component.trim()
	if (trimmed.toUpperCase() === 'PRBC') {
		return 'Packed_Red_Blood_Cells'
	}
	if (trimmed.toUpperCase() === 'FFP') {
		return 'Fresh_Frozen_Plasma'
	}
	return trimmed
}

/**
 * Controller handler for POST /api/emergency/requests
 */
const createEmergencyRequest = catchAsync(async (req, res) => {
	// 1. Role Authorization: Only registered USERs and ADMINs may create emergency requests
	if (req.userRole !== 'USER' && req.userRole !== 'ADMIN') {
		return res.status(403).json({
			status: 'fail',
			code: 'FORBIDDEN',
			message: 'Only registered users or platform administrators may initiate emergency blood requests. Institutional blood banks and staff members must use facility donation intake.',
		})
	}

	const body = req.body || {}

	// 2. Guard against NoSQL injection via malicious body keys or operators
	for (const key of Object.keys(body)) {
		if (key.startsWith('$') || key.includes('.')) {
			return res.status(400).json({
				status: 'fail',
				code: 'INVALID_PAYLOAD',
				message: `Forbidden payload key: '${key}'. Query operators and dotted paths are prohibited.`,
			})
		}
	}

	// 3. Validate Patient Demographics
	const rawName = body.patientName
	if (!rawName || typeof rawName !== 'string' || !rawName.trim()) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Patient full name is required.',
		})
	}
	const patientName = sanitizeText(rawName)
	if (patientName.length < 2 || patientName.length > 100) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Patient name must be between 2 and 100 characters.',
		})
	}

	const rawAge = body.patientAge
	if (rawAge === undefined || rawAge === null || rawAge === '') {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Patient age is required.',
		})
	}
	const parsedAge = Number(rawAge)
	if (!Number.isInteger(parsedAge) || parsedAge < 0 || parsedAge > 120) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Patient age must be an integer between 0 and 120 years.',
		})
	}

	const rawGender = body.patientGender
	if (!rawGender || typeof rawGender !== 'string') {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Patient gender is required.',
		})
	}
	const patientGender = rawGender.trim()
	if (!['Male', 'Female', 'Other'].includes(patientGender)) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: `Invalid patient gender '${patientGender}'. Allowed values: Male, Female, Other.`,
		})
	}

	// 4. Validate Blood Requirement
	const rawBloodGroup = body.requiredBloodGroup
	if (!rawBloodGroup || typeof rawBloodGroup !== 'string') {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Required blood group is mandatory.',
		})
	}
	const requiredBloodGroup = rawBloodGroup.trim()
	if (!VALID_BLOOD_GROUPS.includes(requiredBloodGroup)) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: `Invalid blood group '${requiredBloodGroup}'. Allowed groups: ${VALID_BLOOD_GROUPS.join(', ')}.`,
		})
	}

	const rawComponent = body.requiredComponent || body.componentType
	if (!rawComponent || typeof rawComponent !== 'string') {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Component type is required.',
		})
	}
	const requiredComponent = normalizeComponentType(rawComponent)
	if (!VALID_COMPONENT_TYPES.includes(requiredComponent)) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: `Invalid component type '${requiredComponent}'. Allowed components: ${VALID_COMPONENT_TYPES.join(', ')}.`,
		})
	}

	const rawUnits = body.unitsRequested
	if (rawUnits === undefined || rawUnits === null || rawUnits === '') {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Units requested is required.',
		})
	}
	const unitsRequested = Number(rawUnits)
	if (!Number.isInteger(unitsRequested) || unitsRequested < 1 || unitsRequested > 10) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Units requested must be an integer between 1 and 10 units per emergency ticket.',
		})
	}

	const rawUrgency = body.urgencyLevel
	if (!rawUrgency || typeof rawUrgency !== 'string') {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Urgency level is required.',
		})
	}
	const urgencyLevel = rawUrgency.trim()
	if (!VALID_URGENCY_LEVELS.includes(urgencyLevel)) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: `Invalid urgency level '${urgencyLevel}'. Allowed levels: ${VALID_URGENCY_LEVELS.join(', ')}.`,
		})
	}

	let requiredWithinHours = 4
	if (body.requiredWithinHours !== undefined && body.requiredWithinHours !== null) {
		const parsedHours = Number(body.requiredWithinHours)
		if (!Number.isFinite(parsedHours) || parsedHours < 1 || parsedHours > 48) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Required response window must be a number between 1 and 48 hours.',
			})
		}
		requiredWithinHours = parsedHours
	}

	// 5. Hospital Facility Association & Verification (Defects 1 & 2)
	let hospitalId = null
	let hospitalName = ''
	let hospitalAddress = ''
	let hospitalCity = ''
	let hospitalState = ''
	let hospitalPinCode = null

	if (body.hospitalId !== undefined && body.hospitalId !== null) {
		if (typeof body.hospitalId !== 'string' || !mongoose.Types.ObjectId.isValid(body.hospitalId.trim())) {
			return res.status(400).json({
				status: 'fail',
				code: 'INVALID_HOSPITAL_IDENTIFIER',
				message: 'Hospital identifier must be a valid 24-character hexadecimal ObjectId.',
			})
		}

		const hospitalDoc = await Hospital.findById(body.hospitalId.trim())
		if (!hospitalDoc) {
			return res.status(404).json({
				status: 'fail',
				code: 'HOSPITAL_NOT_FOUND',
				message: 'The referenced hospital facility does not exist.',
			})
		}

		if (hospitalDoc.verificationStatus !== 'Verified' || hospitalDoc.isActive !== true) {
			return res.status(400).json({
				status: 'fail',
				code: 'HOSPITAL_NOT_VERIFIED',
				message: 'Cannot associate emergency request with an unverified or inactive hospital facility.',
			})
		}

		hospitalId = hospitalDoc._id
		// Derive authoritative hospital details directly from the verified hospital registry (Defect 2)
		hospitalName = hospitalDoc.hospitalName
		hospitalAddress = hospitalDoc.address ? hospitalDoc.address.street : ''
		hospitalCity = hospitalDoc.address ? hospitalDoc.address.city : ''
		hospitalState = hospitalDoc.address ? hospitalDoc.address.state : ''
		hospitalPinCode = hospitalDoc.address && hospitalDoc.address.pinCode ? Number(hospitalDoc.address.pinCode) : null
	} else {
		// Legacy / unassociated emergency request: validate client-supplied hospital fields
		const rawHospital = body.hospitalName || body.hospital
		if (!rawHospital || typeof rawHospital !== 'string' || !rawHospital.trim()) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital name is required.',
			})
		}
		hospitalName = sanitizeText(rawHospital)
		if (hospitalName.length < 2 || hospitalName.length > 200) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital name must be between 2 and 200 characters.',
			})
		}

		const rawAddress = body.hospitalAddress
		if (!rawAddress || typeof rawAddress !== 'string' || !rawAddress.trim()) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital address is required.',
			})
		}
		hospitalAddress = sanitizeText(rawAddress)
		if (hospitalAddress.length < 4 || hospitalAddress.length > 300) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital address must be between 4 and 300 characters.',
			})
		}

		const rawCity = body.hospitalCity || body.city
		if (!rawCity || typeof rawCity !== 'string' || !rawCity.trim()) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital city is required.',
			})
		}
		hospitalCity = sanitizeText(rawCity)
		if (hospitalCity.length < 2 || hospitalCity.length > 100) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital city must be between 2 and 100 characters.',
			})
		}

		const rawState = body.hospitalState || body.state
		if (!rawState || typeof rawState !== 'string' || !rawState.trim()) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital state is required.',
			})
		}
		hospitalState = sanitizeText(rawState)
		if (hospitalState.length < 2 || hospitalState.length > 100) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital state must be between 2 and 100 characters.',
			})
		}

		const rawPin = body.hospitalPinCode || body.pinCode
		if (rawPin === undefined || rawPin === null || rawPin === '') {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital PIN code is required.',
			})
		}
		hospitalPinCode = Number(rawPin)
		if (!Number.isInteger(hospitalPinCode) || hospitalPinCode < 100000 || hospitalPinCode > 999999) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Hospital PIN code must be a valid 6-digit postal code (100000 to 999999).',
			})
		}
	}

	// 6. Validate Attending Doctor Details
	const rawDoctor = body.attendingDoctor
	if (!rawDoctor || typeof rawDoctor !== 'object' || Array.isArray(rawDoctor)) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Attending doctor details are required.',
		})
	}

	const rawDocName = rawDoctor.doctorName
	if (!rawDocName || typeof rawDocName !== 'string' || !rawDocName.trim()) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Attending doctor name is required.',
		})
	}
	const doctorName = sanitizeText(rawDocName)
	if (doctorName.length < 2 || doctorName.length > 100) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Attending doctor name must be between 2 and 100 characters.',
		})
	}

	const rawDocPhone = rawDoctor.doctorPhone
	if (!rawDocPhone || typeof rawDocPhone !== 'string' || !rawDocPhone.trim()) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Attending doctor phone number is required.',
		})
	}
	const doctorPhone = rawDocPhone.trim()
	// Accepts standard 10-digit mobile numbers or international E.164 formats
	if (!/^[0-9]{10}$/.test(doctorPhone) && !/^\+?[1-9]\d{6,14}$/.test(doctorPhone)) {
		return res.status(400).json({
			status: 'fail',
			code: 'VALIDATION_ERROR',
			message: 'Attending doctor phone number must be a valid phone number (e.g. 10-digit mobile number).',
		})
	}

	const doctorRegistration = typeof rawDoctor.registrationNumber === 'string'
		? sanitizeText(rawDoctor.registrationNumber).slice(0, 50)
		: ''

	// 7. Validate GeoJSON Location (Optional Coordinates with Administrative Fallback)
	let location = undefined
	if (body.location !== undefined && body.location !== null) {
		const rawLoc = body.location
		if (typeof rawLoc !== 'object' || Array.isArray(rawLoc)) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Location must be a valid GeoJSON object with type Point.',
			})
		}

		if (rawLoc.type !== 'Point') {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: "Location type must be 'Point'.",
			})
		}

		if (!Array.isArray(rawLoc.coordinates) || rawLoc.coordinates.length !== 2) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Location coordinates must be an array of two numeric values: [longitude, latitude].',
			})
		}

		const [lng, lat] = rawLoc.coordinates
		if (
			typeof lng !== 'number' ||
			typeof lat !== 'number' ||
			!Number.isFinite(lng) ||
			!Number.isFinite(lat)
		) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Location coordinates must contain finite numeric values.',
			})
		}

		if (lng < -180 || lng > 180) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Longitude must be between -180 and +180 degrees.',
			})
		}

		if (lat < -90 || lat > 90) {
			return res.status(400).json({
				status: 'fail',
				code: 'VALIDATION_ERROR',
				message: 'Latitude must be between -90 and +90 degrees.',
			})
		}

		location = {
			type: 'Point',
			coordinates: [lng, lat],
		}
	}

	// 8. Clinical Justification & Ward Details
	const clinicalJustification = typeof body.clinicalJustification === 'string'
		? sanitizeText(body.clinicalJustification).slice(0, 1000)
		: ''

	const hospitalWardBed = typeof body.hospitalWardBed === 'string'
		? sanitizeText(body.hospitalWardBed).slice(0, 50)
		: ''

	// 9. Construct New Request with Strictly Server-Controlled Fields (Mass-Assignment Shield)
	const expiresAt = new Date(Date.now() + requiredWithinHours * 60 * 60 * 1000)

	const requestDoc = new EmergencyBloodRequest({
		// Server-controlled identity: NEVER trust client-supplied requesterUserId
		requesterUserId: req.user._id,
		hospitalId,

		// Clinical demographics & blood specs
		patientName,
		patientAge: parsedAge,
		patientGender,
		requiredBloodGroup,
		requiredComponent,
		unitsRequested,
		urgencyLevel,
		requiredWithinHours,
		expiresAt,

		// Hospital facility details & geography
		hospitalName,
		hospitalAddress,
		hospitalCity,
		hospitalState,
		hospitalPinCode,
		location,

		// Medical oversight
		attendingDoctor: {
			doctorName,
			doctorPhone,
			registrationNumber: doctorRegistration,
		},
		hospitalWardBed,
		clinicalJustification,

		// Server-controlled lifecycle and clinical safety invariants
		verificationStatus: 'Pending_Verification', // Mandatory safety invariant: client can NEVER self-verify
		status: 'Active',
		unitsReserved: 0,
		unitsFulfilled: 0,
		matchedBloodbankIds: [],
		reservedUnitIds: [],
		notifiedDonorCount: 0,
		confirmedDonorCount: 0,
		cancellationReason: '',
	})

	// 10. Persistence with Duplicate-Key Collision Handling
	let savedRequest = null
	let retries = 3

	while (retries > 0) {
		try {
			savedRequest = await requestDoc.save()
			break
		} catch (err) {
			// Handle duplicate key error on requestNumber (code 11000)
			if (err.code === 11000 && err.keyPattern && err.keyPattern.requestNumber) {
				retries--
				if (retries === 0) {
					return res.status(409).json({
						status: 'fail',
						code: 'IDENTIFIER_COLLISION',
						message: 'Unable to assign a unique request identifier after multiple retries. Please retry submission.',
					})
				}
				// Regenerate request number with fresh random bytes
				const dateSegment = new Date().toISOString().slice(0, 10).replace(/-/g, '')
				const randomSegment = crypto.randomBytes(3).toString('hex').toUpperCase()
				requestDoc.requestNumber = `EMG-${dateSegment}-${randomSegment}`
			} else {
				throw err
			}
		}
	}

	// 11. Structured Audit Log (Metadata only — no PII, tokens, or sensitive passwords)
	console.log('[EMERGENCY_REQUEST_CREATED]', {
		event: 'REQUEST_CREATED',
		requesterUserId: req.user._id.toString(),
		requestId: savedRequest._id.toString(),
		requestNumber: savedRequest.requestNumber,
		bloodGroup: savedRequest.requiredBloodGroup,
		component: savedRequest.requiredComponent,
		units: savedRequest.unitsRequested,
		urgency: savedRequest.urgencyLevel,
		verificationStatus: savedRequest.verificationStatus,
		status: savedRequest.status,
		timestamp: new Date().toISOString(),
	})

	// 12. Approved Response Allowlist
	return res.status(201).json({
		status: 'success',
		message: 'Emergency blood request created successfully.',
		data: {
			_id: savedRequest._id,
			requestNumber: savedRequest.requestNumber,
			verificationStatus: savedRequest.verificationStatus,
			status: savedRequest.status,
			hospitalId: savedRequest.hospitalId || null,
			patientName: savedRequest.patientName,
			patientAge: savedRequest.patientAge,
			patientGender: savedRequest.patientGender,
			requiredBloodGroup: savedRequest.requiredBloodGroup,
			requiredComponent: savedRequest.requiredComponent,
			unitsRequested: savedRequest.unitsRequested,
			unitsReserved: savedRequest.unitsReserved,
			unitsFulfilled: savedRequest.unitsFulfilled,
			urgencyLevel: savedRequest.urgencyLevel,
			requiredWithinHours: savedRequest.requiredWithinHours,
			expiresAt: savedRequest.expiresAt,
			hospitalName: savedRequest.hospitalName,
			hospitalAddress: savedRequest.hospitalAddress,
			hospitalCity: savedRequest.hospitalCity,
			hospitalState: savedRequest.hospitalState,
			hospitalPinCode: savedRequest.hospitalPinCode,
			location: savedRequest.location,
			attendingDoctor: savedRequest.attendingDoctor,
			clinicalJustification: savedRequest.clinicalJustification,
			createdAt: savedRequest.createdAt,
			updatedAt: savedRequest.updatedAt,
		},
	})
})

/**
 * Controller handler for PATCH /api/emergency/requests/:id/provide-information
 * Original requester provides requested clinical information, transitioning status from
 * More_Information_Required back to Pending_Verification.
 */
const provideAdditionalInformation = catchAsync(async (req, res) => {
	const requestId = req.params.id
	if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
		return res.status(400).json({
			status: 'fail',
			code: 'INVALID_IDENTIFIER',
			message: 'Invalid emergency request identifier format.',
		})
	}

	const request = await EmergencyBloodRequest.findById(requestId)
	if (!request) {
		return res.status(404).json({
			status: 'fail',
			code: 'REQUEST_NOT_FOUND',
			message: 'Emergency blood request not found.',
		})
	}

	// Ownership check: only the original requester (USER) or system administrator can provide info
	const isOwner = req.user && req.user._id && request.requesterUserId && request.requesterUserId.toString() === req.user._id.toString()
	const isAdmin = req.userRole === 'ADMIN'

	if (!isOwner && !isAdmin) {
		return res.status(403).json({
			status: 'fail',
			code: 'FORBIDDEN',
			message: 'Access denied: Only the original requester may provide additional clinical information for this emergency ticket.',
		})
	}

	// State machine check: must be in More_Information_Required
	if (request.verificationStatus === 'Flagged_Suspicious') {
		return res.status(400).json({
			status: 'fail',
			code: 'REQUEST_FLAGGED_SUSPICIOUS',
			message: 'Request is flagged suspicious and quarantined under clinical safety protocol. It cannot be updated.',
		})
	}
	if (request.verificationStatus === 'Verified') {
		return res.status(400).json({
			status: 'fail',
			code: 'REQUEST_ALREADY_VERIFIED',
			message: 'Emergency request has already been verified and cannot be modified.',
		})
	}
	if (request.verificationStatus === 'Rejected') {
		return res.status(400).json({
			status: 'fail',
			code: 'REQUEST_REJECTED',
			message: 'Emergency request has been rejected and cannot be modified.',
		})
	}
	if (request.verificationStatus === 'Pending_Verification') {
		return res.status(400).json({
			status: 'fail',
			code: 'REQUEST_ALREADY_PENDING',
			message: 'Emergency request is already pending verification.',
		})
	}
	if (request.verificationStatus !== 'More_Information_Required') {
		return res.status(400).json({
			status: 'fail',
			code: 'INVALID_STATE_TRANSITION',
			message: `Cannot provide additional information when verification status is '${request.verificationStatus}'.`,
		})
	}

	const responseText = sanitizeText(req.body.additionalInformationResponse || req.body.information || req.body.response)
	if (!responseText || responseText.length < 5) {
		return res.status(400).json({
			status: 'fail',
			code: 'INVALID_INFORMATION_RESPONSE',
			message: 'Detailed response to the requested information (minimum 5 characters) is required.',
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
					verificationStatus: 'Pending_Verification',
					additionalInformationResponse: responseText,
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
					hospitalId: request.hospitalId || null, // null if legacy request (no invented association)
					actorUserId: req.user._id,
					actorModel: req.userRole === 'ADMIN' ? 'admin' : 'user',
					actorRole: req.userRole === 'ADMIN' ? 'ADMIN' : 'USER',
					action: 'RESUBMITTED',
					previousVerificationStatus: 'More_Information_Required',
					newVerificationStatus: 'Pending_Verification',
					additionalInformationResponse: responseText,
					verificationVersion: currentVersion,
				},
			],
			{ session }
		)

		return { updated, audit: auditRecord[0] }
	})

	res.status(200).json({
		status: 'success',
		message: `Additional clinical information submitted successfully for emergency ticket #${result.updated.requestNumber}. Request returned to Pending_Verification.`,
		data: {
			request: result.updated,
			verificationAudit: result.audit,
		},
	})
})

module.exports = {
	createEmergencyRequest,
	provideAdditionalInformation,
	normalizeComponentType,
	sanitizeText,
}

