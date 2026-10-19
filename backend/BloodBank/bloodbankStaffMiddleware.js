const { promisify } = require('util')
const jwt = require('jsonwebtoken')
const catchAsync = require('../Utils/catchAsync')
const { BloodbankStaff } = require('./bloodbankStaffModel')

/**
 * Generates a signed JWT token containing individual staff identity,
 * owning blood bank reference, explicit validated role, mustChangePassword flag, and tokenVersion.
 */
function generateStaffToken(staff) {
	const payload = {
		id: staff._id,
		bloodbankId: staff.bloodbankId,
		role: staff.role,
		mustChangePassword: staff.mustChangePassword === true,
		tokenVersion: typeof staff.tokenVersion === 'number' ? staff.tokenVersion : 0,
		userType: 'staff',
	}
	return jwt.sign(payload, process.env.JWT_SECRET || 'test_jwt_secret_key_12345', {
		expiresIn: process.env.JWT_EXPIRES_IN || '8h',
	})
}

/**
 * Authentication middleware for individual blood bank staff members.
 * Validates token signature, expiration, userType, password invalidation, and active status.
 */
const protectStaff = catchAsync(async (req, res, next) => {
	let token = null
	if (
		req.headers.authorization &&
		req.headers.authorization.startsWith('Bearer')
	) {
		token = req.headers.authorization.split(' ')[1]
	}

	if (!token) {
		return res.status(401).json({
			message: 'Staff authentication required. Please log in with your staff credentials.',
		})
	}

	let decoded = null
	try {
		decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET || 'test_jwt_secret_key_12345')
	} catch (err) {
		return res.status(401).json({
			message: 'Invalid staff token. Authentication failed.',
		})
	}

	const currentTime = Math.floor(Date.now() / 1000)
	if (
		!decoded.iat ||
		typeof decoded.iat !== 'number' ||
		isNaN(decoded.iat) ||
		decoded.iat <= 0
	) {
		return res.status(401).json({
			message: 'Invalid token! Missing or malformed issue timestamp.',
		})
	}

	if (currentTime > decoded.exp) {
		return res.status(401).json({
			message: 'Staff token expired! Please log in again.',
		})
	}

	// Defense-in-depth: Prevent token substitution across different user models
	if (decoded.userType !== 'staff') {
		return res.status(401).json({
			message: 'Invalid token type. Staff token required.',
		})
	}

	const staff = await BloodbankStaff.findById(decoded.id)
	if (!staff) {
		return res.status(401).json({
			message: 'The staff account belonging to this token no longer exists.',
		})
	}

	// Token revocation and password change check
	if (staff.changedPasswordAfter(decoded.iat, decoded.tokenVersion)) {
		return res.status(401).json({
			message: 'Staff credentials or permissions were recently updated! Please log in again.',
		})
	}

	// Account status revocation enforcement
	if (staff.status === 'Suspended') {
		return res.status(401).json({
			message: 'Your staff account is currently suspended. Access denied.',
		})
	}

	if (staff.status === 'Revoked') {
		return res.status(401).json({
			message: 'Your staff account has been revoked. Access denied.',
		})
	}

	if (staff.status !== 'Active') {
		return res.status(401).json({
			message: 'Staff account is inactive. Access denied.',
		})
	}

	// Bind authenticated staff context
	req.staff = staff
	req.staffRole = staff.role
	req.bloodbankId = staff.bloodbankId
	// Provide user context compatible with bloodbank multi-tenant isolation
	req.user = {
		_id: staff.bloodbankId,
		staffId: staff._id,
		staffName: staff.fullName,
		staffRole: staff.role,
		isStaff: true,
	}

	next()
})

/**
 * Role-Based Access Control (RBAC) and Clinical Governance guard.
 *
 * Enforces:
 * 1. Server-side role validation (never trusts request body or query parameters).
 * 2. Mandatory password change completion (blocks staff who have not changed initial password).
 * 3. Medical Officer credential verification check (Medical Officers MUST have medicalLicense.isVerified === true).
 */
function restrictToStaffRole(...allowedRoles) {
	return (req, res, next) => {
		if (!req.staff || !req.staff.role) {
			return res.status(401).json({
				message: 'Authentication required before role verification.',
			})
		}

		// Initial password security gate
		if (req.staff.mustChangePassword) {
			return res.status(403).json({
				message: 'Initial password change required before accessing role-restricted clinical operations. Please change your password.',
			})
		}

		if (!allowedRoles.includes(req.staff.role)) {
			return res.status(403).json({
				message: `Access forbidden: Your role '${req.staff.role}' is not authorized for this operation. Required: ${allowedRoles.join(', ')}.`,
			})
		}

		// Clinical Governance Gate: Medical Officers MUST be verified by a Global Admin
		if (req.staff.role === 'Medical_Officer' && !req.staff.medicalLicense?.isVerified) {
			return res.status(403).json({
				message: 'Access forbidden: Medical Officer credentials have not been verified by a Global Administrator.',
			})
		}

		next()
	}
}

module.exports = {
	generateStaffToken,
	protectStaff,
	restrictToStaffRole,
}
