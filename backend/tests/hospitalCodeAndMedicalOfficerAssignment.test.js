/**
 * Backend Integration Tests: Hospital Registration Concurrency & Medical Officer Onboarding Lifecycle
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const userModel = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { HospitalSequence } = require('../Hospital/hospitalSequenceModel')
const { MedicalOfficerHospital } = require('../Hospital/medicalOfficerHospitalModel')
const hospitalController = require('../Hospital/hospitalController')
const { generateHospitalCode } = hospitalController
const { login } = require('../Login_And_Authentication/login')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')

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
	model = null,
} = {}) {
	const req = {
		headers,
		body,
		params,
		query,
		user,
		userRole,
		model,
		header(name) {
			return this.headers[name.toLowerCase()]
		},
	}

	const res = {
		statusCode: 200,
		jsonData: null,
		status(code) {
			this.statusCode = code
			return this
		},
		json(data) {
			this.jsonData = data
			return this
		},
	}

	return { req, res }
}

describe('Hospital Code Concurrency, Registration Validation & MO Onboarding Lifecycle', () => {
	let adminUser
	let adminToken
	let activeMoUser
	let pendingMoUser
	let regularUser
	let testHospital1
	let testHospital2

	const testCreatedHospitalIds = []
	const testCreatedAssocIds = []
	const testCreatedUserIds = []

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}

		// 1. Create mock platform admin
		adminUser = await Admin.create({
			phoneNo: `98${Date.now().toString().slice(-8)}`,
			email: `master_admin_onboard_${Date.now()}@nammablood.org`,
			password: 'Password123!',
		})
		adminToken = jwt.sign(
			{ id: adminUser._id.toString(), role: 'ADMIN', tokenVersion: 0 },
			TEST_SECRET,
			{ expiresIn: '1h' }
		)

		// 2. Create verified hospital
		testHospital1 = await Hospital.create({
			hospitalCode: `HOSP-CHE-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Apollo Main Centre Test',
			hospitalType: 'Private',
			address: {
				street: '21 Greams Lane',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600006',
			},
			contactPhone: '04428290200',
			contactEmail: `apollo.test.${Date.now()}@apollo.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		testCreatedHospitalIds.push(testHospital1._id)

		testHospital2 = await Hospital.create({
			hospitalCode: `HOSP-CHE-${(Date.now() + 1).toString().slice(-4)}`,
			hospitalName: 'Fortis Malar Hospital Test',
			hospitalType: 'Private',
			address: {
				street: '52 1st Main Rd, Adyar',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600020',
			},
			contactPhone: '04424914020',
			contactEmail: `fortis.test.${Date.now()}@fortis.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		testCreatedHospitalIds.push(testHospital2._id)

		// 3. Create verified active accredited Medical Officer
		activeMoUser = await userModel.create({
			firstName: 'Ramesh',
			lastName: 'Kuppusamy',
			email: `dr.ramesh_${Date.now()}@hospital.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'Password123!',
			role: 'MEDICAL_OFFICER',
			verificationStatus: 'Verified',
			status: true,
			medicalRegistrationNumber: `TMC-VER-${Date.now().toString().slice(-5)}`,
			medicalCouncil: 'Tamil Nadu Medical Council',
			registrationState: 'Tamil Nadu',
		})
		testCreatedUserIds.push(activeMoUser._id)

		// 4. Create pending unverified Medical Officer
		pendingMoUser = await userModel.create({
			firstName: 'Siddharth',
			lastName: 'Natarajan',
			email: `dr.sid_${Date.now()}@hospital.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'Password123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: 'Pending_Verification',
			verificationStatus: 'Pending',
			status: true,
			medicalRegistrationNumber: `TMC-PEND-${Date.now().toString().slice(-5)}`,
			medicalCouncil: 'Tamil Nadu Medical Council',
			registrationState: 'Tamil Nadu',
		})
		testCreatedUserIds.push(pendingMoUser._id)

		// 5. Create regular user
		regularUser = await userModel.create({
			firstName: 'Anand',
			lastName: 'Kumar',
			gender: 'Male',
			dob: new Date('1995-10-10'),
			age: 29,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `anand_reg_${Date.now()}@gmail.com`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'T Nagar',
			pinCode: 600017,
			password: 'Password123!',
			role: 'USER',
			status: true,
		})
		testCreatedUserIds.push(regularUser._id)
	})

	after(async () => {
		if (testCreatedAssocIds.length > 0) {
			await MedicalOfficerHospital.deleteMany({ _id: { $in: testCreatedAssocIds } })
		}
		if (testCreatedHospitalIds.length > 0) {
			await Hospital.deleteMany({ _id: { $in: testCreatedHospitalIds } })
		}
		if (testCreatedUserIds.length > 0) {
			await userModel.deleteMany({ _id: { $in: testCreatedUserIds } })
		}
		if (adminUser?._id) {
			await Admin.deleteOne({ _id: adminUser._id })
		}
		await mongoose.disconnect()
	})

	describe('1. Hospital Registration: Field Validation, Code Generation & Concurrency Safety', () => {
		it('should reject registration when required fields are missing and return specific fields array', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					// hospitalName missing
					hospitalType: 'Private',
					address: {
						city: 'Chennai',
						// street, state, pinCode missing
					},
					// contactPhone, contactEmail missing
				},
			})

			await hospitalController.registerHospital(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.ok(res.jsonData?.fields)
			assert.ok(res.jsonData.fields.includes('hospitalName'))
			assert.ok(res.jsonData.fields.includes('contactPhone'))
			assert.ok(res.jsonData.fields.includes('contactEmail'))
			assert.ok(res.jsonData.fields.includes('street'))
			assert.ok(res.jsonData.fields.includes('state'))
			assert.ok(res.jsonData.fields.includes('pinCode'))
		})

		it('should reject registration with invalid facility classification', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalName: 'Invalid Type Clinic',
					hospitalType: 'UnrecognizedType',
					address: { street: 'Main Rd', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600001' },
					contactPhone: '04412345678',
					contactEmail: 'contact@invalidtype.org',
				},
			})

			await hospitalController.registerHospital(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.jsonData?.field, 'hospitalType')
		})

		it('should reject registration with invalid PIN code format', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalName: 'Invalid PIN Clinic',
					hospitalType: 'Private',
					address: { street: 'Main Rd', city: 'Chennai', state: 'Tamil Nadu', pinCode: 'ABC-12' },
					contactPhone: '04412345678',
					contactEmail: 'contact@invalidpin.org',
				},
			})

			await hospitalController.registerHospital(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.jsonData?.field, 'pinCode')
		})

		it('should authoritatively generate code, ignore client hospitalCode, and create hospital in Pending & inactive status', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalCode: 'FORGED-HOSP-CODE-999', // Client-supplied code to be ignored
					hospitalName: 'Apollo City Hospital Adyar',
					hospitalType: 'Private',
					address: {
						street: 'LB Road',
						city: 'Chennai',
						state: 'Tamil Nadu',
						pinCode: '600020',
					},
					contactPhone: '04424914000',
					contactEmail: `apollo.adyar.${Date.now()}@apollo.org`,
				},
			})

			await hospitalController.registerHospital(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			assert.ok(res.jsonData?.data?.hospital)
			const hosp = res.jsonData.data.hospital
			testCreatedHospitalIds.push(hosp._id)

			// Client code was overridden
			assert.notStrictEqual(hosp.hospitalCode, 'FORGED-HOSP-CODE-999')
			assert.match(hosp.hospitalCode, /^HOSP-CHE-\d{4}$/)
			assert.strictEqual(hosp.verificationStatus, 'Pending')
			assert.strictEqual(hosp.isActive, false)
		})

		it('should guarantee uniqueness under concurrent code generation requests (Atomic Sequence Safety)', async () => {
			const city = 'Coimbatore'
			const concurrentRequests = 10

			const codes = await Promise.all(
				Array.from({ length: concurrentRequests }).map(() => generateHospitalCode(city))
			)

			// Verify all 10 generated codes are distinct
			const uniqueCodes = new Set(codes)
			assert.strictEqual(
				uniqueCodes.size,
				concurrentRequests,
				'All concurrent code requests must produce distinct, non-overlapping codes'
			)

			// Verify all follow HOSP-COI-XXXX format
			codes.forEach((code) => {
				assert.match(code, /^HOSP-COI-\d{4}$/)
			})
		})
	})

	describe('2. Medical Officer Onboarding & Credential Verification Lifecycle', () => {
		let onboardedDoctorId = null
		const testRegNo = `TMC-ONB-${Date.now().toString().slice(-5)}`
		const testEmail = `dr.onboarded.${Date.now()}@hospital.org`

		it('should onboard new Medical Officer in Pending status and inactive (status: false)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					firstName: 'Venkatesh',
					lastName: 'Sundaram',
					email: testEmail,
					phoneNo1: '9840123999',
					medicalRegistrationNumber: testRegNo,
					medicalCouncil: 'Tamil Nadu Medical Council',
					registrationState: 'Tamil Nadu',
					supportingEvidence: 'MCI Verification Reg: 2024-TN-99812',
					nominatedByHospitalId: testHospital1._id.toString(),
				},
			})

			await hospitalController.onboardMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			assert.ok(res.jsonData?.data?.medicalOfficer)
			const doc = res.jsonData.data.medicalOfficer
			onboardedDoctorId = doc._id
			testCreatedUserIds.push(doc._id)

			assert.strictEqual(doc.role, 'MEDICAL_OFFICER')
			assert.strictEqual(doc.verificationStatus, 'Pending')
			assert.strictEqual(doc.status, false) // Inactive until approved
			assert.strictEqual(doc.medicalRegistrationNumber, testRegNo)
			assert.ok(doc.nominatedByHospital)
			assert.strictEqual(doc.nominatedByHospital.hospitalCode, testHospital1.hospitalCode)
		})

		it('should reject onboarding duplicate email with HTTP 409 Conflict', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					firstName: 'Another',
					lastName: 'Doctor',
					email: testEmail, // Duplicate email
					phoneNo1: '9840999888',
					medicalRegistrationNumber: `TMC-NEW-${Date.now()}`,
					medicalCouncil: 'Tamil Nadu Medical Council',
					registrationState: 'Tamil Nadu',
				},
			})

			await hospitalController.onboardMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 409)
			assert.strictEqual(res.jsonData?.field, 'email')
		})

		it('should reject onboarding duplicate Medical Registration Number with HTTP 409 Conflict', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					firstName: 'Another',
					lastName: 'Doctor',
					email: `different.email.${Date.now()}@hospital.org`,
					phoneNo1: '9840999777',
					medicalRegistrationNumber: testRegNo, // Duplicate registration number
					medicalCouncil: 'Tamil Nadu Medical Council',
					registrationState: 'Tamil Nadu',
				},
			})

			await hospitalController.onboardMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 409)
			assert.strictEqual(res.jsonData?.field, 'medicalRegistrationNumber')
		})

		it('should ALLOW unverified active Medical Officer to authenticate into ONBOARDING session (HTTP 200)', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: pendingMoUser.email,
					password: 'Password123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.jsonData?.sessionScope, 'ONBOARDING')
		})

		it('should strictly BLOCK unverified Medical Officer from clinical verification operations via middleware (HTTP 403)', async () => {
			const pendingToken = jwt.sign(
				{ id: pendingMoUser._id.toString(), role: 'MEDICAL_OFFICER', userType: 'user' },
				TEST_SECRET,
				{ expiresIn: '1h' }
			)

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingToken}` },
			})

			await protectMedicalOfficerAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.jsonData?.message, /pending administrative verification|verification status is 'Pending'/i)
		})

		it('should list all onboarded doctors in the Admin directory with status filters', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				query: { verificationStatus: 'Pending' },
			})

			await hospitalController.getMedicalOfficersDirectory(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			const doctors = res.jsonData?.data?.medicalOfficers || []
			assert.ok(doctors.length > 0)
			assert.ok(doctors.every((d) => d.verificationStatus === 'Pending'))
		})

		it('should require a rejection reason when rejecting a Medical Officer account', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				params: { id: onboardedDoctorId.toString() },
				body: {
					verificationStatus: 'Rejected',
					rejectionReason: '', // Empty reason
				},
			})

			await hospitalController.verifyMedicalOfficerAccount(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.jsonData?.field, 'rejectionReason')
		})

		it('should allow Admin to approve credentials and activate Medical Officer account (Verified & active)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				params: { id: onboardedDoctorId.toString() },
				body: {
					verificationStatus: 'Verified',
					isActive: true,
				},
			})

			await hospitalController.verifyMedicalOfficerAccount(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.jsonData?.data?.medicalOfficer?.verificationStatus, 'Verified')
			assert.strictEqual(res.jsonData?.data?.medicalOfficer?.status, true)
		})

		it('should include newly Verified and active doctor in the assignment selector (GET /api/hospitals/medical-officers)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				query: { search: testRegNo },
			})

			await hospitalController.getMedicalOfficers(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			const list = res.jsonData?.data?.medicalOfficers || []
			const found = list.find((d) => d._id.toString() === onboardedDoctorId.toString())
			assert.ok(found, 'Newly verified doctor must now appear in the assignment selector')
			assert.strictEqual(found.verificationStatus, 'Verified')
			assert.strictEqual(found.status, true)
		})
	})

	describe('3. Multi-Hospital Association & Explicit Permission Enforcement', () => {
		it('should successfully associate Verified Medical Officer with Hospital 1', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					medicalOfficerUserId: activeMoUser._id.toString(),
					hospitalId: testHospital1._id.toString(),
					permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
					associationStatus: 'Active',
					effectiveFrom: new Date(),
				},
			})

			await hospitalController.assignMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			assert.ok(res.jsonData?.data?.association)
			testCreatedAssocIds.push(res.jsonData.data.association._id)
		})

		it('should successfully associate the SAME Medical Officer with Hospital 2 (Multi-Hospital reuse)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					medicalOfficerUserId: activeMoUser._id.toString(),
					hospitalId: testHospital2._id.toString(),
					permissions: ['VIEW_EMERGENCY_REQUESTS'],
					associationStatus: 'Active',
					effectiveFrom: new Date(),
				},
			})

			await hospitalController.assignMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			assert.ok(res.jsonData?.data?.association)
			testCreatedAssocIds.push(res.jsonData.data.association._id)

			// Verify both associations exist independently
			const totalAssocs = await MedicalOfficerHospital.find({
				medicalOfficerUserId: activeMoUser._id,
			})
			assert.strictEqual(totalAssocs.length, 2, 'Doctor must be associated with both hospitals')
		})

		it('should reject associating an unverified Medical Officer with HTTP 400', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					medicalOfficerUserId: pendingMoUser._id.toString(),
					hospitalId: testHospital1._id.toString(),
					permissions: ['VIEW_EMERGENCY_REQUESTS'],
				},
			})

			await hospitalController.assignMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.jsonData?.message, /Only Verified accounts can be associated/i)
		})
	})
})
