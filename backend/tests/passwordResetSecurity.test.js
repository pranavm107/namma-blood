const { describe, it } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const { forgotPassword, resetPassword } = require('../Login_And_Authentication/forgotPassword')
const User = require('../User/userModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const Admin = require('../Admin/adminModel')
const emailContent = require('../Utils/emailContant')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'
process.env.JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '1h'

function createMockReqRes({ body = {}, params = {}, model = User } = {}) {
	const req = {
		body,
		params,
		model,
	}
	const res = {
		statusCode: 200,
		responseData: null,
		status(code) {
			this.statusCode = code
			return this
		},
		json(data) {
			this.responseData = data
			return this
		},
	}
	const next = (err) => {
		if (err) {
			res.statusCode = err.statusCode || 500
			res.responseData = { message: err.message }
		}
	}
	return { req, res, next }
}

describe('Password Reset & Credential Handling Security Hardening', () => {
	// -------------------------------------------------------------
	// 1. Generic Responses (Anti-Account Enumeration)
	// -------------------------------------------------------------
	describe('1. Anti-Account Enumeration (Generic Responses)', () => {
		it('should return identical generic response when email does not exist (200)', async () => {
			const originalFindOne = User.findOne
			User.findOne = async () => null // Account does not exist

			try {
				const { req, res, next } = createMockReqRes({
					body: { email: 'nonexistent@example.com' },
					model: User,
				})
				await forgotPassword(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.match(res.responseData.message, /If an account with that email exists/)
			} finally {
				User.findOne = originalFindOne
			}
		})

		it('should return identical generic response when email exists (200)', async () => {
			const originalFindOne = User.findOne
			const originalSave = User.prototype.save
			let emailSent = false

			const mockUser = new User({
				firstName: 'Pranav',
				lastName: 'User',
				gender: 'Male',
				dob: new Date('1995-01-01'),
				age: 28,
				phoneNo1: '9876543210',
				email: 'existing@example.com',
				state: 'Karnataka',
				city: 'Bengaluru',
				address: '123 Main St',
				pinCode: 560001,
				password: 'ExistingPassword123',
			})
			mockUser.save = async () => mockUser

			User.findOne = async () => mockUser

			try {
				const { req, res, next } = createMockReqRes({
					body: { email: 'existing@example.com' },
					model: User,
				})
				await forgotPassword(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.match(res.responseData.message, /If an account with that email exists/)
			} finally {
				User.findOne = originalFindOne
				User.prototype.save = originalSave
			}
		})

		it('should reject forgot password with empty email (400)', async () => {
			const { req, res, next } = createMockReqRes({
				body: { email: '   ' },
				model: User,
			})
			await forgotPassword(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Email address is required/)
		})
	})

	// -------------------------------------------------------------
	// 2. Cryptographic Token Generation & Hashing
	// -------------------------------------------------------------
	describe('2. Cryptographic Token Generation & Hashing', () => {
		it('should generate a 64-character random hex token and store only SHA-256 hash in User', () => {
			const user = new User()
			const rawToken = user.createPasswordResetToken()

			assert.strictEqual(typeof rawToken, 'string')
			assert.strictEqual(rawToken.length, 64) // 32 bytes in hex = 64 characters
			assert.notStrictEqual(user.passwordResetToken, rawToken, 'Stored token must not be raw token')

			// Verify hash matches SHA-256 of raw token
			const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex')
			assert.strictEqual(user.passwordResetToken, expectedHash)
			assert.ok(user.passwordResetExpires > Date.now())
		})

		it('should generate secure reset token in Bloodbank model and verify crypto import', () => {
			const bloodbank = new Bloodbank()
			const rawToken = bloodbank.createPasswordResetToken()

			assert.strictEqual(rawToken.length, 64)
			const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex')
			assert.strictEqual(bloodbank.passwordResetToken, expectedHash)
			assert.ok(bloodbank.passwordResetExpires > Date.now())
		})

		it('should generate secure reset token in Admin model and verify crypto import', () => {
			const admin = new Admin()
			const rawToken = admin.createPasswordResetToken()

			assert.strictEqual(rawToken.length, 64)
			const expectedHash = crypto.createHash('sha256').update(rawToken).digest('hex')
			assert.strictEqual(admin.passwordResetToken, expectedHash)
			assert.ok(admin.passwordResetExpires > Date.now())
		})
	})

	// -------------------------------------------------------------
	// 3. Single-Use Invalidation & Expiry
	// -------------------------------------------------------------
	describe('3. Single-Use Invalidation & Expiry', () => {
		it('should reset password, invalidate token after single use, and update passwordChangedAt', async () => {
			const rawToken = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
			const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex')

			let savedPassword = null
			const mockUser = {
				_id: new mongoose.Types.ObjectId(),
				passwordResetToken: hashedToken,
				passwordResetExpires: Date.now() + 10 * 60 * 1000,
				save: async function () {
					savedPassword = this.password
					this.passwordChangedAt = new Date(Date.now() - 1000)
					return this
				},
			}

			const originalFindOne = User.findOne
			User.findOne = async (query) => {
				if (query.passwordResetToken === hashedToken && query.passwordResetExpires.$gt) {
					return mockUser
				}
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					params: { token: rawToken },
					body: {
						password: 'NewSecurePassword123',
						passwordConfirm: 'NewSecurePassword123',
					},
					model: User,
				})
				await resetPassword(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'Password Reset Successfully.')
				assert.strictEqual(savedPassword, 'NewSecurePassword123')
				// Verify token was invalidated
				assert.strictEqual(mockUser.passwordResetToken, undefined)
				assert.strictEqual(mockUser.passwordResetExpires, undefined)
				// Verify passwordChangedAt was set
				assert.ok(mockUser.passwordChangedAt !== undefined)
			} finally {
				User.findOne = originalFindOne
			}
		})

		it('should prevent reusing the reset token a second time (400)', async () => {
			const rawToken = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
			const originalFindOne = User.findOne
			// On second attempt, token in DB is undefined so findOne returns null
			User.findOne = async () => null

			try {
				const { req, res, next } = createMockReqRes({
					params: { token: rawToken },
					body: { password: 'SecondPass123' },
					model: User,
				})
				await resetPassword(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Password reset token is invalid or has expired/)
			} finally {
				User.findOne = originalFindOne
			}
		})

		it('should reject reset attempt when token is expired (400)', async () => {
			const originalFindOne = User.findOne
			User.findOne = async () => null // Query { passwordResetExpires: { $gt: Date.now() } } returns null

			try {
				const { req, res, next } = createMockReqRes({
					params: { token: 'validlengthtoken1234567890abcdef' },
					body: { password: 'NewPassword123' },
					model: User,
				})
				await resetPassword(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Password reset token is invalid or has expired/)
			} finally {
				User.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 4. Input Validation & Error Handling
	// -------------------------------------------------------------
	describe('4. Input Validation & Mismatch Rejection', () => {
		it('should reject password reset when password and confirmation do not match (400)', async () => {
			const { req, res, next } = createMockReqRes({
				params: { token: 'validtokenwithproperlength123456' },
				body: {
					password: 'Password1234',
					passwordConfirm: 'DifferentPassword5678',
				},
				model: User,
			})
			await resetPassword(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Password and password confirmation do not match/)
		})

		it('should reject password reset when password is too short (400)', async () => {
			const { req, res, next } = createMockReqRes({
				params: { token: 'validtokenwithproperlength123456' },
				body: { password: 'short' },
				model: User,
			})
			await resetPassword(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /between 8 and 20 characters/)
		})

		it('should reject reset attempt with malformed token parameter (400)', async () => {
			const { req, res, next } = createMockReqRes({
				params: { token: 'short' },
				body: { password: 'ValidPassword123' },
				model: User,
			})
			await resetPassword(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Password reset token is invalid or has expired/)
		})
	})

	// -------------------------------------------------------------
	// 5. Credential Leakage in Emails
	// -------------------------------------------------------------
	describe('5. Credential Leakage Prevention in Emails', () => {
		it('should not include plaintext passwords in registerBloodbankEmail function', () => {
			const fnString = emailContent.registerBloodbankEmail.toString()
			assert.ok(!fnString.includes('Password: ${password}'), 'Plaintext password must not be interpolated in email')
			assert.ok(!fnString.includes('password) =>'), 'Function must not accept password parameter')
		})

		it('should not include plaintext passwords in registerUserEmail function', () => {
			const fnString = emailContent.registerUserEmail.toString()
			assert.ok(!fnString.includes('Password:'), 'User email must never contain password')
		})
	})

	// -------------------------------------------------------------
	// 6. JWT Password Change Boundary Invalidation Across Models
	// -------------------------------------------------------------
	describe('6. JWT Invalidation Boundary & Token-Version Verification Across Models', () => {
		const changeTimeMs = 1700000000000 // Fixed reference timestamp
		const changeSec = Math.floor(changeTimeMs / 1000)

		describe('User Model', () => {
			it('should reject tokens with older tokenVersion and accept current tokenVersion', () => {
				const user = new User({
					passwordChangedAt: new Date(changeTimeMs),
					tokenVersion: 2,
				})

				// Token with older tokenVersion (0 or 1) must be rejected
				assert.strictEqual(user.changedPasswordAfter(changeSec + 10, 0), true, 'Older tokenVersion=0 must be rejected')
				assert.strictEqual(user.changedPasswordAfter(changeSec + 10, 1), true, 'Older tokenVersion=1 must be rejected')

				// Token with matching current tokenVersion must be accepted even if issued in same second
				assert.strictEqual(user.changedPasswordAfter(changeSec, 2), false, 'Matching current tokenVersion=2 must be accepted')

				// Token issued after with matching tokenVersion
				assert.strictEqual(user.changedPasswordAfter(changeSec + 1, 2), false, 'Current tokenVersion issued after change must be accepted')
			})

			it('should fallback to timestamp invalidation when token has no tokenVersion', () => {
				const user = new User({
					passwordChangedAt: new Date(changeTimeMs),
					tokenVersion: 1,
				})

				// Token without tokenVersion issued before change
				assert.strictEqual(user.changedPasswordAfter(changeSec - 1), true, 'Legacy token issued before must be rejected')
				// Token without tokenVersion issued at boundary
				assert.strictEqual(user.changedPasswordAfter(changeSec), true, 'Legacy token issued at boundary must be rejected')
				// Token without tokenVersion issued after change
				assert.strictEqual(user.changedPasswordAfter(changeSec + 1), false, 'Legacy token issued after must be accepted')
				// Missing iat
				assert.strictEqual(user.changedPasswordAfter(undefined), true, 'Missing iat must be rejected')
			})

			it('should allow fresh user where password was never changed', () => {
				const freshUser = new User()
				assert.strictEqual(freshUser.changedPasswordAfter(changeSec, 0), false, 'Fresh user token must be accepted')
			})
		})

		describe('Bloodbank Model', () => {
			it('should reject older tokenVersion and fallback to timestamp correctly', () => {
				const bloodbank = new Bloodbank({
					passwordChangedAt: new Date(changeTimeMs),
					tokenVersion: 1,
				})

				assert.strictEqual(bloodbank.changedPasswordAfter(changeSec + 5, 0), true, 'Older tokenVersion must be rejected')
				assert.strictEqual(bloodbank.changedPasswordAfter(changeSec, 1), false, 'Current tokenVersion must be accepted')
				assert.strictEqual(bloodbank.changedPasswordAfter(changeSec - 1), true, 'Legacy token issued before must be rejected')
				assert.strictEqual(bloodbank.changedPasswordAfter(changeSec + 1), false, 'Legacy token issued after must be accepted')
			})
		})

		describe('Admin Model', () => {
			it('should reject older tokenVersion and fallback to timestamp correctly', () => {
				const admin = new Admin({
					passwordChangedAt: new Date(changeTimeMs),
					tokenVersion: 1,
				})

				assert.strictEqual(admin.changedPasswordAfter(changeSec + 5, 0), true, 'Older tokenVersion must be rejected')
				assert.strictEqual(admin.changedPasswordAfter(changeSec, 1), false, 'Current tokenVersion must be accepted')
				assert.strictEqual(admin.changedPasswordAfter(changeSec - 1), true, 'Legacy token issued before must be rejected')
				assert.strictEqual(admin.changedPasswordAfter(changeSec + 1), false, 'Legacy token issued after must be accepted')
			})
		})

		describe('Token-Version Token Generation (No Future-Issued JWTs)', () => {
			const { tokenGenerate } = require('../Login_And_Authentication/login')
			const jwt = require('jsonwebtoken')

			it('should generate JWT with natural iat and encode tokenVersion without future timestamps', () => {
				const beforeSign = Math.floor(Date.now() / 1000)
				const token = tokenGenerate('user123', 3)
				const afterSign = Math.floor(Date.now() / 1000)
				const decoded = jwt.decode(token)

				// Verify iat is current, NOT in the future
				assert.ok(decoded.iat >= beforeSign && decoded.iat <= afterSign, `iat (${decoded.iat}) must be within [${beforeSign}, ${afterSign}] and never in the future`)
				assert.strictEqual(decoded.tokenVersion, 3, 'JWT payload must contain tokenVersion')

				// Verify immediate verification against user with matching tokenVersion
				const user = new User({
					passwordChangedAt: new Date(decoded.iat * 1000),
					tokenVersion: 3,
				})
				assert.strictEqual(user.changedPasswordAfter(decoded.iat, decoded.tokenVersion), false, 'Immediate login token must be valid')
			})
		})
	})

	// -------------------------------------------------------------
	// 7. Token-Version Edge Cases & Full Password-Reset Invalidation Lifecycle
	// -------------------------------------------------------------
	describe('7. Token-Version Edge Cases & Invalidation Lifecycle Audit', () => {
		const changeTimeMs = 1700000000000
		const changeSec = Math.floor(changeTimeMs / 1000)

		it('should reject malformed or non-numeric iat (NaN, string, null, zero) when password was changed', () => {
			const user = new User({
				passwordChangedAt: new Date(changeTimeMs),
				tokenVersion: 1,
			})

			assert.strictEqual(user.changedPasswordAfter(NaN), true, 'NaN iat must be rejected')
			assert.strictEqual(user.changedPasswordAfter('malformed'), true, 'String iat must be rejected')
			assert.strictEqual(user.changedPasswordAfter(null), true, 'Null iat must be rejected')
			assert.strictEqual(user.changedPasswordAfter(0), true, 'Zero iat must be rejected')
		})

		it('should reject malformed or missing iat even for accounts where password was never changed', () => {
			const freshUser = new User() // passwordChangedAt is undefined

			assert.strictEqual(freshUser.changedPasswordAfter(undefined), true, 'Missing iat must be rejected even if password never changed')
			assert.strictEqual(freshUser.changedPasswordAfter(null), true, 'Null iat must be rejected even if password never changed')
			assert.strictEqual(freshUser.changedPasswordAfter(NaN), true, 'NaN iat must be rejected even if password never changed')
			assert.strictEqual(freshUser.changedPasswordAfter('malformed'), true, 'String iat must be rejected even if password never changed')
			assert.strictEqual(freshUser.changedPasswordAfter(0), true, 'Zero iat must be rejected even if password never changed')
			assert.strictEqual(freshUser.changedPasswordAfter(-100), true, 'Negative iat must be rejected even if password never changed')
		})

		it('should safely handle account documents missing tokenVersion property (undefined) via timestamp fallback', () => {
			const user = new User({
				passwordChangedAt: new Date(changeTimeMs),
			})
			user.tokenVersion = undefined

			// Stale token issued before change
			assert.strictEqual(user.changedPasswordAfter(changeSec - 1), true, 'Must reject stale token via fallback')
			// Token issued after change
			assert.strictEqual(user.changedPasswordAfter(changeSec + 1), false, 'Must accept post-change token via fallback')
		})

		it('should execute complete User password-reset lifecycle: invalidate old token, issue new version, and accept immediate login', async () => {
			const { tokenGenerate } = require('../Login_And_Authentication/login')
			const rawToken = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
			const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex')

			// 1. User has tokenVersion = 0 and an active session token T1
			const userDoc = new User({
				_id: new mongoose.Types.ObjectId(),
				email: 'alice@example.com',
				password: 'OldPassword123',
				tokenVersion: 0,
				passwordResetToken: hashedToken,
				passwordResetExpires: Date.now() + 600000,
			})
			const tokenT1 = tokenGenerate(userDoc._id.toString(), userDoc.tokenVersion)
			assert.strictEqual(userDoc.changedPasswordAfter(jwt.decode(tokenT1).iat, jwt.decode(tokenT1).tokenVersion), false, 'Initial token T1 must be active')

			// 2. Perform password reset
			userDoc.password = 'NewSecurePassword123'
			userDoc.passwordResetToken = undefined
			userDoc.passwordResetExpires = undefined
			// Simulate pre('save') hook
			userDoc.passwordChangedAt = Date.now()
			userDoc.tokenVersion = (userDoc.tokenVersion || 0) + 1

			// 3. Verify old token T1 is now strictly invalidated
			assert.strictEqual(userDoc.changedPasswordAfter(jwt.decode(tokenT1).iat, jwt.decode(tokenT1).tokenVersion), true, 'Old session token T1 must be invalidated after password reset')

			// 4. User immediately logs in with new credentials, receives token T2
			const tokenT2 = tokenGenerate(userDoc._id.toString(), userDoc.tokenVersion)
			assert.strictEqual(jwt.decode(tokenT2).tokenVersion, 1, 'New token T2 must have incremented tokenVersion')

			// 5. Verify token T2 is accepted immediately
			assert.strictEqual(userDoc.changedPasswordAfter(jwt.decode(tokenT2).iat, jwt.decode(tokenT2).tokenVersion), false, 'New login token T2 must be accepted immediately')
		})

		it('should execute complete Admin password-reset lifecycle: invalidate old token, issue new version, and accept immediate login', () => {
			const { tokenGenerate } = require('../Login_And_Authentication/login')
			const adminDoc = new Admin({
				_id: new mongoose.Types.ObjectId(),
				email: 'admin@example.com',
				password: 'OldAdminPassword1',
				tokenVersion: 0,
			})
			const adminToken1 = tokenGenerate(adminDoc._id.toString(), adminDoc.tokenVersion)
			assert.strictEqual(adminDoc.changedPasswordAfter(jwt.decode(adminToken1).iat, jwt.decode(adminToken1).tokenVersion), false)

			// Admin resets password
			adminDoc.password = 'NewAdminPassword2'
			adminDoc.passwordChangedAt = Date.now()
			adminDoc.tokenVersion = (adminDoc.tokenVersion || 0) + 1

			// Old token rejected
			assert.strictEqual(adminDoc.changedPasswordAfter(jwt.decode(adminToken1).iat, jwt.decode(adminToken1).tokenVersion), true, 'Old admin token must be rejected')

			// New token accepted immediately
			const adminToken2 = tokenGenerate(adminDoc._id.toString(), adminDoc.tokenVersion)
			assert.strictEqual(adminDoc.changedPasswordAfter(jwt.decode(adminToken2).iat, jwt.decode(adminToken2).tokenVersion), false, 'New admin token must be accepted')
		})

		it('should execute complete Bloodbank password-reset lifecycle: invalidate old token, issue new version, and accept immediate login', () => {
			const { tokenGenerate } = require('../Login_And_Authentication/login')
			const bankDoc = new Bloodbank({
				_id: new mongoose.Types.ObjectId(),
				email: 'bank@example.com',
				password: 'OldBankPassword1',
				tokenVersion: 0,
			})
			const bankToken1 = tokenGenerate(bankDoc._id.toString(), bankDoc.tokenVersion)
			assert.strictEqual(bankDoc.changedPasswordAfter(jwt.decode(bankToken1).iat, jwt.decode(bankToken1).tokenVersion), false)

			// Bank resets password
			bankDoc.password = 'NewBankPassword2'
			bankDoc.passwordChangedAt = Date.now()
			bankDoc.tokenVersion = (bankDoc.tokenVersion || 0) + 1

			// Old token rejected
			assert.strictEqual(bankDoc.changedPasswordAfter(jwt.decode(bankToken1).iat, jwt.decode(bankToken1).tokenVersion), true, 'Old bank token must be rejected')

			// New token accepted immediately
			const bankToken2 = tokenGenerate(bankDoc._id.toString(), bankDoc.tokenVersion)
			assert.strictEqual(bankDoc.changedPasswordAfter(jwt.decode(bankToken2).iat, jwt.decode(bankToken2).tokenVersion), false, 'New bank token must be accepted')
		})
	})
})
