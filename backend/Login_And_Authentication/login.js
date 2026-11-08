const AppError = require('../Utils/appError')
const catchAsync = require('../Utils/catchAsync')
const jwt = require('jsonwebtoken')
const {
	emailValidate,
	passwordLengthValidate,
} = require('../Common/Functions/validateInputs')

const tokenGenerate = (id, tokenVersion = 0) => {
	const secret = process.env.JWT_SECRET
	if (!secret || typeof secret !== 'string' || secret.trim() === '') {
		const err = new Error('Server configuration error: JWT_SECRET environment variable is not configured.')
		err.statusCode = 500
		throw err
	}
	const payload = {
		id,
		tokenVersion: typeof tokenVersion === 'number' ? tokenVersion : 0,
	}
	return jwt.sign(payload, secret, {
		expiresIn: process.env.JWT_EXPIRES_IN || '1h',
	})
}

const loginMiddleware = (req, res, next) => {
	const missingValues = []

	if (!req.body.email) missingValues.push('Email')
	if (!req.body.password) missingValues.push('Password')

	if (missingValues.length > 0)
		return next(
			new AppError(
				`Required missing values : ${missingValues.join(', ')}`,
				400
			)
		)

	if (!emailValidate(req.body.email)) {
		return next(new AppError('Invalid email address.', 400))
	}

	if (!passwordLengthValidate(req.body.password)) {
		return next(
			new AppError('Password should be at least 8 to 20 characters.', 400)
		)
	}

	next()
}

const login = catchAsync(async (req, res) => {
	const { email, password } = req.body

	const user = await req.model.findOne({ email }).select('+password')
	if (
		user === null ||
		!(await user.correctPassword(password, user.password))
	) {
		return res.status(401).json({
			message:
				'Email or Password incorrect. Check your Login credentials.',
		})
	}

	// General inactive account check
	if (user.status === false) {
		return res.status(401).json({
			status: 'fail',
			message: 'Account is deactivated or suspended.',
		})
	}

	// Platform User Lifecycle Authentication Guard
	if (user.role === 'USER') {
		if (user.accountStatus && (user.accountStatus === 'Suspended' || user.accountStatus === 'Deactivated')) {
			return res.status(403).json({
				status: 'fail',
				message: `Account is ${user.accountStatus.toLowerCase()}. Access denied.`,
			})
		}
	}

	// Medical Officer Lifecycle Authentication Guard
	if (user.role === 'MEDICAL_OFFICER') {
		// Gate 1: Account Status Enforcement
		if (!user.accountStatus) {
			return res.status(403).json({
				status: 'fail',
				message: 'Medical Officer account status is missing. Administrative activation required.',
			})
		}
		if (user.accountStatus === 'Pending_Activation') {
			return res.status(403).json({
				status: 'fail',
				message: 'Medical Officer account is pending activation.',
			})
		}
		if (user.accountStatus === 'Suspended' || user.accountStatus === 'Deactivated') {
			return res.status(403).json({
				status: 'fail',
				message: `Medical Officer account is ${user.accountStatus.toLowerCase()}.`,
			})
		}
		if (user.accountStatus !== 'Active') {
			return res.status(403).json({
				status: 'fail',
				message: `Medical Officer account status is '${user.accountStatus}'. Active account required.`,
			})
		}

		// Gate 2: Credential Status Precedence (Strict Security Matrix)
		const credStatus = user.credentialStatus

		if (credStatus === 'Verified') {
			// Passes Gate 2 unconditionally
		} else if (credStatus === 'Suspended') {
			return res.status(403).json({
				status: 'fail',
				message: 'Medical Officer account is suspended.',
			})
		} else if (credStatus === 'Rejected') {
			return res.status(403).json({
				status: 'fail',
				message: 'Medical Officer account verification was rejected.',
			})
		} else if (credStatus === 'Pending_Verification' || credStatus === 'Under_Review') {
			return res.status(403).json({
				status: 'fail',
				message: 'Medical Officer account is pending administrative verification.',
			})
		} else if (credStatus === 'Unsubmitted') {
			return res.status(403).json({
				status: 'fail',
				message: 'Medical Officer professional credentials have not been submitted.',
			})
		} else if (credStatus === null) {
			return res.status(403).json({
				status: 'fail',
				message: 'Medical Officer credential status is invalid (null). Verified credentials required.',
			})
		} else if (typeof credStatus === 'string' && credStatus.trim() === '') {
			return res.status(403).json({
				status: 'fail',
				message: 'Medical Officer credential status is invalid (empty). Verified credentials required.',
			})
		} else if (credStatus !== undefined) {
			return res.status(403).json({
				status: 'fail',
				message: `Medical Officer credential status is malformed or invalid ('${credStatus}'). Verified credentials required.`,
			})
		} else {
			// credStatus === undefined (genuinely absent from legacy database record)
			const legacyStatus = user.verificationStatus
			if (legacyStatus === 'Verified') {
				// Scoped legacy compatibility pass permitted
			} else if (!legacyStatus || typeof legacyStatus !== 'string' || legacyStatus.trim() === '') {
				return res.status(403).json({
					status: 'fail',
					message: 'Medical Officer credential status is missing. Administrative verification required.',
				})
			} else if (legacyStatus === 'Pending') {
				return res.status(403).json({
					status: 'fail',
					message: 'Medical Officer account is pending administrative verification.',
				})
			} else if (legacyStatus === 'Rejected') {
				return res.status(403).json({
					status: 'fail',
					message: 'Medical Officer account verification was rejected.',
				})
			} else if (legacyStatus === 'Suspended') {
				return res.status(403).json({
					status: 'fail',
					message: 'Medical Officer account is suspended.',
				})
			} else {
				return res.status(403).json({
					status: 'fail',
					message: `Medical Officer verification status is '${legacyStatus}'. Verified status required.`,
				})
			}
		}
	}

	// Hospital Representative Lifecycle Authentication Guard
	if (user.role === 'HOSPITAL_ADMIN') {
		if (
			user.status === false ||
			(user.accountStatus && user.accountStatus !== 'Active') ||
			(user.representativeStatus && user.representativeStatus !== 'Active')
		) {
			const repStatus = user.representativeStatus || user.accountStatus || 'inactive'
			return res.status(403).json({
				status: 'fail',
				message: `Hospital Representative account is ${repStatus.toLowerCase()}. Access denied until administrative activation.`,
			})
		}
	}

	user.password = undefined

	const token = tokenGenerate(user._id, user.tokenVersion)

	return res.status(200).json({
		message: 'Login Successfully.',
		token,
		role: user.role,
		user: {
			_id: user._id,
			firstName: user.firstName,
			lastName: user.lastName,
			email: user.email,
			role: user.role,
			accountStatus: user.accountStatus,
			credentialStatus: user.credentialStatus,
			hospitalId: user.hospitalId,
			representativeStatus: user.representativeStatus,
		},
	})
})

module.exports = {
	tokenGenerate,
	loginMiddleware,
	login,
}
