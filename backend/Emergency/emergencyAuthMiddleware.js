/**
 * Unified Authentication Middleware for Emergency Endpoints
 * Namma Blood — Emergency Blood Connection (Milestone 4.3)
 *
 * Authenticates requests from any registered platform entity:
 * - Regular Users (User model)
 * - Blood Bank Staff Members (BloodbankStaff model)
 * - Blood Bank Institutional Accounts (Bloodbank model)
 * - System Administrators (Admin model)
 */

const { promisify } = require('util')
const jwt = require('jsonwebtoken')
const catchAsync = require('../Utils/catchAsync')
const userModel = require('../User/userModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Admin = require('../Admin/adminModel')

const protectEmergencyAuth = catchAsync(async (req, res, next) => {
	// If already authenticated by preceding middleware, proceed
	if (req.user) {
		return next()
	}

	let token = null
	if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
		token = req.headers.authorization.split(' ')[1]
	}

	if (!token) {
		return res.status(401).json({
			status: 'fail',
			message: 'Authentication required. You must be logged in to access emergency discovery.',
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
			message: 'Token expired! Please log in again to access emergency discovery.',
		})
	}

	// 1. Staff Token Resolution
	if (decoded.userType === 'staff') {
		const staff = await BloodbankStaff.findById(decoded.id).select('+password')
		if (!staff) {
			return res.status(401).json({
				status: 'fail',
				message: 'The staff account belonging to this token no longer exists.',
			})
		}
		if (staff.status !== 'Active') {
			return res.status(401).json({
				status: 'fail',
				message: 'Staff account is inactive or suspended.',
			})
		}
		if (staff.changedPasswordAfter(decoded.iat, decoded.tokenVersion)) {
			return res.status(401).json({
				status: 'fail',
				message: 'Staff recently changed password. Please log in again.',
			})
		}
		req.user = staff
		req.staff = staff
		req.userRole = 'STAFF'
		return next()
	}

	// Reject unrecognized userType claims
	if (decoded.userType && decoded.userType !== 'user') {
		return res.status(401).json({
			status: 'fail',
			message: 'Invalid token payload: unrecognized userType claim.',
		})
	}

	// 2. Platform User / Bloodbank / Admin Resolution
	let currentUser = await userModel.findById(decoded.id).select('+password')
	let userRole = 'USER'

	if (currentUser) {
		if (currentUser.role === 'MEDICAL_OFFICER') {
			userRole = 'MEDICAL_OFFICER'
		} else if (currentUser.role === 'HOSPITAL_ADMIN') {
			userRole = 'HOSPITAL_ADMIN'
		} else {
			userRole = 'USER'
		}
	} else {
		currentUser = await Bloodbank.findById(decoded.id).select('+password')
		if (currentUser) {
			userRole = 'BLOODBANK'
		}
	}

	if (!currentUser) {
		currentUser = await Admin.findById(decoded.id).select('+password')
		if (currentUser) {
			userRole = 'ADMIN'
		}
	}

	if (!currentUser) {
		return res.status(401).json({
			status: 'fail',
			message: 'The account belonging to this token no longer exists.',
		})
	}

	// Account lifecycle check: reject deactivated accounts
	if (currentUser.status === false) {
		return res.status(401).json({
			status: 'fail',
			message: 'Account is deactivated or suspended.',
		})
	}

	// Role-specific accountStatus enforcement
	if (userRole === 'MEDICAL_OFFICER') {
		// Strict Medical Officer gate: missing lifecycle is NEVER treated as Active
		if (!currentUser.accountStatus) {
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: Medical Officer account status is missing. Administrative activation required.',
			})
		}
		if (currentUser.accountStatus !== 'Active') {
			return res.status(403).json({
				status: 'fail',
				message: `Access denied: Medical Officer account is ${currentUser.accountStatus.toLowerCase()}.`,
			})
		}
	} else if (userRole === 'HOSPITAL_ADMIN') {
		// Hospital Representative requires Active accountStatus
		if (!currentUser.accountStatus || currentUser.accountStatus !== 'Active') {
			const repStatus = currentUser.accountStatus || 'pending_activation'
			return res.status(403).json({
				status: 'fail',
				message: `Hospital Representative account is ${repStatus.toLowerCase()}. Access denied until administrative activation.`,
			})
		}
	} else if (userRole === 'USER') {
		// Platform USER: reject explicitly suspended or deactivated accounts
		// Legacy records with absent accountStatus remain authorized if status === true
		if (currentUser.accountStatus && currentUser.accountStatus !== 'Active') {
			return res.status(403).json({
				status: 'fail',
				message: `Account is ${currentUser.accountStatus.toLowerCase()}. Access denied.`,
			})
		}
	}
	// ADMIN and BLOODBANK use boolean status (enforced above); accountStatus does not apply to their schemas.

	if (currentUser.changedPasswordAfter(decoded.iat, decoded.tokenVersion)) {
		return res.status(401).json({
			status: 'fail',
			message: 'User recently changed password! Please log in again.',
		})
	}

	req.user = currentUser
	req.userRole = userRole
	next()
})

module.exports = {
	protectEmergencyAuth,
}
