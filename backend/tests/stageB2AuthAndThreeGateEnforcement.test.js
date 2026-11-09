/**
 * Stage B2 Integration Test Suite: Core Auth, Middleware & Three-Gate Enforcement
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Phase 4.3.5)
 *
 * Verifies:
 * 1. Gate 1: Account Status Enforcement (Active, Pending_Activation, Suspended, Deactivated)
 * 2. Gate 2: Professional Credential Enforcement (Verified, Unsubmitted, Pending_Verification, Under_Review, Rejected, Suspended)
 * 3. Gate 3: Hospital Association Enforcement (Active, Pending, Suspended, Revoked, Expired, Future Date, Permissions, Hospital Verified)
 * 4. HOSPITAL_ADMIN Authorization & BOLA Tenant Isolation
 * 5. Role Forgery Prevention (client cannot override authenticated role)
 * 6. Hospital-Specific Availability (independent across hospitals, does not revoke verification authorization)
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const userModel = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { MedicalOfficerHospital } = require('../Hospital/medicalOfficerHospitalModel')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const { protectHospitalAdminAuth } = require('../Hospital/hospitalAdminMiddleware')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { login, tokenGenerate } = require('../Login_And_Authentication/login')
const { generateStaffToken, protectStaff } = require('../BloodBank/bloodbankStaffMiddleware')
const medicalOfficerController = require('../Hospital/medicalOfficerController')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'
const TEST_SECRET = process.env.JWT_SECRET
const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

function signToken(userId, options = {}) {
	return jwt.sign(
		{ id: userId.toString(), ...options },
		TEST_SECRET,
		{ expiresIn: options.expiresIn || '1h' }
	)
}

function createMockReqRes({
	headers = {},
	body = {},
	params = {},
	query = {},
	user = null,
	userRole = null,
	model = null,
} = {}) {
	const req = {
		headers: { ...headers },
		body: { ...body },
		params: { ...params },
		query: { ...query },
		user,
		userRole,
		model,
		header(name) {
			return this.headers[name.toLowerCase()]
		},
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
	return { req, res }
}

describe('Stage B2: Core Authentication, Authorization Middleware & Three-Gate Enforcement', () => {
	let verifiedHospital1
	let verifiedHospital2
	let inactiveHospital

	// Fully authorized Medical Officer (all 3 gates pass)
	let fullyAuthorizedMo
	let fullyAuthorizedMoToken

	// Association IDs & User IDs for cleanup
	const createdUserIds = []
	const createdHospitalIds = []
	const createdAssocIds = []

	before(async () => {
		if (mongoose.connection.readyState !== 1) {
			await mongoose.connect(TEST_DB_URI)
		}

		// 1. Create Verified & Active Hospital 1
		verifiedHospital1 = await Hospital.create({
			hospitalCode: `HOSP-B2-01-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Apollo Speciality Hospitals',
			hospitalType: 'Private',
			address: {
				street: '21 Greams Road',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600006',
			},
			contactPhone: '04428290200',
			contactEmail: `apollo.b2.${Date.now()}@apollo.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		createdHospitalIds.push(verifiedHospital1._id)

		// 2. Create Verified & Active Hospital 2
		verifiedHospital2 = await Hospital.create({
			hospitalCode: `HOSP-B2-02-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Fortis Malar Hospital',
			hospitalType: 'Private',
			address: {
				street: '52 1st Main Road, Gandhi Nagar',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600020',
			},
			contactPhone: '04424914020',
			contactEmail: `fortis.b2.${Date.now()}@fortis.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		createdHospitalIds.push(verifiedHospital2._id)

		// 3. Create Inactive / Unverified Hospital
		inactiveHospital = await Hospital.create({
			hospitalCode: `HOSP-B2-03-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Unverified Community Clinic',
			hospitalType: 'Trust',
			address: {
				street: '10 Old Road',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600001',
			},
			contactPhone: '04425251111',
			contactEmail: `unverified.b2.${Date.now()}@clinic.org`,
			verificationStatus: 'Pending',
			isActive: false,
		})
		createdHospitalIds.push(inactiveHospital._id)

		// 4. Create Fully Authorized Doctor (Gate 1: Active, Gate 2: Verified, Gate 3: Active with permission)
		fullyAuthorizedMo = await userModel.create({
			firstName: 'Dr. Anand',
			lastName: 'Subramanian',
			email: `dr.anand.b2.${Date.now()}@apollo.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'SecurePassword123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			status: true,
			credentialStatus: 'Verified',
			verificationStatus: 'Verified',
			medicalRegistrationNumber: `TMC-B2-${Date.now().toString().slice(-5)}`,
			medicalCouncil: 'Tamil Nadu Medical Council',
			registrationState: 'Tamil Nadu',
		})
		createdUserIds.push(fullyAuthorizedMo._id)
		fullyAuthorizedMoToken = signToken(fullyAuthorizedMo._id)

		const assoc1 = await MedicalOfficerHospital.create({
			medicalOfficerUserId: fullyAuthorizedMo._id,
			hospitalId: verifiedHospital1._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			availabilityStatus: 'Unavailable', // Initial default
		})
		createdAssocIds.push(assoc1._id)
	})

	after(async () => {
		if (createdAssocIds.length > 0) {
			await MedicalOfficerHospital.deleteMany({ _id: { $in: createdAssocIds } })
		}
		if (createdUserIds.length > 0) {
			await userModel.deleteMany({ _id: { $in: createdUserIds } })
		}
		if (createdHospitalIds.length > 0) {
			await Hospital.deleteMany({ _id: { $in: createdHospitalIds } })
		}
		await mongoose.disconnect()
	})

	// =========================================================================
	// 1. Gate 1: Account Status Enforcement
	// =========================================================================
	describe('1. Gate 1: Account Status Enforcement', () => {
		it('should SUCCEED when accountStatus is Active and status is true', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${fullyAuthorizedMoToken}` },
			})

			let nextCalled = false
			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {
				nextCalled = true
			})

			assert.strictEqual(nextCalled, true, 'Next middleware should be called')
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(req.userRole, 'MEDICAL_OFFICER')
			assert.strictEqual(req.user._id.toString(), fullyAuthorizedMo._id.toString())
		})

		it('should REJECT Medical Officer when accountStatus is Pending_Activation (HTTP 403)', async () => {
			const pendingMo = await userModel.create({
				firstName: 'Dr. Pending',
				lastName: 'Doctor',
				email: `dr.pending.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Pending_Activation',
				status: true,
				credentialStatus: 'Verified',
			})
			createdUserIds.push(pendingMo._id)

			const token = signToken(pendingMo._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /pending activation/i)
		})

		it('should REJECT Medical Officer when accountStatus is Suspended (HTTP 403)', async () => {
			const suspendedMo = await userModel.create({
				firstName: 'Dr. Suspended',
				lastName: 'Doctor',
				email: `dr.suspended.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Suspended',
				status: true,
				credentialStatus: 'Verified',
			})
			createdUserIds.push(suspendedMo._id)

			const token = signToken(suspendedMo._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account is suspended/i)
		})

		it('should REJECT Medical Officer when accountStatus is Deactivated (HTTP 403)', async () => {
			const deactivatedMo = await userModel.create({
				firstName: 'Dr. Deactivated',
				lastName: 'Doctor',
				email: `dr.deactivated.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Deactivated',
				status: false,
				credentialStatus: 'Verified',
			})
			createdUserIds.push(deactivatedMo._id)

			const token = signToken(deactivatedMo._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account is deactivated/i)
		})

		it('should REJECT Medical Officer when accountStatus is genuinely ABSENT (HTTP 403, missing lifecycle not treated as Active)', async () => {
			const noAccMo = await userModel.create({
				firstName: 'Dr. NoAccountStatus',
				lastName: 'Doctor',
				email: `dr.noacc.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				status: true,
				credentialStatus: 'Verified',
			})
			createdUserIds.push(noAccMo._id)
			// Unset accountStatus directly in collection to simulate legacy record without lifecycle field
			await userModel.collection.updateOne({ _id: noAccMo._id }, { $unset: { accountStatus: '' } })

			const token = signToken(noAccMo._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account status is missing/i)
		})
	})

	// =========================================================================
	// 2. Gate 2: Professional Credential Status Enforcement
	// =========================================================================
	describe('2. Gate 2: Professional Credential Status Enforcement', () => {
		it('should ALLOW Medical Officer when credentialStatus is Verified (passes Gate 2)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${fullyAuthorizedMoToken}` },
			})

			let nextCalled = false
			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {
				nextCalled = true
			})

			assert.strictEqual(nextCalled, true)
			assert.strictEqual(res.statusCode, 200)
		})

		it('should REJECT Medical Officer when credentialStatus is Unsubmitted (HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. Unsubmitted',
				lastName: 'Doc',
				email: `dr.unsubmitted.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Unsubmitted',
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('should REJECT Medical Officer when credentialStatus is Pending_Verification (HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. PendingCreds',
				lastName: 'Doc',
				email: `dr.pendingcreds.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Pending_Verification',
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /pending administrative verification/i)
		})

		it('should REJECT Medical Officer when credentialStatus is Under_Review (HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. UnderReview',
				lastName: 'Doc',
				email: `dr.underreview.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Under_Review',
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /under administrative review/i)
		})

		it('should REJECT Medical Officer when credentialStatus is Rejected (HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. Rejected',
				lastName: 'Doc',
				email: `dr.rejected.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Rejected',
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials were rejected/i)
		})

		it('should REJECT Medical Officer when credentialStatus is Suspended (HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. SuspendedCreds',
				lastName: 'Doc',
				email: `dr.suspendedcreds.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Suspended',
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials are suspended/i)
		})

		it('should REJECT Medical Officer when credentialStatus is Suspended even if legacy verificationStatus is Verified (precedence, HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. SuspendedWithLegacyVerified',
				lastName: 'Doc',
				email: `dr.susp_leg_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Suspended',
				verificationStatus: 'Verified', // Contradictory legacy field
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials are suspended/i)

			// Stage B3.4 Decoupled Auth: Active account authenticates into ONBOARDING session
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: doc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.strictEqual(loginMock.res.responseData?.sessionScope, 'ONBOARDING')
		})

		it('should REJECT Medical Officer when credentialStatus is Rejected even if legacy verificationStatus is Verified (precedence, HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. RejectedWithLegacyVerified',
				lastName: 'Doc',
				email: `dr.rej_leg_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Rejected',
				verificationStatus: 'Verified',
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials were rejected/i)

			// Stage B3.4 Decoupled Auth: Active account authenticates into ONBOARDING session
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: doc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.strictEqual(loginMock.res.responseData?.sessionScope, 'ONBOARDING')
		})

		it('should REJECT Medical Officer when credentialStatus is Pending_Verification even if legacy verificationStatus is Verified (precedence, HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. PendingWithLegacyVerified',
				lastName: 'Doc',
				email: `dr.pend_leg_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Pending_Verification',
				verificationStatus: 'Verified',
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /pending administrative verification/i)

			// Stage B3.4 Decoupled Auth: Active account authenticates into ONBOARDING session
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: doc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.strictEqual(loginMock.res.responseData?.sessionScope, 'ONBOARDING')
		})

		it('should REJECT Medical Officer when credentialStatus and verificationStatus are both MISSING (HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. MissingCreds',
				lastName: 'Doc',
				email: `dr.missing_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(doc._id)
			// Unset both fields directly in collection
			await userModel.collection.updateOne(
				{ _id: doc._id },
				{ $unset: { credentialStatus: '', verificationStatus: '' } }
			)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credential status is missing/i)

			// Stage B3.4 Decoupled Auth: Active account authenticates into ONBOARDING session
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: doc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.strictEqual(loginMock.res.responseData?.sessionScope, 'ONBOARDING')
		})

		it('should ALLOW legacy Medical Officer when credentialStatus is genuinely ABSENT but verificationStatus is Verified (scoped legacy fallback)', async () => {
			const legacyDoc = await userModel.create({
				firstName: 'Dr. LegacyVerified',
				lastName: 'Doc',
				email: `dr.legacy_ver_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				verificationStatus: 'Verified',
				status: true,
			})
			createdUserIds.push(legacyDoc._id)
			// Unset credentialStatus to strictly test genuinely absent legacy state
			await userModel.collection.updateOne({ _id: legacyDoc._id }, { $unset: { credentialStatus: '' } })

			// Create active association for Gate 3
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: legacyDoc._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			createdAssocIds.push(assoc._id)

			const token = signToken(legacyDoc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			let nextCalled = false
			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {
				nextCalled = true
			})

			assert.strictEqual(nextCalled, true, 'Legacy Verified MO should pass Gate 2 via fallback')
			assert.strictEqual(res.statusCode, 200)

			// Login should also succeed
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: legacyDoc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.ok(loginMock.res.responseData?.token)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should REJECT Medical Officer when credentialStatus is MALFORMED/invalid (HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. MalformedCreds',
				lastName: 'Doc',
				email: `dr.malformed_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(doc._id)
			// Force invalid/malformed string directly into collection (bypassing enum validation)
			await userModel.collection.updateOne(
				{ _id: doc._id },
				{ $set: { credentialStatus: 'CORRUPTED_VALUE_NON_ENUM' } }
			)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /malformed or invalid/i)

			// Stage B3.4 Decoupled Auth: Active account authenticates into ONBOARDING session
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: doc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.strictEqual(loginMock.res.responseData?.sessionScope, 'ONBOARDING')
		})

		it('should strictly REJECT Medical Officer when credentialStatus is explicit NULL even if legacy verificationStatus is Verified (null is not absent, HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. NullCreds',
				lastName: 'Doc',
				email: `dr.nullcreds_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(doc._id)
			// Explicitly set credentialStatus to null and verificationStatus to Verified
			await userModel.collection.updateOne(
				{ _id: doc._id },
				{ $set: { credentialStatus: null, verificationStatus: 'Verified' } }
			)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /invalid \(null\)/i)

			// Stage B3.4 Decoupled Auth: Active account authenticates into ONBOARDING session
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: doc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.strictEqual(loginMock.res.responseData?.sessionScope, 'ONBOARDING')
		})

		it('should strictly REJECT Medical Officer when credentialStatus is empty string even if legacy verificationStatus is Verified (empty string is not absent, HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. EmptyCreds',
				lastName: 'Doc',
				email: `dr.emptycreds_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(doc._id)
			// Explicitly set credentialStatus to empty string and verificationStatus to Verified
			await userModel.collection.updateOne(
				{ _id: doc._id },
				{ $set: { credentialStatus: '', verificationStatus: 'Verified' } }
			)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /invalid \(empty\)/i)

			// Stage B3.4 Decoupled Auth: Active account authenticates into ONBOARDING session
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: doc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.strictEqual(loginMock.res.responseData?.sessionScope, 'ONBOARDING')
		})

		it('should REJECT Medical Officer when credentialStatus is Unsubmitted even if legacy verificationStatus is Verified (precedence, HTTP 403)', async () => {
			const doc = await userModel.create({
				firstName: 'Dr. UnsubWithLegacyVerified',
				lastName: 'Doc',
				email: `dr.unsub_leg_${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Unsubmitted',
				verificationStatus: 'Verified',
			})
			createdUserIds.push(doc._id)

			const token = signToken(doc._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)

			// Stage B3.4 Decoupled Auth: Active account authenticates into ONBOARDING session
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: doc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.strictEqual(loginMock.res.responseData?.sessionScope, 'ONBOARDING')
		})
	})

	// =========================================================================
	// 3. Gate 3: Hospital Association Authorization Enforcement
	// =========================================================================
	describe('3. Gate 3: Hospital Association Authorization Enforcement', () => {
		let verifiedDoctorUser
		let verifiedDoctorToken

		before(async () => {
			verifiedDoctorUser = await userModel.create({
				firstName: 'Dr. Priya',
				lastName: 'Raman',
				email: `dr.priya.b2.${Date.now()}@hospital.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Verified',
				verificationStatus: 'Verified',
			})
			createdUserIds.push(verifiedDoctorUser._id)
			verifiedDoctorToken = signToken(verifiedDoctorUser._id)
		})

		beforeEach(async () => {
			await MedicalOfficerHospital.deleteMany({ medicalOfficerUserId: verifiedDoctorUser._id })
		})

		it('should REJECT doctor when no association exists (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /No hospital association found/i)
		})

		it('should REJECT doctor when association is Pending_Admin_Approval or Pending (HTTP 403)', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: verifiedDoctorUser._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Pending_Admin_Approval',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			createdAssocIds.push(assoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /pending administrative approval/i)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should REJECT doctor when association is Suspended (HTTP 403)', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: verifiedDoctorUser._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Suspended',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			createdAssocIds.push(assoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /suspended/i)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should REJECT doctor when association is Revoked (HTTP 403)', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: verifiedDoctorUser._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Revoked',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			createdAssocIds.push(assoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /revoked/i)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should REJECT association whose effectiveFrom is in the future (HTTP 403)', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: verifiedDoctorUser._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
				effectiveFrom: new Date(Date.now() + 7 * 24 * 3600 * 1000), // 7 days future
			})
			createdAssocIds.push(assoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /not yet effective/i)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should REJECT association whose expiresAt has passed (HTTP 403)', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: verifiedDoctorUser._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
				effectiveFrom: new Date(Date.now() - 30 * 24 * 3600 * 1000),
				expiresAt: new Date(Date.now() - 1000), // expired 1s ago
			})
			createdAssocIds.push(assoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /expired/i)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should REJECT association when missing required permission (HTTP 403)', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: verifiedDoctorUser._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'], // Lacks VERIFY_EMERGENCY_REQUESTS
			})
			createdAssocIds.push(assoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			// Requesting verification action
			await protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /does not grant the required 'VERIFY_EMERGENCY_REQUESTS'/i)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})

		it('should REJECT association when hospital is unverified or inactive (HTTP 403)', async () => {
			const assoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: verifiedDoctorUser._id,
				hospitalId: inactiveHospital._id, // Pending & inactive hospital
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			createdAssocIds.push(assoc._id)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Only Verified hospitals are authorized|unverified or inactive/i)

			await MedicalOfficerHospital.deleteOne({ _id: assoc._id })
		})
	})

	// =========================================================================
	// 4. HOSPITAL_ADMIN Authorization & BOLA Tenant Isolation
	// =========================================================================
	describe('4. HOSPITAL_ADMIN Authorization & Tenant Isolation', () => {
		let hospitalAdminUser
		let hospitalAdminToken

		before(async () => {
			hospitalAdminUser = await userModel.create({
				firstName: 'Admin',
				lastName: 'ApolloRep',
				email: `rep.apollo.b2.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'HOSPITAL_ADMIN',
				accountStatus: 'Active',
				status: true,
				hospitalId: verifiedHospital1._id,
				representativeStatus: 'Active',
			})
			createdUserIds.push(hospitalAdminUser._id)
			hospitalAdminToken = signToken(hospitalAdminUser._id)
		})

		it('should AUTHORIZE valid HOSPITAL_ADMIN and bind authoritative hospital scope', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${hospitalAdminToken}` },
			})

			let nextCalled = false
			await protectHospitalAdminAuth(req, res, () => {
				nextCalled = true
			})

			assert.strictEqual(nextCalled, true)
			assert.strictEqual(req.userRole, 'HOSPITAL_ADMIN')
			assert.strictEqual(req.hospitalId.toString(), verifiedHospital1._id.toString())
			assert.strictEqual(req.hospital.hospitalName, 'Apollo Speciality Hospitals')
		})

		it('should REJECT HOSPITAL_ADMIN attempting to access or modify records of another hospital (BOLA defense, HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${hospitalAdminToken}` },
				body: { hospitalId: verifiedHospital2._id.toString() }, // Forged hospitalId
			})

			await protectHospitalAdminAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /cannot access, nominate, or manage records for another hospital/i)
		})

		it('should REJECT HOSPITAL_ADMIN attempting to access Medical Officer clinical verification endpoints (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${hospitalAdminToken}` },
			})

			await protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Hospital Representatives are not authorized/i)
		})

		it('should REJECT unactivated or suspended HOSPITAL_ADMIN (HTTP 403)', async () => {
			const suspendedRep = await userModel.create({
				firstName: 'Rep',
				lastName: 'Suspended',
				email: `rep.suspended.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'HOSPITAL_ADMIN',
				accountStatus: 'Suspended',
				status: true,
				hospitalId: verifiedHospital1._id,
				representativeStatus: 'Suspended',
			})
			createdUserIds.push(suspendedRep._id)

			const token = signToken(suspendedRep._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectHospitalAdminAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /suspended/i)
		})
	})

	// =========================================================================
	// 5. Role Forgery Prevention
	// =========================================================================
	describe('5. Role Forgery Prevention', () => {
		it('should derive userRole exclusively from database record and IGNORE client-forged role in body, query, or headers', async () => {
			// A regular USER attempts to claim role: 'MEDICAL_OFFICER' or 'ADMIN'
			const normalUser = await userModel.create({
				firstName: 'Sneaky',
				lastName: 'Attacker',
				email: `attacker.${Date.now()}@gmail.com`,
				gender: 'Male',
				dob: new Date('1995-01-01'),
				age: 30,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: 'Guindy',
				pinCode: 600032,
				password: 'Password123!',
				role: 'USER',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(normalUser._id)

			const token = signToken(normalUser._id)
			const { req, res } = createMockReqRes({
				headers: {
					authorization: `Bearer ${token}`,
					'x-user-role': 'ADMIN',
				},
				body: { role: 'MEDICAL_OFFICER' },
				query: { role: 'ADMIN' },
			})

			await protectEmergencyAuth(req, res, () => {})
			// Middleware resolves role from database
			assert.strictEqual(req.userRole, 'USER', 'Role must remain USER from database')

			// Medical Officer middleware rejects this user
			const moReqRes = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
				body: { role: 'MEDICAL_OFFICER' },
			})
			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(moReqRes.req, moReqRes.res, () => {})
			assert.strictEqual(moReqRes.res.statusCode, 403)
			assert.match(moReqRes.res.responseData?.message, /Role 'USER' is not authorized/i)
		})
	})

	// =========================================================================
	// 6. Hospital-Specific Medical Officer Availability
	// =========================================================================
	describe('6. Hospital-Specific Medical Officer Availability', () => {
		let multiHospDoc
		let multiHospToken
		let assocHosp1
		let assocHosp2

		before(async () => {
			multiHospDoc = await userModel.create({
				firstName: 'Dr. Multi',
				lastName: 'Hospital',
				email: `dr.multi.${Date.now()}@apollo.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
				credentialStatus: 'Verified',
				verificationStatus: 'Verified',
			})
			createdUserIds.push(multiHospDoc._id)
			multiHospToken = signToken(multiHospDoc._id)

			// Associated with both Hospital 1 and Hospital 2
			assocHosp1 = await MedicalOfficerHospital.create({
				medicalOfficerUserId: multiHospDoc._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
				availabilityStatus: 'Unavailable',
			})
			createdAssocIds.push(assocHosp1._id)

			assocHosp2 = await MedicalOfficerHospital.create({
				medicalOfficerUserId: multiHospDoc._id,
				hospitalId: verifiedHospital2._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
				availabilityStatus: 'Unavailable',
			})
			createdAssocIds.push(assocHosp2._id)
		})

		it('should update availability at Hospital 1 to Available without affecting Hospital 2', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${multiHospToken}` },
				params: { hospitalId: verifiedHospital1._id.toString() },
				body: { availabilityStatus: 'Available' },
			})

			// Pass through middleware first
			let middlewareErr = null
			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, (err) => {
				if (err) middlewareErr = err
			})
			if (middlewareErr) throw middlewareErr
			await medicalOfficerController.updateAvailability(req, res, () => {})

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.availabilityStatus, 'Available')
			assert.strictEqual(res.responseData?.data?.hospitalId.toString(), verifiedHospital1._id.toString())

			// Verify in DB: Hospital 1 is Available, Hospital 2 remains strictly Unavailable
			const dbAssoc1 = await MedicalOfficerHospital.findById(assocHosp1._id)
			const dbAssoc2 = await MedicalOfficerHospital.findById(assocHosp2._id)

			assert.strictEqual(dbAssoc1.availabilityStatus, 'Available')
			assert.strictEqual(dbAssoc2.availabilityStatus, 'Unavailable', 'Hospital 2 must remain Unavailable')
		})

		it('should allow an Unavailable doctor to STILL access queue and clinical verification (Availability does not revoke authorization)', async () => {
			// Doctor is Unavailable at Hospital 2, but has Active association and VERIFY_EMERGENCY_REQUESTS
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${multiHospToken}` },
				query: { hospitalId: verifiedHospital2._id.toString() },
			})

			let nextCalled = false
			await protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS')(req, res, () => {
				nextCalled = true
			})

			assert.strictEqual(nextCalled, true, 'Unavailable doctor must still be authorized')
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(req.activeHospital._id.toString(), verifiedHospital2._id.toString())
		})
	})

	// =========================================================================
	// 7. Existing Role Authentication Compatibility & Lifecycle Regression
	// =========================================================================
	describe('7. Existing Role Authentication Compatibility & Lifecycle Regression', () => {
		let adminUser, adminToken
		let bbDoc, bbToken
		let staffDoc, staffToken

		before(async () => {
			// 1. Create ADMIN
			adminUser = await Admin.create({
				firstName: 'Root',
				lastName: 'Admin',
				email: `admin.reg_${Date.now()}@bloodbank.org`,
				phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				password: 'Password123!',
				status: true,
			})
			createdUserIds.push(adminUser._id)
			adminToken = signToken(adminUser._id, { userType: 'user' })

			// 2. Create BLOODBANK
			bbDoc = await Bloodbank.create({
				bloodbankName: 'City Blood Bank',
				state: 'Tamil Nadu',
				city: 'Chennai',
				category: 'Government',
				contactPerson: 'Dr. Ramesh',
				address1: '12 Hospital Rd',
				address2: 'Near Central',
				pinCode: 600001,
				phoneNo1: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				phoneNo2: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				email: `bb.reg_${Date.now()}@bloodbank.org`,
				password: 'Password123!',
				status: true,
				location: { type: 'Point', coordinates: [80.2707, 13.0827] },
			})
			createdHospitalIds.push(bbDoc._id)
			bbToken = signToken(bbDoc._id, { userType: 'user' })

			// 3. Create STAFF
			staffDoc = await BloodbankStaff.create({
				fullName: 'Nurse Sangeetha',
				email: `staff.reg_${Date.now()}@bloodbank.org`,
				phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				password: 'Password123!',
				bloodbankId: bbDoc._id,
				createdBy: bbDoc._id,
				role: 'Lab_Technician',
				status: 'Active',
			})
			createdUserIds.push(staffDoc._id)
			staffToken = signToken(staffDoc._id, { userType: 'staff' })
		})

		it('should ALLOW existing ADMIN login and emergency authorization (status: true)', async () => {
			// Login
			const loginMock = createMockReqRes({
				model: Admin,
				body: { email: adminUser.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.ok(loginMock.res.responseData?.token)

			// Auth middleware
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${adminToken}` },
			})
			let nextCalled = false
			await protectEmergencyAuth(req, res, () => { nextCalled = true })
			assert.strictEqual(nextCalled, true)
			assert.strictEqual(req.userRole, 'ADMIN')
		})

		it('should ALLOW existing USER login and emergency authorization with legacy record (absent accountStatus, status: true)', async () => {
			const legacyUser = await userModel.create({
				firstName: 'Legacy',
				lastName: 'Donor',
				email: `legacy.donor_${Date.now()}@donor.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				gender: 'Male',
				dob: new Date('1990-01-01'),
				age: 34,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: '12 Main Rd',
				pinCode: 600001,
				password: 'Password123!',
				role: 'USER',
				status: true,
			})
			createdUserIds.push(legacyUser._id)
			// Unset accountStatus directly in Mongo collection
			await userModel.collection.updateOne({ _id: legacyUser._id }, { $unset: { accountStatus: '' } })

			// Login
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: legacyUser.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.ok(loginMock.res.responseData?.token)

			// Auth middleware
			const token = signToken(legacyUser._id, { userType: 'user' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})
			let nextCalled = false
			await protectEmergencyAuth(req, res, () => { nextCalled = true })
			assert.strictEqual(nextCalled, true)
			assert.strictEqual(req.userRole, 'USER')
		})

		it('should ALLOW USER with explicit accountStatus: Active', async () => {
			const activeUser = await userModel.create({
				firstName: 'Active',
				lastName: 'User',
				email: `act.user_${Date.now()}@user.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				gender: 'Female',
				dob: new Date('1992-05-15'),
				age: 32,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: '44 Anna Salai',
				pinCode: 600002,
				password: 'Password123!',
				role: 'USER',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(activeUser._id)

			const token = signToken(activeUser._id, { userType: 'user' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})
			let nextCalled = false
			await protectEmergencyAuth(req, res, () => { nextCalled = true })
			assert.strictEqual(nextCalled, true)
			assert.strictEqual(req.userRole, 'USER')
		})

		it('should REJECT USER with explicit accountStatus: Suspended (HTTP 403)', async () => {
			const suspUser = await userModel.create({
				firstName: 'Suspended',
				lastName: 'User',
				email: `susp.user_${Date.now()}@user.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				gender: 'Male',
				dob: new Date('1988-11-20'),
				age: 36,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: '88 Mount Rd',
				pinCode: 600002,
				password: 'Password123!',
				role: 'USER',
				accountStatus: 'Suspended',
				status: true,
			})
			createdUserIds.push(suspUser._id)

			// Login
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: suspUser.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 403)
			assert.match(loginMock.res.responseData?.message, /account is suspended/i)

			// Emergency Auth
			const token = signToken(suspUser._id, { userType: 'user' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})
			await protectEmergencyAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account is suspended/i)
		})

		it('should REJECT USER with explicit accountStatus: Deactivated (HTTP 403)', async () => {
			const deactUser = await userModel.create({
				firstName: 'Deactivated',
				lastName: 'User',
				email: `deact.user_${Date.now()}@user.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				gender: 'Female',
				dob: new Date('1995-02-10'),
				age: 29,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: '10 Beach Rd',
				pinCode: 600001,
				password: 'Password123!',
				role: 'USER',
				accountStatus: 'Deactivated',
				status: true,
			})
			createdUserIds.push(deactUser._id)

			const token = signToken(deactUser._id, { userType: 'user' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})
			await protectEmergencyAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account is deactivated/i)
		})

		it('should REJECT USER with status: false (HTTP 401)', async () => {
			const inactUser = await userModel.create({
				firstName: 'Inactive',
				lastName: 'User',
				email: `inact.user_${Date.now()}@user.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				gender: 'Male',
				dob: new Date('1985-07-04'),
				age: 39,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: '22 South Rd',
				pinCode: 600017,
				password: 'Password123!',
				role: 'USER',
				accountStatus: 'Active',
				status: false,
			})
			createdUserIds.push(inactUser._id)

			// Login
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: inactUser.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 401)
			assert.match(loginMock.res.responseData?.message, /deactivated or suspended/i)

			// Emergency Auth
			const token = signToken(inactUser._id, { userType: 'user' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})
			await protectEmergencyAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /deactivated or suspended/i)
		})

		it('should ALLOW existing BLOODBANK login and emergency authorization (status: true)', async () => {
			// Login
			const loginMock = createMockReqRes({
				model: Bloodbank,
				body: { email: bbDoc.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 200)
			assert.ok(loginMock.res.responseData?.token)

			// Auth middleware
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${bbToken}` },
			})
			let nextCalled = false
			await protectEmergencyAuth(req, res, () => { nextCalled = true })
			assert.strictEqual(nextCalled, true)
			assert.strictEqual(req.userRole, 'BLOODBANK')
		})

		it('should REJECT BLOODBANK with status: false (HTTP 401)', async () => {
			const inactBb = await Bloodbank.create({
				bloodbankName: 'Closed Blood Bank',
				state: 'Tamil Nadu',
				city: 'Madurai',
				category: 'Private',
				contactPerson: 'Dr. Suresh',
				address1: 'Old Rd',
				address2: 'Near Bus Stand',
				pinCode: 625001,
				phoneNo1: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				phoneNo2: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				email: `bb.inact_${Date.now()}@bloodbank.org`,
				password: 'Password123!',
				status: false,
				location: { type: 'Point', coordinates: [78.1198, 9.9252] },
			})
			createdHospitalIds.push(inactBb._id)

			const loginMock = createMockReqRes({
				model: Bloodbank,
				body: { email: inactBb.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 401)

			const token = signToken(inactBb._id, { userType: 'user' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})
			await protectEmergencyAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 401)
		})

		it('should ALLOW existing STAFF authentication (status: Active) with staff token', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${staffToken}` },
			})
			let nextCalled = false
			await protectEmergencyAuth(req, res, () => { nextCalled = true })
			assert.strictEqual(nextCalled, true)
			assert.strictEqual(req.userRole, 'STAFF')
			assert.strictEqual(req.staff._id.toString(), staffDoc._id.toString())
		})

		it('should REJECT STAFF with status: Suspended (HTTP 401)', async () => {
			const suspStaff = await BloodbankStaff.create({
				fullName: 'Suspended Staff',
				email: `staff.susp_${Date.now()}@bloodbank.org`,
				phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				password: 'Password123!',
				bloodbankId: bbDoc._id,
				createdBy: bbDoc._id,
				role: 'Lab_Technician',
				status: 'Suspended',
			})
			createdUserIds.push(suspStaff._id)

			const token = signToken(suspStaff._id, { userType: 'staff' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})
			await protectEmergencyAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /inactive or suspended/i)
		})

		it('should strictly REJECT Medical Officer authentication when accountStatus is absent (HTTP 403, missing lifecycle not treated as Active)', async () => {
			const moWithoutAccStatus = await userModel.create({
				firstName: 'Dr. NoStatusMO',
				lastName: 'Doctor',
				email: `mo.nostatus_${Date.now()}@hospital.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				credentialStatus: 'Verified',
				status: true,
			})
			createdUserIds.push(moWithoutAccStatus._id)
			await userModel.collection.updateOne({ _id: moWithoutAccStatus._id }, { $unset: { accountStatus: '' } })

			// Login attempt
			const loginMock = createMockReqRes({
				model: userModel,
				body: { email: moWithoutAccStatus.email, password: 'Password123!' },
			})
			await login(loginMock.req, loginMock.res, () => {})
			assert.strictEqual(loginMock.res.statusCode, 403)
			assert.match(loginMock.res.responseData?.message, /account status is missing/i)

			// Emergency Auth attempt
			const token = signToken(moWithoutAccStatus._id, { userType: 'user' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})
			await protectEmergencyAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account status is missing/i)
		})
	})

	// =========================================================================
	// 8. Production JWT Secret Configuration & Fail-Closed Security Enforcement
	// =========================================================================
	describe('8. Production JWT Secret Configuration & Fail-Closed Security Enforcement', () => {
		const originalSecret = process.env.JWT_SECRET

		afterEach(() => {
			if (originalSecret) {
				process.env.JWT_SECRET = originalSecret
			} else {
				delete process.env.JWT_SECRET
			}
		})

		it('should throw HTTP 500 from tokenGenerate when JWT_SECRET is unset or empty', () => {
			delete process.env.JWT_SECRET
			assert.throws(
				() => {
					tokenGenerate('some_user_id', 0)
				},
				(err) => {
					return err.statusCode === 500 && /JWT_SECRET environment variable is not configured/i.test(err.message)
				}
			)

			process.env.JWT_SECRET = '   '
			assert.throws(
				() => {
					tokenGenerate('some_user_id', 0)
				},
				(err) => {
					return err.statusCode === 500 && /JWT_SECRET environment variable is not configured/i.test(err.message)
				}
			)
		})

		it('should throw HTTP 500 from generateStaffToken when JWT_SECRET is unset or empty', () => {
			delete process.env.JWT_SECRET
			assert.throws(
				() => {
					generateStaffToken({ _id: 'staff_1', bloodbankId: 'bb_1', role: 'Lab_Technician' })
				},
				(err) => {
					return err.statusCode === 500 && /JWT_SECRET environment variable is not configured/i.test(err.message)
				}
			)
		})

		it('should return HTTP 500 error from protectMedicalOfficerAuth when JWT_SECRET is unset (fail closed)', async () => {
			delete process.env.JWT_SECRET

			const token = signToken(fullyAuthorizedMo._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 500)
			assert.strictEqual(res.responseData?.status, 'error')
			assert.match(res.responseData?.message, /JWT_SECRET environment variable is not configured/i)
		})

		it('should return HTTP 500 error from protectHospitalAdminAuth when JWT_SECRET is unset (fail closed)', async () => {
			delete process.env.JWT_SECRET

			const token = signToken(fullyAuthorizedMo._id)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectHospitalAdminAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 500)
			assert.strictEqual(res.responseData?.status, 'error')
			assert.match(res.responseData?.message, /JWT_SECRET environment variable is not configured/i)
		})

		it('should return HTTP 500 error from protectEmergencyAuth when JWT_SECRET is unset (fail closed)', async () => {
			delete process.env.JWT_SECRET

			const token = signToken(fullyAuthorizedMo._id, { userType: 'user' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectEmergencyAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 500)
			assert.strictEqual(res.responseData?.status, 'error')
			assert.match(res.responseData?.message, /JWT_SECRET environment variable is not configured/i)
		})

		it('should return HTTP 500 error from protectStaff when JWT_SECRET is unset (fail closed)', async () => {
			delete process.env.JWT_SECRET

			const token = signToken(new mongoose.Types.ObjectId(), { userType: 'staff' })
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectStaff(req, res, () => {})
			assert.strictEqual(res.statusCode, 500)
			assert.strictEqual(res.responseData?.status, 'error')
			assert.match(res.responseData?.message, /JWT_SECRET environment variable is not configured/i)
		})

		it('should NEVER fall back to hardcoded test secret when token signed with hardcoded secret attempts access with a different configured secret', async () => {
			// Configured production secret
			process.env.JWT_SECRET = 'configured_production_secure_secret_99887766'

			// Token forged/signed using the obsolete hardcoded secret fallback
			const forgedToken = jwt.sign(
				{ id: fullyAuthorizedMo._id.toString(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 },
				'test_jwt_secret_key_12345'
			)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${forgedToken}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /invalid or expired/i)
		})

		it('should successfully sign and verify tokens when JWT_SECRET is properly configured', async () => {
			const validSecret = 'valid_configured_secret_for_production_testing_332211'
			process.env.JWT_SECRET = validSecret

			const generatedToken = tokenGenerate(fullyAuthorizedMo._id.toString(), 0)
			assert.ok(typeof generatedToken === 'string' && generatedToken.length > 20)

			const decoded = jwt.verify(generatedToken, validSecret)
			assert.strictEqual(decoded.id, fullyAuthorizedMo._id.toString())

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${generatedToken}` },
			})

			let nextCalled = false
			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {
				nextCalled = true
			})

			assert.strictEqual(nextCalled, true)
			assert.strictEqual(res.statusCode, 200)
		})
	})
})
