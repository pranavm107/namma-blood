/**
 * Emergency Request Matching Service — Foundation, Authorization & Compatibility
 * Namma Blood — Emergency Blood Connection (Sub-Milestones 4.3.3.1 & 4.3.3.2)
 *
 * Scope:
 * 1. Safe Emergency Request Resolution (ObjectId and requestNumber lookups).
 * 2. Strict Broken Object-Level Authorization (BOLA/IDOR) Access Control (Anti-Enumeration 404).
 * 3. Request Verification & Lifecycle Validation (Verified-only gate, standardized expiry).
 * 4. Shortfall Data Integrity Invariants (unitsReserved === reservedUnitIds.length, sum <= unitsRequested).
 * 5. Presumptive Immunohematology Matching & Component Integration (Whole Blood, PRBC, FFP, Platelets, Cryo).
 *
 * Invariant:
 * Strictly read-only. Zero database mutations occur during request resolution, authorization, or compatibility derivation.
 */

const mongoose = require('mongoose')
const {
	EmergencyBloodRequest,
	VALID_EMERGENCY_STATUSES,
	VALID_VERIFICATION_STATUSES,
} = require('./emergencyBloodRequestModel')
const {
	getCompatibleDonorGroups,
	parseBloodGroup,
	COMPATIBILITY_SPEC_VERSION,
	CLINICAL_AUTHORITY,
} = require('./compatibilityEngine')

/**
 * Validates and safely resolves an EmergencyBloodRequest document by its identifier.
 * Supports:
 * - 24-character hexadecimal MongoDB ObjectId string (or ObjectId instance).
 * - Human-readable requestNumber string (e.g. 'EMG-20261102-ABC123').
 *
 * Security: Safe query construction prevents NoSQL injection via malicious operators or objects.
 *
 * @param {string|mongoose.Types.ObjectId} identifier
 * @returns {Promise<Object>} Mongoose document
 */
async function resolveEmergencyRequest(identifier) {
	if (identifier === null || identifier === undefined) {
		const err = new Error('Emergency request identifier is required.')
		err.code = 'INVALID_REQUEST_IDENTIFIER'
		err.statusCode = 400
		throw err
	}

	// Guard against object injection (e.g. query objects or operators passed as identifier)
	if (typeof identifier === 'object' && !(identifier instanceof mongoose.Types.ObjectId)) {
		const err = new Error('Invalid request identifier format: query objects or operators are not permitted.')
		err.code = 'INVALID_REQUEST_IDENTIFIER'
		err.statusCode = 400
		throw err
	}

	const rawId = identifier instanceof mongoose.Types.ObjectId
		? identifier.toString()
		: String(identifier).trim()

	if (!rawId) {
		const err = new Error('The emergency request identifier is invalid.')
		err.code = 'INVALID_REQUEST_IDENTIFIER'
		err.statusCode = 400
		throw err
	}

	// Guard against NoSQL operator keys or path navigation
	if (rawId.startsWith('$') || rawId.includes('.')) {
		const err = new Error('The emergency request identifier is invalid.')
		err.code = 'INVALID_REQUEST_IDENTIFIER'
		err.statusCode = 400
		throw err
	}

	// Case 1: 24-character hexadecimal MongoDB ObjectId
	const isHexObjectId = /^[0-9a-fA-F]{24}$/.test(rawId) && mongoose.Types.ObjectId.isValid(rawId)
	if (isHexObjectId) {
		const requestDoc = await EmergencyBloodRequest.findById(new mongoose.Types.ObjectId(rawId))
		if (!requestDoc) {
			const err = new Error('Emergency blood request was not found.')
			err.code = 'REQUEST_NOT_FOUND'
			err.statusCode = 404
			throw err
		}
		return requestDoc
	}

	// Case 2: Formatted human-readable requestNumber (e.g. EMG-YYYYMMDD-XXXXXX)
	const isRequestNumberFormat = /^EMG-[0-9A-Za-z_-]{4,30}$/i.test(rawId)
	if (isRequestNumberFormat) {
		const requestDoc = await EmergencyBloodRequest.findOne({ requestNumber: rawId.toUpperCase() })
		if (!requestDoc) {
			const err = new Error('Emergency blood request was not found.')
			err.code = 'REQUEST_NOT_FOUND'
			err.statusCode = 404
			throw err
		}
		return requestDoc
	}

	// Invalid syntax format
	const err = new Error('The emergency request identifier is invalid.')
	err.code = 'INVALID_REQUEST_IDENTIFIER'
	err.statusCode = 400
	throw err
}

/**
 * Validates request verification status, temporal validity, and lifecycle status.
 *
 * Policies:
 * - Verification gate: strictly allows 'Verified'; blocks 'Pending_Verification', 'Rejected', 'Flagged_Suspicious'.
 * - Expiry boundary: request.expiresAt <= now is treated as strictly expired.
 * - Terminal states: Fully_Reserved, In_Transit, Fulfilled, Cancelled, Expired are blocked.
 *
 * @param {Object} request - EmergencyBloodRequest document or object
 * @param {Object} [options]
 * @param {Date} [options.now=new Date()] - Injectable clock for deterministic boundary testing
 * @returns {Object} { isValid: true, status: string, verificationStatus: string }
 */
function validateRequestLifecycle(request, { now = new Date() } = {}) {
	if (!request || typeof request !== 'object') {
		const err = new Error('Invalid emergency request: document is required.')
		err.code = 'INVALID_REQUEST_OBJECT'
		err.statusCode = 400
		throw err
	}

	// 1. Verification Gate Enforcement
	const verification = request.verificationStatus
	if (verification === 'Verified') {
		// Proceed
	} else if (verification === 'Pending_Verification') {
		const err = new Error(
			'Emergency blood request is pending medical verification. Actionable matching recommendations cannot be generated until clinical verification is confirmed.'
		)
		err.code = 'REQUEST_PENDING_VERIFICATION'
		err.statusCode = 400
		throw err
	} else if (verification === 'Rejected') {
		const err = new Error(
			'Emergency blood request verification was rejected. Matching cannot be performed on rejected requests.'
		)
		err.code = 'REQUEST_VERIFICATION_REJECTED'
		err.statusCode = 400
		throw err
	} else if (verification === 'Flagged_Suspicious') {
		const err = new Error(
			'Emergency blood request has been flagged as suspicious. Matching is blocked pending clinical investigation.'
		)
		err.code = 'REQUEST_FLAGGED_SUSPICIOUS'
		err.statusCode = 400
		throw err
	} else if (verification === 'More_Information_Required') {
		const err = new Error(
			'Emergency blood request requires additional clinical information before verification can proceed. Actionable matching recommendations cannot be generated.'
		)
		err.code = 'REQUEST_MORE_INFORMATION_REQUIRED'
		err.statusCode = 400
		throw err
	} else {
		const err = new Error(`Emergency request has invalid or unrecognized verification status '${verification}'.`)
		err.code = 'REQUEST_VERIFICATION_INVALID'
		err.statusCode = 400
		throw err
	}

	// 2. Temporal Expiration Gate (Standardized: request.expiresAt <= now)
	const expiryDate = request.expiresAt ? new Date(request.expiresAt) : null
	if (!expiryDate || isNaN(expiryDate.getTime())) {
		const err = new Error('Emergency request has missing or invalid expiration timestamp (expiresAt).')
		err.code = 'INVALID_EXPIRY_DATA'
		err.statusCode = 400
		throw err
	}

	const referenceNow = now instanceof Date ? now : new Date(now)
	if (isNaN(referenceNow.getTime())) {
		const err = new Error('Invalid comparison timestamp provided for expiry check.')
		err.code = 'INVALID_CLOCK_DATA'
		err.statusCode = 400
		throw err
	}

	if (expiryDate.getTime() <= referenceNow.getTime()) {
		const err = new Error('Emergency request validity window has lapsed. Matching is closed.')
		err.code = 'EMERGENCY_REQUEST_EXPIRED'
		err.statusCode = 400
		throw err
	}

	// 3. Lifecycle Status Gate
	const status = request.status
	if (status === 'Active' || status === 'Partially_Reserved') {
		// Allowed for matching
	} else if (status === 'Fully_Reserved') {
		const err = new Error('All requested units have confirmed reservations. No additional matching candidates needed.')
		err.code = 'REQUEST_FULLY_RESERVED'
		err.statusCode = 400
		throw err
	} else if (status === 'In_Transit') {
		const err = new Error('Blood units are currently in transit to hospital. Matching is closed.')
		err.code = 'REQUEST_IN_TRANSIT'
		err.statusCode = 400
		throw err
	} else if (status === 'Fulfilled') {
		const err = new Error('Emergency blood request is already fulfilled. Matching is closed.')
		err.code = 'REQUEST_ALREADY_FULFILLED'
		err.statusCode = 400
		throw err
	} else if (status === 'Cancelled') {
		const err = new Error('Emergency blood request has been cancelled. Matching is closed.')
		err.code = 'REQUEST_CANCELLED'
		err.statusCode = 400
		throw err
	} else if (status === 'Expired') {
		const err = new Error('Emergency request validity window has lapsed. Matching is closed.')
		err.code = 'EMERGENCY_REQUEST_EXPIRED'
		err.statusCode = 400
		throw err
	} else {
		const err = new Error(`Emergency request has invalid or unrecognized lifecycle status '${status}'.`)
		err.code = 'INVALID_LIFECYCLE_STATUS'
		err.statusCode = 400
		throw err
	}

	return {
		isValid: true,
		status,
		verificationStatus: verification,
	}
}

/**
 * Validates request quantity data integrity invariants and calculates unmet shortfall.
 *
 * Invariants:
 * 1. unitsRequested, unitsReserved, unitsFulfilled must be non-negative integers.
 * 2. unitsReserved must strictly equal reservedUnitIds.length.
 * 3. unitsReserved + unitsFulfilled must not exceed unitsRequested.
 * 4. Inconsistent values fail closed with DATA_INTEGRITY_VIOLATION.
 *
 * Shortfall Formula:
 * unmetUnits = unitsRequested - (unitsReserved + unitsFulfilled)
 *
 * @param {Object} request - EmergencyBloodRequest document or object
 * @returns {Object} { unitsRequested, unitsReserved, unitsFulfilled, unmetUnits }
 */
function validateShortfallIntegrity(request) {
	if (!request || typeof request !== 'object') {
		const err = new Error('Invalid emergency request: document is required.')
		err.code = 'INVALID_REQUEST_OBJECT'
		err.statusCode = 400
		throw err
	}

	// 1. Non-negative integer validation
	if (
		typeof request.unitsRequested !== 'number' ||
		!Number.isInteger(request.unitsRequested) ||
		request.unitsRequested < 1
	) {
		const err = new Error(
			`Emergency request quantity data integrity violation: unitsRequested (${request.unitsRequested}) must be a positive integer.`
		)
		err.code = 'DATA_INTEGRITY_VIOLATION'
		err.statusCode = 500
		throw err
	}

	if (
		typeof request.unitsReserved !== 'number' ||
		!Number.isInteger(request.unitsReserved) ||
		request.unitsReserved < 0
	) {
		const err = new Error(
			`Emergency request quantity data integrity violation: unitsReserved (${request.unitsReserved}) must be a non-negative integer.`
		)
		err.code = 'DATA_INTEGRITY_VIOLATION'
		err.statusCode = 500
		throw err
	}

	if (
		typeof request.unitsFulfilled !== 'number' ||
		!Number.isInteger(request.unitsFulfilled) ||
		request.unitsFulfilled < 0
	) {
		const err = new Error(
			`Emergency request quantity data integrity violation: unitsFulfilled (${request.unitsFulfilled}) must be a non-negative integer.`
		)
		err.code = 'DATA_INTEGRITY_VIOLATION'
		err.statusCode = 500
		throw err
	}

	// 2. Reservation Count Mismatch Check: unitsReserved === reservedUnitIds.length
	let reservedIdsCount = 0
	if (Array.isArray(request.reservedUnitIds)) {
		reservedIdsCount = request.reservedUnitIds.length
	} else if (request.reservedUnitIds === null || request.reservedUnitIds === undefined) {
		reservedIdsCount = 0
	} else {
		// Non-array, non-null value for reservedUnitIds is a schema violation
		const err = new Error('Emergency request quantity data integrity violation: reservedUnitIds must be an array.')
		err.code = 'DATA_INTEGRITY_VIOLATION'
		err.statusCode = 500
		throw err
	}

	if (request.unitsReserved !== reservedIdsCount) {
		const err = new Error(
			`Emergency request quantity data integrity violation: unitsReserved (${request.unitsReserved}) does not match reservedUnitIds count (${reservedIdsCount}).`
		)
		err.code = 'DATA_INTEGRITY_VIOLATION'
		err.statusCode = 500
		throw err
	}

	// 3. Upper Bound Check: unitsReserved + unitsFulfilled <= unitsRequested
	const totalAccounted = request.unitsReserved + request.unitsFulfilled
	if (totalAccounted > request.unitsRequested) {
		const err = new Error(
			`Emergency request quantity data integrity violation: sum of unitsReserved (${request.unitsReserved}) and unitsFulfilled (${request.unitsFulfilled}) exceeds unitsRequested (${request.unitsRequested}).`
		)
		err.code = 'DATA_INTEGRITY_VIOLATION'
		err.statusCode = 500
		throw err
	}

	// 4. Calculate Unmet Shortfall
	const unmetUnits = request.unitsRequested - totalAccounted

	return {
		unitsRequested: request.unitsRequested,
		unitsReserved: request.unitsReserved,
		unitsFulfilled: request.unitsFulfilled,
		unmetUnits,
	}
}

/**
 * Enforces strict Broken Object-Level Authorization (BOLA/IDOR) on an emergency request.
 *
 * Access Rules:
 * - USER: allowed ONLY if request.requesterUserId === req.user._id.
 * - ADMIN: allowed (platform oversight).
 * - BLOODBANK: allowed ONLY if its authenticated ObjectId appears in request.matchedBloodbankIds.
 * - STAFF: allowed ONLY if staff is Active and its owning bloodbankId appears in request.matchedBloodbankIds.
 * - Unassigned Blood Banks and Staff: strictly denied (403 Forbidden).
 * - All other / unrecognized roles: strictly denied (403 Forbidden).
 *
 * @param {Object} request - EmergencyBloodRequest document or object
 * @param {Object} authContext - { user, userRole, staff }
 * @returns {Object} Authorization grant descriptor
 */
function authorizeRequestAccess(request, authContext) {
	if (!authContext || !authContext.user) {
		const err = new Error('Authentication required. You must be logged in to access emergency request matches.')
		err.code = 'AUTHENTICATION_REQUIRED'
		err.statusCode = 401
		throw err
	}

	if (!request || typeof request !== 'object') {
		const err = new Error('Invalid emergency request: document is required for authorization.')
		err.code = 'INVALID_REQUEST_OBJECT'
		err.statusCode = 400
		throw err
	}

	const role = authContext.userRole

	// 1. Regular User (Patient / Requester)
	if (role === 'USER') {
		const requesterId = request.requesterUserId ? request.requesterUserId.toString() : null
		const currentUserId = authContext.user._id ? authContext.user._id.toString() : null

		if (!requesterId || !currentUserId || requesterId !== currentUserId) {
			// Anti-enumeration security: return 404 REQUEST_NOT_FOUND instead of 403 ACCESS_DENIED
			// to prevent request existence disclosure, while maintaining internal audit flags.
			const err = new Error('Emergency blood request was not found.')
			err.code = 'REQUEST_NOT_FOUND'
			err.statusCode = 404
			err.isAuthorizationDenial = true
			err.internalCode = 'ACCESS_DENIED'
			throw err
		}

		return {
			isAuthorized: true,
			authorizedRole: 'USER',
			isCreator: true,
		}
	}

	// 2. System Administrator
	if (role === 'ADMIN') {
		if (authContext.user.status === false) {
			const err = new Error('Account is deactivated or suspended.')
			err.code = 'ACCOUNT_DEACTIVATED'
			err.statusCode = 401
			throw err
		}

		return {
			isAuthorized: true,
			authorizedRole: 'ADMIN',
			isAdministrator: true,
		}
	}

	// 3. Blood Bank Institutional Account
	if (role === 'BLOODBANK') {
		const bankId = authContext.user._id ? authContext.user._id.toString() : null
		const matchedBankIds = Array.isArray(request.matchedBloodbankIds)
			? request.matchedBloodbankIds.map((id) => id.toString())
			: []

		if (!bankId || !matchedBankIds.includes(bankId)) {
			// Anti-enumeration security: return 404 REQUEST_NOT_FOUND to unassigned facilities
			const err = new Error('Emergency blood request was not found.')
			err.code = 'REQUEST_NOT_FOUND'
			err.statusCode = 404
			err.isAuthorizationDenial = true
			err.internalCode = 'ACCESS_DENIED'
			throw err
		}

		return {
			isAuthorized: true,
			authorizedRole: 'BLOODBANK',
			bloodbankId: bankId,
		}
	}

	// 4. Blood Bank Staff Account
	if (role === 'STAFF') {
		const staff = authContext.staff || authContext.user
		if (!staff || staff.status !== 'Active') {
			const err = new Error('Staff account is inactive or suspended.')
			err.code = 'STAFF_INACTIVE'
			err.statusCode = 401
			throw err
		}

		const owningBankId = staff.bloodbankId ? staff.bloodbankId.toString() : null
		const matchedBankIds = Array.isArray(request.matchedBloodbankIds)
			? request.matchedBloodbankIds.map((id) => id.toString())
			: []

		if (!owningBankId || !matchedBankIds.includes(owningBankId)) {
			// Anti-enumeration security: return 404 REQUEST_NOT_FOUND to unassigned staff
			const err = new Error('Emergency blood request was not found.')
			err.code = 'REQUEST_NOT_FOUND'
			err.statusCode = 404
			err.isAuthorizationDenial = true
			err.internalCode = 'ACCESS_DENIED'
			throw err
		}

		return {
			isAuthorized: true,
			authorizedRole: 'STAFF',
			bloodbankId: owningBankId,
			staffId: staff._id ? staff._id.toString() : null,
		}
	}

	// 5. Unrecognized or Unsupported Role
	const err = new Error('Emergency blood request was not found.')
	err.code = 'REQUEST_NOT_FOUND'
	err.statusCode = 404
	err.isAuthorizationDenial = true
	err.internalCode = 'ACCESS_DENIED'
	throw err
}

/**
 * Derives presumptive clinical immunohematology compatibility for an emergency blood request.
 * Integrates directly with compatibilityEngine.getCompatibleDonorGroups without duplicating the clinical matrix.
 *
 * Supported Components:
 * - Whole_Blood: Strictly ABO and Rh(D) identical only. Broader component compatibility rules are excluded.
 * - Packed_Red_Blood_Cells: Standard reciprocal antibody matching (anti-A, anti-B) and Rh(D) concordance.
 * - Fresh_Frozen_Plasma: Acellular product; inverse ABO matching; Rh is non-immunogenic.
 * - Platelet_Concentrate: ABO-identical preferred; out-of-group isohemagglutinins & Rh alloimmunization advisories.
 * - Cryoprecipitate: Low plasma volume; identical preferred; non-identical allocations flag MO review.
 *
 * Clinical Governance Invariants:
 * - isAuthoritativeClinicalDecision: false
 * - isPresumptiveImmunohematologyCheck: true
 * - cannotAuthorizeDispatch: true
 * - cannotIssuePrescriptionOrOrder: true
 * - requiresLaboratoryCrossmatch: true
 *
 * @param {Object} request - Validated EmergencyBloodRequest document or object
 * @returns {Object} Structured clinical compatibility descriptor
 */
function deriveRequestCompatibility(request) {
	if (!request || typeof request !== 'object') {
		const err = new Error('Invalid emergency request: document or object is required for compatibility derivation.')
		err.code = 'INVALID_REQUEST_OBJECT'
		err.statusCode = 400
		throw err
	}

	const recipientGroup = request.requiredBloodGroup
	if (!recipientGroup || typeof recipientGroup !== 'string' || !recipientGroup.trim()) {
		const err = new Error('Emergency request is missing mandatory requiredBloodGroup specification.')
		err.code = 'INVALID_BLOOD_GROUP'
		err.statusCode = 400
		throw err
	}

	const componentType = request.requiredComponent
	if (!componentType || typeof componentType !== 'string' || !componentType.trim()) {
		const err = new Error('Emergency request is missing mandatory requiredComponent specification.')
		err.code = 'UNSUPPORTED_COMPONENT_TYPE'
		err.statusCode = 400
		throw err
	}

	// Validate and parse blood group; throws UNRECOGNIZED_BLOOD_GROUP (400) if invalid
	const parsedRecipient = parseBloodGroup(recipientGroup.trim())

	// Delegate to compatibilityEngine without duplicating the clinical matrix
	// Throws UNSUPPORTED_COMPONENT_TYPE (400) if component is unrecognized
	const compatResult = getCompatibleDonorGroups({
		recipientGroup: parsedRecipient.raw,
		componentType: componentType.trim(),
	})

	const preferredGroup = compatResult.preferredGroup
	const compatibleGroups = compatResult.compatibleGroups
	const alternateGroups = compatResult.alternateGroups || compatibleGroups.filter((g) => g !== preferredGroup)
	const hasCompatibleAlternatives = alternateGroups.length > 0

	// Compile component-specific warnings and advisories
	const warnings = []

	if (componentType === 'Whole_Blood') {
		warnings.push(
			'Whole Blood: Strictly ABO and Rh(D) identical transfusion required. Broader component compatibility rules are strictly prohibited for whole blood.'
		)
	} else if (componentType === 'Platelet_Concentrate') {
		warnings.push(
			'Platelets: ABO-identical is clinically preferred for optimal count increment. Out-of-group platelets contain donor plasma isohemagglutinins and require Medical Officer sign-off.'
		)
		if (parsedRecipient.rh === 'Negative') {
			warnings.push(
				'Rh Cautious Notice: Transfusing Rh-positive platelets to an Rh-negative recipient carries trace RBC anti-D alloimmunization risk; evaluate anti-D immunoglobulin prophylaxis for females of childbearing potential (< 50 years).'
			)
		}
	} else if (componentType === 'Cryoprecipitate') {
		warnings.push(
			'Cryoprecipitate: Prepared from plasma. ABO-identical is clinically preferred. Non-identical cryoprecipitate requires Medical Officer review per NBTC Sec. G-4.1 recommendations.'
		)
	}

	const requiresMedicalOfficerApproval = Boolean(
		compatResult.governance?.requiresMedicalOfficerApprovalForAlternatives && hasCompatibleAlternatives
	)

	return {
		recipientGroup: parsedRecipient.raw,
		recipientFormatted: parsedRecipient.formatted,
		componentType: compatResult.componentType,
		preferredGroup,
		compatibleGroups,
		alternateGroups,
		hasCompatibleAlternatives,
		requiresMedicalOfficerApproval,
		clinicalRationale: compatResult.clinicalRationale,
		unresolvedInstitutionalDecision: compatResult.unresolvedInstitutionalDecision || null,
		warnings,
		governance: {
			ruleVersion: compatResult.governance.ruleVersion,
			clinicalAuthority: compatResult.governance.clinicalAuthority,
			isAuthoritativeClinicalDecision: false,
			isPresumptiveImmunohematologyCheck: true,
			cannotAuthorizeDispatch: true,
			cannotIssuePrescriptionOrOrder: true,
			requiresLaboratoryCrossmatch: true,
			requiresMedicalOfficerApprovalForAlternatives: Boolean(
				compatResult.governance.requiresMedicalOfficerApprovalForAlternatives
			),
			disclaimer: compatResult.governance.disclaimer,
			clinicalSafetyNotice:
				'Compatibility matching is an algorithmic presumptive guide only. Pre-donation screening, haemoglobin assessment, physical examination, TTI screening, and laboratory crossmatching are mandatory clinical safety prerequisites prior to blood issuance.',
			statutoryNotice:
				'Compatibility matching is an algorithmic presumptive guide only. Pre-donation screening, haemoglobin assessment, physical examination, TTI screening, and laboratory crossmatching are mandatory prior to blood issuance under NBTC Standards.',
		},
	}
}

/**
 * Composite validator: Resolves, authorizes, validates lifecycle, checks shortfall integrity,
 * and derives presumptive immunohematology compatibility for an emergency blood request.
 * Completely read-only with zero database side-effects.
 *
 * Security Pipeline Sequence (Information-Disclosure Prevention):
 * 1. Resolution: Safely resolve request document by ObjectId or requestNumber.
 * 2. Authorization: Immediately enforce BOLA/IDOR authorization BEFORE validating lifecycle
 *    or shortfall invariants. This guarantees that unauthorized callers cannot probe or infer
 *    private request states (e.g. pending verification, expired, cancelled, or data anomalies).
 * 3. Lifecycle Validation: Enforce Verified-only status, temporal validity (expiresAt > now),
 *    and non-terminal status.
 * 4. Shortfall Integrity: Validate non-negative quantities, reservation count match,
 *    and calculate unmet demand.
 * 5. Compatibility Integration: Derive presumptive clinical compatibility for the requested component.
 *
 * @param {string|mongoose.Types.ObjectId} identifier
 * @param {Object} authContext - { user, userRole, staff }
 * @param {Object} [options]
 * @param {Date} [options.now=new Date()]
 * @returns {Promise<Object>} { request, shortfall, authResult, lifecycleResult, compatibility }
 */
async function validateAndAuthorizeEmergencyRequest(identifier, authContext, { now = new Date() } = {}) {
	const request = await resolveEmergencyRequest(identifier)
	const authResult = authorizeRequestAccess(request, authContext)
	const lifecycleResult = validateRequestLifecycle(request, { now })
	const shortfall = validateShortfallIntegrity(request)
	const compatibility = deriveRequestCompatibility(request)

	return {
		request,
		shortfall,
		authResult,
		lifecycleResult,
		compatibility,
	}
}

// ============================================================================
// SUB-MILESTONE 4.3.3.3: DUAL-STREAM CANDIDATE DISCOVERY & 128-BIT HMAC ENGINE
// ============================================================================

const crypto = require('crypto')
const { EmergencyDonorProfile } = require('./emergencyDonorProfileModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const stockService = require('../BloodStock/stockService')
const { calculateHaversineDistanceKm, isValidCoordinate } = require('./geoValidation')

/**
 * Escapes special regex characters for safe administrative searches.
 * Prevents regex injection and ReDoS vulnerabilities.
 *
 * @param {string} text
 * @returns {string}
 */
function escapeRegex(text) {
	if (!text || typeof text !== 'string') return ''
	return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

/**
 * Validates dedicated HMAC cryptographic configuration.
 *
 * Fail-Closed Invariants:
 * 1. Must be sourced from EMERGENCY_HMAC_SECRET.
 * 2. Minimum length of 32 characters.
 * 3. Never falls back to JWT_SECRET or other secrets.
 * 4. Never logs or leaks the secret in error messages.
 *
 * @param {string} secret
 * @returns {boolean}
 */
function validateHmacConfiguration(secret) {
	if (!secret || typeof secret !== 'string' || secret.length < 32) {
		const err = new Error(
			'Cryptographic configuration failure: EMERGENCY_HMAC_SECRET is mandatory and must be at least 32 characters.'
		)
		err.code = 'HMAC_CONFIG_INVALID'
		err.statusCode = 500
		throw err
	}
	return true
}

/**
 * Derives a 128-bit truncated keyed HMAC-SHA256 candidate reference for a donor.
 *
 * Specification:
 * - Secret: EMERGENCY_HMAC_SECRET (min 32 chars).
 * - Keyed input: `${requestId.toString()}:${donorId.toString()}`.
 * - Digest: 128-bit truncated (16 bytes = 32 hex characters).
 * - Format: 'DNR-' followed by 32 uppercase hex characters (`DNR-[0-9A-F]{32}`).
 * - Deterministic: Stable for identical donor, request, and key.
 * - Security: candidateRef is an opaque pseudonym, NOT an authorization credential.
 *
 * @param {string|mongoose.Types.ObjectId} requestId
 * @param {string|mongoose.Types.ObjectId} donorId
 * @param {string} [secret=process.env.EMERGENCY_HMAC_SECRET]
 * @returns {string}
 */
function deriveCandidateReference(requestId, donorId, secret = process.env.EMERGENCY_HMAC_SECRET) {
	validateHmacConfiguration(secret)

	if (!requestId || !donorId) {
		const err = new Error('Both requestId and donorId are required to derive candidate reference.')
		err.code = 'INVALID_HMAC_INPUT'
		err.statusCode = 400
		throw err
	}

	const message = `${requestId.toString()}:${donorId.toString()}`
	const digest = crypto
		.createHmac('sha256', secret)
		.update(message)
		.digest('hex')
		.slice(0, 32)
		.toUpperCase()

	return `DNR-${digest}`
}

/**
 * Verifies a donor candidate reference under the active key and optional previous key during rotation.
 *
 * Dual-Key Rotation Protocol:
 * - Checks against EMERGENCY_HMAC_SECRET (active key).
 * - If check fails, checks against EMERGENCY_HMAC_SECRET_PREVIOUS (grace window).
 * - Fails closed if current secret is invalid or missing.
 *
 * @param {string} candidateRef
 * @param {string|mongoose.Types.ObjectId} requestId
 * @param {string|mongoose.Types.ObjectId} donorId
 * @param {Object} [options]
 * @param {string} [options.secret=process.env.EMERGENCY_HMAC_SECRET]
 * @param {string} [options.previousSecret=process.env.EMERGENCY_HMAC_SECRET_PREVIOUS]
 * @returns {{ isValid: boolean, keyVersion: 'current'|'previous'|null }}
 */
/**
 * Verifies a donor candidate reference under the active key and an explicitly bounded previous-key grace window.
 *
 * Dual-Key Rotation Protocol & Bounded Grace Period:
 * 1. Checks candidate reference against EMERGENCY_HMAC_SECRET (active key).
 * 2. Active-key verification MUST be preserved independently of previous-key grace window status.
 * 3. If check does not match, checks against EMERGENCY_HMAC_SECRET_PREVIOUS ONLY IF:
 *    - previousSecret is configured and >= 32 characters.
 *    - BOTH previousKeyStartsAt and previousKeyExpiresAt are explicitly configured.
 *    - Both timestamps are valid and satisfy previousKeyStartsAt < previousKeyExpiresAt.
 *    - referenceNow >= previousKeyStartsAt AND referenceNow < previousKeyExpiresAt.
 * 4. Fails closed: Missing, malformed, or inconsistent rotation configuration strictly blocks
 *    previous-key verification to prevent indefinite acceptance of rotated credentials.
 * 5. Rejection Boundary: Exact expiry instant (referenceNow >= previousKeyExpiresAt) is strictly rejected.
 *
 * @param {string} candidateRef
 * @param {string|mongoose.Types.ObjectId} requestId
 * @param {string|mongoose.Types.ObjectId} donorId
 * @param {Object} [options]
 * @param {string} [options.secret=process.env.EMERGENCY_HMAC_SECRET]
 * @param {string} [options.previousSecret=process.env.EMERGENCY_HMAC_SECRET_PREVIOUS]
 * @param {Date|string} [options.previousKeyStartsAt=process.env.EMERGENCY_HMAC_PREVIOUS_KEY_STARTS_AT]
 * @param {Date|string} [options.previousKeyExpiresAt=process.env.EMERGENCY_HMAC_PREVIOUS_KEY_EXPIRY]
 * @param {Date} [options.now=new Date()] - Injectable clock for deterministic testing
 * @returns {{ isValid: boolean, keyVersion: 'current'|'previous'|null, rotationStatus?: string }}
 */
function verifyCandidateReference(
	candidateRef,
	requestId,
	donorId,
	{
		secret = process.env.EMERGENCY_HMAC_SECRET,
		previousSecret = process.env.EMERGENCY_HMAC_SECRET_PREVIOUS,
		previousKeyStartsAt = process.env.EMERGENCY_HMAC_PREVIOUS_KEY_STARTS_AT,
		previousKeyExpiresAt = process.env.EMERGENCY_HMAC_PREVIOUS_KEY_EXPIRY,
		now = new Date(),
	} = {}
) {
	if (!candidateRef || typeof candidateRef !== 'string' || !/^DNR-[0-9A-F]{32}$/.test(candidateRef)) {
		return { isValid: false, keyVersion: null }
	}

	if (!requestId || !donorId) {
		return { isValid: false, keyVersion: null }
	}

	// 1. Verify with current active key (fails closed if secret is missing or < 32 characters)
	// Active-key verification MUST be preserved independently of previous-key grace window.
	validateHmacConfiguration(secret)
	const expectedCurrent = deriveCandidateReference(requestId, donorId, secret)
	if (candidateRef === expectedCurrent) {
		return { isValid: true, keyVersion: 'current' }
	}

	// 2. Evaluate previous key rotation grace period if previous key is configured
	if (previousSecret && typeof previousSecret === 'string') {
		// Previous secret must satisfy the same 32-character minimum length constraint
		if (previousSecret.length < 32) {
			return { isValid: false, keyVersion: null, rotationStatus: 'INVALID_PREVIOUS_SECRET' }
		}

		// Require BOTH previousKeyStartsAt AND previousKeyExpiresAt whenever previousSecret is configured.
		// Missing or incomplete rotation configuration strictly fails closed.
		if (!previousKeyStartsAt) {
			return { isValid: false, keyVersion: null, rotationStatus: 'MISSING_GRACE_START' }
		}
		if (!previousKeyExpiresAt) {
			return { isValid: false, keyVersion: null, rotationStatus: 'MISSING_GRACE_EXPIRY' }
		}

		// Require valid timestamps
		const startDate =
			previousKeyStartsAt instanceof Date ? previousKeyStartsAt : new Date(previousKeyStartsAt)
		if (isNaN(startDate.getTime())) {
			return { isValid: false, keyVersion: null, rotationStatus: 'INVALID_GRACE_STARTS_AT' }
		}

		const expiryDate =
			previousKeyExpiresAt instanceof Date ? previousKeyExpiresAt : new Date(previousKeyExpiresAt)
		if (isNaN(expiryDate.getTime())) {
			return { isValid: false, keyVersion: null, rotationStatus: 'INVALID_GRACE_EXPIRY' }
		}

		// Require consistent range: previousKeyStartsAt must be strictly before previousKeyExpiresAt
		if (startDate.getTime() >= expiryDate.getTime()) {
			return { isValid: false, keyVersion: null, rotationStatus: 'INCONSISTENT_ROTATION_CONFIG' }
		}

		const referenceNow = now instanceof Date ? now : new Date(now)
		if (isNaN(referenceNow.getTime())) {
			return { isValid: false, keyVersion: null, rotationStatus: 'INVALID_REFERENCE_CLOCK' }
		}

		// Verify start boundary: referenceNow < startDate
		// Exact start instant (referenceNow.getTime() === startDate.getTime()) is valid and accepted
		if (referenceNow.getTime() < startDate.getTime()) {
			return { isValid: false, keyVersion: null, rotationStatus: 'GRACE_PERIOD_NOT_STARTED' }
		}

		// Verify expiry boundary: Reject previous-key verification when now >= previousKeyExpiresAt
		// Exact expiry instant (referenceNow.getTime() === expiryDate.getTime()) MUST be rejected
		if (referenceNow.getTime() >= expiryDate.getTime()) {
			return { isValid: false, keyVersion: null, rotationStatus: 'GRACE_PERIOD_EXPIRED' }
		}

		// During active grace window [startDate, expiryDate): verify under previous key
		const expectedPrevious = deriveCandidateReference(requestId, donorId, previousSecret)
		if (candidateRef === expectedPrevious) {
			return { isValid: true, keyVersion: 'previous' }
		}
	}

	return { isValid: false, keyVersion: null }
}

/**
 * Derives a deterministic, opaque public discovery reference for a blood bank facility.
 * Format: 'BB-' followed by 12 uppercase hexadecimal characters.
 *
 * @param {string|mongoose.Types.ObjectId} bloodbankId
 * @returns {string}
 */
function derivePublicFacilityReference(bloodbankId) {
	if (!bloodbankId) return ''
	const rawId = bloodbankId.toString()
	const hash = crypto
		.createHash('sha256')
		.update(`namma_blood_facility_public_ref_${rawId}`)
		.digest('hex')
		.slice(0, 12)
		.toUpperCase()
	return `BB-${hash}`
}

/**
 * Explicit allowlist sanitizer for donor candidates.
 * Strictly guarantees that internal ObjectIds, user IDs, exact coordinates,
 * phone numbers, email addresses, and push subscriptions are never exposed.
 *
 * @param {Object} donor - Raw donor document
 * @param {Object} meta - Derived metadata
 * @returns {Object} Sanitized donor candidate
 */
function sanitizeDonorCandidate(donor, meta) {
	return {
		candidateRef: meta.candidateRef,
		bloodGroup: donor.bloodGroup,
		matchQuality: meta.matchQuality,
		classification: meta.classification,
		approxDistanceKm: meta.approxDistanceKm,
		withinDonorTravelRadius: meta.withinDonorTravelRadius,
		maxTravelDistanceKm: donor.maxTravelDistanceKm || 15,
		availabilityStatus: donor.availabilityStatus,
		clinicalEligibilityStatus: donor.clinicalEligibilityStatus,
		clinicalNotice: meta.clinicalNotice,
		city: donor.city,
		state: donor.state,
		rankingExplanation: meta.rankingExplanation,
	}
}

/**
 * Explicit allowlist sanitizer for blood bank candidates.
 * Strictly guarantees that internal ObjectIds, passwords, tokens, DINs,
 * and private staff data are never exposed.
 *
 * Privacy Guarantees:
 * - Address: Contains only official institutional facility premises (address1, address2).
 * - Contact numbers (phoneNo1, phoneNo2): Official blood bank institutional helpline/reception lines.
 * - Email: Official blood bank institutional contact email.
 * - Excludes: Personal staff names, mobile numbers, passwords, tokens, and internal database keys.
 *
 * @param {Object} bank - Raw bloodbank document
 * @param {Object} meta - Derived metadata
 * @returns {Object} Sanitized blood bank candidate
 */
function sanitizeBloodBankCandidate(bank, meta) {
	return {
		facilityRef: meta.facilityRef,
		bloodbankName: bank.bloodbankName || '',
		category: bank.category || '',
		address: [bank.address1, bank.address2].filter(Boolean).join(', '),
		city: bank.city || '',
		state: bank.state || '',
		pinCode: bank.pinCode || null,
		phoneNo1: bank.phoneNo1 || '',
		phoneNo2: bank.phoneNo2 || '',
		email: bank.email || '',
		operatingStatus: bank.status !== false ? 'Active' : 'Inactive',
		approxDistanceKm: meta.approxDistanceKm,
		inventoryTrustStatus: meta.inventoryTrustStatus,
		verifiedUnitsAvailable: meta.verifiedUnitsAvailable,
		availableComponentCategories: meta.availableComponentCategories || [],
		matchQuality: meta.matchQuality,
		inventoryNotice: meta.inventoryNotice,
		rankingExplanation: meta.rankingExplanation,
	}
}

/**
 * Multi-attribute ranking engine for donor candidates.
 *
 * Ranking Hierarchy:
 * 1. Primary: Clinical Evaluation Status (Potential_Donor_Match before Pending_Clinical_Evaluation).
 * 2. Secondary: Immunohematological Match Quality (Identical before Compatible_Alternative).
 * 3. Tertiary: Travel Radius Feasibility (withinDonorTravelRadius true before false).
 * 4. Quaternary: Geographic Distance (approxDistanceKm ascending; non-null before null).
 * 5. Deterministic Tie-Breaker: candidateRef ascending string comparison.
 *
 * Invariant: Clinical eligibility strictly supersedes geographic proximity.
 * Under no circumstances can a Pending_Clinical_Evaluation donor outrank a Clinically_Cleared
 * donor solely due to shorter travel distance.
 *
 * Recommendation-Only: Ranking is an informational decision-support recommendation and
 * does not authorize donor phlebotomy, blood collection, or transfusion.
 *
 * @param {Array<Object>} donors
 * @returns {Array<Object>} Sorted donors array
 */
function rankDonorCandidates(donors) {
	return [...donors].sort((a, b) => {
		// 1. Clinical Status: Potential_Donor_Match (1) before Pending_Clinical_Evaluation (2)
		const classScoreA = a.classification === 'Potential_Donor_Match' ? 1 : 2
		const classScoreB = b.classification === 'Potential_Donor_Match' ? 1 : 2
		if (classScoreA !== classScoreB) return classScoreA - classScoreB

		// 2. Immunohematological Match Quality: Identical (1) before Compatible_Alternative (2)
		const matchScoreA = a.matchQuality === 'Identical' ? 1 : 2
		const matchScoreB = b.matchQuality === 'Identical' ? 1 : 2
		if (matchScoreA !== matchScoreB) return matchScoreA - matchScoreB

		// 3. Travel feasibility: withinDonorTravelRadius true (1) before false (2)
		const travelScoreA = a.withinDonorTravelRadius === true ? 1 : (a.withinDonorTravelRadius === false ? 2 : 3)
		const travelScoreB = b.withinDonorTravelRadius === true ? 1 : (b.withinDonorTravelRadius === false ? 2 : 3)
		if (travelScoreA !== travelScoreB) return travelScoreA - travelScoreB

		// 4. Geographic distance: approxDistanceKm ascending
		if (a.approxDistanceKm !== null && b.approxDistanceKm !== null) {
			if (a.approxDistanceKm !== b.approxDistanceKm) {
				return a.approxDistanceKm - b.approxDistanceKm
			}
		} else if (a.approxDistanceKm !== null) {
			return -1
		} else if (b.approxDistanceKm !== null) {
			return 1
		}

		// 5. Deterministic tie-breaker: candidateRef ascending string comparison
		return (a.candidateRef || '').localeCompare(b.candidateRef || '')
	})
}

/**
 * Multi-attribute ranking engine for blood bank candidates.
 *
 * Ranking Hierarchy:
 * 1. Primary: Inventory Trust Status (Verified_Bloodbank_Stock_Match before No_Matching_Stock before Inventory_Unverified).
 * 2. Secondary: Immunohematological Match Quality (Identical before Compatible_Alternative).
 * 3. Tertiary: Shortfall Coverage & Verified Quantity (Full ticket coverage first, then verifiedUnitsAvailable descending).
 * 4. Quaternary: Geographic Distance (approxDistanceKm ascending; non-null before null).
 * 5. Deterministic Tie-Breaker: facilityRef ascending string comparison.
 *
 * Invariant: Unverified inventory can NEVER be ranked as confirmed stock.
 *
 * @param {Array<Object>} bloodbanks
 * @param {Object} [options]
 * @param {number} [options.unmetUnits] - Optional request shortfall demand
 * @returns {Array<Object>} Sorted bloodbanks array
 */
function rankBloodBankCandidates(bloodbanks, { unmetUnits } = {}) {
	return [...bloodbanks].sort((a, b) => {
		// 1. Inventory Trust Status
		const trustOrder = {
			Verified_Bloodbank_Stock_Match: 1,
			No_Matching_Stock: 2,
			Inventory_Unverified: 3,
		}
		const trustA = trustOrder[a.inventoryTrustStatus] || 4
		const trustB = trustOrder[b.inventoryTrustStatus] || 4
		if (trustA !== trustB) return trustA - trustB

		// 2 & 3. For verified stock matches: match quality, shortfall capacity, and verifiedUnitsAvailable descending
		if (
			a.inventoryTrustStatus === 'Verified_Bloodbank_Stock_Match' &&
			b.inventoryTrustStatus === 'Verified_Bloodbank_Stock_Match'
		) {
			const matchScoreA = a.matchQuality === 'Identical' ? 1 : 2
			const matchScoreB = b.matchQuality === 'Identical' ? 1 : 2
			if (matchScoreA !== matchScoreB) return matchScoreA - matchScoreB

			const unitsA = typeof a.verifiedUnitsAvailable === 'number' ? a.verifiedUnitsAvailable : 0
			const unitsB = typeof b.verifiedUnitsAvailable === 'number' ? b.verifiedUnitsAvailable : 0

			// Shortfall consideration: facility able to fulfill entire ticket in a single order ranks higher
			if (typeof unmetUnits === 'number' && unmetUnits > 0) {
				const fullA = unitsA >= unmetUnits ? 1 : 2
				const fullB = unitsB >= unmetUnits ? 1 : 2
				if (fullA !== fullB) return fullA - fullB
			}

			if (unitsA !== unitsB) return unitsB - unitsA
		}

		// 4. Geographic distance: approxDistanceKm ascending
		if (a.approxDistanceKm !== null && b.approxDistanceKm !== null) {
			if (a.approxDistanceKm !== b.approxDistanceKm) {
				return a.approxDistanceKm - b.approxDistanceKm
			}
		} else if (a.approxDistanceKm !== null) {
			return -1
		} else if (b.approxDistanceKm !== null) {
			return 1
		}

		// 5. Deterministic tie-breaker: facilityRef ascending string comparison
		return (a.facilityRef || '').localeCompare(b.facilityRef || '')
	})
}

/**
 * Multi-attribute cross-stream ranking engine across all candidate types.
 *
 * CLINICAL & OPERATIONAL JUSTIFICATION FOR GLOBAL TIERS:
 *
 * Tier 1: Verified_Bloodbank_Stock_Match
 * - Clinical Rationale: These units are already collected, fully screened for all 5 mandatory TTIs
 *   (HIV, HBV, HCV, Syphilis, Malaria Non_Reactive), verified by a qualified Medical Officer,
 *   and held in certified cold-chain refrigeration. Because laboratory testing and safety clearance
 *   are already completed, verified inventory represents a higher-certainty supply stream than live
 *   donor mobilization.
 * - Clinical & Institutional Safeguard Notice: Discovery and ranking do NOT authorize reservation,
 *   issuance, dispatch, or transfusion. Verified inventory cannot be dispatched immediately without
 *   formal blood bank order, recipient-unit crossmatching, and institutional release verification.
 *   All applicable clinical and institutional procedures remain mandatory.
 *
 * Tier 2: Potential_Donor_Match (Clinically_Cleared)
 * - Clinical Rationale: Clinically cleared voluntary donors with historical Medical Officer review on record.
 *   While they require on-site pre-donation physical re-examination, hemoglobin evaluation, rapid TTI screening,
 *   and blood collection, their verified clinical clearance makes them the highest-reliability live donor stream.
 *
 * Tier 3: Pending_Clinical_Evaluation
 * - Clinical Rationale: Prospective donors who have self-reported availability intent but have NEVER undergone
 *   qualified clinical review. Surfaced strictly as prospects with prominent mandatory screening notices.
 *   Cannot outrank Tier 1 or Tier 2 candidates regardless of proximity.
 *
 * Tier 4: No_Matching_Stock
 * - Facilities with active traceable inventory on the platform, but confirmed zero eligible units for this filter.
 *
 * Tier 5: Inventory_Unverified
 * - Facilities where traceable inventory is uninitialized, failed, or malformed.
 *   Strictly reported with verifiedUnitsAvailable: null and NEVER represented as confirmed stock.
 *
 * Request Urgency & Shortfall:
 * - When unmetUnits > 0, facilities offering complete ticket fulfillment (verifiedUnitsAvailable >= unmetUnits)
 *   are prioritized over partial quantities to minimize split dispatches and hospital logistics delays.
 *
 * Deterministic Tie-Breaking & Recommendation-Only:
 * - Alphanumeric tie-breaking on candidateRef or facilityRef ensures deterministic ordering.
 * - Discovery and ranking do not authorize reservation, issuance, dispatch, or transfusion.
 *   All applicable clinical and institutional procedures remain mandatory.
 *
 * @param {Array<Object>} candidates
 * @param {Object} [options]
 * @param {number} [options.unmetUnits]
 * @returns {Array<Object>} Sorted unified candidates
 */
function rankCombinedCandidates(candidates, { unmetUnits } = {}) {
	return [...candidates].sort((a, b) => {
		const getTier = (c) => {
			if (c.inventoryTrustStatus === 'Verified_Bloodbank_Stock_Match') return 1
			if (c.classification === 'Potential_Donor_Match') return 2
			if (c.classification === 'Pending_Clinical_Evaluation') return 3
			if (c.inventoryTrustStatus === 'No_Matching_Stock') return 4
			return 5 // Inventory_Unverified
		}

		const tierA = getTier(a)
		const tierB = getTier(b)
		if (tierA !== tierB) return tierA - tierB

		// Match quality within tier (Identical before Compatible_Alternative)
		const matchScoreA = a.matchQuality === 'Identical' ? 1 : 2
		const matchScoreB = b.matchQuality === 'Identical' ? 1 : 2
		if (matchScoreA !== matchScoreB) return matchScoreA - matchScoreB

		// Secondary attribute within tier
		if (tierA === 1) {
			const unitsA = typeof a.verifiedUnitsAvailable === 'number' ? a.verifiedUnitsAvailable : 0
			const unitsB = typeof b.verifiedUnitsAvailable === 'number' ? b.verifiedUnitsAvailable : 0

			// Shortfall demand consideration: single-facility complete fulfillment preferred
			if (typeof unmetUnits === 'number' && unmetUnits > 0) {
				const fullA = unitsA >= unmetUnits ? 1 : 2
				const fullB = unitsB >= unmetUnits ? 1 : 2
				if (fullA !== fullB) return fullA - fullB
			}

			if (unitsA !== unitsB) return unitsB - unitsA
		} else if (tierA === 2 || tierA === 3) {
			const travelScoreA = a.withinDonorTravelRadius === true ? 1 : 2
			const travelScoreB = b.withinDonorTravelRadius === true ? 1 : 2
			if (travelScoreA !== travelScoreB) return travelScoreA - travelScoreB
		}

		// Distance ascending (proximity is strictly secondary to clinical/inventory suitability)
		if (a.approxDistanceKm !== null && b.approxDistanceKm !== null) {
			if (a.approxDistanceKm !== b.approxDistanceKm) {
				return a.approxDistanceKm - b.approxDistanceKm
			}
		} else if (a.approxDistanceKm !== null) {
			return -1
		} else if (b.approxDistanceKm !== null) {
			return 1
		}

		// Deterministic tie-breaker
		const refA = a.candidateRef || a.facilityRef || ''
		const refB = b.candidateRef || b.facilityRef || ''
		return refA.localeCompare(refB)
	})
}

/**
 * Discovers nearby compatible emergency blood donors for an emergency request.
 *
 * Rules:
 * 1. Matches compatible donor groups derived in Sub-Milestone 4.3.3.2.
 * 2. Excludes temporarily and permanently deferred donors.
 * 3. Excludes donors with active cooldown periods (eligibleToDonateAfter > now).
 * 4. Excludes busy/unavailable donors (availabilityStatus !== 'Ready' or isEmergencyDonor !== true).
 * 5. Generates 128-bit truncated keyed HMAC candidateRef (DNR-...).
 * 6. Distinguishes Clinically_Cleared (Potential_Donor_Match) from Pending_Clinical_Evaluation.
 * 7. Applies strict allowlist response sanitization.
 *
 * @param {Object} request - Validated EmergencyBloodRequest document
 * @param {Object} compatibility - Presumptive compatibility descriptor
 * @param {Object} [options]
 * @param {number} [options.radiusKm=15]
 * @param {Date} [options.now=new Date()]
 * @param {string} [options.hmacSecret=process.env.EMERGENCY_HMAC_SECRET]
 * @param {number} [options.donorPage=1]
 * @param {number} [options.donorLimit=10]
 * @returns {Promise<Object>} { pagination, data }
 */
async function discoverDonorCandidates(request, compatibility, options = {}) {
	const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date())
	const hmacSecret = options.hmacSecret || process.env.EMERGENCY_HMAC_SECRET

	validateHmacConfiguration(hmacSecret)

	const hasCoords =
		request.location &&
		Array.isArray(request.location.coordinates) &&
		request.location.coordinates.length === 2 &&
		isValidCoordinate(request.location.coordinates)

	const radiusKm = Math.max(1, Math.min(50, Number(options.radiusKm) || 15))

	const donorQuery = {
		isEmergencyDonor: true,
		availabilityStatus: 'Ready',
		bloodGroup: { $in: compatibility.compatibleGroups },
		clinicalEligibilityStatus: {
			$nin: ['Temporarily_Deferred', 'Permanently_Deferred'],
		},
		$or: [
			{ eligibleToDonateAfter: null },
			{ eligibleToDonateAfter: { $lte: now } },
		],
	}

	if (hasCoords) {
		donorQuery.location = {
			$geoWithin: {
				$centerSphere: [request.location.coordinates, radiusKm / 6371],
			},
		}
	} else {
		const fallbackCity = request.hospitalCity || request.city
		const fallbackState = request.hospitalState || request.state
		if (fallbackCity && typeof fallbackCity === 'string' && fallbackCity.trim()) {
			donorQuery.city = { $regex: new RegExp(`^${escapeRegex(fallbackCity.trim())}$`, 'i') }
		}
		if (fallbackState && typeof fallbackState === 'string' && fallbackState.trim()) {
			donorQuery.state = { $regex: new RegExp(`^${escapeRegex(fallbackState.trim())}$`, 'i') }
		}
	}

	const donorDocs = await EmergencyDonorProfile.find(donorQuery).lean()

	const mappedDonors = donorDocs.map((donor) => {
		let approxDistanceKm = null
		let withinDonorTravelRadius = null

		if (
			hasCoords &&
			donor.location &&
			Array.isArray(donor.location.coordinates) &&
			isValidCoordinate(donor.location.coordinates)
		) {
			approxDistanceKm = calculateHaversineDistanceKm(
				request.location.coordinates,
				donor.location.coordinates
			)
			withinDonorTravelRadius = approxDistanceKm <= (donor.maxTravelDistanceKm || 15)
		}

		const matchQuality =
			donor.bloodGroup === compatibility.preferredGroup ? 'Identical' : 'Compatible_Alternative'

		const classification =
			donor.clinicalEligibilityStatus === 'Clinically_Cleared'
				? 'Potential_Donor_Match'
				: 'Pending_Clinical_Evaluation'

		let clinicalNotice = ''
		if (classification === 'Potential_Donor_Match') {
			clinicalNotice =
				'Donor has historical Medical Officer review on record. Mandatory clinical safety notice: Pre-donation physical screening, hemoglobin testing, TTI screening, and laboratory crossmatching remain compulsory prior to blood collection.'
		} else {
			clinicalNotice =
				'Mandatory clinical safety notice: Prospective candidate with self-reported availability. Donor has not undergone qualified clinical review. Full pre-donation screening and TTI testing are required before donation.'
		}

		const candidateRef = deriveCandidateReference(request._id, donor._id, hmacSecret)

		const rankingExplanation =
			(matchQuality === 'Identical' ? 'ABO/Rh identical match' : 'Compatible alternative match') +
			` (${donor.bloodGroup}), ` +
			(classification === 'Potential_Donor_Match' ? 'historical clinical clearance' : 'pending clinical evaluation') +
			(approxDistanceKm !== null ? `, approx distance ${approxDistanceKm} km.` : ' (administrative location match).')

		return sanitizeDonorCandidate(donor, {
			candidateRef,
			matchQuality,
			classification,
			approxDistanceKm,
			withinDonorTravelRadius,
			clinicalNotice,
			rankingExplanation,
		})
	})

	const rankedDonors = rankDonorCandidates(mappedDonors)

	const page = Math.max(1, parseInt(options.donorPage || options.page, 10) || 1)
	const limit = Math.max(1, Math.min(50, parseInt(options.donorLimit || options.limit, 10) || 10))
	const totalCount = rankedDonors.length
	const totalPages = Math.ceil(totalCount / limit) || 1
	const paginatedData = rankedDonors.slice((page - 1) * limit, page * limit)

	return {
		pagination: {
			page,
			limit,
			totalCount,
			totalPages,
		},
		data: paginatedData,
	}
}

/**
 * Discovers nearby registered blood banks and queries traceable inventory.
 *
 * Rules:
 * 1. Surfacing only active blood banks (status: true).
 * 2. Uses stockService.getTraceableAvailableStock meeting all Phase 3 safety gates.
 * 3. Enforces exact 3-way inventory classification:
 *    - Verified_Bloodbank_Stock_Match: >= 1 verified units meeting all criteria.
 *    - No_Matching_Stock: breakdown.totalUnits > 0, but verified query returned 0 units.
 *    - Inventory_Unverified: query failure/malformed/no traceable platform records (verifiedUnitsAvailable: null).
 * 4. Applies strict allowlist response sanitization (facilityRef: BB-XXXXXXXXXXXX).
 * 5. Multi-attribute ranking prioritizing verified stock over unverified inventory.
 *
 * @param {Object} request - Validated EmergencyBloodRequest document
 * @param {Object} compatibility - Presumptive compatibility descriptor
 * @param {Object} [options]
 * @param {number} [options.radiusKm=15]
 * @param {Date} [options.now=new Date()]
 * @param {number} [options.bankPage=1]
 * @param {number} [options.bankLimit=10]
 * @returns {Promise<Object>} { pagination, data }
 */
async function discoverBloodBankCandidates(request, compatibility, options = {}) {
	const now = options.now instanceof Date ? options.now : (options.now ? new Date(options.now) : new Date())

	const hasCoords =
		request.location &&
		Array.isArray(request.location.coordinates) &&
		request.location.coordinates.length === 2 &&
		isValidCoordinate(request.location.coordinates)

	const radiusKm = Math.max(1, Math.min(50, Number(options.radiusKm) || 15))

	const bankQuery = { status: true }

	if (hasCoords) {
		bankQuery.location = {
			$geoWithin: {
				$centerSphere: [request.location.coordinates, radiusKm / 6371],
			},
		}
	} else {
		const fallbackCity = request.hospitalCity || request.city
		const fallbackState = request.hospitalState || request.state
		if (fallbackCity && typeof fallbackCity === 'string' && fallbackCity.trim()) {
			bankQuery.city = { $regex: new RegExp(`^${escapeRegex(fallbackCity.trim())}$`, 'i') }
		}
		if (fallbackState && typeof fallbackState === 'string' && fallbackState.trim()) {
			bankQuery.state = { $regex: new RegExp(`^${escapeRegex(fallbackState.trim())}$`, 'i') }
		}
	}

	const bloodbankDocs = await Bloodbank.find(bankQuery).lean()

	const mappedBanks = await Promise.all(
		bloodbankDocs.map(async (bank) => {
			let approxDistanceKm = null
			if (
				hasCoords &&
				bank.location &&
				Array.isArray(bank.location.coordinates) &&
				isValidCoordinate(bank.location.coordinates)
			) {
				approxDistanceKm = calculateHaversineDistanceKm(
					request.location.coordinates,
					bank.location.coordinates
				)
			}

			const facilityRef = derivePublicFacilityReference(bank._id)

			let inventoryTrustStatus = 'Inventory_Unverified'
			let verifiedUnitsAvailable = null
			let availableComponentCategories = []
			let matchQuality = null
			let inventoryNotice = ''
			let rankingExplanation = ''

			try {
				const breakdown = await stockService.getTraceableStatusBreakdown(bank._id, { now })

				if (
					!breakdown ||
					typeof breakdown !== 'object' ||
					typeof breakdown.totalUnits !== 'number' ||
					breakdown.totalUnits === 0
				) {
					inventoryTrustStatus = 'Inventory_Unverified'
					verifiedUnitsAvailable = null
					availableComponentCategories = []
					matchQuality = null
					inventoryNotice =
						'Traceable inventory records are not available or have not been initialized for this facility. Presence in discovery does not imply stock availability.'
					rankingExplanation =
						'Inventory unverified on platform' +
						(approxDistanceKm !== null ? `, approx distance ${approxDistanceKm} km.` : '.')
				} else {
					const [stockMap, distinctComponents] = await Promise.all([
						stockService.getTraceableAvailableStock(bank._id, {
							componentType: request.requiredComponent,
							now,
						}),
						stockService.getTraceableAvailableComponents(bank._id, {
							componentType: request.requiredComponent,
							now,
						}),
					])

					if (!stockMap || typeof stockMap !== 'object') {
						throw new Error('Malformed stock data returned from inventory service.')
					}

					availableComponentCategories = Array.isArray(distinctComponents) ? distinctComponents : []

					const preferredGroup = compatibility.preferredGroup
					const preferredUnits = Number(stockMap[preferredGroup]) || 0
					let totalCompatibleUnits = 0
					for (const grp of compatibility.compatibleGroups) {
						totalCompatibleUnits += Number(stockMap[grp]) || 0
					}

					if (preferredUnits > 0) {
						inventoryTrustStatus = 'Verified_Bloodbank_Stock_Match'
						matchQuality = 'Identical'
						verifiedUnitsAvailable = preferredUnits
						inventoryNotice =
							'Verified issue-eligible inventory meeting all mandatory clinical safety standards is available.'
						rankingExplanation = `Verified stock available (${preferredUnits} units), identical match (${preferredGroup})${approxDistanceKm !== null ? `, approx distance ${approxDistanceKm} km.` : '.'}`
					} else if (totalCompatibleUnits > 0) {
						inventoryTrustStatus = 'Verified_Bloodbank_Stock_Match'
						matchQuality = 'Compatible_Alternative'
						verifiedUnitsAvailable = totalCompatibleUnits
						inventoryNotice =
							'Verified issue-eligible inventory meeting all mandatory clinical safety standards is available (compatible alternative).'
						rankingExplanation = `Verified stock available (${totalCompatibleUnits} units), compatible alternative match${approxDistanceKm !== null ? `, approx distance ${approxDistanceKm} km.` : '.'}`
					} else {
						inventoryTrustStatus = 'No_Matching_Stock'
						matchQuality = null
						verifiedUnitsAvailable = 0
						inventoryNotice =
							'Inventory records verified. No matching units found for the requested group and component.'
						rankingExplanation = `Inventory verified, no matching stock currently available${approxDistanceKm !== null ? `, approx distance ${approxDistanceKm} km.` : '.'}`
					}
				}
			} catch (err) {
				// Fail-closed boundary: inventory failure MUST NEVER be treated as zero stock
				inventoryTrustStatus = 'Inventory_Unverified'
				verifiedUnitsAvailable = null
				matchQuality = null
				availableComponentCategories = []
				inventoryNotice =
					'Inventory verification service is temporarily unavailable for this facility. Presence in discovery does not imply stock availability.'
				rankingExplanation =
					'Inventory unverified on platform' +
					(approxDistanceKm !== null ? `, approx distance ${approxDistanceKm} km.` : '.')
			}

			return sanitizeBloodBankCandidate(bank, {
				facilityRef,
				approxDistanceKm,
				inventoryTrustStatus,
				verifiedUnitsAvailable,
				availableComponentCategories,
				matchQuality,
				inventoryNotice,
				rankingExplanation,
			})
		})
	)

	const unmetUnits =
		options.unmetUnits !== undefined
			? options.unmetUnits
			: typeof request.unitsRequested === 'number'
				? Math.max(
						0,
						request.unitsRequested -
							((Number(request.unitsReserved) || 0) + (Number(request.unitsFulfilled) || 0))
					)
				: undefined

	const rankedBanks = rankBloodBankCandidates(mappedBanks, { unmetUnits })

	const page = Math.max(1, parseInt(options.bankPage || options.page, 10) || 1)
	const limit = Math.max(1, Math.min(50, parseInt(options.bankLimit || options.limit, 10) || 10))
	const totalCount = rankedBanks.length
	const totalPages = Math.ceil(totalCount / limit) || 1
	const paginatedData = rankedBanks.slice((page - 1) * limit, page * limit)

	return {
		pagination: {
			page,
			limit,
			totalCount,
			totalPages,
		},
		data: paginatedData,
	}
}

/**
 * End-to-End Emergency Matching Engine:
 * Validates request, authorizes access, evaluates lifecycle and shortfall,
 * derives clinical compatibility, and discovers candidate donors and blood banks.
 * Completely read-only with zero database side-effects.
 *
 * @param {string|mongoose.Types.ObjectId} identifier
 * @param {Object} authContext - { user, userRole, staff }
 * @param {Object} [options]
 * @param {Date} [options.now=new Date()]
 * @param {string} [options.hmacSecret=process.env.EMERGENCY_HMAC_SECRET]
 * @param {number} [options.radiusKm=15]
 * @param {number} [options.donorPage=1]
 * @param {number} [options.donorLimit=10]
 * @param {number} [options.bankPage=1]
 * @param {number} [options.bankLimit=10]
 * @returns {Promise<Object>} Full matching response payload
 */
async function findEmergencyRequestMatches(identifier, authContext, options = {}) {
	const validated = await validateAndAuthorizeEmergencyRequest(identifier, authContext, options)
	const { request, shortfall, compatibility } = validated

	const hmacSecret = options.hmacSecret || process.env.EMERGENCY_HMAC_SECRET
	validateHmacConfiguration(hmacSecret)

	const discoveryOptions = {
		...options,
		unmetUnits: shortfall.unmetUnits,
	}

	const [donorsResult, banksResult] = await Promise.all([
		discoverDonorCandidates(request, compatibility, discoveryOptions),
		discoverBloodBankCandidates(request, compatibility, discoveryOptions),
	])

	const totalVerifiedUnitsNearby = banksResult.data.reduce(
		(sum, b) =>
			b.inventoryTrustStatus === 'Verified_Bloodbank_Stock_Match' && typeof b.verifiedUnitsAvailable === 'number'
				? sum + b.verifiedUnitsAvailable
				: sum,
		0
	)
	const verifiedBloodBankCount = banksResult.data.filter(
		(b) => b.inventoryTrustStatus === 'Verified_Bloodbank_Stock_Match'
	).length
	const potentialDonorCount = donorsResult.data.filter(
		(d) => d.classification === 'Potential_Donor_Match'
	).length
	const pendingEvaluationDonorCount = donorsResult.data.filter(
		(d) => d.classification === 'Pending_Clinical_Evaluation'
	).length

	const matchingSummary = {
		searchRadiusKm: Math.max(1, Math.min(50, Number(options.radiusKm) || 15)),
		compatibleGroups: compatibility.compatibleGroups,
		preferredGroup: compatibility.preferredGroup,
		totalVerifiedUnitsNearby,
		verifiedBloodBankCount,
		potentialDonorCount,
		pendingEvaluationDonorCount,
	}

	const emergencyRequestSummary = {
		requestNumber: request.requestNumber,
		verificationStatus: request.verificationStatus,
		requiredBloodGroup: request.requiredBloodGroup,
		requiredComponent: request.requiredComponent,
		unitsRequested: shortfall.unitsRequested,
		unitsReserved: shortfall.unitsReserved,
		unitsFulfilled: shortfall.unitsFulfilled,
		unitsUnmet: shortfall.unmetUnits,
		urgencyLevel: request.urgencyLevel,
		hospitalName: request.hospitalName,
		hospitalCity: request.hospitalCity,
		hospitalState: request.hospitalState,
		status: request.status,
		expiresAt: request.expiresAt,
	}

	const governance = {
		specVersion: '1.0.0-matching-engine',
		isAuthoritativeClinicalDecision: false,
		isPresumptiveImmunohematologyCheck: true,
		isMatchingRecommendationOnly: true,
		cannotAuthorizeDonation: true,
		cannotAuthorizeReservation: true,
		cannotAuthorizeDispatch: true,
		cannotIssuePrescriptionOrOrder: true,
		requiresLaboratoryCrossmatch: true,
		preservesPhase3Safeguards: true,
		clinicalSafetyNotice:
			'Emergency matching output is presumptive immunohematology guidance only. Discovery and ranking do not authorize reservation, issuance, dispatch, or transfusion. Pre-donation donor screening, hemoglobin assessment, physical examination, mandatory transfusion-transmissible infection (TTI) testing, pre-transfusion laboratory crossmatching, and institutional release verification are essential clinical safety prerequisites prior to blood collection, reservation, dispatch, or administration.',
		disclaimer: compatibility.governance.disclaimer,
	}

	return {
		emergencyRequest: emergencyRequestSummary,
		matchingSummary,
		bloodBanks: banksResult,
		donors: donorsResult,
		governance,
	}
}

module.exports = {
	resolveEmergencyRequest,
	validateRequestLifecycle,
	validateShortfallIntegrity,
	authorizeRequestAccess,
	deriveRequestCompatibility,
	validateAndAuthorizeEmergencyRequest,
	// Sub-Milestone 4.3.3.3 Cryptographic & Reference Helpers
	validateHmacConfiguration,
	deriveCandidateReference,
	verifyCandidateReference,
	derivePublicFacilityReference,
	// Sub-Milestone 4.3.3.3 Sanitization & Ranking Helpers
	sanitizeDonorCandidate,
	sanitizeBloodBankCandidate,
	rankDonorCandidates,
	rankBloodBankCandidates,
	rankCombinedCandidates,
	// Sub-Milestone 4.3.3.3 Dual-Stream Discovery Engine
	discoverDonorCandidates,
	discoverBloodBankCandidates,
	findEmergencyRequestMatches,
	escapeRegex,
}

