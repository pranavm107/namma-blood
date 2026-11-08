/**
 * Hospital Registry & Administrative Management Controller
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

const crypto = require('crypto')
const catchAsync = require('../Utils/catchAsync')
const userModel = require('../User/userModel')
const { Hospital, VALID_HOSPITAL_TYPES } = require('./hospitalModel')
const { HospitalSequence } = require('./hospitalSequenceModel')
const {
	MedicalOfficerHospital,
	VALID_ASSOCIATION_STATUSES,
	VALID_MO_PERMISSIONS,
} = require('./medicalOfficerHospitalModel')
const { isValidCoordinate } = require('../Emergency/geoValidation')

/**
 * Helper: Authoritatively generate a concurrency-safe institutional Hospital Code
 * Format: HOSP-<CITY_PREFIX>-<0001>
 * Uses document-level atomic sequence counter (HospitalSequence) backed by unique index on Hospital.
 */
async function generateHospitalCode(city) {
	const rawCity = (city || 'GEN').replace(/[^a-zA-Z]/g, '').toUpperCase()
	const cityPrefix = rawCity.length >= 3 ? rawCity.substring(0, 3) : rawCity.padEnd(3, 'X')
	const basePrefix = `HOSP-${cityPrefix}`

	// 1. Initialize sequence counter from existing Hospital documents if not present
	const existingCounter = await HospitalSequence.findById(basePrefix)
	if (!existingCounter) {
		const existingWithPrefix = await Hospital.find({
			hospitalCode: new RegExp(`^${basePrefix}-\\d{4}$`),
		})
			.select('hospitalCode')
			.lean()

		let maxSeq = 0
		for (const h of existingWithPrefix) {
			const parts = h.hospitalCode.split('-')
			const num = parseInt(parts[2], 10)
			if (!isNaN(num) && num > maxSeq) {
				maxSeq = num
			}
		}

		await HospitalSequence.findByIdAndUpdate(
			basePrefix,
			{ $setOnInsert: { seq: maxSeq } },
			{ upsert: true, new: true }
		)
	}

	// 2. Atomically increment sequence counter
	let allocatedCode = null
	let attempts = 0
	while (attempts < 10) {
		const counter = await HospitalSequence.findByIdAndUpdate(
			basePrefix,
			{ $inc: { seq: 1 } },
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		)

		const candidate = `${basePrefix}-${String(counter.seq).padStart(4, '0')}`

		// Verify candidate does not collide with out-of-band records
		const exists = await Hospital.findOne({ hospitalCode: candidate }).lean()
		if (!exists) {
			allocatedCode = candidate
			break
		}
		attempts++
	}

	if (!allocatedCode) {
		throw new Error('Failed to allocate unique hospital code. Please retry.')
	}

	return allocatedCode
}

exports.generateHospitalCode = generateHospitalCode

/**
 * Public / Authenticated: Get active verified hospitals for dropdown selection
 * GET /api/hospitals/verified
 */
exports.getVerifiedHospitals = catchAsync(async (req, res, next) => {
	const query = {
		verificationStatus: 'Verified',
		isActive: true,
	}

	if (req.query.city) {
		query['address.city'] = new RegExp(`^${req.query.city.trim()}$`, 'i')
	}
	if (req.query.state) {
		query['address.state'] = new RegExp(`^${req.query.state.trim()}$`, 'i')
	}
	if (req.query.search) {
		const searchRegex = new RegExp(req.query.search.trim(), 'i')
		query.$or = [{ hospitalName: searchRegex }, { hospitalCode: searchRegex }]
	}

	const hospitals = await Hospital.find(query)
		.select('hospitalCode hospitalName hospitalType address location contactPhone contactEmail')
		.sort({ hospitalName: 1 })
		.limit(100)

	res.status(200).json({
		status: 'success',
		results: hospitals.length,
		data: { hospitals },
	})
})

/**
 * Admin Only: Register new hospital (defaults to Pending, inactive)
 * Generates institutional Hospital Code authoritatively on backend.
 * POST /api/hospitals
 */
exports.registerHospital = catchAsync(async (req, res, next) => {
	const {
		hospitalName,
		hospitalType,
		address,
		location,
		contactPhone,
		contactEmail,
	} = req.body

	// Detailed field-specific validation
	const missingFields = []
	if (!hospitalName || typeof hospitalName !== 'string' || !hospitalName.trim()) {
		missingFields.push('hospitalName')
	}
	if (!contactPhone || typeof contactPhone !== 'string' || !contactPhone.trim()) {
		missingFields.push('contactPhone')
	}
	if (!contactEmail || typeof contactEmail !== 'string' || !contactEmail.trim()) {
		missingFields.push('contactEmail')
	}
	if (!address || typeof address !== 'object') {
		missingFields.push('address')
	} else {
		if (!address.street || typeof address.street !== 'string' || !address.street.trim()) {
			missingFields.push('street')
		}
		if (!address.city || typeof address.city !== 'string' || !address.city.trim()) {
			missingFields.push('city')
		}
		if (!address.state || typeof address.state !== 'string' || !address.state.trim()) {
			missingFields.push('state')
		}
		if (!address.pinCode || !String(address.pinCode).trim()) {
			missingFields.push('pinCode')
		}
	}

	if (missingFields.length > 0) {
		return res.status(400).json({
			status: 'fail',
			message: `Missing required hospital registration field(s): ${missingFields.join(', ')}.`,
			fields: missingFields,
		})
	}

	if (hospitalType && !VALID_HOSPITAL_TYPES.includes(hospitalType)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid facility classification '${hospitalType}'. Allowed: ${VALID_HOSPITAL_TYPES.join(', ')}.`,
			field: 'hospitalType',
		})
	}

	const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
	if (!emailRegex.test(contactEmail.trim())) {
		return res.status(400).json({
			status: 'fail',
			message: 'Invalid official contact email format.',
			field: 'contactEmail',
		})
	}

	const pinStr = String(address.pinCode).trim()
	if (!/^\d{5,8}$/.test(pinStr)) {
		return res.status(400).json({
			status: 'fail',
			message: 'Postal PIN code must be 5 to 8 numeric digits.',
			field: 'pinCode',
		})
	}

	let validLocation = undefined
	if (location && location.coordinates && Array.isArray(location.coordinates) && location.coordinates.length === 2) {
		const [lng, lat] = location.coordinates
		if (typeof lng === 'number' && typeof lat === 'number' && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
			validLocation = {
				type: 'Point',
				coordinates: [lng, lat],
			}
		}
	}

	// Concurrency-safe creation with retry on duplicate key error E11000
	let hospital = null
	let createAttempts = 0
	while (createAttempts < 5) {
		try {
			const generatedHospitalCode = await generateHospitalCode(address.city)
			hospital = await Hospital.create({
				hospitalCode: generatedHospitalCode,
				hospitalName: hospitalName.trim(),
				hospitalType: hospitalType || 'Private',
				address: {
					street: address.street.trim(),
					city: address.city.trim(),
					state: address.state.trim(),
					pinCode: pinStr,
				},
				location: validLocation,
				contactPhone: contactPhone.trim(),
				contactEmail: contactEmail.trim().toLowerCase(),
				verificationStatus: 'Pending',
				isActive: false,
			})
			break
		} catch (err) {
			if (err.code === 11000 && err.keyPattern && err.keyPattern.hospitalCode) {
				createAttempts++
				continue
			}
			throw err
		}
	}

	if (!hospital) {
		return res.status(500).json({
			status: 'error',
			message: 'Could not create hospital due to repeated code collisions. Please retry.',
		})
	}

	res.status(201).json({
		status: 'success',
		message: `Hospital facility '${hospital.hospitalName}' registered successfully with code ${hospital.hospitalCode}.`,
		data: { hospital },
	})
})

/**
 * Admin Only: List all hospitals with optional filters and pagination
 * GET /api/hospitals
 */
exports.getAllHospitals = catchAsync(async (req, res, next) => {
	const { verificationStatus, isActive, city, search, page = 1, limit = 15 } = req.query

	const query = {}

	if (verificationStatus) {
		query.verificationStatus = verificationStatus
	}

	if (isActive !== undefined && isActive !== '') {
		query.isActive = isActive === 'true'
	}

	if (city) {
		query['address.city'] = new RegExp(`^${city.trim()}$`, 'i')
	}

	if (search) {
		const searchRegex = new RegExp(search.trim(), 'i')
		query.$or = [
			{ hospitalName: searchRegex },
			{ hospitalCode: searchRegex },
			{ 'address.city': searchRegex },
		]
	}

	const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(100, parseInt(limit, 10))
	const pageSize = Math.min(100, parseInt(limit, 10))

	const [totalRecords, hospitals] = await Promise.all([
		Hospital.countDocuments(query),
		Hospital.find(query)
			.populate('verifiedBy', 'name email')
			.sort({ createdAt: -1 })
			.skip(skip)
			.limit(pageSize),
	])

	res.status(200).json({
		status: 'success',
		results: hospitals.length,
		pagination: {
			page: parseInt(page, 10),
			limit: pageSize,
			totalPages: Math.ceil(totalRecords / pageSize),
			totalRecords,
		},
		data: { hospitals },
	})
})

/**
 * Authenticated: Get single hospital facility details
 * GET /api/hospitals/:id
 */
exports.getHospitalById = catchAsync(async (req, res, next) => {
	const hospital = await Hospital.findById(req.params.id).populate('verifiedBy', 'name email')
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital facility not found.',
		})
	}

	res.status(200).json({
		status: 'success',
		data: { hospital },
	})
})

/**
 * Admin Only: Verify, Reject, or Activate Hospital
 * PATCH /api/hospitals/:id/verify
 */
exports.verifyHospital = catchAsync(async (req, res, next) => {
	const { verificationStatus, isActive } = req.body

	const hospital = await Hospital.findById(req.params.id)
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital facility not found.',
		})
	}

	if (verificationStatus) {
		if (!['Pending', 'Verified', 'Rejected'].includes(verificationStatus)) {
			return res.status(400).json({
				status: 'fail',
				message: `Invalid verification status '${verificationStatus}'. Allowed: Pending, Verified, Rejected.`,
			})
		}
		hospital.verificationStatus = verificationStatus
		if (verificationStatus === 'Verified') {
			hospital.verifiedBy = req.user._id
			hospital.verifiedAt = new Date()
			if (isActive !== undefined) {
				hospital.isActive = Boolean(isActive)
			} else {
				hospital.isActive = true
			}
		} else if (verificationStatus === 'Rejected') {
			hospital.isActive = false
		}
	}

	if (isActive !== undefined && verificationStatus !== 'Verified') {
		hospital.isActive = Boolean(isActive)
	}

	await hospital.save()

	res.status(200).json({
		status: 'success',
		message: `Hospital ${hospital.hospitalName} status updated to '${hospital.verificationStatus}' (active: ${hospital.isActive}).`,
		data: { hospital },
	})
})

/**
 * Admin Only: Onboard / Register a new Medical Officer
 * POST /api/hospitals/medical-officers/onboard
 */
exports.onboardMedicalOfficer = catchAsync(async (req, res, next) => {
	const {
		firstName,
		lastName,
		email,
		phoneNo1,
		medicalRegistrationNumber,
		medicalCouncil,
		registrationState,
		supportingEvidence,
		nominatedByHospitalId,
		password,
	} = req.body

	// Validate required fields
	const missing = []
	if (!firstName || !firstName.trim()) missing.push('firstName')
	if (!lastName || !lastName.trim()) missing.push('lastName')
	if (!email || !email.trim()) missing.push('email')
	if (!phoneNo1 || !String(phoneNo1).trim()) missing.push('phoneNo1')
	if (!medicalRegistrationNumber || !medicalRegistrationNumber.trim()) missing.push('medicalRegistrationNumber')
	if (!medicalCouncil || !medicalCouncil.trim()) missing.push('medicalCouncil')
	if (!registrationState || !registrationState.trim()) missing.push('registrationState')

	if (missing.length > 0) {
		return res.status(400).json({
			status: 'fail',
			message: `Missing required Medical Officer onboarding field(s): ${missing.join(', ')}.`,
			fields: missing,
		})
	}

	const cleanEmail = email.trim().toLowerCase()
	const cleanRegNo = medicalRegistrationNumber.trim().toUpperCase()

	// Check duplicate email
	const existingUser = await userModel.findOne({ email: cleanEmail })
	if (existingUser) {
		return res.status(409).json({
			status: 'fail',
			message: `An account with email '${cleanEmail}' is already registered in the platform.`,
			field: 'email',
		})
	}

	// Check duplicate registration number
	const existingDoctor = await userModel.findOne({
		role: 'MEDICAL_OFFICER',
		medicalRegistrationNumber: cleanRegNo,
	})
	if (existingDoctor) {
		return res.status(409).json({
			status: 'fail',
			message: `Medical Registration Number '${cleanRegNo}' is already registered for Dr. ${existingDoctor.firstName} ${existingDoctor.lastName}.`,
			field: 'medicalRegistrationNumber',
		})
	}

	// Validate nominated hospital if provided
	let nominatedHospital = null
	if (nominatedByHospitalId) {
		nominatedHospital = await Hospital.findById(nominatedByHospitalId)
		if (!nominatedHospital) {
			return res.status(404).json({
				status: 'fail',
				message: 'Nominated hospital facility not found.',
				field: 'nominatedByHospitalId',
			})
		}
	}

	// Clean contact number
	const cleanPhone = parseInt(String(phoneNo1).replace(/\D/g, ''), 10)
	if (isNaN(cleanPhone) || String(cleanPhone).length < 10) {
		return res.status(400).json({
			status: 'fail',
			message: 'Contact number must contain at least 10 valid digits.',
			field: 'phoneNo1',
		})
	}

	// Initial password
	const initialPassword = password && password.trim().length >= 8
		? password.trim()
		: `Dr@${crypto.randomBytes(4).toString('hex')}!`

	// Create Medical Officer in Pending status and inactive
	const newDoctor = await userModel.create({
		firstName: firstName.trim(),
		lastName: lastName.trim(),
		email: cleanEmail,
		phoneNo1: cleanPhone,
		medicalRegistrationNumber: cleanRegNo,
		medicalCouncil: medicalCouncil.trim(),
		registrationState: registrationState.trim(),
		supportingEvidence: supportingEvidence ? supportingEvidence.trim() : '',
		nominatedByHospital: nominatedHospital ? nominatedHospital._id : null,
		password: initialPassword,
		role: 'MEDICAL_OFFICER',
		verificationStatus: 'Pending',
		status: false, // Inactive until approved
	})

	const safeDoctor = {
		_id: newDoctor._id,
		firstName: newDoctor.firstName,
		lastName: newDoctor.lastName,
		email: newDoctor.email,
		phoneNo1: newDoctor.phoneNo1,
		medicalRegistrationNumber: newDoctor.medicalRegistrationNumber,
		medicalCouncil: newDoctor.medicalCouncil,
		registrationState: newDoctor.registrationState,
		supportingEvidence: newDoctor.supportingEvidence,
		nominatedByHospital: nominatedHospital
			? {
					_id: nominatedHospital._id,
					hospitalCode: nominatedHospital.hospitalCode,
					hospitalName: nominatedHospital.hospitalName,
			  }
			: null,
		role: newDoctor.role,
		verificationStatus: newDoctor.verificationStatus,
		status: newDoctor.status,
		createdAt: newDoctor.createdAt,
	}

	res.status(201).json({
		status: 'success',
		message: `Medical Officer account for Dr. ${newDoctor.firstName} ${newDoctor.lastName} created in Pending verification status.`,
		data: { medicalOfficer: safeDoctor },
	})
})

/**
 * Admin Only: List Medical Officer directory with lifecycle status filters
 * GET /api/hospitals/medical-officers/directory
 */
exports.getMedicalOfficersDirectory = catchAsync(async (req, res, next) => {
	const { verificationStatus, search, page = 1, limit = 20 } = req.query
	const query = { role: 'MEDICAL_OFFICER' }

	if (verificationStatus && ['Pending', 'Verified', 'Rejected', 'Suspended'].includes(verificationStatus)) {
		query.verificationStatus = verificationStatus
	}

	if (search && typeof search === 'string' && search.trim()) {
		const searchRegex = new RegExp(search.trim(), 'i')
		query.$or = [
			{ firstName: searchRegex },
			{ lastName: searchRegex },
			{ email: searchRegex },
			{ medicalRegistrationNumber: searchRegex },
			{ medicalCouncil: searchRegex },
		]
	}

	const skip = (Math.max(1, parseInt(page, 10)) - 1) * Math.min(100, parseInt(limit, 10))
	const pageSize = Math.min(100, parseInt(limit, 10))

	const [totalRecords, doctors] = await Promise.all([
		userModel.countDocuments(query),
		userModel.find(query)
			.select('_id firstName lastName email phoneNo1 medicalRegistrationNumber medicalCouncil registrationState supportingEvidence verificationStatus status rejectionReason verifiedAt createdAt')
			.populate('nominatedByHospital', 'hospitalCode hospitalName address.city')
			.populate('verifiedBy', 'name email')
			.sort({ createdAt: -1 })
			.skip(skip)
			.limit(pageSize)
			.lean(),
	])

	res.status(200).json({
		status: 'success',
		results: doctors.length,
		pagination: {
			page: parseInt(page, 10),
			limit: pageSize,
			totalPages: Math.ceil(totalRecords / pageSize),
			totalRecords,
		},
		data: { medicalOfficers: doctors },
	})
})

/**
 * Admin Only: Verify, Reject, or Suspend Medical Officer account
 * PATCH /api/hospitals/medical-officers/:id/verify
 */
exports.verifyMedicalOfficerAccount = catchAsync(async (req, res, next) => {
	const { id } = req.params
	const { verificationStatus, rejectionReason, isActive } = req.body

	const doctor = await userModel.findOne({ _id: id, role: 'MEDICAL_OFFICER' })
	if (!doctor) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer account not found.',
		})
	}

	if (!['Pending', 'Verified', 'Rejected', 'Suspended'].includes(verificationStatus)) {
		return res.status(400).json({
			status: 'fail',
			message: `Invalid verification status '${verificationStatus}'. Allowed: Pending, Verified, Rejected, Suspended.`,
		})
	}

	if (verificationStatus === 'Rejected' && (!rejectionReason || !rejectionReason.trim())) {
		return res.status(400).json({
			status: 'fail',
			message: 'Rejection reason is mandatory when rejecting a Medical Officer account.',
			field: 'rejectionReason',
		})
	}

	doctor.verificationStatus = verificationStatus

	if (verificationStatus === 'Verified') {
		doctor.status = isActive !== undefined ? Boolean(isActive) : true
		doctor.verifiedBy = req.user._id
		doctor.verifiedAt = new Date()
		doctor.rejectionReason = ''
	} else if (verificationStatus === 'Rejected') {
		doctor.status = false
		doctor.rejectionReason = rejectionReason.trim()
		doctor.verifiedBy = req.user._id
		doctor.verifiedAt = new Date()
	} else if (verificationStatus === 'Suspended') {
		doctor.status = false
	} else if (verificationStatus === 'Pending') {
		doctor.status = false
	}

	await doctor.save()

	res.status(200).json({
		status: 'success',
		message: `Medical Officer Dr. ${doctor.firstName} ${doctor.lastName} status updated to '${verificationStatus}'.`,
		data: {
			medicalOfficer: {
				_id: doctor._id,
				firstName: doctor.firstName,
				lastName: doctor.lastName,
				email: doctor.email,
				medicalRegistrationNumber: doctor.medicalRegistrationNumber,
				medicalCouncil: doctor.medicalCouncil,
				verificationStatus: doctor.verificationStatus,
				status: doctor.status,
				rejectionReason: doctor.rejectionReason,
				verifiedAt: doctor.verifiedAt,
			},
		},
	})
})

/**
 * Authenticated: Nominate a Medical Officer for a hospital
 * POST /api/hospitals/medical-officers/nominate
 */
exports.nominateMedicalOfficer = catchAsync(async (req, res, next) => {
	const { hospitalId, medicalOfficerUserId } = req.body
	if (!hospitalId || !medicalOfficerUserId) {
		return res.status(400).json({
			status: 'fail',
			message: 'Both hospitalId and medicalOfficerUserId are required for nomination.',
		})
	}

	const [hospital, doctor] = await Promise.all([
		Hospital.findById(hospitalId),
		userModel.findOne({ _id: medicalOfficerUserId, role: 'MEDICAL_OFFICER' }),
	])

	if (!hospital) {
		return res.status(404).json({ status: 'fail', message: 'Hospital not found.' })
	}
	if (!doctor) {
		return res.status(404).json({ status: 'fail', message: 'Medical Officer account not found.' })
	}

	doctor.nominatedByHospital = hospital._id
	await doctor.save()

	res.status(200).json({
		status: 'success',
		message: `Dr. ${doctor.firstName} ${doctor.lastName} nominated by ${hospital.hospitalName}. Pending Admin verification.`,
		data: { doctorId: doctor._id, hospitalId: hospital._id },
	})
})

/**
 * Admin Only: Assign Medical Officer to Hospital
 * POST /api/hospitals/medical-officers/assign
 */
exports.assignMedicalOfficer = catchAsync(async (req, res, next) => {
	const {
		medicalOfficerUserId,
		hospitalId,
		permissions = ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
		associationStatus = 'Active',
		effectiveFrom = new Date(),
		expiresAt = null,
	} = req.body

	if (!medicalOfficerUserId || !hospitalId) {
		return res.status(400).json({
			status: 'fail',
			message: 'Both medicalOfficerUserId and hospitalId are required.',
		})
	}

	// Verify user exists and is an active, verified MEDICAL_OFFICER
	const moUser = await userModel.findById(medicalOfficerUserId)
	if (!moUser) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer user account not found.',
		})
	}
	if (moUser.role !== 'MEDICAL_OFFICER') {
		return res.status(400).json({
			status: 'fail',
			message: `User '${moUser.firstName} ${moUser.lastName}' does not have the MEDICAL_OFFICER role.`,
		})
	}
	if (moUser.verificationStatus !== 'Verified') {
		return res.status(400).json({
			status: 'fail',
			message: `Medical Officer account '${moUser.firstName} ${moUser.lastName}' has verification status '${moUser.verificationStatus}'. Only Verified accounts can be associated with hospitals.`,
		})
	}
	if (moUser.status !== true) {
		return res.status(400).json({
			status: 'fail',
			message: `Medical Officer account '${moUser.firstName} ${moUser.lastName}' is inactive.`,
		})
	}

	// Verify hospital exists
	const hospital = await Hospital.findById(hospitalId)
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Hospital not found.',
		})
	}

	// Upsert or update association
	let association = await MedicalOfficerHospital.findOne({
		medicalOfficerUserId,
		hospitalId,
	})

	if (association) {
		association.associationStatus = associationStatus
		association.permissions = permissions
		association.effectiveFrom = effectiveFrom
		association.expiresAt = expiresAt
		association.approvedBy = req.user._id
		association.approvedAt = new Date()
		await association.save()
	} else {
		association = await MedicalOfficerHospital.create({
			medicalOfficerUserId,
			hospitalId,
			associationStatus,
			permissions,
			effectiveFrom,
			expiresAt,
			approvedBy: req.user._id,
			approvedAt: new Date(),
		})
	}

	res.status(201).json({
		status: 'success',
		message: `Medical Officer successfully associated with ${hospital.hospitalName}.`,
		data: { association },
	})
})

/**
 * Admin Only: List Medical Officer hospital associations
 * GET /api/hospitals/medical-officers/associations
 */
exports.getAssociations = catchAsync(async (req, res, next) => {
	const filter = {}
	if (req.query.hospitalId) filter.hospitalId = req.query.hospitalId
	if (req.query.medicalOfficerUserId) filter.medicalOfficerUserId = req.query.medicalOfficerUserId
	if (req.query.associationStatus) filter.associationStatus = req.query.associationStatus

	const associations = await MedicalOfficerHospital.find(filter)
		.populate('medicalOfficerUserId', 'firstName lastName email medicalRegistrationNumber medicalCouncil verificationStatus status')
		.populate('hospitalId', 'hospitalCode hospitalName hospitalType address verificationStatus isActive')
		.sort({ createdAt: -1 })

	res.status(200).json({
		status: 'success',
		results: associations.length,
		data: { associations },
	})
})

/**
 * Admin Only: Update association status (Active, Suspended, Revoked)
 * PATCH /api/hospitals/medical-officers/association/:id/status
 */
exports.updateAssociationStatus = catchAsync(async (req, res, next) => {
	const { associationStatus, permissions, expiresAt } = req.body

	const association = await MedicalOfficerHospital.findById(req.params.id)
	if (!association) {
		return res.status(404).json({
			status: 'fail',
			message: 'Medical Officer association not found.',
		})
	}

	if (associationStatus) {
		if (!VALID_ASSOCIATION_STATUSES.includes(associationStatus)) {
			return res.status(400).json({
				status: 'fail',
				message: `Invalid association status '${associationStatus}'. Allowed: ${VALID_ASSOCIATION_STATUSES.join(', ')}.`,
			})
		}
		association.associationStatus = associationStatus
	}

	if (permissions) {
		association.permissions = permissions
	}

	if (expiresAt !== undefined) {
		association.expiresAt = expiresAt
	}

	association.approvedBy = req.user._id
	association.approvedAt = new Date()

	await association.save()

	res.status(200).json({
		status: 'success',
		message: `Association status updated to '${association.associationStatus}'.`,
		data: { association },
	})
})

/**
 * Admin Only: List accredited, verified Medical Officer accounts for hospital assignment selector
 * GET /api/hospitals/medical-officers
 */
exports.getMedicalOfficers = catchAsync(async (req, res, next) => {
	const query = {
		role: 'MEDICAL_OFFICER',
		verificationStatus: 'Verified',
		status: true,
	}

	if (req.query.search && typeof req.query.search === 'string' && req.query.search.trim()) {
		const searchRegex = new RegExp(req.query.search.trim(), 'i')
		query.$or = [
			{ firstName: searchRegex },
			{ lastName: searchRegex },
			{ email: searchRegex },
			{ medicalRegistrationNumber: searchRegex },
			{ medicalCouncil: searchRegex },
		]
	}

	const medicalOfficers = await userModel.find(query)
		.select('_id firstName lastName email medicalRegistrationNumber medicalCouncil status role verificationStatus')
		.sort({ firstName: 1, lastName: 1 })
		.limit(100)
		.lean()

	res.status(200).json({
		status: 'success',
		results: medicalOfficers.length,
		data: { medicalOfficers },
	})
})
