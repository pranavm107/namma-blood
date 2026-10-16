const catchAsync = require('../Utils/catchAsync')
const crypto = require('crypto')
const { forgotPasswordEmail } = require('../Utils/emailContant')

const GENERIC_FORGOT_PASSWORD_MSG =
	'If an account with that email exists, password reset instructions have been sent.'

const forgotPassword = catchAsync(async (req, res, next) => {
	const email = (req.body.email || '').trim().toLowerCase()

	if (!email) {
		return res.status(400).json({
			message: 'Email address is required.',
		})
	}

	// 1) Find account by email
	const user = await req.model.findOne({ email })
	if (!user) {
		// Generic response prevents account enumeration
		return res.status(200).json({
			message: GENERIC_FORGOT_PASSWORD_MSG,
		})
	}

	// 2) Generate cryptographically secure random reset token (stored as SHA-256 hash in DB)
	const resetToken = user.createPasswordResetToken()
	await user.save({ validateBeforeSave: false })

	// 3) Send token via email without logging sensitive tokens
	try {
		await forgotPasswordEmail(resetToken, user.email)

		return res.status(200).json({
			message: GENERIC_FORGOT_PASSWORD_MSG,
		})
	} catch (err) {
		user.passwordResetToken = undefined
		user.passwordResetExpires = undefined
		await user.save({ validateBeforeSave: false })

		return res.status(500).json({
			message: 'There was an error sending the password reset email. Please try again later.',
		})
	}
})

const resetPassword = catchAsync(async (req, res, next) => {
	const { token } = req.params
	const { password, passwordConfirm } = req.body

	if (!token || typeof token !== 'string' || token.trim().length < 16) {
		return res.status(400).json({
			message: 'Password reset token is invalid or has expired.',
		})
	}

	if (!password || typeof password !== 'string') {
		return res.status(400).json({
			message: 'New password is required.',
		})
	}

	if (password.length < 8 || password.length > 20) {
		return res.status(400).json({
			message: 'Password must be between 8 and 20 characters.',
		})
	}

	if (password.includes(' ')) {
		return res.status(400).json({
			message: 'Password cannot contain spaces.',
		})
	}

	if (passwordConfirm !== undefined && password !== passwordConfirm) {
		return res.status(400).json({
			message: 'Password and password confirmation do not match.',
		})
	}

	// 1) Hash the incoming raw token using SHA-256 to compare with stored hash
	const hashAlgorithm = process.env.CREATEHASH_KEY || 'sha256'
	const hashedToken = crypto
		.createHash(hashAlgorithm)
		.update(token.trim())
		.digest('hex')

	const user = await req.model.findOne({
		passwordResetToken: hashedToken,
		passwordResetExpires: { $gt: Date.now() },
	})

	// 2) If token is invalid or expired, fail safely
	if (!user) {
		return res.status(400).json({
			message: 'Password reset token is invalid or has expired.',
		})
	}

	// 3) Invalidate token immediately to prevent reuse (single-use guarantee)
	user.password = password
	user.passwordResetToken = undefined
	user.passwordResetExpires = undefined

	// 4) Save user — schema pre('save') hashes password and sets passwordChangedAt
	await user.save()

	return res.status(200).json({
		message: 'Password Reset Successfully.',
	})
})

module.exports = {
	forgotPassword,
	resetPassword,
}
