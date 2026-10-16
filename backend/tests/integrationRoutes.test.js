const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const http = require('http')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const app = require('../app')
const Admin = require('../Admin/adminModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const User = require('../User/userModel')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'

describe('Express Route Pipeline Integration Tests (Live HTTP Server)', () => {
	let server
	let baseUrl
	let originalReadyState

	before(async () => {
		// Mock DB readyState check in app.js so requests pass to router pipeline
		originalReadyState = mongoose.connection.readyState
		Object.defineProperty(mongoose.connection, 'readyState', {
			value: 1,
			configurable: true,
			writable: true,
		})

		await new Promise((resolve) => {
			server = http.createServer(app)
			server.listen(0, '127.0.0.1', () => {
				const port = server.address().port
				baseUrl = `http://127.0.0.1:${port}`
				resolve()
			})
		})
	})

	after(async () => {
		if (server) {
			await new Promise((resolve) => server.close(resolve))
		}
		Object.defineProperty(mongoose.connection, 'readyState', {
			value: originalReadyState,
			configurable: true,
			writable: true,
		})
	})

	// -------------------------------------------------------------
	// 1. Unauthenticated Route Rejection (Live Middleware Chain)
	// -------------------------------------------------------------
	describe('1. Unauthenticated Access Rejection across Route Stack', () => {
		it('GET /api/user/getuserprofile without token should return 401', async () => {
			const res = await fetch(`${baseUrl}/api/user/getuserprofile`)
			const data = await res.json()
			assert.strictEqual(res.status, 401)
			assert.match(data.message, /You are not logged in/)
		})

		it('GET /api/user/getuserbyid/:id without token should return 401 (not public)', async () => {
			const dummyId = new mongoose.Types.ObjectId().toString()
			const res = await fetch(`${baseUrl}/api/user/getuserbyid/${dummyId}`)
			const data = await res.json()
			assert.strictEqual(res.status, 401)
			assert.match(data.message, /You are not logged in/)
		})

		it('POST /api/state without token should return 401', async () => {
			const res = await fetch(`${baseUrl}/api/state`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ stateName: 'Karnataka' }),
			})
			const data = await res.json()
			assert.strictEqual(res.status, 401)
			assert.match(data.message, /You are not logged in/)
		})

		it('POST /api/city/addcity without token should return 401', async () => {
			const res = await fetch(`${baseUrl}/api/city/addcity`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ stateName: 'Karnataka', cityName: 'Bengaluru' }),
			})
			const data = await res.json()
			assert.strictEqual(res.status, 401)
			assert.match(data.message, /You are not logged in/)
		})

		it('PATCH /api/bloodstock/updatestock without token should return 401', async () => {
			const res = await fetch(`${baseUrl}/api/bloodstock/updatestock`, {
				method: 'PATCH',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ A_Positive: 5 }),
			})
			const data = await res.json()
			assert.strictEqual(res.status, 401)
			assert.match(data.message, /You are not logged in/)
		})

		it('POST /api/donaterequests/addrequest without token should return 401', async () => {
			const res = await fetch(`${baseUrl}/api/donaterequests/addrequest`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			})
			const data = await res.json()
			assert.strictEqual(res.status, 401)
			assert.match(data.message, /You are not logged in/)
		})

		it('POST /api/receiverequests/addrequest without token should return 401', async () => {
			const res = await fetch(`${baseUrl}/api/receiverequests/addrequest`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			})
			const data = await res.json()
			assert.strictEqual(res.status, 401)
			assert.match(data.message, /You are not logged in/)
		})
	})

	// -------------------------------------------------------------
	// 2. Cross-Role Route Protection (Wrong Token Rejection)
	// -------------------------------------------------------------
	describe('2. Cross-Role Token Rejection in Route Pipeline', () => {
		it('User token on Bloodbank route (PATCH /api/bloodstock/updatestock) should return 401', async () => {
			const userToken = jwt.sign(
				{ id: new mongoose.Types.ObjectId().toString(), exp: Math.floor(Date.now() / 1000) + 3600 },
				process.env.JWT_SECRET
			)
			// Mock Bloodbank findById returning null for user ID
			const originalFindById = Bloodbank.findById
			Bloodbank.findById = () => ({ select: async () => null })

			try {
				const res = await fetch(`${baseUrl}/api/bloodstock/updatestock`, {
					method: 'PATCH',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${userToken}`,
					},
					body: JSON.stringify({ A_Positive: 2 }),
				})
				const data = await res.json()
				assert.strictEqual(res.status, 401)
				assert.match(data.message, /The user belonging to this token does no longer exist/)
			} finally {
				Bloodbank.findById = originalFindById
			}
		})

		it('User token on Admin route (POST /api/state) should return 401', async () => {
			const userToken = jwt.sign(
				{ id: new mongoose.Types.ObjectId().toString(), exp: Math.floor(Date.now() / 1000) + 3600 },
				process.env.JWT_SECRET
			)
			// Mock Admin findById returning null for user ID
			const originalFindById = Admin.findById
			Admin.findById = () => ({ select: async () => null })

			try {
				const res = await fetch(`${baseUrl}/api/state`, {
					method: 'POST',
					headers: {
						'Content-Type': 'application/json',
						Authorization: `Bearer ${userToken}`,
					},
					body: JSON.stringify({ stateName: 'Karnataka' }),
				})
				const data = await res.json()
				assert.strictEqual(res.status, 401)
				assert.match(data.message, /The user belonging to this token does no longer exist/)
			} finally {
				Admin.findById = originalFindById
			}
		})
	})

	// -------------------------------------------------------------
	// 3. Removed / Deprecated Routes Verification
	// -------------------------------------------------------------
	describe('3. Public Admin Registration Removal', () => {
		it('POST /api/admin/register should return 404 (removed from router)', async () => {
			const res = await fetch(`${baseUrl}/api/admin/register`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ email: 'admin@test.com', password: 'Password123' }),
			})
			assert.strictEqual(res.status, 404)
		})
	})

	// -------------------------------------------------------------
	// 4. JWT Invalidation After Password Change
	// -------------------------------------------------------------
	describe('4. JWT Invalidation & Password-Change Boundary Handling (Live Pipeline)', () => {
		it('should reject a token issued well before passwordChangedAt (401)', async () => {
			const userId = new mongoose.Types.ObjectId().toString()
			const iat = Math.floor(Date.now() / 1000) - 600
			const staleToken = jwt.sign(
				{ id: userId, iat, exp: Math.floor(Date.now() / 1000) + 3600 },
				process.env.JWT_SECRET
			)

			const originalFindById = User.findById
			const mockUser = new User({
				_id: userId,
				email: 'user@test.com',
				passwordChangedAt: new Date(Date.now() - 300 * 1000),
			})
			User.findById = () => ({ select: async () => mockUser })

			try {
				const res = await fetch(`${baseUrl}/api/user/getuserprofile`, {
					headers: { Authorization: `Bearer ${staleToken}` },
				})
				const data = await res.json()
				assert.strictEqual(res.status, 401)
				assert.match(data.message, /User recently changed password! Please log in again/)
			} finally {
				User.findById = originalFindById
			}
		})

		it('should reject a token issued immediately before password change (boundary - 1s) (401)', async () => {
			const userId = new mongoose.Types.ObjectId().toString()
			const changeTime = Date.now() - 50 * 1000
			const changeSec = Math.floor(changeTime / 1000)
			// Token issued 1 second before password was saved
			const tokenIssuedBefore = jwt.sign(
				{ id: userId, iat: changeSec - 1, exp: changeSec + 3600 },
				process.env.JWT_SECRET
			)

			const originalFindById = User.findById
			const mockUser = new User({
				_id: userId,
				email: 'user@test.com',
				passwordChangedAt: new Date(changeTime),
			})
			User.findById = () => ({ select: async () => mockUser })

			try {
				const res = await fetch(`${baseUrl}/api/user/getuserprofile`, {
					headers: { Authorization: `Bearer ${tokenIssuedBefore}` },
				})
				const data = await res.json()
				assert.strictEqual(res.status, 401)
				assert.match(data.message, /User recently changed password! Please log in again/)
			} finally {
				User.findById = originalFindById
			}
		})

		it('should reject a token issued during the password change boundary (same second) (401)', async () => {
			const userId = new mongoose.Types.ObjectId().toString()
			const changeTime = Date.now() - 50 * 1000
			const changeSec = Math.floor(changeTime / 1000)
			// Token issued in the exact same second as password change
			const tokenIssuedDuring = jwt.sign(
				{ id: userId, iat: changeSec, exp: changeSec + 3600 },
				process.env.JWT_SECRET
			)

			const originalFindById = User.findById
			const mockUser = new User({
				_id: userId,
				email: 'user@test.com',
				passwordChangedAt: new Date(changeTime),
			})
			User.findById = () => ({ select: async () => mockUser })

			try {
				const res = await fetch(`${baseUrl}/api/user/getuserprofile`, {
					headers: { Authorization: `Bearer ${tokenIssuedDuring}` },
				})
				const data = await res.json()
				assert.strictEqual(res.status, 401)
				assert.match(data.message, /User recently changed password! Please log in again/)
			} finally {
				User.findById = originalFindById
			}
		})

		it('should accept a token issued after password change (boundary + 1s) (200)', async () => {
			const userId = new mongoose.Types.ObjectId().toString()
			const changeTime = Date.now() - 50 * 1000
			const changeSec = Math.floor(changeTime / 1000)
			// Token issued 1 second after password change
			const validToken = jwt.sign(
				{ id: userId, iat: changeSec + 1, exp: changeSec + 3600 },
				process.env.JWT_SECRET
			)

			const originalFindById = User.findById
			const mockUser = new User({
				_id: userId,
				firstName: 'John',
				lastName: 'Doe',
				email: 'user@test.com',
				passwordChangedAt: new Date(changeTime),
			})
			User.findById = () => ({ select: async () => mockUser })

			try {
				const res = await fetch(`${baseUrl}/api/user/getuserprofile`, {
					headers: { Authorization: `Bearer ${validToken}` },
				})
				const data = await res.json()
				assert.strictEqual(res.status, 200)
				assert.strictEqual(data.email, 'user@test.com')
			} finally {
				User.findById = originalFindById
			}
		})

		it('should accept a newly generated login token with matching tokenVersion in the same second without future iat (200)', async () => {
			const userId = new mongoose.Types.ObjectId().toString()
			const nowSec = Math.floor(Date.now() / 1000)
			const mockUser = new User({
				_id: userId,
				firstName: 'Jane',
				lastName: 'Doe',
				email: 'jane@test.com',
				passwordChangedAt: new Date(nowSec * 1000),
				tokenVersion: 1,
			})
			const originalFindById = User.findById
			User.findById = () => ({ select: async () => mockUser })

			const { tokenGenerate } = require('../Login_And_Authentication/login')
			const loginToken = tokenGenerate(userId, mockUser.tokenVersion)

			try {
				const res = await fetch(`${baseUrl}/api/user/getuserprofile`, {
					headers: { Authorization: `Bearer ${loginToken}` },
				})
				const data = await res.json()
				assert.strictEqual(res.status, 200)
				assert.strictEqual(data.email, 'jane@test.com')
			} finally {
				User.findById = originalFindById
			}
		})

		it('should reject a token with missing or malformed iat on live pipeline (401)', async () => {
			const userId = new mongoose.Types.ObjectId().toString()
			// 1. Missing iat
			const tokenWithoutIat = jwt.sign(
				{ id: userId, exp: Math.floor(Date.now() / 1000) + 3600 },
				process.env.JWT_SECRET,
				{ noTimestamp: true }
			)

			const res1 = await fetch(`${baseUrl}/api/user/getuserprofile`, {
				headers: { Authorization: `Bearer ${tokenWithoutIat}` },
			})
			const data1 = await res1.json()
			assert.strictEqual(res1.status, 401)
			assert.match(data1.message, /Missing or malformed issue timestamp/)

			// 2. Non-numeric string iat (forged/tampered)
			const crypto = require('crypto')
			const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
			const payload = Buffer.from(JSON.stringify({ id: userId, iat: 'invalid-iat', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
			const signature = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${header}.${payload}`).digest('base64url')
			const forgedToken = `${header}.${payload}.${signature}`

			const res2 = await fetch(`${baseUrl}/api/user/getuserprofile`, {
				headers: { Authorization: `Bearer ${forgedToken}` },
			})
			const data2 = await res2.json()
			assert.strictEqual(res2.status, 401)
			assert.match(data2.message, /Missing or malformed issue timestamp/)
		})
	})

	// -------------------------------------------------------------
	// 5. Public Filter Validation on Live HTTP
	// -------------------------------------------------------------
	describe('5. Query Operator Rejection on Live HTTP API', () => {
		it('GET /api/bloodbank/getbloodbanksbyquery?$where=hack should return 400', async () => {
			const res = await fetch(`${baseUrl}/api/bloodbank/getbloodbanksbyquery?$where=hack`)
			const data = await res.json()
			assert.strictEqual(res.status, 400)
			assert.match(data.message, /Forbidden query operator/)
		})

		it('POST /api/contactus/addcontactus with empty body should return 400', async () => {
			const res = await fetch(`${baseUrl}/api/contactus/addcontactus`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			})
			const data = await res.json()
			assert.strictEqual(res.status, 400)
			assert.match(data.message, /Email, phone, and message are required/)
		})
	})
})
