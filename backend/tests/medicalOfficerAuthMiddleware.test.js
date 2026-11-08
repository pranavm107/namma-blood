/**
 * Comprehensive Security Test Suite:
 * Hospital Medical Officer Authentication & Authorization Middleware
 * Namma Blood — Phase 4.3.5 Stage 2
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const userModel = require('../User/userModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Admin = require('../Admin/adminModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { MedicalOfficerHospital } = require('../Hospital/medicalOfficerHospitalModel')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'
const TEST_SECRET = process.env.JWT_SECRET
const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

function createMockReqRes({
	headers = {},
	body = {},
	params = {},
	query = {},
	user = null,
	userRole = null,
} = {}) {
	const req = {
		headers,
		body,
		params,
		query,
		user,
		userRole,
		ip: '127.0.0.1',
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
	let nextCalled = false
	let nextError = null
	const next = (err) => {
		nextCalled = true
		if (err) {
			nextError = err
			res.statusCode = err.statusCode || 500
			res.responseData = { status: 'error', message: err.message }
		}
	}
	return {
		req,
		res,
		next,
		isNextCalled: () => nextCalled,
		getNextError: () => nextError,
	}
}

function generateToken(payload, expiresIn = '1h') {
	const iat = Math.floor(Date.now() / 1000)
	return jwt.sign({ iat, ...payload }, TEST_SECRET, { expiresIn })
}

describe('Phase 4.3.5 Stage 2: Authentication & Authorization Middleware', () => {
	let dbConnected = false
	const cleanupIds = {
		users: [],
		hospitals: [],
		associations: [],
	}

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
			dbConnected = true
		} else {
			dbConnected = true
		}
	})

	after(async () => {
		// Clean up only test records created during this run
		if (cleanupIds.associations.length > 0) {
			await MedicalOfficerHospital.deleteMany({ _id: { $in: cleanupIds.associations } })
		}
		if (cleanupIds.hospitals.length > 0) {
			await Hospital.deleteMany({ _id: { $in: cleanupIds.hospitals } })
		}
		if (cleanupIds.users.length > 0) {
			await userModel.deleteMany({ _id: { $in: cleanupIds.users } })
		}
		if (dbConnected) {
			await mongoose.disconnect()
		}
	})

	describe('1. Role Resolution Invariants in emergencyAuthMiddleware', () => {
		it('should resolve standard USER role correctly', async () => {
			const userDoc = await userModel.create({
				firstName: 'Regular',
				lastName: 'User',
				gender: 'Male',
				dob: new Date('1990-01-01'),
				age: 34,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				email: `reguser_${Date.now()}_${Math.random()}@test.com`,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: 'Main St',
				pinCode: 600001,
				password: 'Password123!',
				role: 'USER',
			})
			cleanupIds.users.push(userDoc._id)

			const token = generateToken({ id: userDoc._id, userType: 'user' })
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectEmergencyAuth(req, res, next)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'USER')
			assert.strictEqual(req.user._id.toString(), userDoc._id.toString())
		})

		it('should resolve MEDICAL_OFFICER role correctly without colliding with USER', async () => {
			const moDoc = await userModel.create({
				firstName: 'Dr. Ramesh',
				lastName: 'Gupta',
				gender: 'Male',
				dob: new Date('1982-03-15'),
				age: 42,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				email: `mo_${Date.now()}_${Math.random()}@hospital.org`,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: 'Hospital Rd',
				pinCode: 600006,
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				medicalRegistrationNumber: 'MCI-12345',
			})
			cleanupIds.users.push(moDoc._id)

			const token = generateToken({ id: moDoc._id, userType: 'user' })
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectEmergencyAuth(req, res, next)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'MEDICAL_OFFICER')
			assert.strictEqual(req.user.role, 'MEDICAL_OFFICER')
		})

		it('should reject unauthenticated request with 401', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes()
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /Authentication required/)
		})

		it('should reject expired token with 401', async () => {
			const expiredToken = jwt.sign(
				{ id: new mongoose.Types.ObjectId(), iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 },
				TEST_SECRET
			)
			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${expiredToken}` },
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 401)
		})
	})

	describe('2. Role Access Gates (Blocking USER, STAFF, BLOODBANK, ADMIN)', () => {
		it('should reject USER role attempting to access Medical Officer operations with 403', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				user: { _id: new mongoose.Types.ObjectId(), role: 'USER' },
				userRole: 'USER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Access denied: Role 'USER' is not authorized/)
		})

		it('should reject STAFF role attempting to access Medical Officer operations with 403', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				user: { _id: new mongoose.Types.ObjectId(), role: 'Staff_Admin' },
				userRole: 'STAFF',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Access denied: Role 'STAFF' is not authorized/)
		})

		it('should reject BLOODBANK role attempting to access Medical Officer operations with 403', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				user: { _id: new mongoose.Types.ObjectId() },
				userRole: 'BLOODBANK',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Access denied: Role 'BLOODBANK' is not authorized/)
		})

		it('should reject ADMIN role attempting to directly access Medical Officer operations with 403', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				user: { _id: new mongoose.Types.ObjectId() },
				userRole: 'ADMIN',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Access denied: Role 'ADMIN' is not authorized/)
		})
	})

	describe('3. Medical Officer Hospital Association Gates', () => {
		let moUser = null
		let verifiedHospital = null

		before(async () => {
			moUser = await userModel.create({
				firstName: 'Dr. Ananya',
				lastName: 'Deshmukh',
				gender: 'Female',
				dob: new Date('1986-07-22'),
				age: 38,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				email: `ananya_${Date.now()}@hospital.org`,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: 'Greams Rd',
				pinCode: 600006,
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				medicalRegistrationNumber: 'MCI-88990',
			})
			cleanupIds.users.push(moUser._id)

			verifiedHospital = await Hospital.create({
				hospitalCode: `HOSP-${Date.now().toString().slice(-6)}`,
				hospitalName: 'Apollo Main Hospital',
				hospitalType: 'Private',
				address: { street: '21 Greams Rd', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600006' },
				contactPhone: '9840123456',
				contactEmail: `apollo_${Date.now()}@hospital.org`,
				verificationStatus: 'Verified',
				isActive: true,
			})
			cleanupIds.hospitals.push(verifiedHospital._id)
		})

		it('should reject Medical Officer with no association with 403', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /No hospital association found/)
		})

		it('should reject Medical Officer with Pending association with 403', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Pending',
				permissions: ['VERIFY_EMERGENCY_REQUESTS'],
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /pending administrative approval/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should reject Medical Officer with Suspended association with 403', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Suspended',
				permissions: ['VERIFY_EMERGENCY_REQUESTS'],
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /suspended/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should reject Medical Officer with Revoked association with 403', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Revoked',
				permissions: ['VERIFY_EMERGENCY_REQUESTS'],
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /revoked/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should reject association whose effectiveFrom is in the future with 403', async () => {
			const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) // 7 days in future
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Active',
				permissions: ['VERIFY_EMERGENCY_REQUESTS'],
				effectiveFrom: futureDate,
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /not yet effective/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should reject association whose expiresAt is in the past with 403', async () => {
			const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000) // 1 day ago
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Active',
				permissions: ['VERIFY_EMERGENCY_REQUESTS'],
				effectiveFrom: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
				expiresAt: pastDate,
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /expired/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should reject association missing required permission with 403', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'], // Lacks VERIFY_EMERGENCY_REQUESTS
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS')(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /does not grant the required 'VERIFY_EMERGENCY_REQUESTS' permission/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should reject association with an unverified hospital with 403', async () => {
			const unverifiedHospital = await Hospital.create({
				hospitalCode: `HOSP-UNVER-${Date.now().toString().slice(-4)}`,
				hospitalName: 'Unverified Clinic',
				hospitalType: 'Private',
				address: { street: '12 Test St', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600001' },
				contactPhone: '9840123457',
				contactEmail: `unver_${Date.now()}@clinic.org`,
				verificationStatus: 'Pending', // Unverified!
				isActive: true,
			})
			cleanupIds.hospitals.push(unverifiedHospital._id)

			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: unverifiedHospital._id,
				associationStatus: 'Active',
				permissions: ['VERIFY_EMERGENCY_REQUESTS'],
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Only Verified hospitals are authorized/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should reject association with an inactive hospital with 403', async () => {
			const inactiveHospital = await Hospital.create({
				hospitalCode: `HOSP-INACT-${Date.now().toString().slice(-4)}`,
				hospitalName: 'Deactivated Hospital',
				hospitalType: 'Private',
				address: { street: '34 Test Rd', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600002' },
				contactPhone: '9840123458',
				contactEmail: `inact_${Date.now()}@hosp.org`,
				verificationStatus: 'Verified',
				isActive: false, // Inactive!
			})
			cleanupIds.hospitals.push(inactiveHospital._id)

			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: inactiveHospital._id,
				associationStatus: 'Active',
				permissions: ['VERIFY_EMERGENCY_REQUESTS'],
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /currently marked inactive/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should AUTHORIZE valid active Medical Officer with verified active hospital', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
				effectiveFrom: new Date(Date.now() - 24 * 60 * 60 * 1000), // Active since yesterday
				expiresAt: null, // No expiration
			})
			cleanupIds.associations.push(assoc._id)

			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
			})
			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(res.statusCode, 200)

			// Verify context binding
			assert.strictEqual(req.activeAssociation._id.toString(), assoc._id.toString())
			assert.strictEqual(req.activeHospital._id.toString(), verifiedHospital._id.toString())
			assert.strictEqual(req.hospitalId.toString(), verifiedHospital._id.toString())
			assert.strictEqual(req.hospitalScope.toString(), verifiedHospital._id.toString())

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should REJECT client-supplied hospitalId scope manipulation attempt with 403', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: moUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			cleanupIds.associations.push(assoc._id)

			const rogueHospitalId = new mongoose.Types.ObjectId().toString()
			const { req, res, next, isNextCalled } = createMockReqRes({
				user: moUser,
				userRole: 'MEDICAL_OFFICER',
				body: { hospitalId: rogueHospitalId }, // Attempt to forge hospital scope
			})

			await protectMedicalOfficerAuth(req, res, next)
			assert.strictEqual(isNextCalled(), false)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Client-supplied hospitalId does not match your authorized facility scope/)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})
	})
})
