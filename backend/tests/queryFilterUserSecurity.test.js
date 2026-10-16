const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const bloodbankController = require('../BloodBank/bloodbankController')
const userController = require('../User/userController')
const Bloodbank = require('../BloodBank/bloodbankModel')
const User = require('../User/userModel')
const donateController = require('../BloodDonate/bloodDonateController')
const DonateRequests = require('../BloodDonate/bloodDonateModel')

function createMockReqRes({ user, body = {}, query = {}, params = {}, headers = {}, model = null } = {}) {
	const req = {
		user,
		body,
		query,
		params,
		headers,
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

describe('Blood Bank Query Filters & User Data Security', () => {
	const userA = { _id: new mongoose.Types.ObjectId().toString(), role: 'user' }
	const userB = { _id: new mongoose.Types.ObjectId().toString(), role: 'user' }
	const adminUser = { _id: new mongoose.Types.ObjectId().toString(), role: 'admin' }
	const validBloodbankId = new mongoose.Types.ObjectId().toString()

	// -------------------------------------------------------------
	// 1. Blood Bank Query Filter & NoSQL Injection Guards
	// -------------------------------------------------------------
	describe('1. Blood Bank Query Filter & NoSQL Injection Protection', () => {
		it('should reject operator injection with $ operator keys in query parameters (400)', async () => {
			const { req, res, next } = createMockReqRes({
				query: { '$where': 'sleep(5000)' },
			})
			await bloodbankController.getBloodbanksByQuery(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Forbidden query operator/)
		})

		it('should reject nested query objects attempting operator injection like state[$ne]=null (400)', async () => {
			const { req, res, next } = createMockReqRes({
				query: { state: { '$ne': null } },
			})
			await bloodbankController.getBloodbanksByQuery(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Nested query objects are not allowed/)
		})

		it('should reject dot notation queries in req.query (400)', async () => {
			const { req, res, next } = createMockReqRes({
				query: { 'address.city': 'Bangalore' },
			})
			await bloodbankController.getBloodbanksByQuery(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Forbidden query operator or key/)
		})

		it('should safely filter by allowlisted fields (state, city, category) without operator exposure', async () => {
			let capturedFilter = null
			const originalFind = Bloodbank.find

			Bloodbank.find = (filter) => {
				capturedFilter = filter
				return {
					select: () => ({
						sort: async () => [{ bloodbankName: 'City Hospital Blood Bank' }],
					}),
				}
			}

			try {
				const { req, res, next } = createMockReqRes({
					query: {
						state: 'Karnataka',
						city: 'Bengaluru',
						category: 'Government',
						unknownParam: 'malicious_input',
					},
				})
				await bloodbankController.getBloodbanksByQuery(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.length, 1)
				// Ensure unknownParam is completely excluded from the database filter
				assert.strictEqual(capturedFilter.unknownParam, undefined)
				// Ensure category is strictly allowlisted
				assert.strictEqual(capturedFilter.category, 'Government')
				// Ensure regex is safely escaped
				assert.ok(capturedFilter.state.$regex instanceof RegExp)
				assert.ok(capturedFilter.city.$regex instanceof RegExp)
			} finally {
				Bloodbank.find = originalFind
			}
		})
	})

	// -------------------------------------------------------------
	// 2. Private Blood Bank Data Exposure
	// -------------------------------------------------------------
	describe('2. Blood Bank Sensitive Field Protection', () => {
		it('should exclude password and reset tokens when querying blood bank by ID', async () => {
			let selectedFields = null
			const originalFindById = Bloodbank.findById

			Bloodbank.findById = (id) => {
				return {
					select: (fields) => {
						selectedFields = fields
						return {
							_id: id,
							bloodbankName: 'Life Care Blood Bank',
							email: 'lifecare@example.com',
						}
					},
				}
			}

			try {
				const { req, res, next } = createMockReqRes({
					params: { id: validBloodbankId },
				})
				await bloodbankController.getBloodbankById(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.ok(selectedFields.includes('-password'))
				assert.ok(selectedFields.includes('-passwordResetToken'))
				assert.ok(selectedFields.includes('-passwordResetExpires'))
			} finally {
				Bloodbank.findById = originalFindById
			}
		})

		it('should return 400 for invalid blood bank ID format', async () => {
			const { req, res, next } = createMockReqRes({
				params: { id: 'invalid-id-format' },
			})
			await bloodbankController.getBloodbankById(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Valid blood bank ID is required/)
		})

		it('should return 404 when blood bank is not found', async () => {
			const originalFindById = Bloodbank.findById
			Bloodbank.findById = () => ({
				select: async () => null,
			})

			try {
				const { req, res, next } = createMockReqRes({
					params: { id: validBloodbankId },
				})
				await bloodbankController.getBloodbankById(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.match(res.responseData.message, /Blood bank not found/)
			} finally {
				Bloodbank.findById = originalFindById
			}
		})
	})

	// -------------------------------------------------------------
	// 3. User Authorization & Cross-User Access Control (BOLA / IDOR)
	// -------------------------------------------------------------
	describe('3. User Object-Level Authorization (BOLA Prevention)', () => {
		it('should prevent User B from viewing User A profile by changing the ID in getUserById (404)', async () => {
			const { req, res, next } = createMockReqRes({
				user: userB, // Authenticated as User B
				params: { id: userA._id }, // Attempting to access User A
				model: User,
			})
			await userController.getUserById(req, res, next)
			assert.strictEqual(res.statusCode, 404)
			assert.strictEqual(res.responseData.message, 'User not found.')
		})

		it('should allow User A to view their own profile via getUserById (200)', async () => {
			const originalFindById = User.findById
			User.findById = (id) => ({
				select: async () => ({
					_id: id,
					firstName: 'Pranav',
					lastName: 'User',
					email: 'pranav@example.com',
				}),
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: userA, // Authenticated as User A
					params: { id: userA._id }, // Accessing User A's own ID
					model: User,
				})
				await userController.getUserById(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.user.firstName, 'Pranav')
			} finally {
				User.findById = originalFindById
			}
		})

		it('should forbid any non-owner from viewing another user profile via getUserById (404)', async () => {
			const { req, res, next } = createMockReqRes({
				user: { _id: new mongoose.Types.ObjectId().toString() },
				params: { id: userA._id },
				model: User,
			})
			await userController.getUserById(req, res, next)
			assert.strictEqual(res.statusCode, 404)
			assert.strictEqual(res.responseData.message, 'User not found.')
		})

		it('should reject getUserById with malformed ObjectId (400)', async () => {
			const { req, res, next } = createMockReqRes({
				user: userA,
				params: { id: 'malformed-user-id' },
				model: User,
			})
			await userController.getUserById(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Valid user ID is required/)
		})
	})

	// -------------------------------------------------------------
	// 4. Protection of Private User Data & Update Sanitization
	// -------------------------------------------------------------
	describe('4. Protection of Private User Data & Sanitization', () => {
		it('should ensure getUserProfile excludes passwords and reset tokens', async () => {
			let selectedFields = null
			const originalFindById = User.findById

			User.findById = (id) => ({
				select: async (fields) => {
					selectedFields = fields
					return {
						_id: id,
						firstName: 'Pranav',
						email: 'pranav@example.com',
					}
				},
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: userA,
					model: User,
				})
				await userController.getUserProfile(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.ok(!selectedFields.includes('passwordResetToken'))
				assert.ok(!selectedFields.includes('passwordResetExpires'))
				assert.ok(!selectedFields.includes('passwordChangedAt'))
			} finally {
				User.findById = originalFindById
			}
		})

		it('should ignore unauthorized fields in updateUser (e.g. role, password, status)', async () => {
			let capturedUpdate = null
			const originalFindByIdAndUpdate = User.findByIdAndUpdate

			User.findByIdAndUpdate = (id, updateBody) => {
				capturedUpdate = updateBody
				return {
					select: async () => ({
						_id: id,
						firstName: updateBody.firstName,
					}),
				}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: userA,
					body: {
						firstName: 'UpdatedName',
						role: 'admin', // Malicious attempt to escalate role
						password: 'new_hacked_password',
						passwordResetToken: 'token123',
						status: false,
					},
					model: User,
				})
				await userController.updateUser(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				// Ensure only allowlisted fields were passed to the update
				assert.strictEqual(capturedUpdate.firstName, 'UpdatedName')
				assert.strictEqual(capturedUpdate.role, undefined)
				assert.strictEqual(capturedUpdate.password, undefined)
				assert.strictEqual(capturedUpdate.passwordResetToken, undefined)
				assert.strictEqual(capturedUpdate.status, undefined)
			} finally {
				User.findByIdAndUpdate = originalFindByIdAndUpdate
			}
		})
	})

	// -------------------------------------------------------------
	// 5. Blood Bank Request Query Protection (getBloodbankDataQuery)
	// -------------------------------------------------------------
	describe('5. Blood Bank Request Query Protection', () => {
		it('should reject operator injection in donate getBloodbankDataQuery (400)', async () => {
			const { req, res, next } = createMockReqRes({
				user: { _id: validBloodbankId },
				query: { '$gt': { bloodType: 'O_Positive' } },
			})
			await donateController.getBloodbankDataQuery(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Forbidden query operator/)
		})

		it('should project safe user fields when populating userId in getBloodbankDataQuery', async () => {
			let populateConfig = null
			const originalFind = DonateRequests.find

			DonateRequests.find = () => ({
				populate: (config) => {
					populateConfig = config
					return {
						sort: async () => [],
					}
				},
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: validBloodbankId },
					query: { status: 'Pending' },
				})
				await donateController.getBloodbankDataQuery(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.ok(!populateConfig.select.includes('password'))
				assert.ok(!populateConfig.select.includes('passwordResetToken'))
			} finally {
				DonateRequests.find = originalFind
			}
		})
	})
})
