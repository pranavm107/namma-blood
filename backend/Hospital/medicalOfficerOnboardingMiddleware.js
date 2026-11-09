/**
 * Medical Officer Onboarding Middleware
 * Namma Blood — Stage B3.4 Healthcare Governance & Onboarding Foundation
 *
 * Implements a restricted, secure authorization middleware for Medical Officers
 * undergoing credential submission, status verification, and clarification workflows.
 *
 * Security Invariants:
 * 1. Authenticates token identity and derives role strictly from database records (zero client trust).
 * 2. Enforces Gate 1: Account must be Active (`accountStatus === 'Active'` and `status === true`).
 * 3. Rejects suspended, deactivated, and pending-activation accounts with HTTP 403.
 * 4. Strictly denies non-MEDICAL_OFFICER roles (USER, STAFF, BLOODBANK, HOSPITAL_ADMIN, ADMIN).
 * 5. Broken Object Level Authorization (BOLA) Defense: If route includes target doctor identifiers
 *    (:doctorId or :id), ensures the authenticated doctor can ONLY inspect or modify their own record.
 * 6. Isolated from clinical operations: Holding onboarding access grants ZERO authority to view
 *    clinical emergency requests, clinical verification queues, or hospital availability.
 */

const { promisify } = require('util')
const jwt = require('jsonwebtoken')
const userModel = require('../User/userModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Admin = require('../Admin/adminModel')

/**
 * Middleware protecting Medical Officer Onboarding & Credential Management routes
 */
async function protectMedicalOfficerOnboarding(req, res, next) {
	// ------------------------------------------------------------------------
	// STEP 1: Authentication Resolution
	// ------------------------------------------------------------------------
	let token = null
	if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
		token = req.headers.authorization.split(' ')[1]
	}

	if (!token) {
		return res.status(401).json({
			status: 'fail',
			message: 'Authentication required. You must be logged in to access Medical Officer onboarding.',
		})
	}

	const secret = process.env.JWT_SECRET
	if (!secret || typeof secret !== 'string' || secret.trim() === '') {
		return res.status(500).json({
			status: 'error',
			message: 'Server configuration error: JWT_SECRET environment variable is not configured.',
		})
	}

	let decoded = null
	try {
		decoded = await promisify(jwt.verify)(token, secret)
	} catch (err) {
		return res.status(401).json({
			status: 'fail',
			message: 'Invalid or expired authentication token. Please log in again.',
		})
	}

	const currentTime = Math.floor(Date.now() / 1000)
	if (!decoded.iat || typeof decoded.iat !== 'number' || isNaN(decoded.iat) || decoded.iat <= 0) {
		return res.status(401).json({
			status: 'fail',
			message: 'Invalid token: Missing or malformed issue timestamp.',
		})
	}

	if (currentTime > decoded.exp) {
		return res.status(401).json({
			status: 'fail',
			message: 'Token expired! Please log in again.',
		})
	}

	// Reject staff and unrecognized userType claims
	if (decoded.userType === 'staff') {
		req.userRole = 'STAFF'
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Blood bank staff accounts are not authorized for Medical Officer onboarding.',
		})
	}

	if (decoded.userType && decoded.userType !== 'user') {
		return res.status(401).json({
			status: 'fail',
			message: 'Invalid token payload: unrecognized userType claim.',
		})
	}

	// ------------------------------------------------------------------------
	// STEP 2: Database Identity Resolution (Live authoritative check)
	// ------------------------------------------------------------------------
	const currentUser = await userModel.findById(decoded.id).select('+password')

	if (!currentUser) {
		// Institutional token checks
		const bloodbank = await Bloodbank.findById(decoded.id)
		if (bloodbank) {
			req.userRole = 'BLOODBANK'
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: Blood bank accounts are not authorized for Medical Officer onboarding.',
			})
		}

		const admin = await Admin.findById(decoded.id)
		if (admin) {
			req.userRole = 'ADMIN'
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: Platform administrators must use dedicated administrative portals.',
			})
		}

		return res.status(401).json({
			status: 'fail',
			message: 'The account belonging to this token no longer exists.',
		})
	}

	// Reject non-doctor roles
	if (currentUser.role === 'USER') {
		req.userRole = 'USER'
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Standard user accounts are not authorized for Medical Officer onboarding.',
		})
	}

	if (currentUser.role === 'HOSPITAL_ADMIN') {
		req.userRole = 'HOSPITAL_ADMIN'
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Hospital Representatives must use the hospital administration portal.',
		})
	}

	if (currentUser.role !== 'MEDICAL_OFFICER') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Medical Officer role required.',
		})
	}

	// ------------------------------------------------------------------------
	// STEP 3: Gate 1 Account Status Enforcement
	// ------------------------------------------------------------------------
	if (!currentUser.accountStatus) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Medical Officer account status is missing. Administrative activation required.',
		})
	}

	if (currentUser.accountStatus === 'Pending_Activation') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Medical Officer account is pending activation.',
		})
	}

	if (currentUser.accountStatus === 'Suspended') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Medical Officer account is suspended.',
		})
	}

	if (currentUser.accountStatus === 'Deactivated') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Medical Officer account is deactivated.',
		})
	}

	if (currentUser.accountStatus !== 'Active') {
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Medical Officer account status is '${currentUser.accountStatus}'. Active account required.`,
		})
	}

	if (currentUser.status === false) {
		return res.status(401).json({
			status: 'fail',
			message: 'Account is deactivated or suspended.',
		})
	}

	// Password change invalidation check
	if (currentUser.changedPasswordAfter && currentUser.changedPasswordAfter(decoded.iat, decoded.tokenVersion)) {
		return res.status(401).json({
			status: 'fail',
			message: 'User recently changed password! Please log in again.',
		})
	}

	// ------------------------------------------------------------------------
	// STEP 4: Broken Object Level Authorization (BOLA) Defense
	// ------------------------------------------------------------------------
	const targetDoctorId = req.params?.doctorId || req.params?.id
	if (targetDoctorId && String(targetDoctorId) !== String(currentUser._id)) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: You may only access or submit credentials for your own account.',
		})
	}

	// ------------------------------------------------------------------------
	// STEP 4.5: Mass-Assignment & Privilege Escalation Defense
	// Onboarding requests cannot directly modify credentials, roles, permissions,
	// verification fields, or hospital association statuses.
	// ------------------------------------------------------------------------
	if (req.body && typeof req.body === 'object') {
		const FORBIDDEN_SECURITY_MUTATION_FIELDS = [
			'role',
			'credentialStatus',
			'verificationStatus',
			'accountStatus',
			'status',
			'permissions',
			'isVerified',
			'tokenVersion',
			'hospitalAssociationId',
			'associationStatus',
			'availabilityStatus',
		]

		for (const field of FORBIDDEN_SECURITY_MUTATION_FIELDS) {
			if (Object.prototype.hasOwnProperty.call(req.body, field)) {
				return res.status(400).json({
					status: 'fail',
					message: `Mass-assignment violation: direct client modification of protected security field '${field}' is strictly prohibited.`,
				})
			}
		}
	}

	// ------------------------------------------------------------------------
	// STEP 5: Request Binding
	// ------------------------------------------------------------------------
	req.user = currentUser
	req.userRole = 'MEDICAL_OFFICER'
	req.sessionScope = currentUser.credentialStatus === 'Verified' ? 'CLINICAL' : 'ONBOARDING'

	next()
}

module.exports = {
	protectMedicalOfficerOnboarding,
}
