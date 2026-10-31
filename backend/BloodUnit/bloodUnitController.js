const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const AppError = require('../Utils/appError')
const { withTransaction } = require('../Utils/transactionHelper')
const {
	BloodUnit,
	MANDATORY_TTI_TESTS,
	VALID_BLOOD_GROUPS,
	VALID_STATUSES,
	VALID_COMPONENT_TYPES,
} = require('./bloodUnitModel')
const { BloodUnitAuditLog, recordAuditLog } = require('./bloodUnitAuditModel')

const {
	reserveUnitsForRequest,
	releaseReservationForRequest,
} = require('./reservationService')
const {
	issueUnitsForRequest,
	recordCrossmatchForUnit,
	recordPhysicalDispatch,
	VALID_CROSSMATCH_RESULTS,
} = require('./issuanceService')
const stockService = require('../BloodStock/stockService')

const VALID_TEST_RESULTS = ['Pending', 'Non_Reactive', 'Reactive']

/**
 * Helper to locate a BloodUnit by MongoDB ObjectId or unique DIN/unitNumber.
 * Enforces multi-tenant ownership (BOLA guard) matching the authenticated blood bank.
 */
async function findOwnedBloodUnit(identifier, bloodbankId, options = {}) {
	const query = { bloodbankId }

	if (mongoose.Types.ObjectId.isValid(identifier)) {
		query.$or = [{ _id: identifier }, { unitNumber: identifier.toString().toUpperCase() }]
	} else if (typeof identifier === 'string' && identifier.trim()) {
		query.unitNumber = identifier.trim().toUpperCase()
	} else {
		return null
	}

	return await BloodUnit.findOne(query, null, options)
}

/**
 * Records Transfusion Transmissible Infection (TTI) laboratory screening results
 * for a specific traceable blood unit.
 *
 * Hardened Clinical Safety & Integrity Invariants:
 * 1. Only the authenticated owning blood bank can record laboratory results (BOLA defense).
 * 2. Only approved tests (hiv, hbv, hcv, syphilis, malaria) and result values
 *    ('Pending', 'Non_Reactive', 'Reactive') are accepted.
 * 3. Unexpected fields and nested injection attempts (e.g. status, clearance) are strictly rejected.
 * 4. Timestamps cannot be in the future or precede the unit's collection date.
 * 5. Batch metadata (testBatchId) must be valid, non-empty, and bounded.
 * 6. Overwrite Protection: Previously recorded 'Reactive' results can NEVER be downgraded to
 *    'Non_Reactive' or reverted to 'Pending' via ordinary screening resubmissions. Concluded
 *    'Non_Reactive' results cannot be reverted to 'Pending'.
 * 7. State machine transitions: Units transition from 'Quarantined' to 'Tested_Passed' ONLY when all 5
 *    mandatory tests are confirmed 'Non_Reactive'. Any 'Reactive' test keeps/reverts unit to 'Quarantined'.
 * 8. Screening results ALONE NEVER make a unit 'Available' (Medical Officer clearance is strictly required).
 *    clearance.isVerified is locked to false.
 * 9. Records an append-only, non-repudiable BloodUnitAuditLog entry within the same database transaction.
 */
const recordScreeningResults = catchAsync(async (req, res, next) => {
	const { id } = req.params
	const payload = req.body || {}

	if (!id || (typeof id === 'string' && !id.trim())) {
		return res.status(400).json({
			message: 'Unit identifier (ID or DIN) is required.',
		})
	}

	// 1. Validate top-level keys against unexpected fields / injection attempts
	const allowedTopLevelKeys = [...MANDATORY_TTI_TESTS, 'tests', 'testBatchId', 'testedAt', 'notes']
	for (const key of Object.keys(payload)) {
		if (!allowedTopLevelKeys.includes(key)) {
			return res.status(400).json({
				message: `Unrecognized or forbidden field: '${key}'. Field injection is strictly blocked.`,
			})
		}
	}

	// 2. Extract and validate tests input
	let testsInput = {}
	if (payload.tests !== undefined) {
		if (typeof payload.tests !== 'object' || payload.tests === null || Array.isArray(payload.tests)) {
			return res.status(400).json({
				message: "'tests' field must be an object containing screening test results.",
			})
		}
		for (const key of Object.keys(payload.tests)) {
			if (!MANDATORY_TTI_TESTS.includes(key)) {
				return res.status(400).json({
					message: `Unrecognized test name in 'tests': '${key}'. Supported tests: ${MANDATORY_TTI_TESTS.join(', ')}.`,
				})
			}
		}
		testsInput = payload.tests
	} else {
		for (const test of MANDATORY_TTI_TESTS) {
			if (payload[test] !== undefined) {
				testsInput[test] = payload[test]
			}
		}
	}

	// Validate test results
	const submittedTests = {}
	let hasValidTestField = false

	for (const test of MANDATORY_TTI_TESTS) {
		if (testsInput[test] !== undefined) {
			const value = testsInput[test]
			if (!VALID_TEST_RESULTS.includes(value)) {
				return res.status(400).json({
					message: `Invalid test result for '${test}': '${value}'. Allowed values: ${VALID_TEST_RESULTS.join(', ')}.`,
				})
			}
			submittedTests[test] = value
			hasValidTestField = true
		}
	}

	if (!hasValidTestField) {
		return res.status(400).json({
			message: `At least one valid TTI test result must be provided. Supported tests: ${MANDATORY_TTI_TESTS.join(', ')}.`,
		})
	}

	// 3. Validate testBatchId if provided
	if (payload.testBatchId !== undefined) {
		if (typeof payload.testBatchId !== 'string' || payload.testBatchId.trim().length === 0) {
			return res.status(400).json({
				message: 'testBatchId must be a non-empty string.',
			})
		}
		if (payload.testBatchId.length > 100) {
			return res.status(400).json({
				message: 'testBatchId exceeds maximum permitted length of 100 characters.',
			})
		}
	}

	// 4. Validate testedAt if provided
	let parsedTestedAt = null
	if (payload.testedAt !== undefined) {
		parsedTestedAt = new Date(payload.testedAt)
		if (isNaN(parsedTestedAt.getTime())) {
			return res.status(400).json({
				message: 'Invalid testedAt timestamp format.',
			})
		}
		if (parsedTestedAt > new Date()) {
			return res.status(400).json({
				message: 'Invalid testedAt timestamp: Test timestamp cannot be in the future.',
			})
		}
	}

	return await withTransaction(async (session) => {
		const opts = session ? { session } : {}

		// Locate owned unit
		const unit = await findOwnedBloodUnit(id, req.user._id, opts)
		if (!unit) {
			const err = new Error('Blood unit not found or not owned by your blood bank.')
			err.statusCode = 404
			throw err
		}

		// Validate testedAt vs collectionDate
		if (parsedTestedAt && unit.collectionDate && parsedTestedAt < new Date(unit.collectionDate)) {
			const err = new Error(
				'Invalid testedAt timestamp: Test timestamp cannot precede unit collection date.'
			)
			err.statusCode = 400
			throw err
		}

		// State guard: Cannot submit screening tests on invalid lifecycle states
		if (unit.status === 'Available') {
			const err = new Error(
				'Cannot modify screening results: Unit is already verified and Available in inventory.'
			)
			err.statusCode = 400
			throw err
		}

		if (unit.status === 'Issued') {
			const err = new Error('Cannot modify screening results on an already issued blood unit.')
			err.statusCode = 400
			throw err
		}

		if (unit.status === 'Discarded') {
			const err = new Error('Cannot record screening results on a discarded unit.')
			err.statusCode = 400
			throw err
		}

		if (unit.status === 'Expired') {
			const err = new Error('Cannot record screening results on an expired blood unit.')
			err.statusCode = 400
			throw err
		}

		// Overwrite Guard: Prevent ordinary resubmissions from downgrading Reactive results
		// or reverting concluded Non_Reactive results to Pending
		for (const [test, value] of Object.entries(submittedTests)) {
			const existingResult = unit.testing ? unit.testing[test] : 'Pending'

			// 1. Reactive result lock: Cannot overwrite Reactive to Non_Reactive or Pending!
			if (existingResult === 'Reactive' && value !== 'Reactive') {
				const err = new Error(
					`Safety violation: Cannot overwrite previously Reactive test '${test}' to '${value}'. Units with confirmed reactive markers are locked against ordinary downgrade.`
				)
				err.statusCode = 400
				throw err
			}

			// 2. Concluded result reversion guard: Cannot revert Non_Reactive back to Pending!
			if (existingResult === 'Non_Reactive' && value === 'Pending') {
				const err = new Error(
					`Safety violation: Cannot revert concluded test '${test}' from 'Non_Reactive' back to 'Pending'.`
				)
				err.statusCode = 400
				throw err
			}
		}

		const previousStatus = unit.status
		const previousTesting = {
			hiv: unit.testing?.hiv || 'Pending',
			hbv: unit.testing?.hbv || 'Pending',
			hcv: unit.testing?.hcv || 'Pending',
			syphilis: unit.testing?.syphilis || 'Pending',
			malaria: unit.testing?.malaria || 'Pending',
			testBatchId: unit.testing?.testBatchId || null,
			testedAt: unit.testing?.testedAt || null,
		}

		// Apply updated test results
		if (!unit.testing) {
			unit.testing = {}
		}

		for (const [test, value] of Object.entries(submittedTests)) {
			unit.testing[test] = value
		}

		// Provenance tracking
		unit.testing.testedBy = req.user._id
		unit.testing.testedAt = parsedTestedAt || new Date()
		if (payload.testBatchId) {
			unit.testing.testBatchId = payload.testBatchId.toString().trim()
		}

		// Determine lifecycle state transition:
		// 1. Any Reactive test result -> MUST NOT be Tested_Passed or Available. Enforce Quarantined hold.
		// 2. All 5 mandatory tests Non_Reactive -> Transition to Tested_Passed (ready for MO clearance).
		// 3. Otherwise (some Pending, none Reactive) -> Remains Quarantined.
		const isAnyReactive = MANDATORY_TTI_TESTS.some(
			(test) => unit.testing[test] === 'Reactive'
		)
		const isAllNonReactive = MANDATORY_TTI_TESTS.every(
			(test) => unit.testing[test] === 'Non_Reactive'
		)

		if (isAnyReactive) {
			unit.status = 'Quarantined'
		} else if (isAllNonReactive) {
			unit.status = 'Tested_Passed'
		} else {
			unit.status = 'Quarantined'
		}

		// Safety Gate: Ensure clearance.isVerified remains false (screening alone NEVER clears availability)
		if (unit.clearance) {
			unit.clearance.isVerified = false
		}

		// Save via document .save() to trigger all pre-save clinical schema hooks
		await unit.save(opts)

		// Record immutable audit event within the same session
		await recordAuditLog({
			unitId: unit._id,
			unitNumber: unit.unitNumber,
			bloodbankId: req.user._id,
			action: 'TTI_TESTING_RECORDED',
			previousStatus,
			newStatus: unit.status,
			actorId: req.user._id,
			actorModel: 'bloodbank',
			ipAddress: req.ip || null,
			reason: payload.notes || 'TTI laboratory screening results recorded',
			metadata: {
				submittedTests,
				testBatchId: unit.testing.testBatchId,
				testedAt: unit.testing.testedAt,
				isAllNonReactive,
				isAnyReactive,
				previousTesting,
			},
			session: opts.session,
		})

		return res.status(200).json({
			message: 'Screening results recorded successfully.',
			unit: {
				_id: unit._id,
				unitNumber: unit.unitNumber,
				bloodGroup: unit.bloodGroup,
				componentType: unit.componentType,
				status: unit.status,
				testing: {
					hiv: unit.testing.hiv,
					hbv: unit.testing.hbv,
					hcv: unit.testing.hcv,
					syphilis: unit.testing.syphilis,
					malaria: unit.testing.malaria,
					testBatchId: unit.testing.testBatchId,
					testedAt: unit.testing.testedAt,
				},
				clearance: {
					isVerified: unit.clearance?.isVerified || false,
				},
			},
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

/**
 * Retrieves a blood unit by ID or DIN for the authenticated blood bank or staff member.
 * Strips sensitive donor PII to preserve least privilege and patient confidentiality.
 * Includes complete clinical lifecycle, reservation, issuance, and audit trail metadata.
 */
const getBloodUnitById = catchAsync(async (req, res, next) => {
	const { id } = req.params
	const bloodbankId = req.bloodbankId || req.user?._id

	const unit = await findOwnedBloodUnit(id, bloodbankId)
	if (!unit) {
		return res.status(404).json({
			message: 'Blood unit not found.',
		})
	}

	let auditHistory = []
	if (mongoose.connection && mongoose.connection.readyState === 1) {
		try {
			auditHistory = await BloodUnitAuditLog.find({ unitId: unit._id })
				.sort({ timestamp: -1 })
				.limit(50)
				.lean()
		} catch (e) {
			// fallback if audit log query fails
		}
	}


	return res.status(200).json({
		_id: unit._id,
		unitNumber: unit.unitNumber,
		bloodGroup: unit.bloodGroup,
		componentType: unit.componentType,
		volumeMl: unit.volumeMl,
		collectionDate: unit.collectionDate,
		expiryDate: unit.expiryDate,
		status: unit.status,
		storageLocation: unit.storageLocation,
		testing: unit.testing,
		clearance: unit.clearance,
		reservation: unit.reservation,
		issuance: unit.issuance,
		discard: unit.discard,
		isLegacyMigrated: unit.isLegacyMigrated,
		isIssueEligible: typeof unit.isIssueEligible === 'function' ? unit.isIssueEligible() : false,
		auditHistory,
		createdAt: unit.createdAt,
		updatedAt: unit.updatedAt,
	})
})

/**
 * Searches and lists traceable blood units for the authenticated blood bank.
 * Supports filtering by blood group, component type, lifecycle status, screening status, expiry, and search query.
 */
const getBloodUnits = catchAsync(async (req, res, next) => {
	const bloodbankId = req.bloodbankId || req.user?._id
	if (!bloodbankId) {
		return res.status(401).json({
			message: 'Authentication required: Owning blood bank ID is missing.',
		})
	}

	const {
		q,
		search,
		bloodGroup,
		status,
		componentType,
		screeningStatus,
		isExpired,
		page = 1,
		limit = 10,
		sortBy = 'createdAt',
		sortOrder = 'desc',
	} = req.query

	const query = { bloodbankId: new mongoose.Types.ObjectId(bloodbankId) }

	const searchTerm = (q || search || '').trim()
	if (searchTerm) {
		const escaped = searchTerm.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
		query.unitNumber = { $regex: escaped, $options: 'i' }
	}

	if (bloodGroup && VALID_BLOOD_GROUPS.includes(bloodGroup)) {
		query.bloodGroup = bloodGroup
	}

	if (status && VALID_STATUSES.includes(status)) {
		query.status = status
	}

	if (componentType && VALID_COMPONENT_TYPES.includes(componentType)) {
		query.componentType = componentType
	}

	if (screeningStatus) {
		if (screeningStatus === 'Reactive') {
			query.$or = MANDATORY_TTI_TESTS.map((test) => ({
				[`testing.${test}`]: 'Reactive',
			}))
		} else if (screeningStatus === 'Non_Reactive') {
			for (const test of MANDATORY_TTI_TESTS) {
				query[`testing.${test}`] = 'Non_Reactive'
			}
		} else if (screeningStatus === 'Pending') {
			query.$or = MANDATORY_TTI_TESTS.map((test) => ({
				[`testing.${test}`]: 'Pending',
			}))
		}
	}

	if (isExpired === 'true') {
		query.expiryDate = { $lte: new Date() }
	} else if (isExpired === 'false') {
		query.expiryDate = { $gt: new Date() }
	}

	const pageNum = Math.max(1, parseInt(page, 10) || 1)
	const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 10))
	const skip = (pageNum - 1) * limitNum

	const ALLOWED_SORT_FIELDS = [
		'createdAt',
		'updatedAt',
		'unitNumber',
		'expiryDate',
		'collectionDate',
		'bloodGroup',
		'status',
		'volumeMl',
	]
	const safeSortBy = ALLOWED_SORT_FIELDS.includes(sortBy) ? sortBy : 'createdAt'
	const sortDirection = sortOrder === 'asc' ? 1 : -1
	const sortOptions = { [safeSortBy]: sortDirection }

	const [units, total, statusBreakdown] = await Promise.all([
		BloodUnit.find(query)
			.select('-donorUserId -donationRequestId')
			.sort(sortOptions)
			.skip(skip)
			.limit(limitNum)
			.lean(),
		BloodUnit.countDocuments(query),
		stockService.getTraceableStatusBreakdown(bloodbankId),
	])

	return res.status(200).json({
		units,
		total,
		page: pageNum,
		limit: limitNum,
		totalPages: Math.ceil(total / limitNum) || 1,
		statusBreakdown,
	})
})


/**
 * Medical Officer Quality Verification and Clinical Clearance Endpoint.
 * Transitions a blood unit from 'Tested_Passed' to 'Available'.
 *
 * Enforces:
 * 1. Medical Officer Role & Credential Verification:
 *    Only an active Medical Officer with verified credentials (medicalLicense.isVerified === true)
 *    and completed password setup (mustChangePassword === false) can clear a unit.
 * 2. Multi-Tenant Isolation & Ownership (BOLA defense):
 *    Unit must exist and belong to req.staff.bloodbankId. Cross-bank attempts return safe 404.
 * 3. Request Input Hardening:
 *    Only optional bounded string 'notes' is accepted in request body. Any unexpected,
 *    tampered, or injected fields (status, clearance, isVerified, timestamps, etc.) are strictly rejected.
 * 4. Clinical State & Test Panel Eligibility:
 *    - Current status must be exactly 'Tested_Passed'.
 *    - Unit must not already have clearance.isVerified === true.
 *    - Mandatory 5 TTI tests (hiv, hbv, hcv, syphilis, malaria) must all be 'Non_Reactive'.
 *    - Valid collectionDate and expiryDate required; unit must not be expired (expiryDate > now).
 *    - Unit collectionDate cannot be in the future or after expiryDate.
 * 5. Atomic Multi-Document Transaction:
 *    - Unit re-read inside transaction session to prevent stale/concurrent clearance races.
 *    - Status transition to 'Available' via document .save() executing all clinical pre-save hooks.
 *    - Clearance attribution stamped with verifiedBy (blood bank), verifiedByStaffId (MO), verifiedAt, and notes.
 *    - Immutable BloodUnitAuditLog entry recorded with action 'MEDICAL_OFFICER_CLEARED' inside the same session.
 *    - If audit logging or unit save fails, entire transaction rolls back.
 *    - Legacy Bloodstock counters are NOT touched.
 */
const verifyBloodUnitClearance = catchAsync(async (req, res, next) => {
	const { id } = req.params
	const payload = req.body || {}

	// 1. Validate ID parameter
	if (!id || typeof id !== 'string' || !id.trim()) {
		return res.status(400).json({
			message: 'Unit identifier (ID or DIN) is required.',
		})
	}

	const trimmedId = id.trim()
	const isValidObjectId = mongoose.Types.ObjectId.isValid(trimmedId)
	const isValidDINFormat = /^[A-Za-z0-9_-]{5,50}$/.test(trimmedId)

	if (!isValidObjectId && !isValidDINFormat) {
		return res.status(400).json({
			message: 'Invalid blood unit identifier format.',
		})
	}

	// 2. Validate request body against tampering and field injection
	const allowedKeys = ['notes']
	for (const key of Object.keys(payload)) {
		if (!allowedKeys.includes(key)) {
			return res.status(400).json({
				message: `Unrecognized or forbidden field: '${key}'. Field injection is strictly blocked.`,
			})
		}
	}

	if (payload.notes !== undefined) {
		if (typeof payload.notes !== 'string') {
			return res.status(400).json({
				message: "'notes' must be a string.",
			})
		}
		if (payload.notes.length > 500) {
			return res.status(400).json({
				message: "'notes' exceeds maximum permitted length of 500 characters.",
			})
		}
	}

	// 3. Defense-in-depth authorization check
	if (!req.staff || req.staff.role !== 'Medical_Officer') {
		return res.status(403).json({
			message: 'Access forbidden: Only an authorized Medical Officer can verify blood unit clearance.',
		})
	}

	if (req.staff.mustChangePassword) {
		return res.status(403).json({
			message: 'Initial password change required before accessing role-restricted clinical operations. Please change your password.',
		})
	}

	if (!req.staff.medicalLicense?.isVerified) {
		return res.status(403).json({
			message: 'Access forbidden: Medical Officer credentials have not been verified by a Global Administrator.',
		})
	}

	if (req.staff.status !== 'Active') {
		return res.status(401).json({
			message: 'Staff account is inactive. Access denied.',
		})
	}

	const bloodbankId = req.staff.bloodbankId

	return await withTransaction(async (session) => {
		const opts = session ? { session } : {}

		// Locate owned unit within the transaction to prevent race conditions
		const unit = await findOwnedBloodUnit(trimmedId, bloodbankId, opts)
		if (!unit) {
			const err = new Error('Blood unit not found or not owned by your blood bank.')
			err.statusCode = 404
			throw err
		}

		// Check current lifecycle status
		if (unit.status !== 'Tested_Passed') {
			const err = new Error(
				`Cannot clear blood unit for availability: current status is '${unit.status}'. Expected 'Tested_Passed'.`
			)
			err.statusCode = 400
			throw err
		}

		// Check duplicate / already cleared
		if (unit.clearance?.isVerified) {
			const err = new Error('Blood unit has already received Medical Officer clearance.')
			err.statusCode = 400
			throw err
		}

		// Validate screening panel completeness and results
		if (!unit.testing) {
			const err = new Error('Safety violation: Blood unit has no screening testing records.')
			err.statusCode = 400
			throw err
		}

		for (const test of MANDATORY_TTI_TESTS) {
			const result = unit.testing[test]
			if (result !== 'Non_Reactive') {
				const err = new Error(
					`Safety violation: Blood unit cannot be cleared. Mandatory screening test '${test}' is '${result || 'Missing'}'. All tests must be confirmed 'Non_Reactive'.`
				)
				err.statusCode = 400
				throw err
			}
		}

		// Validate dates and expiry
		if (!unit.collectionDate || isNaN(new Date(unit.collectionDate).getTime())) {
			const err = new Error('Safety violation: Blood unit has missing or invalid collection date.')
			err.statusCode = 400
			throw err
		}

		if (!unit.expiryDate || isNaN(new Date(unit.expiryDate).getTime())) {
			const err = new Error('Safety violation: Blood unit has missing or invalid expiry date.')
			err.statusCode = 400
			throw err
		}

		const now = new Date()
		if (new Date(unit.collectionDate) > now) {
			const err = new Error('Safety violation: Unit collection date cannot be in the future.')
			err.statusCode = 400
			throw err
		}

		if (new Date(unit.expiryDate) <= now) {
			const err = new Error('Safety violation: Blood unit has expired and cannot be cleared for availability.')
			err.statusCode = 400
			throw err
		}

		if (new Date(unit.collectionDate) > new Date(unit.expiryDate)) {
			const err = new Error('Safety violation: Unit collection date cannot be after expiry date.')
			err.statusCode = 400
			throw err
		}

		// Execute transition
		const previousStatus = unit.status
		unit.status = 'Available'
		if (!unit.clearance) {
			unit.clearance = {}
		}
		unit.clearance.isVerified = true
		unit.clearance.verifiedBy = bloodbankId
		unit.clearance.verifiedByStaffId = req.staff._id
		unit.clearance.verifiedAt = now
		unit.clearance.notes = payload.notes
			? `[MO: ${req.staff.fullName} | Lic: ${req.staff.medicalLicense?.licenseNumber || 'N/A'}] ${payload.notes.trim()}`
			: `[MO: ${req.staff.fullName} | Lic: ${req.staff.medicalLicense?.licenseNumber || 'N/A'}] Clinical quality verification and clearance for availability.`

		// Save via document .save() to enforce pre-save schema validation
		await unit.save(opts)

		// Record immutable audit event within the transaction
		await recordAuditLog({
			unitId: unit._id,
			unitNumber: unit.unitNumber,
			bloodbankId,
			action: 'MEDICAL_OFFICER_CLEARED',
			previousStatus,
			newStatus: 'Available',
			actorId: req.staff._id,
			actorModel: 'bloodbank',
			ipAddress: req.ip || null,
			reason: payload.notes || 'Medical Officer clinical verification and availability clearance',
			metadata: {
				staffId: req.staff._id,
				staffName: req.staff.fullName,
				licenseNumber: req.staff.medicalLicense?.licenseNumber || null,
				issuingCouncil: req.staff.medicalLicense?.issuingCouncil || null,
				bloodbankId,
				clearanceNotes: payload.notes || '',
				verifiedAt: unit.clearance.verifiedAt,
			},
			session: opts.session,
		})

		return res.status(200).json({
			message: 'Blood unit cleared successfully and marked Available.',
			unit: {
				_id: unit._id,
				unitNumber: unit.unitNumber,
				bloodGroup: unit.bloodGroup,
				componentType: unit.componentType,
				status: unit.status,
				collectionDate: unit.collectionDate,
				expiryDate: unit.expiryDate,
				clearance: {
					isVerified: unit.clearance.isVerified,
					verifiedBy: unit.clearance.verifiedBy,
					verifiedByStaffId: unit.clearance.verifiedByStaffId,
					verifiedAt: unit.clearance.verifiedAt,
					notes: unit.clearance.notes,
				},
			},
		})
	}).catch((err) => {
		const statusCode =
			err.statusCode ||
			(err.name === 'ValidationError' || err.message?.startsWith('Safety violation')
				? 400
				: 500)
		return res.status(statusCode).json({
			message: err.message,
		})
	})
})

/**
 * Patient Receive Request Blood Unit Reservation & FEFO Allocation.
 *
 * Enforces:
 * 1. Multi-Tenant Scoping (BOLA): Request must belong to authenticated blood bank.
 * 2. Issue-Eligible Filtering: Available, verified clearance, non-reactive TTI tests, unexpired.
 * 3. Deterministic FEFO Allocation: Earliest expiryDate first, older collectionDate, _id tie-breaker.
 * 4. Atomic Conditional Update: DB-enforced status transition to 'Reserved'.
 * 5. All-or-Nothing Sufficiency: If inventory is insufficient, fails closed with 400 without partial allocation.
 * 6. Non-Repudiable Audit: Appends immutable 'UNIT_RESERVED' audit event within transaction.
 * 7. Donor Privacy: Strips all donor PII from response.
 * 8. Legacy Stock Isolation: Legacy aggregate counters are never allocated or modified.
 */
const reserveBloodUnits = catchAsync(async (req, res, next) => {
	const payload = req.body || {}

	// 1. Validate request body against tampering
	const allowedKeys = ['requestId', 'componentType', 'holdHours']
	for (const key of Object.keys(payload)) {
		if (!allowedKeys.includes(key)) {
			return res.status(400).json({
				message: `Unrecognized or forbidden field: '${key}'. Field injection is strictly blocked.`,
			})
		}
	}

	const { requestId, componentType, holdHours } = payload

	if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
		return res.status(400).json({
			message: 'Valid requestId is required.',
		})
	}

	const trimmedRequestId = requestId.trim()
	if (!mongoose.Types.ObjectId.isValid(trimmedRequestId)) {
		return res.status(400).json({
			message: 'Invalid requestId format: must be a valid ObjectId.',
		})
	}

	if (componentType !== undefined) {
		const { VALID_COMPONENT_TYPES } = require('./bloodUnitModel')
		if (!VALID_COMPONENT_TYPES.includes(componentType)) {
			return res.status(400).json({
				message: `Invalid componentType '${componentType}'. Allowed: ${VALID_COMPONENT_TYPES.join(', ')}.`,
			})
		}
	}

	if (holdHours !== undefined) {
		const parsedHours = Number(holdHours)
		if (isNaN(parsedHours) || parsedHours < 1 || parsedHours > 72) {
			return res.status(400).json({
				message: 'holdHours must be a number between 1 and 72.',
			})
		}
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : req.user._id
	const actorId = req.staff ? req.staff._id : req.user._id
	const actorModel = 'bloodbank'

	return await withTransaction(async (session) => {
		const result = await reserveUnitsForRequest({
			requestId: trimmedRequestId,
			bloodbankId,
			actorId,
			actorModel,
			ipAddress: req.ip || null,
			componentType: componentType || null,
			holdHours: holdHours || 24,
			session,
		})

		return res.status(200).json({
			message: `Successfully reserved ${result.reservedUnits.length} unit(s) for receive request.`,
			reservation: {
				requestId: result.request._id,
				bloodType: result.request.bloodType,
				unitsCount: result.reservedUnits.length,
				status: result.request.status,
				units: result.reservedUnits.map((u) => ({
					_id: u._id,
					unitNumber: u.unitNumber,
					bloodGroup: u.bloodGroup,
					componentType: u.componentType,
					volumeMl: u.volumeMl,
					expiryDate: u.expiryDate,
					reservedAt: u.reservation?.reservedAt,
					reservedExpiresAt: u.reservation?.reservedExpiresAt,
				})),
			},
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

/**
 * Explicit Reservation Release Endpoint.
 * Releases all units reserved for a receive request back to Available inventory.
 */
const releaseBloodUnitReservation = catchAsync(async (req, res, next) => {
	const payload = req.body || {}

	const allowedKeys = ['requestId', 'reason']
	for (const key of Object.keys(payload)) {
		if (!allowedKeys.includes(key)) {
			return res.status(400).json({
				message: `Unrecognized or forbidden field: '${key}'. Field injection is strictly blocked.`,
			})
		}
	}

	const { requestId, reason } = payload

	if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
		return res.status(400).json({
			message: 'Valid requestId is required.',
		})
	}

	const trimmedRequestId = requestId.trim()
	if (!mongoose.Types.ObjectId.isValid(trimmedRequestId)) {
		return res.status(400).json({
			message: 'Invalid requestId format: must be a valid ObjectId.',
		})
	}

	if (reason !== undefined) {
		if (typeof reason !== 'string') {
			return res.status(400).json({
				message: "'reason' must be a string.",
			})
		}
		if (reason.length > 500) {
			return res.status(400).json({
				message: "'reason' exceeds maximum permitted length of 500 characters.",
			})
		}
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : req.user._id
	const actorId = req.staff ? req.staff._id : req.user._id
	const actorModel = 'bloodbank'

	return await withTransaction(async (session) => {
		const result = await releaseReservationForRequest({
			requestId: trimmedRequestId,
			bloodbankId,
			actorId,
			actorModel,
			ipAddress: req.ip || null,
			reason: reason || 'Reservation manually released by blood bank.',
			session,
		})

		return res.status(200).json({
			message: 'Reservation released successfully.',
			releasedCount: result.releasedCount,
			requestId: result.request._id,
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

/**
 * Final Issuance & Physical Dispatch Endpoint.
 * Transitions reserved traceable blood units to 'Issued' status and records physical dispatch.
 *
 * Invariants:
 * 1. Role-permission & tenant scoping: Enforces bloodbank / authorized staff identity.
 * 2. Crossmatch verification: Requires confirmed 'Compatible' or authorized 'Emergency_Uncrossmatched'.
 * 3. Atomic conditional update: Guarantees no concurrent double-issuance.
 * 4. Privacy: Omit donor PII completely from API response.
 * 5. Legacy inventory isolation: Never modifies legacy aggregate Bloodstock.
 */
const issueBloodUnits = catchAsync(async (req, res, next) => {
	const payload = req.body || {}

	// Validate top-level keys against injection
	const allowedKeys = [
		'requestId',
		'recipientPatientName',
		'hospitalName',
		'crossmatchResult',
		'unitCrossmatches',
		'dispatchNotes',
		'isEmergency',
		'emergencyReason',
	]
	for (const key of Object.keys(payload)) {
		if (!allowedKeys.includes(key)) {
			return res.status(400).json({
				message: `Unrecognized or forbidden field: '${key}'. Field injection is strictly blocked.`,
			})
		}
	}

	const {
		requestId,
		recipientPatientName,
		hospitalName,
		crossmatchResult,
		unitCrossmatches,
		dispatchNotes,
		isEmergency,
		emergencyReason,
	} = payload

	if (!requestId || typeof requestId !== 'string' || !requestId.trim()) {
		return res.status(400).json({
			message: 'Valid requestId is required for issuance.',
		})
	}

	const trimmedRequestId = requestId.trim()
	if (!mongoose.Types.ObjectId.isValid(trimmedRequestId)) {
		return res.status(400).json({
			message: 'Invalid requestId format: must be a valid ObjectId.',
		})
	}

	if (recipientPatientName !== undefined && typeof recipientPatientName !== 'string') {
		return res.status(400).json({
			message: "'recipientPatientName' must be a string.",
		})
	}

	if (hospitalName !== undefined && typeof hospitalName !== 'string') {
		return res.status(400).json({
			message: "'hospitalName' must be a string.",
		})
	}

	if (dispatchNotes !== undefined && typeof dispatchNotes !== 'string') {
		return res.status(400).json({
			message: "'dispatchNotes' must be a string.",
		})
	}

	// Clinical Governance Check: Emergency uncrossmatched issuance requires verified Medical Officer authorization
	if (crossmatchResult === 'Emergency_Uncrossmatched' && isEmergency !== true) {
		return res.status(400).json({
			message:
				"Clinical safety violation: Unit marked 'Emergency_Uncrossmatched' requires explicit emergency protocol authorization (isEmergency: true) for dispatch.",
		})
	}

	const isEmergencyRequested =
		isEmergency === true || crossmatchResult === 'Emergency_Uncrossmatched'
	const isMOVerified = !!(
		req.staff &&
		req.staff.role === 'Medical_Officer' &&
		req.staff.medicalLicense?.isVerified === true
	)

	if (isEmergencyRequested) {
		if (!isMOVerified) {
			return res.status(403).json({
				message:
					'Access forbidden: Emergency uncrossmatched blood issuance strictly requires authorization by a verified Medical Officer.',
			})
		}

		if (
			!emergencyReason ||
			typeof emergencyReason !== 'string' ||
			emergencyReason.trim().length < 10
		) {
			return res.status(400).json({
				message:
					'Clinical safety violation: Emergency uncrossmatched blood issuance requires clinical justification (emergencyReason of at least 10 characters).',
			})
		}
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : req.user._id
	const actorId = req.staff ? req.staff._id : req.user._id
	const actorModel = 'bloodbank'
	const staffId = req.staff ? req.staff._id : null

	return await withTransaction(async (session) => {
		const result = await issueUnitsForRequest({
			requestId: trimmedRequestId,
			bloodbankId,
			actorId,
			actorModel,
			staffId,
			isMOVerified,
			recipientPatientName: recipientPatientName || '',
			hospitalName: hospitalName || '',
			crossmatchResult: crossmatchResult || null,
			unitCrossmatches: unitCrossmatches || null,
			dispatchNotes: dispatchNotes || '',
			isEmergency: isEmergencyRequested,
			emergencyReason: emergencyReason || '',
			ipAddress: req.ip || null,
			session,
		})

		return res.status(200).json({
			message: `Successfully issued ${result.issuedUnits.length} unit(s) for receive request.`,
			issuance: {
				requestId: result.request._id,
				recipientPatientName: result.recipientPatientName,
				hospitalName: result.hospitalName,
				status: result.request.status,
				issuedAt: result.issuedAt,
				isEmergency: result.isEmergency,
				emergencyReason: result.emergencyReason || undefined,
				unitsCount: result.issuedCount,
				units: result.issuedUnits.map((u) => ({
					_id: u._id,
					unitNumber: u.unitNumber,
					bloodGroup: u.bloodGroup,
					componentType: u.componentType,
					volumeMl: u.volumeMl,
					crossmatchResult: u.issuance?.crossmatchResult,
					issuedAt: u.issuance?.issuedAt,
					isDispatched: u.issuance?.dispatch?.isDispatched || false,
				})),
			},
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

/**
 * Record Crossmatch Result for an individual blood unit.
 */
const recordCrossmatchResult = catchAsync(async (req, res, next) => {
	const { id } = req.params
	const payload = req.body || {}

	const allowedKeys = ['crossmatchResult', 'notes', 'receiveRequestId']
	for (const key of Object.keys(payload)) {
		if (!allowedKeys.includes(key)) {
			return res.status(400).json({
				message: `Unrecognized or forbidden field: '${key}'. Field injection is strictly blocked.`,
			})
		}
	}

	const { crossmatchResult, notes, receiveRequestId } = payload

	if (!id || (typeof id === 'string' && !id.trim())) {
		return res.status(400).json({
			message: 'Unit identifier (ID) is required.',
		})
	}

	if (!crossmatchResult) {
		return res.status(400).json({
			message: 'crossmatchResult is required.',
		})
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : req.user._id
	const actorId = req.staff ? req.staff._id : req.user._id
	const actorModel = 'bloodbank'
	const staffId = req.staff ? req.staff._id : null

	return await withTransaction(async (session) => {
		const unit = await recordCrossmatchForUnit({
			unitId: id,
			receiveRequestId: receiveRequestId || null,
			bloodbankId,
			actorId,
			actorModel,
			staffId,
			ipAddress: req.ip || null,
			crossmatchResult,
			notes: notes || '',
			session,
		})

		return res.status(200).json({
			message: `Crossmatch result '${unit.issuance?.crossmatchResult}' recorded successfully.`,
			unit: {
				_id: unit._id,
				unitNumber: unit.unitNumber,
				bloodGroup: unit.bloodGroup,
				status: unit.status,
				crossmatchResult: unit.issuance?.crossmatchResult,
			},
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

/**
 * Physical Dispatch Endpoint.
 * Records the physical handoff and dispatch of clinically issued blood units.
 */
const dispatchBloodUnits = catchAsync(async (req, res, next) => {
	const payload = req.body || {}

	const allowedKeys = [
		'requestId',
		'unitIds',
		'dispatchedToRecipient',
		'transportBoxId',
		'dispatchNotes',
	]
	for (const key of Object.keys(payload)) {
		if (!allowedKeys.includes(key)) {
			return res.status(400).json({
				message: `Unrecognized or forbidden field: '${key}'. Field injection is strictly blocked.`,
			})
		}
	}

	const {
		requestId,
		unitIds,
		dispatchedToRecipient,
		transportBoxId,
		dispatchNotes,
	} = payload

	if (!requestId && (!Array.isArray(unitIds) || unitIds.length === 0)) {
		return res.status(400).json({
			message: 'requestId or non-empty unitIds array is required for physical dispatch.',
		})
	}

	if (dispatchedToRecipient !== undefined && typeof dispatchedToRecipient !== 'string') {
		return res.status(400).json({
			message: "'dispatchedToRecipient' must be a string.",
		})
	}

	if (transportBoxId !== undefined && typeof transportBoxId !== 'string') {
		return res.status(400).json({
			message: "'transportBoxId' must be a string.",
		})
	}

	if (dispatchNotes !== undefined && typeof dispatchNotes !== 'string') {
		return res.status(400).json({
			message: "'dispatchNotes' must be a string.",
		})
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : req.user._id
	const actorId = req.staff ? req.staff._id : req.user._id
	const actorModel = 'bloodbank'
	const staffId = req.staff ? req.staff._id : null

	return await withTransaction(async (session) => {
		const result = await recordPhysicalDispatch({
			requestId: requestId || null,
			unitIds: unitIds || null,
			bloodbankId,
			actorId,
			actorModel,
			staffId,
			dispatchedToRecipient: dispatchedToRecipient || '',
			transportBoxId: transportBoxId || '',
			dispatchNotes: dispatchNotes || '',
			ipAddress: req.ip || null,
			session,
		})

		return res.status(200).json({
			message: `Successfully recorded physical dispatch for ${result.dispatchedCount} unit(s).`,
			dispatch: {
				dispatchedCount: result.dispatchedCount,
				dispatchedAt: result.dispatchedAt,
				dispatchedToRecipient: result.dispatchedToRecipient,
				transportBoxId: result.transportBoxId,
				units: result.dispatchedUnits.map((u) => ({
					_id: u._id,
					unitNumber: u.unitNumber,
					bloodGroup: u.bloodGroup,
					status: u.status,
					isDispatched: u.issuance?.dispatch?.isDispatched,
					dispatchedAt: u.issuance?.dispatch?.dispatchedAt,
					dispatchedByStaffId: u.issuance?.dispatch?.dispatchedByStaffId,
					dispatchedToRecipient: u.issuance?.dispatch?.dispatchedToRecipient,
					transportBoxId: u.issuance?.dispatch?.transportBoxId,
				})),
			},
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

const { discardBloodUnits } = require('./discardService')

/**
 * Authorized biohazard or clinical discard of traceable blood units.
 *
 * Safety & Audit Guarantees:
 * 1. Enforces staff or blood bank authentication and tenant scoping.
 * 2. Requires a valid discard reason from VALID_DISCARD_REASONS.
 * 3. Enforces valid lifecycle state transitions (Quarantined, Tested_Passed, Available, Reserved, Expired).
 * 4. Rejects units already Discarded (duplicate discard guard), Issued, or Dispatched.
 * 5. Pulls references from ReceiveRequests if discarded unit was Reserved.
 * 6. Appends immutable 'UNIT_DISCARDED' audit event inside transaction.
 * 7. Never mutates legacy aggregate Bloodstock.
 */
const discardBloodUnit = catchAsync(async (req, res, next) => {
	const bloodbankId = req.bloodbankId || req.user?._id
	if (!bloodbankId) {
		return res.status(401).json({
			message: 'Authentication required: Owning blood bank ID is missing.',
		})
	}

	const unitIdentifier = req.params?.id || req.body?.unitId || req.body?.unitIds
	const { reason, wasteManifestNumber, notes } = req.body || {}

	if (!unitIdentifier) {
		return res.status(400).json({
			message: 'Blood unit identifier (id, unitId, or unitIds) is required.',
		})
	}

	const actorId = req.user?._id
	const staffId = req.staff?._id || req.user?.staffId || null
	const actorModel = 'bloodbank'

	return await withTransaction(async (session) => {
		const result = await discardBloodUnits({
			unitIds: unitIdentifier,
			bloodbankId,
			reason,
			wasteManifestNumber: wasteManifestNumber || '',
			notes: notes || '',
			actorId,
			actorModel,
			staffId,
			ipAddress: req.ip || null,
			session,
		})

		return res.status(200).json({
			message: `Successfully discarded ${result.discardedCount} blood unit(s).`,
			discard: {
				discardedCount: result.discardedCount,
				discardedAt: result.discardedAt,
				reason,
				units: result.discardedUnits.map((u) => ({
					_id: u._id,
					unitNumber: u.unitNumber,
					bloodGroup: u.bloodGroup,
					status: u.status,
					discard: u.discard,
				})),
			},
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

module.exports = {
	recordScreeningResults,
	getBloodUnitById,
	getBloodUnits,
	findOwnedBloodUnit,
	verifyBloodUnitClearance,
	reserveBloodUnits,
	releaseBloodUnitReservation,
	issueBloodUnits,
	recordCrossmatchResult,
	dispatchBloodUnits,
	discardBloodUnit,
}
