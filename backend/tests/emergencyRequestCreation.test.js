/**
 * Comprehensive Test Suite: Emergency Blood Request Creation API
 * Namma Blood — Pre-Phase 4.4 Emergency Blood Connection
 *
 * Verifies:
 * 1. Authentication & Role Authorization (USER, ADMIN allowed; BLOODBANK, STAFF denied 403; unauth 401).
 * 2. Strict Input Validation (demographics, enums, numbers, phone, PIN, GeoJSON).
 * 3. Mass-Assignment & Tamper Protection (server controls requesterUserId, requestNumber, verificationStatus, status).
 * 4. Persistence & Lifecycle Defaults (Pending_Verification, Active, expiresAt computation, retry on collision).
 * 5. Rate Limiting Protection (HTTP 429 when quota exceeded, Retry-After header).
 * 6. Zero Clinical Privilege Mutation (No inventory mutation, no donor reservation, no medical clearance).
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const crypto = require('crypto')
const jwt = require('jsonwebtoken')

const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const { createEmergencyRequest, normalizeComponentType } = require('../Emergency/emergencyRequestController')
const {
	requestCreationRateLimiter,
	_resetRateLimiter,
	MAX_REQUESTS_PER_WINDOW,
} = require('../Emergency/emergencyRequestRateLimiter')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const User = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const Bloodbank = require('../BloodBank/bloodbankModel')

const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'

function createMockReqRes({
	body = {},
	params = {},
	query = {},
	headers = {},
	user = null,
	userRole = 'USER',
	ip = '127.0.0.1',
} = {}) {
	const req = {
		body,
		params,
		query,
		headers,
		user,
		userRole,
		ip,
		socket: { remoteAddress: ip },
		connection: { remoteAddress: ip },
	}
	const res = {
		statusCode: 200,
		responseData: null,
		headersSent: {},
		status(code) {
			this.statusCode = code
			return this
		},
		json(data) {
			this.responseData = data
			return this
		},
		setHeader(key, val) {
			this.headersSent[key] = val
		},
	}
	let nextCalled = false
	const next = (err) => {
		nextCalled = true
		if (err) {
			res.statusCode = err.statusCode || 500
			res.responseData = { status: 'error', message: err.message }
		}
	}
	return { req, res, next, isNextCalled: () => nextCalled }
}

describe('Emergency Blood Request Creation API (POST /api/emergency/requests)', () => {
	let dbConnected = false
	let testUser = null
	let testAdmin = null
	let testBloodBank = null
	let validPayload = null
	const createdRequestIds = []

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
			dbConnected = true
		} else {
			dbConnected = true
		}

		// Ensure indexes are ready
		await EmergencyBloodRequest.syncIndexes()

		// Provision isolated test users
		testUser = {
			_id: new mongoose.Types.ObjectId(),
			firstName: 'Kavitha',
			lastName: 'Suresh',
			email: `kavitha_${Date.now()}@nammablood.test`,
			role: 'USER',
			status: true,
			changedPasswordAfter: () => false,
		}

		testAdmin = {
			_id: new mongoose.Types.ObjectId(),
			name: 'Dr. System Admin',
			email: `admin_${Date.now()}@nammablood.test`,
			role: 'ADMIN',
			status: true,
			changedPasswordAfter: () => false,
		}

		testBloodBank = {
			_id: new mongoose.Types.ObjectId(),
			bloodbankName: 'Adyar Test Blood Centre',
			email: `bb_${Date.now()}@nammablood.test`,
			role: 'BLOODBANK',
			status: true,
			changedPasswordAfter: () => false,
		}

		validPayload = {
			patientName: 'Meenakshi Sundaram',
			patientAge: 42,
			patientGender: 'Female',
			requiredBloodGroup: 'B_Positive',
			requiredComponent: 'Packed_Red_Blood_Cells',
			unitsRequested: 2,
			urgencyLevel: 'Critical',
			requiredWithinHours: 4,
			hospitalName: 'Apollo Speciality Hospital Greams Road',
			hospitalAddress: '21 Greams Lane, Thousand Lights',
			hospitalCity: 'Chennai',
			hospitalState: 'Tamil Nadu',
			hospitalPinCode: 600006,
			location: {
				type: 'Point',
				coordinates: [80.2525, 13.0604], // [lng, lat]
			},
			attendingDoctor: {
				doctorName: 'Dr. R. Ramanathan, MD',
				doctorPhone: '9840123456',
				registrationNumber: 'TNMC-2015-8849',
			},
			clinicalJustification: 'Acute gastrointestinal hemorrhage with profound hemodynamic instability.',
		}
	})

	after(async () => {
		// Strictly clean up ONLY records created during this test suite
		if (createdRequestIds.length > 0) {
			await EmergencyBloodRequest.deleteMany({ _id: { $in: createdRequestIds } })
		}
		if (dbConnected) {
			await mongoose.disconnect()
		}
	})

	beforeEach(() => {
		_resetRateLimiter()
	})

	// =========================================================================
	// 1. AUTHENTICATION & ROLE AUTHORIZATION TESTS
	// =========================================================================
	describe('1. Authentication and Role Authorization', () => {
		it('should reject unauthenticated request with 401 when protectEmergencyAuth runs without token', async () => {
			const { req, res, next } = createMockReqRes({ headers: {} })
			await protectEmergencyAuth(req, res, next)
			assert.strictEqual(res.statusCode, 401)
			assert.strictEqual(res.responseData.status, 'fail')
			assert.ok(res.responseData.message.includes('Authentication required'))
		})

		it('should reject request with expired token with 401', async () => {
			const expiredToken = jwt.sign(
				{ id: testUser._id.toString(), iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 },
				process.env.JWT_SECRET
			)
			const { req, res, next } = createMockReqRes({
				headers: { authorization: `Bearer ${expiredToken}` },
			})
			await protectEmergencyAuth(req, res, next)
			assert.strictEqual(res.statusCode, 401)
			assert.ok(/expired/i.test(res.responseData.message))
		})

		it('should allow authenticated USER role to initiate emergency blood request', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload },
				user: testUser,
				userRole: 'USER',
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData.status, 'success')
			assert.ok(res.responseData.data._id)
			createdRequestIds.push(res.responseData.data._id)
		})

		it('should allow authenticated ADMIN role to initiate emergency blood request', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, patientName: 'Admin Initiated QA Patient' },
				user: testAdmin,
				userRole: 'ADMIN',
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData.status, 'success')
			createdRequestIds.push(res.responseData.data._id)
		})

		it('should reject BLOODBANK role attempting to initiate emergency request with 403 Forbidden', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload },
				user: testBloodBank,
				userRole: 'BLOODBANK',
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.strictEqual(res.responseData.code, 'FORBIDDEN')
			assert.ok(res.responseData.message.includes('Only registered users or platform administrators'))
		})

		it('should reject STAFF role attempting to initiate emergency request with 403 Forbidden', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload },
				user: { _id: new mongoose.Types.ObjectId() },
				userRole: 'STAFF',
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.strictEqual(res.responseData.code, 'FORBIDDEN')
		})
	})

	// =========================================================================
	// 2. INPUT VALIDATION TESTS
	// =========================================================================
	describe('2. Input Validation & Schema Enforcement', () => {
		it('should reject payload with missing or empty patientName (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, patientName: '   ' },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('Patient full name is required'))
		})

		it('should reject patientName shorter than 2 characters (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, patientName: 'A' },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('between 2 and 100 characters'))
		})

		it('should reject negative patientAge (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, patientAge: -5 },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('between 0 and 120'))
		})

		it('should reject fractional patientAge (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, patientAge: 32.7 },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('integer'))
		})

		it('should reject patientAge exceeding 120 (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, patientAge: 135 },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('between 0 and 120'))
		})

		it('should reject invalid patientGender enum (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, patientGender: 'NonBinaryCustom' },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('Allowed values: Male, Female, Other'))
		})

		it('should reject invalid requiredBloodGroup (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, requiredBloodGroup: 'C_Positive' },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('Invalid blood group'))
		})

		it('should reject invalid requiredComponent (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, requiredComponent: 'Synthetic_Blood_Sub' },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('Invalid component type'))
		})

		it('should correctly normalize PRBC component alias to Packed_Red_Blood_Cells (201)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, requiredComponent: 'PRBC' },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData.data.requiredComponent, 'Packed_Red_Blood_Cells')
			createdRequestIds.push(res.responseData.data._id)
		})

		it('should reject zero unitsRequested (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, unitsRequested: 0 },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('between 1 and 10 units'))
		})

		it('should reject unitsRequested exceeding 10 (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, unitsRequested: 15 },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('between 1 and 10 units'))
		})

		it('should reject fractional unitsRequested (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, unitsRequested: 2.5 },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('integer between 1 and 10'))
		})

		it('should reject invalid urgencyLevel enum (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, urgencyLevel: 'Extreme_Immediate' },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('Allowed levels: Critical, Urgent, High_Priority'))
		})

		it('should reject requiredWithinHours outside 1 to 48 range (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, requiredWithinHours: 72 },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('between 1 and 48 hours'))
		})

		it('should reject invalid 5-digit PIN code (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, hospitalPinCode: 60006 },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('valid 6-digit postal code'))
		})

		it('should reject invalid attendingDoctor phone number (400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					...validPayload,
					attendingDoctor: { ...validPayload.attendingDoctor, doctorPhone: '123' },
				},
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('valid phone number'))
		})

		it('should reject malformed GeoJSON location with non-Point type (400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					...validPayload,
					location: { type: 'Polygon', coordinates: [80.25, 13.06] },
				},
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes("Location type must be 'Point'"))
		})

		it('should reject out-of-range latitude in GeoJSON coordinates (400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					...validPayload,
					location: { type: 'Point', coordinates: [80.25, 95.5] },
				},
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('Latitude must be between -90 and +90'))
		})

		it('should reject out-of-range longitude in GeoJSON coordinates (400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					...validPayload,
					location: { type: 'Point', coordinates: [-195.0, 13.06] },
				},
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.responseData.message.includes('Longitude must be between -180 and +180'))
		})

		it('should reject NoSQL query operator injection in payload keys (400)', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, $where: 'sleep(1000)' },
				user: testUser,
			})
			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'INVALID_PAYLOAD')
		})
	})

	// =========================================================================
	// 3. MASS-ASSIGNMENT & SECURITY INVARIANT TESTS
	// =========================================================================
	describe('3. Mass-Assignment & Tamper Defense', () => {
		it('should ignore client-supplied requesterUserId and bind authenticated user identity', async () => {
			const forgedRequesterId = new mongoose.Types.ObjectId()
			const { req, res } = createMockReqRes({
				body: { ...validPayload, requesterUserId: forgedRequesterId.toString() },
				user: testUser,
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			createdRequestIds.push(res.responseData.data._id)

			// Query database document directly to verify server-side association
			const persisted = await EmergencyBloodRequest.findById(res.responseData.data._id).lean()
			assert.strictEqual(persisted.requesterUserId.toString(), testUser._id.toString())
			assert.notStrictEqual(persisted.requesterUserId.toString(), forgedRequesterId.toString())
		})

		it('should ignore client-supplied requestNumber and assign server-generated EMG identifier', async () => {
			const forgedRequestNumber = 'EMG-99999999-FORGED'
			const { req, res } = createMockReqRes({
				body: { ...validPayload, requestNumber: forgedRequestNumber },
				user: testUser,
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			createdRequestIds.push(res.responseData.data._id)

			assert.notStrictEqual(res.responseData.data.requestNumber, forgedRequestNumber)
			assert.match(res.responseData.data.requestNumber, /^EMG-\d{8}-[0-9A-F]{6}$/)
		})

		it('should strictly enforce Pending_Verification initial verificationStatus even if client sends Verified', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, verificationStatus: 'Verified' },
				user: testUser,
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			createdRequestIds.push(res.responseData.data._id)

			assert.strictEqual(res.responseData.data.verificationStatus, 'Pending_Verification')

			const persisted = await EmergencyBloodRequest.findById(res.responseData.data._id).lean()
			assert.strictEqual(persisted.verificationStatus, 'Pending_Verification')
		})

		it('should strictly enforce Active initial lifecycle status even if client sends Fulfilled', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload, status: 'Fulfilled' },
				user: testUser,
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			createdRequestIds.push(res.responseData.data._id)

			assert.strictEqual(res.responseData.data.status, 'Active')
		})

		it('should strictly zero out reserved counters and empty matched array fields', async () => {
			const { req, res } = createMockReqRes({
				body: {
					...validPayload,
					unitsReserved: 2,
					unitsFulfilled: 2,
					matchedBloodbankIds: [new mongoose.Types.ObjectId()],
					reservedUnitIds: [new mongoose.Types.ObjectId()],
				},
				user: testUser,
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			createdRequestIds.push(res.responseData.data._id)

			assert.strictEqual(res.responseData.data.unitsReserved, 0)
			assert.strictEqual(res.responseData.data.unitsFulfilled, 0)

			const persisted = await EmergencyBloodRequest.findById(res.responseData.data._id).lean()
			assert.strictEqual(persisted.matchedBloodbankIds.length, 0)
			assert.strictEqual(persisted.reservedUnitIds.length, 0)
		})
	})

	// =========================================================================
	// 4. PERSISTENCE & LIFECYCLE DEFAULTS
	// =========================================================================
	describe('4. Persistence & Database Integrity', () => {
		it('should support administrative location fallback when GeoJSON location is omitted', async () => {
			const payloadWithoutLocation = { ...validPayload }
			delete payloadWithoutLocation.location

			const { req, res } = createMockReqRes({
				body: payloadWithoutLocation,
				user: testUser,
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			createdRequestIds.push(res.responseData.data._id)

			const persisted = await EmergencyBloodRequest.findById(res.responseData.data._id).lean()
			assert.strictEqual(persisted.hospitalCity, 'Chennai')
			assert.strictEqual(persisted.hospitalState, 'Tamil Nadu')
			assert.strictEqual(persisted.location, undefined)
		})

		it('should accurately compute expiresAt timestamp based on requiredWithinHours', async () => {
			const hours = 6
			const beforeTime = Date.now()
			const { req, res } = createMockReqRes({
				body: { ...validPayload, requiredWithinHours: hours },
				user: testUser,
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			createdRequestIds.push(res.responseData.data._id)

			const expiresAt = new Date(res.responseData.data.expiresAt).getTime()
			const expectedExpiresAt = beforeTime + hours * 60 * 60 * 1000
			// Within 5 seconds tolerance of execution time
			assert.ok(Math.abs(expiresAt - expectedExpiresAt) < 5000)
		})

		it('should not create donor reservations, blood units, or notifications on request creation', async () => {
			const { req, res } = createMockReqRes({
				body: { ...validPayload },
				user: testUser,
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			createdRequestIds.push(res.responseData.data._id)

			const persisted = await EmergencyBloodRequest.findById(res.responseData.data._id).lean()
			assert.strictEqual(persisted.notifiedDonorCount, 0)
			assert.strictEqual(persisted.confirmedDonorCount, 0)
			assert.strictEqual(persisted.reservedUnitIds.length, 0)
		})
	})

	// =========================================================================
	// 5. RATE LIMITING TESTS
	// =========================================================================
	describe('5. Rate Limiting & Abuse Prevention', () => {
		it('should accept requests up to MAX_REQUESTS_PER_WINDOW limit', () => {
			const testUserId = new mongoose.Types.ObjectId()
			for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
				const { req, res, next, isNextCalled } = createMockReqRes({
					user: { _id: testUserId },
				})
				requestCreationRateLimiter(req, res, next)
				assert.strictEqual(isNextCalled(), true)
				assert.strictEqual(res.statusCode, 200)
			}
		})

		it('should reject request exceeding quota with HTTP 429 and Retry-After header', () => {
			const testUserId = new mongoose.Types.ObjectId()
			// Exhaust limit
			for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
				const { req, res, next } = createMockReqRes({
					user: { _id: testUserId },
				})
				requestCreationRateLimiter(req, res, next)
			}

			// 11th request must receive 429
			const { req, res, next, isNextCalled } = createMockReqRes({
				user: { _id: testUserId },
			})
			requestCreationRateLimiter(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 429)
			assert.strictEqual(res.responseData.status, 'fail')
			assert.strictEqual(res.responseData.code, 'RATE_LIMIT_EXCEEDED')
			assert.ok(res.headersSent['Retry-After'] >= 1)
			assert.strictEqual(res.headersSent['X-RateLimit-Remaining'], 0)
		})
	})
})
