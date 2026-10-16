const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

// Controllers and models under test
const stateController = require('../State/stateController')
const cityController = require('../City/cityController')
const { stateMiddleware } = require('../State/stateMiddleware')
const { cityMiddleware } = require('../City/cityMiddleware')
const State = require('../State/stateModel')
const City = require('../City/cityModel')
const Admin = require('../Admin/adminModel')
const User = require('../User/userModel')
const { selectAdminModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'

// Helper to create mock req, res, next
function createMockReqRes({ user, body = {}, query = {}, params = {}, headers = {} } = {}) {
	const req = {
		user,
		body,
		query,
		params,
		headers,
		model: null,
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

describe('State & City Endpoints Security Hardening', () => {
	const adminId = new mongoose.Types.ObjectId().toString()
	const userId = new mongoose.Types.ObjectId().toString()
	const validStateId = new mongoose.Types.ObjectId().toString()
	const validCityId = new mongoose.Types.ObjectId().toString()

	const adminToken = jwt.sign({ id: adminId, exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.JWT_SECRET)
	const userToken = jwt.sign({ id: userId, exp: Math.floor(Date.now() / 1000) + 3600 }, process.env.JWT_SECRET)

	// -------------------------------------------------------------
	// 1. Authentication Middleware & Role Enforcement
	// -------------------------------------------------------------
	describe('1. Admin Authorization Enforcement (Middleware Layer)', () => {
		it('should reject unauthenticated request with no token (401)', async () => {
			const { req, res, next } = createMockReqRes({ headers: {} })
			selectAdminModel(req, res, () => {})
			await protect(req, res, next)
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /You are not logged in/)
		})

		it('should reject ordinary user token attempting admin write (401)', async () => {
			const originalFindById = Admin.findById
			// When protect checks Admin.findById(userId), it returns null because userId is not in admins collection
			Admin.findById = () => ({
				select: async () => null,
			})

			try {
				const { req, res, next } = createMockReqRes({
					headers: { authorization: `Bearer ${userToken}` },
				})
				selectAdminModel(req, res, () => {})
				await protect(req, res, next)
				assert.strictEqual(res.statusCode, 401)
				assert.match(res.responseData.message, /The user belonging to this token does no longer exist/)
			} finally {
				Admin.findById = originalFindById
			}
		})

		it('should allow authenticated admin token to proceed', async () => {
			const originalFindById = Admin.findById
			Admin.findById = () => ({
				select: async () => ({
					_id: adminId,
					email: 'admin@nammablood.org',
					changedPasswordAfter: () => false,
				}),
			})

			try {
				const { req, res, next } = createMockReqRes({
					headers: { authorization: `Bearer ${adminToken}` },
				})
				selectAdminModel(req, res, () => {})
				let middlewarePassed = false
				await protect(req, res, () => {
					middlewarePassed = true
				})
				assert.strictEqual(middlewarePassed, true)
				assert.strictEqual(req.user._id, adminId)
			} finally {
				Admin.findById = originalFindById
			}
		})
	})

	// -------------------------------------------------------------
	// 2. State Write Endpoints (Admin Operations)
	// -------------------------------------------------------------
	describe('2. State Write Mutations & Validations', () => {
		it('should allow admin to create a new State', async () => {
			const originalFindOne = State.findOne
			const originalCreate = State.create

			State.findOne = async () => null // No duplicate
			State.create = async (doc) => ({ _id: validStateId, stateName: doc.stateName })

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					body: { stateName: 'Karnataka' },
				})
				await stateController.addState(req, res, next)
				assert.strictEqual(res.statusCode, 201)
				assert.strictEqual(res.responseData.message, 'State added successfully.')
				assert.strictEqual(res.responseData.data.stateName, 'Karnataka')
			} finally {
				State.findOne = originalFindOne
				State.create = originalCreate
			}
		})

		it('should reject state creation with empty or whitespace-only stateName', async () => {
			const { req, res, next } = createMockReqRes({
				user: { _id: adminId },
				body: { stateName: '   ' },
			})
			stateMiddleware(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Required missing values : State Name/)
		})

		it('should reject duplicate state name (case-insensitive)', async () => {
			const originalFindOne = State.findOne
			State.findOne = async () => ({ _id: validStateId, stateName: 'Karnataka' })

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					body: { stateName: 'karnataka' },
				})
				await stateController.addState(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already exists/)
			} finally {
				State.findOne = originalFindOne
			}
		})

		it('should allow admin to update State and cascade update to City records', async () => {
			const originalFindById = State.findById
			const originalFindOne = State.findOne
			const originalUpdateMany = City.updateMany
			let cascadedCityUpdate = null

			const mockState = {
				_id: validStateId,
				stateName: 'Karnataka',
				save: async function () { return this },
			}
			State.findById = async () => mockState
			State.findOne = async () => null // No name collision
			City.updateMany = async (filter, update) => {
				cascadedCityUpdate = { filter, update }
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					params: { id: validStateId },
					body: { stateName: 'Karnataka State' },
				})
				await stateController.updateState(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'State updated successfully.')
				assert.strictEqual(mockState.stateName, 'Karnataka State')
				assert.deepStrictEqual(cascadedCityUpdate.filter, { stateName: 'Karnataka' })
				assert.deepStrictEqual(cascadedCityUpdate.update, { stateName: 'Karnataka State' })
			} finally {
				State.findById = originalFindById
				State.findOne = originalFindOne
				City.updateMany = originalUpdateMany
			}
		})

		it('should prevent deleting a state if cities are linked to it', async () => {
			const originalFindById = State.findById
			const originalCountDocuments = City.countDocuments

			State.findById = async () => ({ _id: validStateId, stateName: 'Karnataka' })
			City.countDocuments = async () => 3 // 3 cities exist in this state

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					params: { id: validStateId },
				})
				await stateController.deleteState(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot delete state because it has 3 associated city/)
			} finally {
				State.findById = originalFindById
				City.countDocuments = originalCountDocuments
			}
		})

		it('should allow admin to delete state when no associated cities exist', async () => {
			const originalFindById = State.findById
			const originalCountDocuments = City.countDocuments
			const originalFindByIdAndDelete = State.findByIdAndDelete

			State.findById = async () => ({ _id: validStateId, stateName: 'Goa' })
			City.countDocuments = async () => 0
			let deletedId = null
			State.findByIdAndDelete = async (id) => {
				deletedId = id
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					params: { id: validStateId },
				})
				await stateController.deleteState(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'State deleted successfully.')
				assert.strictEqual(deletedId, validStateId)
			} finally {
				State.findById = originalFindById
				City.countDocuments = originalCountDocuments
				State.findByIdAndDelete = originalFindByIdAndDelete
			}
		})

		it('should reject state update or delete with invalid ObjectId (400)', async () => {
			const { req, res, next } = createMockReqRes({
				user: { _id: adminId },
				params: { id: 'invalid-id' },
				body: { stateName: 'New' },
			})
			await stateController.updateState(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Valid State ID is required/)

			const { req: delReq, res: delRes, next: delNext } = createMockReqRes({
				user: { _id: adminId },
				params: { id: 'invalid-id' },
			})
			await stateController.deleteState(delReq, delRes, delNext)
			assert.strictEqual(delRes.statusCode, 400)
			assert.match(delRes.responseData.message, /Valid State ID is required/)
		})
	})

	// -------------------------------------------------------------
	// 3. City Write Endpoints (Admin Operations)
	// -------------------------------------------------------------
	describe('3. City Write Mutations & Validations', () => {
		it('should allow admin to create a city referencing an existing state', async () => {
			const originalFindState = State.findOne
			const originalFindCity = City.findOne
			const originalCreateCity = City.create

			State.findOne = async () => ({ _id: validStateId, stateName: 'Karnataka' })
			City.findOne = async () => null // No duplicate city
			City.create = async (doc) => ({ _id: validCityId, ...doc })

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					body: { stateName: 'Karnataka', cityName: 'Bengaluru' },
				})
				await cityController.addCity(req, res, next)
				assert.strictEqual(res.statusCode, 201)
				assert.strictEqual(res.responseData.message, 'City added successfully.')
				assert.strictEqual(res.responseData.data.cityName, 'Bengaluru')
			} finally {
				State.findOne = originalFindState
				City.findOne = originalFindCity
				City.create = originalCreateCity
			}
		})

		it('should reject city creation if referenced state does not exist (404)', async () => {
			const originalFindState = State.findOne
			State.findOne = async () => null // State does not exist

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					body: { stateName: 'NonExistentState', cityName: 'SomeCity' },
				})
				await cityController.addCity(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.match(res.responseData.message, /Referenced state 'NonExistentState' does not exist/)
			} finally {
				State.findOne = originalFindState
			}
		})

		it('should reject duplicate city name (400)', async () => {
			const originalFindState = State.findOne
			const originalFindCity = City.findOne

			State.findOne = async () => ({ _id: validStateId, stateName: 'Karnataka' })
			City.findOne = async () => ({ _id: validCityId, cityName: 'Bengaluru' }) // Already exists

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					body: { stateName: 'Karnataka', cityName: 'Bengaluru' },
				})
				await cityController.addCity(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /City 'Bengaluru' already exists/)
			} finally {
				State.findOne = originalFindState
				City.findOne = originalFindCity
			}
		})

		it('should reject city creation with missing fields in middleware (400)', async () => {
			const { req, res, next } = createMockReqRes({
				user: { _id: adminId },
				body: { stateName: 'Karnataka' }, // missing cityName
			})
			cityMiddleware(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Required missing values : City Name/)
		})

		it('should allow admin to update City and validate referenced state', async () => {
			const originalFindById = City.findById
			const originalFindState = State.findOne
			const originalFindCity = City.findOne

			const mockCity = {
				_id: validCityId,
				stateName: 'Karnataka',
				cityName: 'Bangalore',
				save: async function () { return this },
			}
			City.findById = async () => mockCity
			State.findOne = async () => ({ stateName: 'Karnataka' })
			City.findOne = async () => null // No name collision

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					params: { id: validCityId },
					body: { cityName: 'Bengaluru' },
				})
				await cityController.updateCity(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'City updated successfully.')
				assert.strictEqual(mockCity.cityName, 'Bengaluru')
			} finally {
				City.findById = originalFindById
				State.findOne = originalFindState
				City.findOne = originalFindCity
			}
		})

		it('should allow admin to delete City', async () => {
			const originalFindById = City.findById
			const originalFindByIdAndDelete = City.findByIdAndDelete
			let deletedId = null

			City.findById = async () => ({ _id: validCityId, cityName: 'Bengaluru' })
			City.findByIdAndDelete = async (id) => {
				deletedId = id
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: adminId },
					params: { id: validCityId },
				})
				await cityController.deleteCity(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'City deleted successfully.')
				assert.strictEqual(deletedId, validCityId)
			} finally {
				City.findById = originalFindById
				City.findByIdAndDelete = originalFindByIdAndDelete
			}
		})
	})

	// -------------------------------------------------------------
	// 4. Public Read Availability
	// -------------------------------------------------------------
	describe('4. Public Read Availability', () => {
		it('should allow public access to GET /api/state without authentication', async () => {
			const originalFind = State.find
			State.find = () => ({
				sort: async () => [{ stateName: 'Karnataka' }, { stateName: 'Maharashtra' }],
			})

			try {
				const { req, res, next } = createMockReqRes()
				await stateController.getStates(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.length, 2)
				assert.strictEqual(res.responseData[0].stateName, 'Karnataka')
			} finally {
				State.find = originalFind
			}
		})

		it('should allow public access to GET /api/city/getcitybystatename/:stateName without authentication', async () => {
			const originalFind = City.find
			City.find = () => ({
				sort: async () => [{ cityName: 'Bengaluru', stateName: 'Karnataka' }],
			})

			try {
				const { req, res, next } = createMockReqRes({
					params: { stateName: 'Karnataka' },
				})
				await cityController.getCities(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.length, 1)
				assert.strictEqual(res.responseData[0].cityName, 'Bengaluru')
			} finally {
				City.find = originalFind
			}
		})
	})
})
