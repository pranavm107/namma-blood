/**
 * Hospital Medical Officer Authentication & Authorization Middleware
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 *
 * Enforces strict clinical governance and hospital-level multi-tenancy:
 * 1. Authenticates token identity and ensures user has the MEDICAL_OFFICER role.
 * 2. Derives hospital association strictly from database records (zero client trust).
 * 3. Enforces Active association lifecycle status (rejects Pending, Suspended, Revoked).
 * 4. Enforces temporal validity (effectiveFrom <= now, expiresAt is null or future).
 * 5. Enforces explicit administrative permission grants (VERIFY_EMERGENCY_REQUESTS).
 * 6. Enforces Verified and active hospital registry status.
 * 7. Blocks USER, STAFF, BLOODBANK, and unauthorized ADMIN access with HTTP 403.
 * 8. Detects and rejects client-supplied hospitalId scope tampering (BOLA defense).
 */

const { promisify } = require('util')
const jwt = require('jsonwebtoken')
const catchAsync = require('../Utils/catchAsync')
const userModel = require('../User/userModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Admin = require('../Admin/adminModel')
const { MedicalOfficerHospital } = require('./medicalOfficerHospitalModel')
const { Hospital } = require('./hospitalModel')

/**
 * Core verification handler enforcing all 8 security invariants
 */
async function handleMedicalOfficerAuth(req, res, next, requiredPermission = 'VERIFY_EMERGENCY_REQUESTS') {
	// ------------------------------------------------------------------------
	// STEP 1: Authentication Resolution
	// ------------------------------------------------------------------------
	if (!req.user || !req.userRole) {
		let token = null
		if (req.headers && req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
			token = req.headers.authorization.split(' ')[1]
		}

		if (!token) {
			return res.status(401).json({
				status: 'fail',
				message: 'Authentication required. You must be logged in to access Medical Officer operations.',
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

		// Staff token check
		if (decoded.userType === 'staff') {
			req.userRole = 'STAFF'
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: Blood bank staff accounts are not authorized for hospital Medical Officer operations.',
			})
		}

		// Reject unrecognized userType claims
		if (decoded.userType && decoded.userType !== 'user') {
			return res.status(401).json({
				status: 'fail',
				message: 'Invalid token payload: unrecognized userType claim.',
			})
		}

		// Resolve from userModel
		const currentUser = await userModel.findById(decoded.id).select('+password')

		if (!currentUser) {
			// Check if blood bank institutional token
			const bloodbank = await Bloodbank.findById(decoded.id)
			if (bloodbank) {
				req.userRole = 'BLOODBANK'
				return res.status(403).json({
					status: 'fail',
					message: 'Access denied: Blood bank institutional accounts are not authorized for hospital Medical Officer operations.',
				})
			}

			// Check if admin token
			const admin = await Admin.findById(decoded.id)
			if (admin) {
				req.userRole = 'ADMIN'
				return res.status(403).json({
					status: 'fail',
					message: 'Access denied: Platform administrators cannot directly act as Medical Officers without an authorized hospital association.',
				})
			}

			return res.status(401).json({
				status: 'fail',
				message: 'The account belonging to this token no longer exists.',
			})
		}

		if (currentUser.role === 'HOSPITAL_ADMIN') {
			req.userRole = 'HOSPITAL_ADMIN'
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: Hospital Representatives are not authorized for Medical Officer clinical verification operations.',
			})
		}

		// ------------------------------------------------------------------------
		// GATE 1: Account Status Enforcement
		// ------------------------------------------------------------------------
		if (currentUser.role === 'MEDICAL_OFFICER') {
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

			// ------------------------------------------------------------------------
			// GATE 2: Professional Credential Status Enforcement (Exact Security Matrix)
			// Precedence:
			// 1. credentialStatus === 'Verified' -> Passes Gate 2
			// 2. credentialStatus in ['Suspended', 'Rejected', 'Pending_Verification', 'Under_Review', 'Unsubmitted'] -> Denied (403)
			// 3. credentialStatus === null -> Denied (403: null is not absent)
			// 4. typeof credentialStatus === 'string' && credStatus.trim() === '' -> Denied (403: empty string is not absent)
			// 5. credentialStatus !== undefined -> Denied (403: malformed value is not absent)
			// 6. credentialStatus === undefined (genuinely absent legacy record) -> Narrow legacy fallback:
			//    - verificationStatus === 'Verified' -> Passes Gate 2
			//    - otherwise -> Denied (403)
			// ------------------------------------------------------------------------
			const credStatus = currentUser.credentialStatus

			if (credStatus === 'Verified') {
				// Passes Gate 2
			} else if (credStatus === 'Suspended') {
				return res.status(403).json({
					status: 'fail',
					message: 'Access denied: Medical Officer professional credentials are suspended.',
				})
			} else if (credStatus === 'Rejected') {
				return res.status(403).json({
					status: 'fail',
					message: 'Access denied: Medical Officer professional credentials were rejected.',
				})
			} else if (credStatus === 'Pending_Verification') {
				return res.status(403).json({
					status: 'fail',
					message: 'Access denied: Medical Officer professional credentials are pending administrative verification.',
				})
			} else if (credStatus === 'Under_Review') {
				return res.status(403).json({
					status: 'fail',
					message: 'Access denied: Medical Officer professional credentials are under administrative review.',
				})
			} else if (credStatus === 'Unsubmitted') {
				return res.status(403).json({
					status: 'fail',
					message: 'Access denied: Medical Officer professional credentials have not been submitted.',
				})
			} else if (credStatus === null) {
				return res.status(403).json({
					status: 'fail',
					message: "Access denied: Medical Officer credential status is invalid (null). Only 'Verified' credentials grant clinical access.",
				})
			} else if (typeof credStatus === 'string' && credStatus.trim() === '') {
				return res.status(403).json({
					status: 'fail',
					message: "Access denied: Medical Officer credential status is invalid (empty). Only 'Verified' credentials grant clinical access.",
				})
			} else if (credStatus !== undefined) {
				return res.status(403).json({
					status: 'fail',
					message: `Access denied: Medical Officer credential status is malformed or invalid ('${credStatus}'). Only 'Verified' credentials grant clinical access.`,
				})
			} else {
				// Narrow legacy compatibility fallback: only genuinely absent legacy records (credStatus === undefined)
				// with an explicit verificationStatus === 'Verified' pass.
				const legacyStatus = currentUser.verificationStatus
				if (legacyStatus === 'Verified') {
					// Narrow scoped legacy compatibility pass
				} else if (!legacyStatus || typeof legacyStatus !== 'string' || legacyStatus.trim() === '') {
					return res.status(403).json({
						status: 'fail',
						message: 'Access denied: Medical Officer professional credential status is missing. Administrative credential submission and verification required.',
					})
				} else if (legacyStatus === 'Pending') {
					return res.status(403).json({
						status: 'fail',
						message: "Access denied: Medical Officer verification status is 'Pending'. An approved and verified account is required.",
					})
				} else if (legacyStatus === 'Rejected') {
					return res.status(403).json({
						status: 'fail',
						message: 'Access denied: Medical Officer professional credentials were rejected.',
					})
				} else if (legacyStatus === 'Suspended') {
					return res.status(403).json({
						status: 'fail',
						message: 'Access denied: Medical Officer professional credentials are suspended.',
					})
				} else {
					return res.status(403).json({
						status: 'fail',
						message: `Access denied: Medical Officer legacy verification status is malformed or invalid ('${legacyStatus}').`,
					})
				}
			}
		}

		if (currentUser.changedPasswordAfter(decoded.iat, decoded.tokenVersion)) {
			return res.status(401).json({
				status: 'fail',
				message: 'User recently changed password! Please log in again.',
			})
		}

		req.user = currentUser
		req.userRole = currentUser.role === 'MEDICAL_OFFICER' ? 'MEDICAL_OFFICER' : (currentUser.role === 'HOSPITAL_ADMIN' ? 'HOSPITAL_ADMIN' : 'USER')
	}

	// ------------------------------------------------------------------------
	// STEP 2: Role Gate (Strictly MEDICAL_OFFICER)
	// ------------------------------------------------------------------------
	if (req.userRole !== 'MEDICAL_OFFICER' || req.user.role !== 'MEDICAL_OFFICER') {
		const roleName = req.userRole || req.user?.role || 'UNKNOWN'
		let extraDesc = ''
		if (roleName === 'HOSPITAL_ADMIN') {
			extraDesc = 'Hospital Representatives are not authorized for Medical Officer clinical verification operations.'
		}
		return res.status(403).json({
			status: 'fail',
			message: extraDesc || `Access denied: Role '${roleName}' is not authorized for Medical Officer operations.`,
		})
	}

	// ------------------------------------------------------------------------
	// STEP 3: Database Association Lookup (Never trust client hospitalId)
	// ------------------------------------------------------------------------
	const now = new Date()
	const associations = await MedicalOfficerHospital.find({
		medicalOfficerUserId: req.user._id,
	}).populate('hospitalId')

	if (!associations || associations.length === 0) {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: No hospital association found for this Medical Officer account.',
		})
	}

	// ------------------------------------------------------------------------
	// STEP 4: Association Lifecycle Gate (Active only)
	// ------------------------------------------------------------------------
	const activeAssociations = associations.filter(a => a.associationStatus === 'Active')
	if (activeAssociations.length === 0) {
		const hasPending = associations.some(
			a =>
				a.associationStatus === 'Pending' ||
				a.associationStatus === 'Pending_Admin_Approval' ||
				a.associationStatus === 'Pending_Hospital_Confirmation'
		)
		const hasSuspended = associations.some(a => a.associationStatus === 'Suspended')
		const hasRevoked = associations.some(a => a.associationStatus === 'Revoked')

		let statusDesc = 'inactive'
		if (hasPending) statusDesc = 'pending administrative approval'
		else if (hasSuspended) statusDesc = 'suspended'
		else if (hasRevoked) statusDesc = 'revoked'

		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Medical Officer association is ${statusDesc}.`,
		})
	}

	// ------------------------------------------------------------------------
	// STEP 5: Temporal Validity Gate (effectiveFrom <= now, expiresAt > now)
	// ------------------------------------------------------------------------
	const temporallyValid = activeAssociations.filter(a => {
		const isEffective = a.effectiveFrom && new Date(a.effectiveFrom) <= now
		const notExpired = !a.expiresAt || new Date(a.expiresAt) > now
		return isEffective && notExpired
	})

	if (temporallyValid.length === 0) {
		const isFuture = activeAssociations.some(a => a.effectiveFrom && new Date(a.effectiveFrom) > now)
		const isExpired = activeAssociations.some(a => a.expiresAt && new Date(a.expiresAt) <= now)

		let timeframeDesc = 'outside its operational timeframe'
		if (isFuture) timeframeDesc = 'not yet effective'
		else if (isExpired) timeframeDesc = 'expired'

		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Medical Officer association is ${timeframeDesc}.`,
		})
	}

	// ------------------------------------------------------------------------
	// STEP 6: Explicit Permission Gate
	// ------------------------------------------------------------------------
	const authorizedByPermission = temporallyValid.filter(a => {
		return Array.isArray(a.permissions) && a.permissions.includes(requiredPermission)
	})

	if (authorizedByPermission.length === 0) {
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: Medical Officer association does not grant the required '${requiredPermission}' permission.`,
		})
	}

	// ------------------------------------------------------------------------
	// STEP 7: Hospital Facility Status Gate (Verified & Active)
	// ------------------------------------------------------------------------
	const validHospitalAssociations = authorizedByPermission.filter(a => {
		const hosp = a.hospitalId
		return hosp && hosp.verificationStatus === 'Verified' && hosp.isActive === true
	})

	if (validHospitalAssociations.length === 0) {
		const firstHosp = authorizedByPermission[0]?.hospitalId
		let hospitalDesc = 'Hospital facility is unverified or inactive.'
		if (firstHosp) {
			if (firstHosp.verificationStatus !== 'Verified') {
				hospitalDesc = `Hospital facility verification status is '${firstHosp.verificationStatus}'. Only Verified hospitals are authorized.`
			} else if (!firstHosp.isActive) {
				hospitalDesc = 'Hospital facility is currently marked inactive.'
			}
		}
		return res.status(403).json({
			status: 'fail',
			message: `Access denied: ${hospitalDesc}`,
		})
	}

	// ------------------------------------------------------------------------
	// STEP 8: Anti-Tamper & Multi-Hospital Context Binding
	// ------------------------------------------------------------------------
	req.authorizedAssociations = validHospitalAssociations
	req.authorizedHospitalIds = validHospitalAssociations.map(a => a.hospitalId._id.toString())
	req.authorizedHospitals = validHospitalAssociations.map(a => a.hospitalId)

	// Check if client explicitly requested or supplied a hospitalId scope
	const clientSuppliedHospitalId =
		req.body?.hospitalId || req.query?.hospitalId || req.params?.hospitalId

	if (
		clientSuppliedHospitalId &&
		typeof clientSuppliedHospitalId === 'string' &&
		clientSuppliedHospitalId.trim() !== ''
	) {
		const matchedAssoc = validHospitalAssociations.find(
			a => a.hospitalId._id.toString() === clientSuppliedHospitalId.trim()
		)
		if (!matchedAssoc) {
			return res.status(403).json({
				status: 'fail',
				message: 'Access denied: Client-supplied hospitalId does not match your authorized facility scope.',
			})
		}
		// Explicitly validated selected hospital
		req.activeAssociation = matchedAssoc
		req.activeHospital = matchedAssoc.hospitalId
		req.hospitalId = matchedAssoc.hospitalId._id
		req.hospitalScope = matchedAssoc.hospitalId._id
		req.medicalOfficerPermissions = matchedAssoc.permissions
	} else if (validHospitalAssociations.length === 1) {
		// Single authorized hospital: unambiguous default
		const singleAssoc = validHospitalAssociations[0]
		req.activeAssociation = singleAssoc
		req.activeHospital = singleAssoc.hospitalId
		req.hospitalId = singleAssoc.hospitalId._id
		req.hospitalScope = singleAssoc.hospitalId._id
		req.medicalOfficerPermissions = singleAssoc.permissions
	} else {
		// Multiple authorized hospitals: do not arbitrarily choose one
		req.activeAssociation = null
		req.activeHospital = null
		req.hospitalId = null
		req.hospitalScope = null
		req.isMultiHospital = true
	}

	next()
}

/**
 * Universal middleware interface:
 * Can be used directly: router.use(protectMedicalOfficerAuth)
 * Or configured with specific permission: router.patch('/verify', protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'))
 */
const protectMedicalOfficerAuth = (param1, param2, param3) => {
	// If invoked directly as middleware (req, res, next)
	if (param1 && param1.headers && typeof param3 === 'function') {
		return catchAsync(async (req, res, next) => {
			await handleMedicalOfficerAuth(req, res, next, 'VERIFY_EMERGENCY_REQUESTS')
		})(param1, param2, param3)
	}

	// If invoked as a factory with permission name: protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')
	const requiredPermission = typeof param1 === 'string' ? param1 : 'VERIFY_EMERGENCY_REQUESTS'
	return catchAsync(async (req, res, next) => {
		await handleMedicalOfficerAuth(req, res, next, requiredPermission)
	})
}

module.exports = {
	protectMedicalOfficerAuth,
}

