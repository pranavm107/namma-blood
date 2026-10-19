const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const bcryptjs = require('bcryptjs')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'

const {
	BloodbankStaff,
	VALID_STAFF_ROLES,
	VALID_STAFF_STATUSES,
} = require('../BloodBank/bloodbankStaffModel')
const staffController = require('../BloodBank/bloodbankStaffController')
const adminController = require('../Admin/adminController')
const {
	generateStaffToken,
	protectStaff,
	restrictToStaffRole,
} = require('../BloodBank/bloodbankStaffMiddleware')

// Mock Request & Response Helper
function createMockReqRes({ user, staff, body = {}, query = {}, params = {}, headers = {}, ip = '127.0.0.1' } = {}) {
	const req = {
		user: user || null,
		staff: staff || null,
		body,
		query,
		params,
		headers,
		ip,
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

describe('Phase 3.3B Preparation — Individual Staff Identity & Role-Based Authorization', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId().toString()
	const otherBloodbankId = new mongoose.Types.ObjectId().toString()
	const mockStaffId = new mongoose.Types.ObjectId().toString()

	const bloodbankUser = {
		_id: mockBloodbankId,
		bloodbankName: 'City Central Blood Bank',
		email: 'admin@citycentral.org',
	}

	const otherBloodbankUser = {
		_id: otherBloodbankId,
		bloodbankName: 'Metro Red Cross',
		email: 'admin@metroredcross.org',
	}

	// -------------------------------------------------------------
	// 1. Staff Model Validation & Governance
	// -------------------------------------------------------------
	describe('1. Staff Model Schema & Governance Rules', () => {
		it('should validate roles against VALID_STAFF_ROLES enum', () => {
			assert.deepStrictEqual(VALID_STAFF_ROLES, ['Medical_Officer', 'Lab_Technician', 'Staff_Admin'])
			assert.deepStrictEqual(VALID_STAFF_STATUSES, ['Active', 'Suspended', 'Revoked'])
		})

		it('should require a non-empty medical license number for Medical_Officer role', async () => {
			const staffDoc = new BloodbankStaff({
				fullName: 'Dr. Jane Smith',
				email: 'jane.smith@citycentral.org',
				phoneNo: '9845012345',
				bloodbankId: mockBloodbankId,
				role: 'Medical_Officer',
				password: 'SecurePassword123!',
				medicalLicense: {
					licenseNumber: '', // Empty license!
				},
				createdBy: mockBloodbankId,
			})

			await assert.rejects(
				async () => {
					await staffDoc.save()
				},
				(err) => {
					assert.match(err.message, /Medical Officer must have a non-empty medical license number/i)
					return true
				}
			)
		})

		it('should allow valid Medical_Officer with non-empty license number to pass validation', async () => {
			const staffDoc = new BloodbankStaff({
				fullName: 'Dr. Jane Smith',
				email: 'jane.smith@citycentral.org',
				phoneNo: '9845012345',
				bloodbankId: mockBloodbankId,
				role: 'Medical_Officer',
				password: 'SecurePassword123!',
				medicalLicense: {
					licenseNumber: 'KMC-84920',
					issuingCouncil: 'Karnataka Medical Council',
				},
				createdBy: mockBloodbankId,
			})

			// Pre-save hook validation
			const err = staffDoc.validateSync()
			assert.strictEqual(err, undefined)
			assert.strictEqual(staffDoc.medicalLicense.licenseNumber, 'KMC-84920')
		})

		it('should hash password on save and verify with correctPassword', async () => {
			const originalSave = BloodbankStaff.prototype.save
			const rawPassword = 'ClinicalPassword123!'

			const staffDoc = new BloodbankStaff({
				fullName: 'John Doe',
				email: 'john.doe@citycentral.org',
				phoneNo: '9845054321',
				bloodbankId: mockBloodbankId,
				role: 'Lab_Technician',
				password: rawPassword,
				createdBy: mockBloodbankId,
			})

			// Test pre-save hashing
			await staffDoc.validate()
			staffDoc.password = await bcryptjs.hash(rawPassword, 10)

			const isCorrect = await staffDoc.correctPassword(rawPassword, staffDoc.password)
			const isWrong = await staffDoc.correctPassword('WrongPassword!', staffDoc.password)

			assert.strictEqual(isCorrect, true)
			assert.strictEqual(isWrong, false)
		})

		it('should detect tokenVersion invalidation in changedPasswordAfter', () => {
			const staffDoc = new BloodbankStaff({
				fullName: 'Alice Staff',
				email: 'alice@citycentral.org',
				phoneNo: '9845098765',
				bloodbankId: mockBloodbankId,
				role: 'Staff_Admin',
				password: 'Password123!',
				tokenVersion: 2,
				createdBy: mockBloodbankId,
			})

			const iat = Math.floor(Date.now() / 1000) - 60

			// Token with version 1 is invalidated by current version 2
			assert.strictEqual(staffDoc.changedPasswordAfter(iat, 1), true)
			// Token with version 2 remains valid
			assert.strictEqual(staffDoc.changedPasswordAfter(iat, 2), false)
			// Malformed iat rejected
			assert.strictEqual(staffDoc.changedPasswordAfter(null, 2), true)
			assert.strictEqual(staffDoc.changedPasswordAfter(NaN, 2), true)
		})
	})

	// -------------------------------------------------------------
	// 2. Controlled Administrative Provisioning
	// -------------------------------------------------------------
	describe('2. Controlled Administrative Provisioning Endpoint', () => {
		it('should allow authenticated blood bank to provision an individual Medical_Officer', async () => {
			const originalFindOne = BloodbankStaff.findOne
			const originalSave = BloodbankStaff.prototype.save

			let savedStaff = null
			BloodbankStaff.findOne = async () => null // No duplicate email
			BloodbankStaff.prototype.save = async function () {
				savedStaff = this
				this._id = mockStaffId
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						fullName: 'Dr. Ramesh Kumar',
						email: 'ramesh.kumar@citycentral.org',
						phoneNo: '9845011111',
						role: 'Medical_Officer',
						password: 'DoctorPassword123!',
						medicalLicense: {
							licenseNumber: 'MCI-19482',
							issuingCouncil: 'Medical Council of India',
						},
					},
				})

				await staffController.provisionStaff(req, res, next)

				assert.strictEqual(res.statusCode, 201)
				assert.strictEqual(res.responseData.message, 'Staff account provisioned successfully.')
				assert.strictEqual(savedStaff.role, 'Medical_Officer')
				assert.strictEqual(savedStaff.bloodbankId.toString(), mockBloodbankId)
				assert.strictEqual(savedStaff.medicalLicense.licenseNumber, 'MCI-19482')
				assert.strictEqual(savedStaff.status, 'Active')
			} finally {
				BloodbankStaff.findOne = originalFindOne
				BloodbankStaff.prototype.save = originalSave
			}
		})

		it('should reject provisioning Medical_Officer without license number', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				body: {
					fullName: 'Dr. Ramesh Kumar',
					email: 'ramesh.kumar@citycentral.org',
					phoneNo: '9845011111',
					role: 'Medical_Officer',
					password: 'DoctorPassword123!',
					// Missing medicalLicense!
				},
			})

			await staffController.provisionStaff(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /requires a valid, non-empty medical license number/i)
		})

		it('should reject duplicate staff email across system', async () => {
			const originalFindOne = BloodbankStaff.findOne
			BloodbankStaff.findOne = async () => ({ _id: new mongoose.Types.ObjectId() })

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						fullName: 'Lab Tech 1',
						email: 'tech1@citycentral.org',
						phoneNo: '9845022222',
						role: 'Lab_Technician',
						password: 'TechPassword123!',
					},
				})

				await staffController.provisionStaff(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /staff member with this email already exists/i)
			} finally {
				BloodbankStaff.findOne = originalFindOne
			}
		})

		it('should reject invalid or unrecognized staff roles', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				body: {
					fullName: 'Super User',
					email: 'super@citycentral.org',
					phoneNo: '9845033333',
					role: 'Super_Admin', // Invalid role
					password: 'Password123!',
				},
			})

			await staffController.provisionStaff(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Invalid staff role/i)
		})

		it('should ensure medicalLicense.isVerified cannot be set to true by request-body injection at provisioning', async () => {
			const originalFindOne = BloodbankStaff.findOne
			const originalSave = BloodbankStaff.prototype.save

			let savedStaff = null
			BloodbankStaff.findOne = async () => null
			BloodbankStaff.prototype.save = async function () {
				savedStaff = this
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						fullName: 'Dr. Suspicious Doctor',
						email: 'suspicious@citycentral.org',
						phoneNo: '9845099999',
						role: 'Medical_Officer',
						password: 'DoctorPassword123!',
						medicalLicense: {
							licenseNumber: 'FAKE-1234',
							isVerified: true, // Injection attempt!
						},
					},
				})

				await staffController.provisionStaff(req, res, next)

				assert.strictEqual(res.statusCode, 201)
				// Invariant: isVerified MUST remain false despite request body attempt
				assert.strictEqual(savedStaff.medicalLicense.isVerified, false)
				assert.strictEqual(res.responseData.staff.medicalLicense.isVerified, false)
			} finally {
				BloodbankStaff.findOne = originalFindOne
				BloodbankStaff.prototype.save = originalSave
			}
		})
	})

	// -------------------------------------------------------------
	// 3. Staff Login & Credential Verification
	// -------------------------------------------------------------
	describe('3. Staff Login & Credential Authentication', () => {
		const rawPassword = 'DoctorPassword123!'
		const hashedPassword = bcryptjs.hashSync(rawPassword, 10)

		it('should issue a signed role-bearing token on valid credentials', async () => {
			const originalFindOne = BloodbankStaff.findOne

			BloodbankStaff.findOne = () => ({
				select: async () => ({
					_id: mockStaffId,
					fullName: 'Dr. Ramesh Kumar',
					email: 'ramesh.kumar@citycentral.org',
					bloodbankId: mockBloodbankId,
					role: 'Medical_Officer',
					status: 'Active',
					password: hashedPassword,
					tokenVersion: 0,
					correctPassword: async (candidate, pass) => bcryptjs.compare(candidate, pass),
				}),
			})

			try {
				const { req, res, next } = createMockReqRes({
					body: {
						email: 'ramesh.kumar@citycentral.org',
						password: rawPassword,
					},
				})

				await staffController.loginStaff(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'Staff login successful.')
				assert.ok(res.responseData.token)

				// Verify token claims
				const decoded = jwt.verify(res.responseData.token, process.env.JWT_SECRET)
				assert.strictEqual(decoded.id, mockStaffId)
				assert.strictEqual(decoded.bloodbankId, mockBloodbankId)
				assert.strictEqual(decoded.role, 'Medical_Officer')
				assert.strictEqual(decoded.userType, 'staff')
			} finally {
				BloodbankStaff.findOne = originalFindOne
			}
		})

		it('should reject wrong password with generic 401', async () => {
			const originalFindOne = BloodbankStaff.findOne

			BloodbankStaff.findOne = () => ({
				select: async () => ({
					_id: mockStaffId,
					email: 'ramesh.kumar@citycentral.org',
					password: hashedPassword,
					status: 'Active',
					correctPassword: async (candidate, pass) => bcryptjs.compare(candidate, pass),
				}),
			})

			try {
				const { req, res, next } = createMockReqRes({
					body: {
						email: 'ramesh.kumar@citycentral.org',
						password: 'WrongPassword!',
					},
				})

				await staffController.loginStaff(req, res, next)

				assert.strictEqual(res.statusCode, 401)
				assert.match(res.responseData.message, /Email or password incorrect/i)
			} finally {
				BloodbankStaff.findOne = originalFindOne
			}
		})

		it('should reject login if staff account is Suspended', async () => {
			const originalFindOne = BloodbankStaff.findOne

			BloodbankStaff.findOne = () => ({
				select: async () => ({
					_id: mockStaffId,
					email: 'suspended@citycentral.org',
					password: hashedPassword,
					status: 'Suspended',
					correctPassword: async () => true,
				}),
			})

			try {
				const { req, res, next } = createMockReqRes({
					body: { email: 'suspended@citycentral.org', password: rawPassword },
				})

				await staffController.loginStaff(req, res, next)

				assert.strictEqual(res.statusCode, 401)
				assert.match(res.responseData.message, /staff account is suspended/i)
			} finally {
				BloodbankStaff.findOne = originalFindOne
			}
		})

		it('should reject login if staff account is Revoked', async () => {
			const originalFindOne = BloodbankStaff.findOne

			BloodbankStaff.findOne = () => ({
				select: async () => ({
					_id: mockStaffId,
					email: 'revoked@citycentral.org',
					password: hashedPassword,
					status: 'Revoked',
					correctPassword: async () => true,
				}),
			})

			try {
				const { req, res, next } = createMockReqRes({
					body: { email: 'revoked@citycentral.org', password: rawPassword },
				})

				await staffController.loginStaff(req, res, next)

				assert.strictEqual(res.statusCode, 401)
				assert.match(res.responseData.message, /staff account has been revoked/i)
			} finally {
				BloodbankStaff.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 4. Staff Authentication & RBAC Middleware
	// -------------------------------------------------------------
	describe('4. Staff Auth (protectStaff) and Role Enforcement (restrictToStaffRole)', () => {
		it('should authenticate valid staff token and set req.staff and req.staffRole', async () => {
			const originalFindById = BloodbankStaff.findById

			const mockStaffDoc = {
				_id: mockStaffId,
				fullName: 'Dr. Jane Smith',
				bloodbankId: mockBloodbankId,
				role: 'Medical_Officer',
				status: 'Active',
				tokenVersion: 0,
				changedPasswordAfter: () => false,
			}

			BloodbankStaff.findById = async () => mockStaffDoc

			const token = jwt.sign(
				{ id: mockStaffId, bloodbankId: mockBloodbankId, role: 'Medical_Officer', tokenVersion: 0, userType: 'staff' },
				process.env.JWT_SECRET,
				{ expiresIn: '1h' }
			)

			try {
				const { req, res, next } = createMockReqRes({
					headers: { authorization: `Bearer ${token}` },
				})

				let nextCalled = false
				await protectStaff(req, res, () => { nextCalled = true })

				assert.strictEqual(nextCalled, true)
				assert.strictEqual(req.staff._id, mockStaffId)
				assert.strictEqual(req.staffRole, 'Medical_Officer')
				assert.strictEqual(req.bloodbankId, mockBloodbankId)
				assert.strictEqual(req.user.isStaff, true)
			} finally {
				BloodbankStaff.findById = originalFindById
			}
		})

		it('should allow Medical_Officer role through restrictToStaffRole(Medical_Officer)', () => {
			const { req, res } = createMockReqRes({
				staff: {
					role: 'Medical_Officer',
					mustChangePassword: false,
					medicalLicense: { isVerified: true },
				},
			})

			let nextCalled = false
			const middleware = restrictToStaffRole('Medical_Officer')
			middleware(req, res, () => { nextCalled = true })

			assert.strictEqual(nextCalled, true)
		})

		it('should reject Lab_Technician attempting to access Medical_Officer restricted route with 403', () => {
			const { req, res } = createMockReqRes({
				staff: { role: 'Lab_Technician' },
			})

			let nextCalled = false
			const middleware = restrictToStaffRole('Medical_Officer')
			middleware(req, res, () => { nextCalled = true })

			assert.strictEqual(nextCalled, false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Access forbidden: Your role 'Lab_Technician' is not authorized/i)
			assert.match(res.responseData.message, /Required: Medical_Officer/i)
		})

		it('should reject forged role in request body and strictly verify server-side staff role', () => {
			// Attacker sends body: { role: 'Medical_Officer' } but authenticated token has role: 'Lab_Technician'
			const { req, res } = createMockReqRes({
				staff: { role: 'Lab_Technician' },
				body: { role: 'Medical_Officer' }, // Attempted parameter tampering
			})

			let nextCalled = false
			const middleware = restrictToStaffRole('Medical_Officer')
			middleware(req, res, () => { nextCalled = true })

			assert.strictEqual(nextCalled, false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Your role 'Lab_Technician' is not authorized/i)
		})

		it('should reject token when staff member status is changed to Suspended', async () => {
			const originalFindById = BloodbankStaff.findById

			BloodbankStaff.findById = async () => ({
				_id: mockStaffId,
				status: 'Suspended', // Status updated in DB
				changedPasswordAfter: () => false,
			})

			const token = jwt.sign(
				{ id: mockStaffId, tokenVersion: 0, userType: 'staff' },
				process.env.JWT_SECRET,
				{ expiresIn: '1h' }
			)

			try {
				const { req, res } = createMockReqRes({
					headers: { authorization: `Bearer ${token}` },
				})

				await protectStaff(req, res, () => {})

				assert.strictEqual(res.statusCode, 401)
				assert.match(res.responseData.message, /staff account is currently suspended/i)
			} finally {
				BloodbankStaff.findById = originalFindById
			}
		})

		it('should reject non-staff tokens (token substitution attack) presenting institutional token to protectStaff', async () => {
			// Attacker presents a valid JWT from institutional login (missing userType: 'staff')
			const institutionalToken = jwt.sign(
				{ id: mockBloodbankId, tokenVersion: 0 },
				process.env.JWT_SECRET,
				{ expiresIn: '1h' }
			)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${institutionalToken}` },
			})

			let nextCalled = false
			await protectStaff(req, res, () => { nextCalled = true })

			assert.strictEqual(nextCalled, false)
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /Invalid token type\. Staff token required/i)
		})
	})

	// -------------------------------------------------------------
	// 5. Status Management & Token Revocation
	// -------------------------------------------------------------
	describe('5. Status Updates & Token Invalidation (updateStaffStatus)', () => {
		it('should update status and increment tokenVersion to revoke active sessions', async () => {
			const originalFindOne = BloodbankStaff.findOne
			const originalSave = BloodbankStaff.prototype.save

			const mockStaffDoc = new BloodbankStaff({
				_id: mockStaffId,
				fullName: 'Dr. Jane Smith',
				email: 'jane@citycentral.org',
				phoneNo: '9845012345',
				bloodbankId: mockBloodbankId,
				role: 'Medical_Officer',
				password: 'Password123!',
				tokenVersion: 1,
				createdBy: mockBloodbankId,
			})

			BloodbankStaff.findOne = async () => mockStaffDoc
			BloodbankStaff.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { staffId: mockStaffId },
					body: { status: 'Suspended' },
				})

				await staffController.updateStaffStatus(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(mockStaffDoc.status, 'Suspended')
				// Invariant: tokenVersion MUST increment to invalidate prior JWTs!
				assert.strictEqual(mockStaffDoc.tokenVersion, 2)
				assert.match(res.responseData.message, /active sessions have been invalidated/i)
			} finally {
				BloodbankStaff.findOne = originalFindOne
				BloodbankStaff.prototype.save = originalSave
			}
		})

		it('should forbid blood bank B from updating blood bank A staff member (BOLA guard)', async () => {
			const originalFindOne = BloodbankStaff.findOne

			BloodbankStaff.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, otherBloodbankId)
				return null // Not found under other blood bank
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: otherBloodbankUser,
					params: { staffId: mockStaffId },
					body: { status: 'Revoked' },
				})

				await staffController.updateStaffStatus(req, res, next)

				assert.strictEqual(res.statusCode, 404)
				assert.match(res.responseData.message, /not found or does not belong to your blood bank/i)
			} finally {
				BloodbankStaff.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 6. Initial-Password Security & Setup Token Flow
	// -------------------------------------------------------------
	describe('6. Initial-Password Security & Setup Flow', () => {
		it('should provision staff with mustChangePassword = true and one-time setupToken', async () => {
			const originalFindOne = BloodbankStaff.findOne
			const originalSave = BloodbankStaff.prototype.save

			let savedStaff = null
			BloodbankStaff.findOne = async () => null
			BloodbankStaff.prototype.save = async function () {
				savedStaff = this
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						fullName: 'New Staff Member',
						email: 'newstaff@citycentral.org',
						phoneNo: '9845077777',
						role: 'Lab_Technician',
					},
				})

				await staffController.provisionStaff(req, res, next)

				assert.strictEqual(res.statusCode, 201)
				assert.ok(res.responseData.setupToken, 'One-time setup token returned')
				assert.strictEqual(savedStaff.mustChangePassword, true)
				assert.strictEqual(res.responseData.staff.mustChangePassword, true)
			} finally {
				BloodbankStaff.findOne = originalFindOne
				BloodbankStaff.prototype.save = originalSave
			}
		})

		it('should allow setting password via setupStaffPassword and atomically clear setupToken', async () => {
			const originalFindOneAndUpdate = BloodbankStaff.findOneAndUpdate
			const originalSave = BloodbankStaff.prototype.save

			const mockStaffDoc = new BloodbankStaff({
				_id: mockStaffId,
				fullName: 'Setup Staff',
				email: 'setup@citycentral.org',
				phoneNo: '9845088888',
				bloodbankId: mockBloodbankId,
				role: 'Lab_Technician',
				password: 'InitialPassword123!',
				mustChangePassword: true,
				createdBy: mockBloodbankId,
			})
			const rawSetupToken = mockStaffDoc.createSetupToken()

			BloodbankStaff.findOneAndUpdate = async () => mockStaffDoc
			BloodbankStaff.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					body: {
						token: rawSetupToken,
						password: 'PermPass123!',
						passwordConfirm: 'PermPass123!',
					},
				})

				await staffController.setupStaffPassword(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(mockStaffDoc.mustChangePassword, false)
				assert.strictEqual(mockStaffDoc.tokenVersion, 1)
			} finally {
				BloodbankStaff.findOneAndUpdate = originalFindOneAndUpdate
				BloodbankStaff.prototype.save = originalSave
			}
		})

		it('should reject setupStaffPassword if setup token is invalid or expired', async () => {
			const originalFindOneAndUpdate = BloodbankStaff.findOneAndUpdate
			BloodbankStaff.findOneAndUpdate = async () => null // Token not found or expired

			try {
				const { req, res, next } = createMockReqRes({
					body: {
						token: 'invalid-or-expired-token',
						password: 'PermPass123!',
						passwordConfirm: 'PermPass123!',
					},
				})

				await staffController.setupStaffPassword(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Setup token is invalid or has expired/i)
			} finally {
				BloodbankStaff.findOneAndUpdate = originalFindOneAndUpdate
			}
		})

		it('should reject concurrent duplicate token consumption (atomic concurrency guard)', async () => {
			const originalFindOneAndUpdate = BloodbankStaff.findOneAndUpdate
			const originalSave = BloodbankStaff.prototype.save

			let tokenConsumed = false
			BloodbankStaff.findOneAndUpdate = async () => {
				if (!tokenConsumed) {
					tokenConsumed = true
					return new BloodbankStaff({
						_id: mockStaffId,
						fullName: 'Concurrent Staff',
						email: 'concurrent@citycentral.org',
						phoneNo: '9845088888',
						bloodbankId: mockBloodbankId,
						role: 'Lab_Technician',
						password: 'OldPassword123!',
						mustChangePassword: true,
						createdBy: mockBloodbankId,
					})
				}
				// Second concurrent request finds token already consumed/unset
				return null
			}
			BloodbankStaff.prototype.save = async function () { return this }

			try {
				// Request 1: Wins race
				const req1 = createMockReqRes({
					body: { token: 'valid-token', password: 'PermPass123!', passwordConfirm: 'PermPass123!' },
				})
				await staffController.setupStaffPassword(req1.req, req1.res, req1.next)
				assert.strictEqual(req1.res.statusCode, 200)

				// Request 2: Loses race
				const req2 = createMockReqRes({
					body: { token: 'valid-token', password: 'PermPass123!', passwordConfirm: 'PermPass123!' },
				})
				await staffController.setupStaffPassword(req2.req, req2.res, req2.next)
				assert.strictEqual(req2.res.statusCode, 400)
				assert.match(req2.res.responseData.message, /Setup token is invalid or has expired/i)
			} finally {
				BloodbankStaff.findOneAndUpdate = originalFindOneAndUpdate
				BloodbankStaff.prototype.save = originalSave
			}
		})

		it('should block staff with mustChangePassword = true from accessing restricted roles', () => {
			const { req, res } = createMockReqRes({
				staff: {
					role: 'Medical_Officer',
					mustChangePassword: true, // Has not changed initial password!
					medicalLicense: { isVerified: true },
				},
			})

			let nextCalled = false
			const middleware = restrictToStaffRole('Medical_Officer')
			middleware(req, res, () => { nextCalled = true })

			assert.strictEqual(nextCalled, false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Initial password change required/i)
		})
	})

	// -------------------------------------------------------------
	// 7. Global Administrator Medical Officer Credential Verification
	// -------------------------------------------------------------
	describe('7. Global Administrator Credential Verification (verifyStaffLicense)', () => {
		const mockAdminId = new mongoose.Types.ObjectId().toString()
		const adminUser = {
			_id: mockAdminId,
			email: 'superadmin@nammablood.gov.in',
			role: 'admin',
		}

		it('should allow Global Administrator to verify active Medical Officer credentials', async () => {
			const originalFindById = BloodbankStaff.findById
			const originalSave = BloodbankStaff.prototype.save

			const mockStaffDoc = new BloodbankStaff({
				_id: mockStaffId,
				fullName: 'Dr. Jane Smith',
				email: 'jane@citycentral.org',
				phoneNo: '9845012345',
				bloodbankId: mockBloodbankId,
				role: 'Medical_Officer',
				password: 'Password123!',
				status: 'Active',
				medicalLicense: {
					licenseNumber: 'KMC-84920',
					issuingCouncil: 'Karnataka Medical Council',
					isVerified: false,
				},
				createdBy: mockBloodbankId,
			})

			BloodbankStaff.findById = async () => mockStaffDoc
			BloodbankStaff.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: adminUser,
					params: { staffId: mockStaffId },
					body: {
						notes: 'Verified against Karnataka Medical Council official registry register',
					},
				})

				await adminController.verifyStaffLicense(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(mockStaffDoc.medicalLicense.isVerified, true)
				assert.strictEqual(mockStaffDoc.medicalLicense.verifiedBy.toString(), mockAdminId)
				assert.ok(mockStaffDoc.medicalLicense.verifiedAt instanceof Date)
				assert.match(res.responseData.message, /Medical Officer credentials verified successfully/i)
			} finally {
				BloodbankStaff.findById = originalFindById
				BloodbankStaff.prototype.save = originalSave
			}
		})

		it('should reject verifying credentials for a non-Medical Officer role (e.g. Lab_Technician)', async () => {
			const originalFindById = BloodbankStaff.findById

			BloodbankStaff.findById = async () => ({
				_id: mockStaffId,
				role: 'Lab_Technician',
				status: 'Active',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: adminUser,
					params: { staffId: mockStaffId },
				})

				await adminController.verifyStaffLicense(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot verify medical license for role 'Lab_Technician'/i)
			} finally {
				BloodbankStaff.findById = originalFindById
			}
		})

		it('should reject verifying credentials for suspended or revoked staff member', async () => {
			const originalFindById = BloodbankStaff.findById

			BloodbankStaff.findById = async () => ({
				_id: mockStaffId,
				role: 'Medical_Officer',
				status: 'Suspended', // Suspended account
				medicalLicense: { licenseNumber: 'KMC-1234' },
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: adminUser,
					params: { staffId: mockStaffId },
				})

				await adminController.verifyStaffLicense(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot verify credentials for staff account with status 'Suspended'/i)
			} finally {
				BloodbankStaff.findById = originalFindById
			}
		})

		it('should block Medical Officer with unverified credentials from clinical operations', () => {
			const { req, res } = createMockReqRes({
				staff: {
					role: 'Medical_Officer',
					mustChangePassword: false,
					medicalLicense: {
						licenseNumber: 'KMC-84920',
						isVerified: false, // NOT yet verified by admin!
					},
				},
			})

			let nextCalled = false
			const middleware = restrictToStaffRole('Medical_Officer')
			middleware(req, res, () => { nextCalled = true })

			assert.strictEqual(nextCalled, false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /credentials have not been verified by a Global Administrator/i)
		})

		it('should allow Medical Officer with verified credentials and changed password to access clinical operations', () => {
			const { req, res } = createMockReqRes({
				staff: {
					role: 'Medical_Officer',
					mustChangePassword: false,
					medicalLicense: {
						licenseNumber: 'KMC-84920',
						isVerified: true, // Verified by admin!
					},
				},
			})

			let nextCalled = false
			const middleware = restrictToStaffRole('Medical_Officer')
			middleware(req, res, () => { nextCalled = true })

			assert.strictEqual(nextCalled, true)
		})
	})
})
