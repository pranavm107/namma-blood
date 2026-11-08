/**
 * Hospital Representative (HOSPITAL_ADMIN) Authentication & Authorization Middleware
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Phase 4.3.5 / Stage B2)
 *
 * Enforces strict institutional multi-tenancy and boundary protections:
 * 1. Authenticates token identity and ensures user has the HOSPITAL_ADMIN role.
 * 2. Enforces active account lifecycle status (accountStatus === 'Active', status === true).
 * 3. Enforces active representative status (representativeStatus === 'Active').
 * 4. Binds representative strictly to their authorized hospital (currentUser.hospitalId).
 * 5. Enforces Verified and active hospital registry status.
 * 6. Detects and rejects client-supplied hospitalId scope tampering (BOLA / IDOR defense).
 * 7. Blocks USER, MEDICAL_OFFICER, BLOODBANK, STAFF, and generic ADMIN access.
 * 8. Ensures HOSPITAL_ADMIN never receives platform-wide ADMIN or clinical verification privileges.
 */

const { promisify } = require('util')
const jwt = require('jsonwebtoken')
const catchAsync = require('../Utils/catchAsync')
const userModel = require('../User/userModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const Admin = require('../Admin/adminModel')
const { Hospital } = require('./hospitalModel')

const protectHospitalAdminAuth = catchAsync(async (req, res, next) => {
	// ------------------------------------------------------------------------
	// 1. Authentication Resolution
	// ------------------------------------------------------------------------
	let token = null
	if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
		token = req.headers.authorization.split(' ')[1]
	}

	if (!token) {
		return res.status(401).json({
			status: 'fail',
			message: 'Authentication required. You must be logged in to access Hospital Representative operations.',
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
		decoded = await promisify(jwt.verify)(
			token,
			secret
		)
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

	if (decoded.userType === 'staff') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Blood bank staff accounts are not authorized for Hospital Representative operations.',
		})
	}

	// ------------------------------------------------------------------------
	// 2. Identity & Role Resolution
	// ------------------------------------------------------------------------
	const currentUser = await userModel.findById(decoded.id).select('+password')

	if (!currentUser) {
		const bloodbank = await Bloodbank.findById(decoded.id)
		if (bloodbank) {
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: Blood bank institutional accounts are not authorized for Hospital Representative operations.',
			})
		}

		const admin = await Admin.findById(decoded.id)
		if (admin) {
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: Platform administrators cannot directly act as Hospital Representatives without an authorized representative account.',
			})
		}

		return res.status(401).json({
			status: 'fail',
			message: 'The account belonging to this token no longer exists.',
		})
	}

	if (currentUser.role !== 'HOSPITAL_ADMIN') {
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Role '${currentUser.role}' is not authorized for Hospital Representative operations.`,
		})
	}

	// ------------------------------------------------------------------------
	// 3. Representative Account Lifecycle Gate
	// ------------------------------------------------------------------------
	if (currentUser.accountStatus && currentUser.accountStatus !== 'Active') {
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Hospital Representative account is ${currentUser.accountStatus.toLowerCase()}.`,
		})
	}

	if (currentUser.status === false) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Account is deactivated or suspended.',
		})
	}

	if (currentUser.representativeStatus && currentUser.representativeStatus !== 'Active') {
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Representative authorization status is '${currentUser.representativeStatus}'.`,
		})
	}

	if (currentUser.changedPasswordAfter(decoded.iat, decoded.tokenVersion)) {
		return res.status(401).json({
			status: 'fail',
			message: 'User recently changed password! Please log in again.',
		})
	}

	// ------------------------------------------------------------------------
	// 4. Hospital Scoping & Registry Verification Gate
	// ------------------------------------------------------------------------
	if (!currentUser.hospitalId) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Hospital Representative is not linked to any hospital facility.',
		})
	}

	const hospital = await Hospital.findById(currentUser.hospitalId)
	if (!hospital) {
		return res.status(404).json({
			status: 'fail',
			message: 'Access denied: The associated hospital facility no longer exists.',
		})
	}

	if (hospital.verificationStatus !== 'Verified' || hospital.isActive !== true) {
		let reason = 'Hospital facility is unverified or inactive.'
		if (hospital.verificationStatus !== 'Verified') {
			reason = `Hospital facility verification status is '${hospital.verificationStatus}'. Only Verified hospitals are authorized.`
		} else if (!hospital.isActive) {
			reason = 'Hospital facility is currently marked inactive.'
		}
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: ${reason}`,
		})
	}

	// ------------------------------------------------------------------------
	// 5. Anti-Tamper & Cross-Hospital BOLA / IDOR Defense
	// ------------------------------------------------------------------------
	const clientSuppliedHospitalId =
		req.body?.hospitalId || req.query?.hospitalId || req.params?.hospitalId

	if (
		clientSuppliedHospitalId &&
		typeof clientSuppliedHospitalId === 'string' &&
		clientSuppliedHospitalId.trim() !== ''
	) {
		if (clientSuppliedHospitalId.trim() !== currentUser.hospitalId.toString()) {
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: You cannot access, nominate, or manage records for another hospital facility.',
			})
		}
	}

	// Authoritative Context Binding
	req.user = currentUser
	req.userRole = 'HOSPITAL_ADMIN'
	req.hospitalId = currentUser.hospitalId
	req.hospital = hospital

	next()
})

module.exports = {
	protectHospitalAdminAuth,
}

