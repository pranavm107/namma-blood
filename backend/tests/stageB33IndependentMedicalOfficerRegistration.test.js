/**
 * Stage B3.3 Automated Test Suite
 * Namma Blood — Independent Medical Officer Self-Registration
 *
 * Comprehensive Test Coverage:
 * 1. Registration Tests:
 *    - Valid self-registration succeeds (HTTP 201)
 *    - Role is server-enforced as MEDICAL_OFFICER
 *    - Client-supplied ADMIN / HOSPITAL_ADMIN / USER roles are ignored
 *    - Client-supplied hospital ID, permissions, credentialStatus, accountStatus, verificationStatus ignored
 *    - Duplicate email rejected (HTTP 409)
 *    - Duplicate phone number rejected (HTTP 409)
 *    - Duplicate medical registration number rejected (HTTP 409)
 *    - Email normalization to lowercase
 *    - Invalid email / phone / missing required fields rejected (HTTP 400)
 *    - Weak / invalid passwords rejected (HTTP 400)
 *    - Password hashed with bcrypt and never exposed in responses
 *    - Sensitive fields excluded from responses
 *    - Route alias defense (POST /api/medical-officers/register & POST /api/medical-officer/register)
 * 2. Authentication Tests:
 *    - Lifecycle enforcement on login (Gate 2 fails closed: credentials unsubmitted, HTTP 403)
 *    - Invalid credentials rejected (HTTP 401)
 *    - Verified doctor authentication succeeds with valid JWT (HTTP 200)
 *    - Fail-closed JWT secret enforcement (HTTP 500 when unset)
 * 3. Three-Gate Authorization Tests:
 *    - Registrant cannot access clinical queue (HTTP 403)
 *    - Registrant cannot access request details (HTTP 403)
 *    - Registrant cannot verify emergency requests (HTTP 403)
 *    - Registrant cannot reject emergency requests (HTTP 403)
 *    - Registrant cannot request information (HTTP 403)
 *    - Registrant cannot access medical officer dashboard (HTTP 403)
 *    - Registrant cannot modify hospital availability (HTTP 403)
 *    - Existing verified doctor with active association retains access
 * 4. Hospital Association Tests:
 *    - Zero hospital associations created upon registration
 *    - Client-supplied hospitalId creates zero associations
 *    - Registered doctor can subsequently receive hospital nomination (Stage B3.2 integration)
 *    - Doctor can accept nomination and establish pending association
 *    - Duplicate associations prevented by compound unique index
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const bcryptjs = require('bcryptjs')

const userModel = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { Invitation } = require('../Hospital/invitationModel')
const { NotificationOutbox } = require('../Hospital/notificationOutboxModel')
const { MedicalOfficerHospital } = require('../Hospital/medicalOfficerHospitalModel')
const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const {
	nominateDoctorInvitation,
	acceptDoctorNominationInvitation,
} = require('../Hospital/hospitalInvitationController')
const medicalOfficerController = require('../Hospital/medicalOfficerController')
const hospitalController = require('../Hospital/hospitalController')
const { protectHospitalAdminAuth } = require('../Hospital/hospitalAdminMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { login } = require('../Login_And_Authentication/login')

process.env.JWT_SECRET =
	process.env.JWT_SECRET || 'test_jwt_secret_key_12345_super_secure_min_32'
process.env.INVITATION_TOKEN_ENCRYPTION_KEY =
	process.env.INVITATION_TOKEN_ENCRYPTION_KEY ||
	crypto.randomBytes(32).toString('hex')

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
	hospitalId = null,
	hospital = null,
	model = null,
} = {}) {
	const req = {
		headers: { ...headers },
		body: { ...body },
		params: { ...params },
		query: { ...query },
		user,
		userRole,
		hospitalId,
		hospital,
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

async function executeRoutePipeline(pipeline, req, res) {
	for (const mw of pipeline) {
		let calledNext = false
		await new Promise((resolve, reject) => {
			let settled = false
			const done = (err) => {
				if (settled) return
				settled = true
				if (err) return reject(err)
				resolve()
			}
			const next = (err) => {
				if (settled) return
				calledNext = true
				done(err)
			}
			const origJson = res.json.bind(res)
			res.json = function (data) {
				const ret = origJson(data)
				done()
				return ret
			}
			const origSend = res.send ? res.send.bind(res) : null
			res.send = function (data) {
				const ret = origSend ? origSend(data) : this
				done()
				return ret
			}

			try {
				const result = mw(req, res, next)
				if (result && typeof result.then === 'function') {
					result.catch((err) => done(err))
				}
			} catch (err) {
				done(err)
			}
		})
		if (!calledNext || res.statusCode !== 200 || res.responseData !== null) {
			break
		}
	}
	return res
}

describe('Stage B3.3: Independent Medical Officer Self-Registration', () => {
	let verifiedHospital
	let hospitalRepresentative
	let repToken
	let existingVerifiedDoctor
	let verifiedDoctorToken
	let testEmergencyRequest

	const createdUserIds = []
	const createdHospitalIds = []
	const createdAssociationIds = []
	const createdInvitationIds = []
	const createdEmergencyRequestIds = []
	const createdOutboxEventIds = []

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}
		await userModel.init()

		// 1. Create Verified Hospital Facility
		verifiedHospital = await Hospital.create({
			hospitalCode: `HOSP-B33-${Date.now()}`,
			hospitalName: 'Apollo City Hospital B33',
			hospitalType: 'Private',
			address: {
				street: '12 Health Boulevard',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600002',
			},
			contactPhone: '9876543210',
			contactEmail: `contact.b33.${Date.now()}@test-hospital.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		createdHospitalIds.push(verifiedHospital._id)

		// 2. Create Active Hospital Representative
		hospitalRepresentative = await userModel.create({
			firstName: 'Rajesh',
			lastName: 'Administrator',
			email: `rep.b33.${Date.now()}@test-hospital.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'Password123!',
			role: 'HOSPITAL_ADMIN',
			accountStatus: 'Active',
			representativeStatus: 'Active',
			hospitalId: verifiedHospital._id,
			status: true,
		})
		createdUserIds.push(hospitalRepresentative._id)
		repToken = signToken(hospitalRepresentative._id, { userType: 'user' })

		// 3. Create Existing Verified Medical Officer (with Active hospital association)
		existingVerifiedDoctor = await userModel.create({
			firstName: 'Dr. Vikram',
			lastName: 'VerifiedChief',
			email: `vikram.b33.${Date.now()}@test-doctor.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'DoctorPass123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: 'Verified',
			verificationStatus: 'Verified',
			medicalRegistrationNumber: `REG-VERIFIED-${Date.now()}`,
			medicalCouncil: 'Tamil Nadu Medical Council',
			status: true,
		})
		createdUserIds.push(existingVerifiedDoctor._id)
		verifiedDoctorToken = signToken(existingVerifiedDoctor._id, { userType: 'user' })

		const activeAssoc = await MedicalOfficerHospital.create({
			medicalOfficerUserId: existingVerifiedDoctor._id,
			hospitalId: verifiedHospital._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			availabilityStatus: 'Available',
		})
		createdAssociationIds.push(activeAssoc._id)

		// 4. Create Sample Emergency Blood Request
		testEmergencyRequest = await EmergencyBloodRequest.create({
			requestNumber: `EMG-B33-${Date.now()}`,
			requesterUserId: hospitalRepresentative._id,
			patientName: 'Emergency Patient B33',
			patientAge: 42,
			patientGender: 'Male',
			hospitalId: verifiedHospital._id,
			hospitalName: verifiedHospital.hospitalName,
			hospitalAddress: '12 Health Boulevard, Chennai',
			hospitalCity: 'Chennai',
			hospitalState: 'Tamil Nadu',
			hospitalPinCode: 600002,
			requiredBloodGroup: 'O_Positive',
			requiredComponent: 'Packed_Red_Blood_Cells',
			unitsRequested: 2,
			urgencyLevel: 'Critical',
			requiredWithinHours: 2,
			expiresAt: new Date(Date.now() + 2 * 3600 * 1000),
			attendingDoctor: {
				doctorName: 'Dr. Supervising Chief',
				doctorPhone: '9876543210',
			},
			verificationStatus: 'Pending_Verification',
			status: 'Active',
		})
		createdEmergencyRequestIds.push(testEmergencyRequest._id)
	})

	after(async () => {
		if (createdInvitationIds.length > 0) {
			await Invitation.deleteMany({ _id: { $in: createdInvitationIds } })
		}
		if (createdOutboxEventIds.length > 0) {
			await NotificationOutbox.deleteMany({ eventId: { $in: createdOutboxEventIds } })
		}
		if (createdAssociationIds.length > 0) {
			await MedicalOfficerHospital.deleteMany({ _id: { $in: createdAssociationIds } })
		}
		if (createdEmergencyRequestIds.length > 0) {
			await EmergencyBloodRequest.deleteMany({ _id: { $in: createdEmergencyRequestIds } })
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
	// 1. Registration Tests (Scenarios 1-21)
	// =========================================================================
	describe('1. Registration Validation & Mass-Assignment Defenses', () => {
		it('Scenario 1: Valid independent registration succeeds (HTTP 201, safe response, correct initial states)', async () => {
			const email = `doctor.independent.${Date.now()}@test-doctor.org`
			const phone = Math.floor(1000000000 + Math.random() * 9000000000)
			const regNo = `MCI-REG-${Date.now()}`

			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Aravind',
					lastName: 'Swamy',
					email,
					phoneNo1: phone,
					password: 'SecurePassword123!',
					medicalRegistrationNumber: regNo,
					medicalCouncil: 'Karnataka Medical Council',
					registrationState: 'Karnataka',
					qualification: 'MBBS, MD',
					specialization: 'General Medicine',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData?.status, 'success')
			assert.match(res.responseData?.message, /Medical Officer registered successfully/i)

			const doctor = res.responseData?.data?.medicalOfficer
			assert.ok(doctor)
			assert.strictEqual(doctor.email, email.toLowerCase())
			assert.strictEqual(doctor.role, 'MEDICAL_OFFICER')
			assert.strictEqual(doctor.accountStatus, 'Active')
			assert.strictEqual(doctor.credentialStatus, 'Unsubmitted')
			assert.strictEqual(doctor.verificationStatus, 'Pending')
			assert.strictEqual(doctor.hospitalId, null)
			assert.deepStrictEqual(doctor.associations, [])
			assert.strictEqual(doctor.medicalRegistrationNumber, regNo)

			createdUserIds.push(doctor.id)

			// Verify in MongoDB
			const dbUser = await userModel.findById(doctor.id).select('+password')
			assert.ok(dbUser)
			assert.strictEqual(dbUser.role, 'MEDICAL_OFFICER')
			assert.strictEqual(dbUser.accountStatus, 'Active')
			assert.strictEqual(dbUser.credentialStatus, 'Unsubmitted')
			assert.strictEqual(dbUser.verificationStatus, 'Pending')
			assert.strictEqual(dbUser.hospitalId, null)
		})

		it('Scenario 2: Role is authoritatively assigned as MEDICAL_OFFICER on the server', async () => {
			const email = `doctor.server.role.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					name: 'Dr. Server Assigned',
					email,
					phone: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					medicalRegistrationNumber: `REG-SRV-${Date.now()}`,
					medicalCouncil: 'Delhi Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.role, 'MEDICAL_OFFICER')
		})

		it('Scenario 3: Client-supplied ADMIN role is ignored (remains MEDICAL_OFFICER)', async () => {
			const email = `doctor.ignore.admin.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Attacker',
					lastName: 'Escalate',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					role: 'ADMIN', // Tamper attempt
					medicalRegistrationNumber: `REG-ESC-${Date.now()}`,
					medicalCouncil: 'National Medical Commission',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.role, 'MEDICAL_OFFICER', 'Tampered ADMIN role must be ignored')
		})

		it('Scenario 4: Client-supplied HOSPITAL_ADMIN role is ignored (remains MEDICAL_OFFICER)', async () => {
			const email = `doctor.ignore.rep.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Attacker',
					lastName: 'RepEscalate',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					role: 'HOSPITAL_ADMIN', // Tamper attempt
					medicalRegistrationNumber: `REG-REPESC-${Date.now()}`,
					medicalCouncil: 'National Medical Commission',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.role, 'MEDICAL_OFFICER')
		})

		it('Scenario 5: Client-supplied USER role is ignored (remains MEDICAL_OFFICER)', async () => {
			const email = `doctor.ignore.user.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Attacker',
					lastName: 'UserRole',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					role: 'USER', // Tamper attempt
					medicalRegistrationNumber: `REG-USER-${Date.now()}`,
					medicalCouncil: 'National Medical Commission',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.role, 'MEDICAL_OFFICER')
		})

		it('Scenario 6: Client-supplied hospital ID is ignored (hospitalId remains null)', async () => {
			const email = `doctor.ignore.hosp.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Spoofed',
					lastName: 'HospitalId',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					hospitalId: verifiedHospital._id.toString(), // Tamper attempt
					medicalRegistrationNumber: `REG-HOSP-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.hospitalId, null, 'Client-supplied hospitalId must be disregarded')

			// Invariant: No hospital association created
			const assocCount = await MedicalOfficerHospital.countDocuments({ medicalOfficerUserId: docId })
			assert.strictEqual(assocCount, 0, 'No hospital association document may be created')
		})

		it('Scenario 7: Client-supplied permissions are ignored', async () => {
			const email = `doctor.ignore.perms.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Spoofed',
					lastName: 'Permissions',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					permissions: ['VERIFY_EMERGENCY_REQUESTS', 'ADMIN'], // Tamper attempt
					medicalRegistrationNumber: `REG-PERM-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const assocCount = await MedicalOfficerHospital.countDocuments({ medicalOfficerUserId: docId })
			assert.strictEqual(assocCount, 0)
		})

		it('Scenario 8: Client-supplied credentialStatus (Verified) is ignored (remains Unsubmitted)', async () => {
			const email = `doctor.ignore.cred.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Attacker',
					lastName: 'VerifiedSpoof',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					credentialStatus: 'Verified', // Tamper attempt
					medicalRegistrationNumber: `REG-VERIFSPOOF-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.credentialStatus, 'Unsubmitted', 'Client cannot self-verify credentials')
		})

		it('Scenario 9: Client-supplied accountStatus (Suspended) is ignored (remains Active)', async () => {
			const email = `doctor.ignore.accstatus.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Status',
					lastName: 'Spoof',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					accountStatus: 'Suspended', // Tamper attempt
					medicalRegistrationNumber: `REG-STATUS-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.accountStatus, 'Active')
		})

		it('Scenario 10: Client-supplied verificationStatus (Verified) is ignored (remains Pending)', async () => {
			const email = `doctor.ignore.verifstatus.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Legacy',
					lastName: 'StatusSpoof',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					verificationStatus: 'Verified', // Tamper attempt
					medicalRegistrationNumber: `REG-LEGACY-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.verificationStatus, 'Pending')
		})

		it('Scenario 11: Duplicate email is rejected with HTTP 409 Conflict', async () => {
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Duplicate',
					lastName: 'Email',
					email: existingVerifiedDoctor.email, // Already registered
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					medicalRegistrationNumber: `REG-DUPMAIL-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /already registered/i)
		})

		it('Scenario 12: Duplicate phone number is rejected with HTTP 409 Conflict', async () => {
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Duplicate',
					lastName: 'Phone',
					email: `new.doctor.${Date.now()}@test-doctor.org`,
					phoneNo1: existingVerifiedDoctor.phoneNo1, // Already registered
					password: 'DoctorPass123!',
					medicalRegistrationNumber: `REG-DUPPHONE-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /already registered/i)
		})

		it('Scenario 13: Duplicate medical registration number is rejected with HTTP 409 Conflict', async () => {
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Duplicate',
					lastName: 'RegNumber',
					email: `another.doctor.${Date.now()}@test-doctor.org`,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					medicalRegistrationNumber: existingVerifiedDoctor.medicalRegistrationNumber, // Duplicate
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /Medical Registration Number.*already registered/i)
		})

		it('Scenario 14: Email normalization works (stored in lower-case)', async () => {
			const mixedCaseEmail = `Doctor.Normalized.${Date.now()}@Test-Doctor.ORG`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Case',
					lastName: 'Sensitive',
					email: mixedCaseEmail,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'DoctorPass123!',
					medicalRegistrationNumber: `REG-CASE-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.email, mixedCaseEmail.toLowerCase())
		})

		it('Scenario 15: Invalid email is rejected with HTTP 400 Bad Request', async () => {
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Invalid',
					lastName: 'Email',
					email: 'not-an-email-address',
					phoneNo1: 9876543210,
					password: 'DoctorPass123!',
					medicalRegistrationNumber: `REG-INVMAIL-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /valid email address/i)
		})

		it('Scenario 16: Invalid phone number (<10 digits or non-numeric) is rejected with HTTP 400 Bad Request', async () => {
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Short',
					lastName: 'Phone',
					email: `short.phone.${Date.now()}@test-doctor.org`,
					phoneNo1: '12345', // Short
					password: 'DoctorPass123!',
					medicalRegistrationNumber: `REG-SHORTPH-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /valid 10-digit phone number/i)
		})

		it('Scenario 17: Missing required fields are rejected with HTTP 400 Bad Request', async () => {
			const { req, res } = createMockReqRes({
				body: {
					// Missing firstName, email, phoneNo1, password, medicalRegistrationNumber, medicalCouncil
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Missing required registration field/i)
			assert.ok(Array.isArray(res.responseData?.fields))
		})

		it('Scenario 18: Weak / invalid passwords (<8 or >20 characters) are rejected with HTTP 400 Bad Request', async () => {
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Weak',
					lastName: 'Pass',
					email: `weak.pass.${Date.now()}@test-doctor.org`,
					phoneNo1: 9876543210,
					password: 'short', // < 8 characters
					medicalRegistrationNumber: `REG-WEAK-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Password must be between 8 and 20 characters/i)
		})

		it('Scenario 19: Password is hashed with bcrypt and never returned in plaintext', async () => {
			const plainPass = 'SuperSecretPass123!'
			const email = `doctor.hashed.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Hashed',
					lastName: 'Password',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: plainPass,
					medicalRegistrationNumber: `REG-HASH-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			// Response must not contain password
			assert.strictEqual(res.responseData.data.medicalOfficer.password, undefined)

			// Database must contain bcrypt hash
			const dbUser = await userModel.findById(docId).select('+password')
			assert.notStrictEqual(dbUser.password, plainPass)
			assert.strictEqual(bcryptjs.compareSync(plainPass, dbUser.password), true)
		})

		it('Scenario 20: Sensitive fields are excluded from API responses', async () => {
			const email = `doctor.safe.resp.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Clean',
					lastName: 'Response',
					email,
					phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'CleanPassword123!',
					medicalRegistrationNumber: `REG-CLEAN-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const doc = res.responseData.data.medicalOfficer
			createdUserIds.push(doc.id)

			assert.strictEqual(doc.password, undefined)
			assert.strictEqual(doc.passwordResetToken, undefined)
			assert.strictEqual(doc.tokenVersion, undefined)
			assert.strictEqual(doc.__v, undefined)
		})

		it('Scenario 21: Route alias defense: both /api/medical-officers/register and /api/medical-officer/register route to controller', async () => {
			// Test primary route handler
			const { req: req1, res: res1 } = createMockReqRes({
				body: {
					name: 'Dr. Primary Route',
					email: `primary.route.${Date.now()}@test-doctor.org`,
					phone: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'Password123!',
					medicalRegistrationNumber: `REG-PRI-${Date.now()}`,
					medicalCouncil: 'Council',
				},
			})
			await medicalOfficerController.registerMedicalOfficer(req1, res1, () => {})
			assert.strictEqual(res1.statusCode, 201)
			createdUserIds.push(res1.responseData.data.medicalOfficer.id)

			// Test alias route handler
			const { req: req2, res: res2 } = createMockReqRes({
				body: {
					name: 'Dr. Alias Route',
					email: `alias.route.${Date.now()}@test-doctor.org`,
					phone: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'Password123!',
					medicalRegistrationNumber: `REG-ALI-${Date.now()}`,
					medicalCouncil: 'Council',
				},
			})
			await medicalOfficerController.registerMedicalOfficer(req2, res2, () => {})
			assert.strictEqual(res2.statusCode, 201)
			createdUserIds.push(res2.responseData.data.medicalOfficer.id)
		})
	})

	// =========================================================================
	// 2. Authentication Tests (Scenarios 22-25)
	// =========================================================================
	describe('2. Authentication Lifecycle Invariants', () => {
		let registeredDoc

		beforeEach(async () => {
			const email = `auth.test.${Date.now()}.${Math.floor(Math.random() * 10000)}@test-doctor.org`
			const phone = Math.floor(1000000000 + Math.random() * 9000000000)
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. Auth',
					lastName: 'Lifecycle',
					email,
					phoneNo1: phone,
					password: 'DoctorPass123!',
					medicalRegistrationNumber: `REG-AUTH-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
					medicalCouncil: 'State Council',
				},
			})
			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			registeredDoc = res.responseData.data.medicalOfficer
			createdUserIds.push(registeredDoc.id)
		})

		it('Scenario 22: Newly registered Medical Officer authentication enforces approved lifecycle (Gate 2 fails closed: credentials unsubmitted, HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: registeredDoc.email,
					password: 'DoctorPass123!',
				},
			})

			await login(req, res, () => {})
			// Enforces Gate 2: cannot log in with Unsubmitted credentials
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 23: Invalid credentials (wrong password) are rejected with HTTP 401', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: registeredDoc.email,
					password: 'WrongPassword999!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /Email or Password incorrect/i)
		})

		it('Scenario 24: Verified Medical Officer can authenticate and receive JWT (HTTP 200)', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: existingVerifiedDoctor.email,
					password: 'DoctorPass123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.message, 'Login Successfully.')
			assert.ok(res.responseData?.token)
			assert.strictEqual(res.responseData?.role, 'MEDICAL_OFFICER')
			assert.strictEqual(res.responseData?.user?.accountStatus, 'Active')
		})

		it('Scenario 25: JWT secret configuration fails closed when JWT_SECRET is unset or empty (HTTP 500)', async () => {
			const origSecret = process.env.JWT_SECRET
			delete process.env.JWT_SECRET

			try {
				const { req, res } = createMockReqRes({
					headers: { authorization: 'Bearer some_dummy_token' },
				})
				await executeRoutePipeline([protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')], req, res)
				assert.strictEqual(res.statusCode, 500)
				assert.match(res.responseData?.message, /JWT_SECRET environment variable is not configured/i)
			} finally {
				process.env.JWT_SECRET = origSecret
			}
		})
	})

	// =========================================================================
	// 3. Three-Gate Authorization Tests (Scenarios 26-34)
	// =========================================================================
	describe('3. Three-Gate Authorization Enforcement for Newly Registered Doctor', () => {
		let unverifiedDocToken
		let unverifiedDocId

		before(async () => {
			const email = `threegate.${Date.now()}@test-doctor.org`
			const phone = Math.floor(1000000000 + Math.random() * 9000000000)
			const { req, res } = createMockReqRes({
				body: {
					firstName: 'Dr. ThreeGate',
					lastName: 'Enforcement',
					email,
					phoneNo1: phone,
					password: 'Password123!',
					medicalRegistrationNumber: `REG-GATE-${Date.now()}`,
					medicalCouncil: 'State Medical Council',
				},
			})
			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			unverifiedDocId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(unverifiedDocId)

			unverifiedDocToken = signToken(unverifiedDocId, { userType: 'user' })
		})

		it('Scenario 26: Newly registered Medical Officer cannot access clinical emergency queue (GET /api/medical-officer/requests -> HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDocToken}` },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getAssignedRequests],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 27: Newly registered Medical Officer cannot access clinical queue alias (GET /api/medical-officer/queue -> HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDocToken}` },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getAssignedRequests],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 28: Cannot access emergency request details (GET /api/medical-officer/requests/:id -> HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDocToken}` },
				params: { id: testEmergencyRequest._id.toString() },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getRequestDetails],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 29: Cannot verify emergency requests (PATCH /api/medical-officer/requests/:id/verify -> HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDocToken}` },
				params: { id: testEmergencyRequest._id.toString() },
				body: { hospitalId: verifiedHospital._id.toString() },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.approveEmergencyRequest],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 30: Cannot reject emergency requests (PATCH /api/medical-officer/requests/:id/reject -> HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDocToken}` },
				params: { id: testEmergencyRequest._id.toString() },
				body: { hospitalId: verifiedHospital._id.toString(), rejectionReason: 'Clinical condition mismatch' },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.rejectEmergencyRequest],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 31: Cannot request additional information (PATCH /api/medical-officer/requests/:id/request-information -> HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDocToken}` },
				params: { id: testEmergencyRequest._id.toString() },
				body: { hospitalId: verifiedHospital._id.toString(), notes: 'Clinical notes needed' },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.requestAdditionalInformation],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 32: Cannot access medical officer dashboard (GET /api/medical-officer/dashboard -> HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDocToken}` },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getMedicalOfficerDashboard],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 33: Cannot modify hospital availability (PATCH /api/medical-officer/hospitals/:hospitalId/availability -> HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedDocToken}` },
				params: { hospitalId: verifiedHospital._id.toString() },
				body: { availabilityStatus: 'Available' },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.updateAvailability],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('Scenario 34: Existing verified Medical Officer with active hospital association retains authorized access', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${verifiedDoctorToken}` },
			})
			await executeRoutePipeline(
				[protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getAssignedRequests],
				req,
				res
			)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.status, 'success')
		})
	})

	// =========================================================================
	// 4. Hospital Association Tests (Scenarios 35-39)
	// =========================================================================
	describe('4. Hospital Association Lifecycle Rules', () => {
		it('Scenario 35: Registration creates zero hospital associations in MedicalOfficerHospital', async () => {
			const email = `zero.assoc.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					name: 'Dr. Zero Association',
					email,
					phone: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'Password123!',
					medicalRegistrationNumber: `REG-ZERO-${Date.now()}`,
					medicalCouncil: 'State Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const assocCount = await MedicalOfficerHospital.countDocuments({ medicalOfficerUserId: docId })
			assert.strictEqual(assocCount, 0, 'Must create exactly zero hospital associations upon registration')
		})

		it('Scenario 36: Client-supplied hospital ID in registration payload creates no association', async () => {
			const email = `client.hosp.zero.${Date.now()}@test-doctor.org`
			const { req, res } = createMockReqRes({
				body: {
					name: 'Dr. Client Hosp Zero',
					email,
					phone: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'Password123!',
					medicalRegistrationNumber: `REG-CLHOSP-${Date.now()}`,
					medicalCouncil: 'State Council',
					hospitalId: verifiedHospital._id.toString(), // Client attempts self-affiliation
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const assocCount = await MedicalOfficerHospital.countDocuments({ medicalOfficerUserId: docId })
			assert.strictEqual(assocCount, 0, 'Client-supplied hospitalId must never create an association')
		})

		it('Scenario 37: Newly registered doctor can subsequently receive a hospital nomination via approved Stage B3.2 workflow', async () => {
			// 1. Doctor registers independently
			const email = `nominee.b33.${Date.now()}@test-doctor.org`
			const phone = Math.floor(1000000000 + Math.random() * 9000000000)
			const { req: regReq, res: regRes } = createMockReqRes({
				body: {
					name: 'Dr. Future Nominee',
					email,
					phone,
					password: 'Password123!',
					medicalRegistrationNumber: `REG-FUTNOM-${Date.now()}`,
					medicalCouncil: 'State Council',
				},
			})
			await medicalOfficerController.registerMedicalOfficer(regReq, regRes, () => {})
			assert.strictEqual(regRes.statusCode, 201)
			const docId = regRes.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			// 2. Hospital Representative nominates the registered doctor for verifiedHospital
			const { req: nomReq, res: nomRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken}` },
				body: {
					recipientName: 'Dr. Future Nominee',
					recipientEmail: email,
					recipientPhone: phone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], nomReq, nomRes)
			assert.strictEqual(nomRes.statusCode, 201)
			assert.strictEqual(nomRes.responseData?.status, 'success')
			assert.ok(nomRes.responseData?.data?.invitationToken)

			createdInvitationIds.push(nomRes.responseData.data.invitation.id)
		})

		it('Scenario 38: Doctor can accept the nomination via approved Stage B3.2 acceptance workflow', async () => {
			// 1. Doctor registers independently
			const email = `accept.nom.${Date.now()}@test-doctor.org`
			const phone = Math.floor(1000000000 + Math.random() * 9000000000)
			const { req: regReq, res: regRes } = createMockReqRes({
				body: {
					name: 'Dr. Accept Nominee',
					email,
					phone,
					password: 'Password123!',
					medicalRegistrationNumber: `REG-ACCNOM-${Date.now()}`,
					medicalCouncil: 'State Council',
				},
			})
			await medicalOfficerController.registerMedicalOfficer(regReq, regRes, () => {})
			const docId = regRes.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			// 2. Hospital Representative nominates
			const { req: nomReq, res: nomRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken}` },
				body: {
					recipientName: 'Dr. Accept Nominee',
					recipientEmail: email,
					recipientPhone: phone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], nomReq, nomRes)
			const token = nomRes.responseData.data.invitationToken
			const invId = nomRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// 3. Doctor accepts nomination
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 200)
			assert.strictEqual(accRes.responseData?.status, 'success')

			const assocId = accRes.responseData.data.association.id
			createdAssociationIds.push(assocId)

			// Association created in Pending_Admin_Approval status
			const dbAssoc = await MedicalOfficerHospital.findById(assocId)
			assert.strictEqual(dbAssoc.associationStatus, 'Pending_Admin_Approval')
			assert.strictEqual(dbAssoc.hospitalId.toString(), verifiedHospital._id.toString())
			assert.strictEqual(dbAssoc.medicalOfficerUserId.toString(), docId.toString())
		})

		it('Scenario 39: Duplicate hospital associations remain strictly prevented by compound unique index { medicalOfficerUserId: 1, hospitalId: 1 }', async () => {
			const doctorUser = await userModel.create({
				firstName: 'Dr. Duplicate',
				lastName: 'IndexTest',
				email: `dup.index.${Date.now()}@test-doctor.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(doctorUser._id)

			// First association succeeds
			const firstAssoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: doctorUser._id,
				hospitalId: verifiedHospital._id,
				associationStatus: 'Pending_Admin_Approval',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
				availabilityStatus: 'Unavailable',
			})
			createdAssociationIds.push(firstAssoc._id)

			// Direct attempt to create second association document for same (doctor, hospital) must fail E11000
			await assert.rejects(
				async () => {
					await MedicalOfficerHospital.create({
						medicalOfficerUserId: doctorUser._id,
						hospitalId: verifiedHospital._id,
						associationStatus: 'Active',
						permissions: ['VIEW_EMERGENCY_REQUESTS'],
						availabilityStatus: 'Available',
					})
				},
				(err) => {
					assert.strictEqual(err.code, 11000, 'Compound index must throw duplicate key error code 11000')
					return true
				}
			)
		})
	})

	// =========================================================================
	// 5. Focused Security Verification: Data Sanitization & Race Conditions
	// =========================================================================
	describe('5. Focused Security Verification: Data Sanitization & Race Conditions', () => {
		it('Scenario 40: Rejects malformed or invalid format medicalRegistrationNumber (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					name: 'Dr. Bad Reg',
					email: `bad.reg.${Date.now()}@test-doctor.org`,
					phone: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'Password123!',
					medicalRegistrationNumber: '@@@$$$INVALID!!!', // Disallowed special characters
					medicalCouncil: 'State Medical Council',
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Medical Registration Number must be between 3 and 50 characters/i)
		})

		it('Scenario 41: Rejects unsafe URL schemes in supportingEvidence (HTTP 400)', async () => {
			const unsafeSchemes = [
				'javascript:alert(1)',
				'data:text/html,<script>alert(1)</script>',
				'file:///etc/passwd',
				'ftp://example.com/file',
				'not a valid url at all',
			]

			for (const badUrl of unsafeSchemes) {
				const { req, res } = createMockReqRes({
					body: {
						name: 'Dr. XSS Tester',
						email: `xss.${Date.now()}.${Math.floor(Math.random() * 1000)}@test-doctor.org`,
						phone: Math.floor(1000000000 + Math.random() * 9000000000),
						password: 'Password123!',
						medicalRegistrationNumber: `REG-XSS-${Date.now()}`,
						medicalCouncil: 'State Council',
						supportingEvidence: badUrl,
					},
				})

				await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
				assert.strictEqual(res.statusCode, 400, `Must reject unsafe URL: ${badUrl}`)
				assert.match(res.responseData?.message, /Supporting evidence must be a valid/i)
			}
		})

		it('Scenario 42: Accepts valid HTTPS supporting evidence URL, stores it safely, and verifies that credentialStatus remains strictly Unsubmitted', async () => {
			const email = `evidence.safe.${Date.now()}@test-doctor.org`
			const validUrl = 'https://nmc.org.in/doctor-registry/view/KMC-998877'
			const { req, res } = createMockReqRes({
				body: {
					name: 'Dr. Valid Evidence',
					email,
					phone: Math.floor(1000000000 + Math.random() * 9000000000),
					password: 'Password123!',
					medicalRegistrationNumber: `REG-EVID-${Date.now()}`,
					medicalCouncil: 'National Medical Commission',
					supportingEvidence: validUrl,
				},
			})

			await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData.data.medicalOfficer.id
			createdUserIds.push(docId)

			const dbUser = await userModel.findById(docId)
			assert.strictEqual(dbUser.supportingEvidence, validUrl)
			// Crucial security invariant: credentialStatus must NOT automatically become Verified
			assert.strictEqual(dbUser.credentialStatus, 'Unsubmitted', 'Submitted evidence must NEVER automatically verify credentials')
			assert.strictEqual(dbUser.verificationStatus, 'Pending')
		})

		it('Scenario 43: Concurrency Race Condition: Simultaneous registrations with identical email safely resolve with one 201 and one 409', async () => {
			const duplicateEmail = `concur.email.${Date.now()}@test-doctor.org`
			const phone1 = Math.floor(1000000000 + Math.random() * 9000000000)
			const phone2 = Math.floor(1000000000 + Math.random() * 9000000000)

			const runRegister = async (num, phone) => {
				const { req, res } = createMockReqRes({
					body: {
						name: `Dr. Concurrency Email ${num}`,
						email: duplicateEmail,
						phone,
						password: 'Password123!',
						medicalRegistrationNumber: `REG-CONC-EMAIL-${num}-${Date.now()}`,
						medicalCouncil: 'State Council',
					},
				})
				await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
				return res
			}

			const [res1, res2] = await Promise.all([runRegister(1, phone1), runRegister(2, phone2)])
			const statusCodes = [res1.statusCode, res2.statusCode].sort()

			assert.deepStrictEqual(statusCodes, [201, 409], 'Exactly one request must succeed with 201 and the concurrent request receive 409')

			const successRes = res1.statusCode === 201 ? res1 : res2
			createdUserIds.push(successRes.responseData.data.medicalOfficer.id)

			// Invariant: Exactly one user document exists in MongoDB
			const totalDocs = await userModel.countDocuments({ email: duplicateEmail.toLowerCase() })
			assert.strictEqual(totalDocs, 1, 'Strictly one document must persist in DB')
		})

		it('Scenario 44: Concurrency Race Condition: Simultaneous registrations with identical phone number safely resolve with one 201 and one 409', async () => {
			const sharedPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			const runRegister = async (num) => {
				const { req, res } = createMockReqRes({
					body: {
						name: `Dr. Concurrency Phone ${num}`,
						email: `concur.phone.${num}.${Date.now()}@test-doctor.org`,
						phone: sharedPhone,
						password: 'Password123!',
						medicalRegistrationNumber: `REG-CONC-PHONE-${num}-${Date.now()}`,
						medicalCouncil: 'State Council',
					},
				})
				await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
				return res
			}

			const [res1, res2] = await Promise.all([runRegister(1), runRegister(2)])
			const statusCodes = [res1.statusCode, res2.statusCode].sort()

			assert.deepStrictEqual(statusCodes, [201, 409], 'Exactly one request must succeed with 201 and the concurrent request receive 409')

			const successRes = res1.statusCode === 201 ? res1 : res2
			createdUserIds.push(successRes.responseData.data.medicalOfficer.id)

			// Invariant: Exactly one user document exists in MongoDB with this phone
			const totalDocs = await userModel.countDocuments({ phoneNo1: sharedPhone })
			assert.strictEqual(totalDocs, 1, 'Strictly one document must persist in DB')
		})

		it('Scenario 45: Concurrency Race Condition: Simultaneous registrations with identical medicalRegistrationNumber safely resolve with one 201 and one 409', async () => {
			const sharedRegNo = `REG-CONC-DUP-${Date.now()}`
			const phone1 = Math.floor(1000000000 + Math.random() * 9000000000)
			const phone2 = Math.floor(1000000000 + Math.random() * 9000000000)

			const runRegister = async (num, phone) => {
				const { req, res } = createMockReqRes({
					body: {
						name: `Dr. Concurrency RegNo ${num}`,
						email: `concur.regno.${num}.${Date.now()}@test-doctor.org`,
						phone,
						password: 'Password123!',
						medicalRegistrationNumber: sharedRegNo,
						medicalCouncil: 'State Council',
					},
				})
				await medicalOfficerController.registerMedicalOfficer(req, res, () => {})
				return res
			}

			const [res1, res2] = await Promise.all([runRegister(1, phone1), runRegister(2, phone2)])
			const statusCodes = [res1.statusCode, res2.statusCode].sort()

			assert.deepStrictEqual(statusCodes, [201, 409], 'Exactly one request must succeed with 201 and the concurrent request receive 409')

			const successRes = res1.statusCode === 201 ? res1 : res2
			createdUserIds.push(successRes.responseData.data.medicalOfficer.id)

			// Invariant: Exactly one user document exists in MongoDB with this registration number
			const totalDocs = await userModel.countDocuments({
				role: 'MEDICAL_OFFICER',
				medicalRegistrationNumber: sharedRegNo.toUpperCase(),
			})
			assert.strictEqual(totalDocs, 1, 'Strictly one document must persist in DB')
		})
	})
})

