/**
 * Comprehensive Test Suite:
 * Hospital & Medical Officer Backend APIs, Verification State Machine & Clinical Governance
 * Namma Blood — Phase 4.3.5 Stage 3
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

process.env.EMERGENCY_HMAC_SECRET =
	process.env.EMERGENCY_HMAC_SECRET || '0123456789abcdef0123456789abcdef'

const userModel = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { MedicalOfficerHospital } = require('../Hospital/medicalOfficerHospitalModel')
const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const { EmergencyRequestVerification } = require('../Hospital/emergencyRequestVerificationModel')
const hospitalController = require('../Hospital/hospitalController')
const medicalOfficerController = require('../Hospital/medicalOfficerController')
const { provideAdditionalInformation } = require('../Emergency/emergencyRequestController')
const { getRequestMatches } = require('../Emergency/emergencyDiscoveryController')

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
	authorizedHospitalIds = [],
	activeHospital = null,
	hospitalId = null,
} = {}) {
	const req = {
		headers,
		body,
		params,
		query,
		user,
		userRole,
		authorizedHospitalIds,
		activeHospital,
		hospitalId,
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
			res.responseData = { status: 'error', code: err.code, message: err.message }
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

describe('Phase 4.3.5 Stage 3: Backend APIs & Verification State Machine', () => {
	let dbConnected = false
	const cleanup = {
		users: [],
		admins: [],
		hospitals: [],
		associations: [],
		requests: [],
		verifications: [],
	}

	let testAdmin = null
	let testUserRequester = null
	let testUserOther = null
	let testMO1 = null
	let testMO2 = null
	let testHospitalA = null
	let testHospitalB = null

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
			dbConnected = true
		} else {
			dbConnected = true
		}

		// 1. Provision Platform Administrator
		testAdmin = await Admin.create({
			phoneNo: `99${Date.now().toString().slice(-8)}`,
			email: `admin_${Date.now()}@nammablood.test`,
			password: 'AdminPassword123!',
		})
		cleanup.admins.push(testAdmin._id)

		// 2. Provision Original Requester & Other User
		testUserRequester = await userModel.create({
			firstName: 'Rajesh',
			lastName: 'Kumar',
			gender: 'Male',
			dob: new Date('1988-04-12'),
			age: 36,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `requester_${Date.now()}@test.com`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'Anna Nagar',
			pinCode: 600040,
			password: 'Password123!',
			role: 'USER',
		})
		cleanup.users.push(testUserRequester._id)

		testUserOther = await userModel.create({
			firstName: 'Sunil',
			lastName: 'Verma',
			gender: 'Male',
			dob: new Date('1992-08-10'),
			age: 32,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `other_${Date.now()}@test.com`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'T Nagar',
			pinCode: 600017,
			password: 'Password123!',
			role: 'USER',
		})
		cleanup.users.push(testUserOther._id)

		// 3. Provision Medical Officers
		testMO1 = await userModel.create({
			firstName: 'Dr. Priya',
			lastName: 'Natarajan',
			gender: 'Female',
			dob: new Date('1984-09-20'),
			age: 40,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `mo1_${Date.now()}@hospitala.org`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'Greams Rd',
			pinCode: 600006,
			password: 'Password123!',
			role: 'MEDICAL_OFFICER',
			medicalRegistrationNumber: 'TNMC-2010-0987',
		})
		cleanup.users.push(testMO1._id)

		testMO2 = await userModel.create({
			firstName: 'Dr. Vikram',
			lastName: 'Sethi',
			gender: 'Male',
			dob: new Date('1980-11-15'),
			age: 44,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `mo2_${Date.now()}@hospitalb.org`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'Adyar',
			pinCode: 600020,
			password: 'Password123!',
			role: 'MEDICAL_OFFICER',
			medicalRegistrationNumber: 'TNMC-2005-4321',
		})
		cleanup.users.push(testMO2._id)

		// 4. Provision Hospitals
		testHospitalA = await Hospital.create({
			hospitalCode: `HOSP-A-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Apollo Main Hospital',
			hospitalType: 'Private',
			address: { street: '21 Greams Lane', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600006' },
			contactPhone: '9840111111',
			contactEmail: `contact_${Date.now()}@apollo.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		cleanup.hospitals.push(testHospitalA._id)

		testHospitalB = await Hospital.create({
			hospitalCode: `HOSP-B-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Fortis Malar Hospital',
			hospitalType: 'Private',
			address: { street: 'Gandhi Nagar', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600020' },
			contactPhone: '9840222222',
			contactEmail: `contact_${Date.now()}@fortis.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		cleanup.hospitals.push(testHospitalB._id)

		// 5. Establish Associations:
		// MO1 associated with Hospital A (Active, VERIFY_EMERGENCY_REQUESTS)
		const assocMO1_A = await MedicalOfficerHospital.create({
			medicalOfficerUserId: testMO1._id,
			hospitalId: testHospitalA._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
		})
		cleanup.associations.push(assocMO1_A._id)

		// MO2 associated with Hospital B (Active, VERIFY_EMERGENCY_REQUESTS)
		const assocMO2_B = await MedicalOfficerHospital.create({
			medicalOfficerUserId: testMO2._id,
			hospitalId: testHospitalB._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
		})
		cleanup.associations.push(assocMO2_B._id)
	})

	after(async () => {
		if (cleanup.verifications.length > 0) {
			// Note: bypass model hook for cleanup using raw native collection delete
			await mongoose.connection.collection('emergencyrequestverifications').deleteMany({
				_id: { $in: cleanup.verifications },
			})
		}
		if (cleanup.requests.length > 0) {
			await EmergencyBloodRequest.deleteMany({ _id: { $in: cleanup.requests } })
		}
		if (cleanup.associations.length > 0) {
			await MedicalOfficerHospital.deleteMany({ _id: { $in: cleanup.associations } })
		}
		if (cleanup.hospitals.length > 0) {
			await Hospital.deleteMany({ _id: { $in: cleanup.hospitals } })
		}
		if (cleanup.users.length > 0) {
			await userModel.deleteMany({ _id: { $in: cleanup.users } })
		}
		if (cleanup.admins.length > 0) {
			await Admin.deleteMany({ _id: { $in: cleanup.admins } })
		}
		if (dbConnected) {
			await mongoose.disconnect()
		}
	})

	describe('1. Hospital Administration & Directory APIs', () => {
		it('should register a new hospital in Pending status (Admin only)', async () => {
			const { req, res } = createMockReqRes({
				user: testAdmin,
				userRole: 'ADMIN',
				body: {
					hospitalCode: `HOSP-REG-${Date.now().toString().slice(-4)}`,
					hospitalName: 'Government General Hospital',
					hospitalType: 'Government',
					address: { street: 'EVR Periyar Salai', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600003' },
					contactPhone: '9840333333',
					contactEmail: 'ggh@tn.gov.in',
				},
			})

			await hospitalController.registerHospital(req, res)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData.data.hospital.verificationStatus, 'Pending')
			assert.strictEqual(res.responseData.data.hospital.isActive, false)
			cleanup.hospitals.push(res.responseData.data.hospital._id)
		})

		it('should verify and activate a hospital (Admin only)', async () => {
			const pendingHosp = await Hospital.create({
				hospitalCode: `HOSP-PEND-${Date.now().toString().slice(-4)}`,
				hospitalName: 'Pending Clinic',
				address: { street: 'St 1', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600001' },
				contactPhone: '9840444444',
				contactEmail: 'p@c.com',
				verificationStatus: 'Pending',
				isActive: false,
			})
			cleanup.hospitals.push(pendingHosp._id)

			const { req, res } = createMockReqRes({
				user: testAdmin,
				userRole: 'ADMIN',
				params: { id: pendingHosp._id.toString() },
				body: { verificationStatus: 'Verified', isActive: true },
			})

			await hospitalController.verifyHospital(req, res)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.data.hospital.verificationStatus, 'Verified')
			assert.strictEqual(res.responseData.data.hospital.isActive, true)
		})

		it('should return active verified hospitals for public dropdown', async () => {
			const { req, res } = createMockReqRes()
			await hospitalController.getVerifiedHospitals(req, res)
			assert.strictEqual(res.statusCode, 200)
			assert.ok(Array.isArray(res.responseData.data.hospitals))
			assert.ok(res.responseData.data.hospitals.length >= 2)
			const allVerified = res.responseData.data.hospitals.every(
				h => h.verificationStatus === undefined || h.verificationStatus === 'Verified'
			)
			assert.strictEqual(allVerified, true)
		})
	})

	describe('2. Multi-Hospital Authorization & BOLA Prevention', () => {
		let requestHospA = null
		let requestHospB = null
		let legacyRequest = null

		before(async () => {
			requestHospA = await EmergencyBloodRequest.create({
				requesterUserId: testUserRequester._id,
				hospitalId: testHospitalA._id,
				patientName: 'Karthikeyan',
				patientAge: 45,
				patientGender: 'Male',
				requiredBloodGroup: 'O_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				hospitalName: testHospitalA.hospitalName,
				hospitalAddress: testHospitalA.address.street,
				hospitalCity: testHospitalA.address.city,
				hospitalState: testHospitalA.address.state,
				hospitalPinCode: 600006,
				attendingDoctor: { doctorName: 'Dr. Doctor A', doctorPhone: '9840111111' },
				verificationStatus: 'Pending_Verification',
			})
			cleanup.requests.push(requestHospA._id)

			requestHospB = await EmergencyBloodRequest.create({
				requesterUserId: testUserRequester._id,
				hospitalId: testHospitalB._id,
				patientName: 'Soundarya',
				patientAge: 29,
				patientGender: 'Female',
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 1,
				hospitalName: testHospitalB.hospitalName,
				hospitalAddress: testHospitalB.address.street,
				hospitalCity: testHospitalB.address.city,
				hospitalState: testHospitalB.address.state,
				hospitalPinCode: 600020,
				attendingDoctor: { doctorName: 'Dr. Doctor B', doctorPhone: '9840222222' },
				verificationStatus: 'Pending_Verification',
			})
			cleanup.requests.push(requestHospB._id)

			// Legacy request without hospitalId (null)
			legacyRequest = await EmergencyBloodRequest.create({
				requesterUserId: testUserRequester._id,
				hospitalId: null, // Legacy
				patientName: 'Legacy Patient',
				patientAge: 50,
				patientGender: 'Male',
				requiredBloodGroup: 'A_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 1,
				hospitalName: 'Unregistered Rural Clinic',
				hospitalAddress: 'Village Road',
				hospitalCity: 'Madurai',
				hospitalState: 'Tamil Nadu',
				hospitalPinCode: 625001,
				attendingDoctor: { doctorName: 'Dr. Rural', doctorPhone: '9840999999' },
				verificationStatus: 'Pending_Verification',
			})
			cleanup.requests.push(legacyRequest._id)
		})

		it('should ALLOW Medical Officer 1 to view request belonging to Hospital A', async () => {
			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: requestHospA._id.toString() },
			})

			await medicalOfficerController.getRequestDetails(req, res, next)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.data.request._id.toString(), requestHospA._id.toString())
		})

		it('should REJECT Medical Officer 1 attempting to view request for Hospital B with 403 Forbidden', async () => {
			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()], // Only A
				params: { id: requestHospB._id.toString() }, // Request for B!
			})

			await medicalOfficerController.getRequestDetails(req, res, next)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /not authorized to verify or view requests for this hospital facility/)
		})

		it('should REJECT Medical Officer 1 attempting to view legacy request without hospitalId with 404 Not Found', async () => {
			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: legacyRequest._id.toString() }, // Legacy!
			})

			await medicalOfficerController.getRequestDetails(req, res, next)
			assert.strictEqual(res.statusCode, 404)
			assert.match(res.responseData.message, /not found/i)
		})

		it('should support multi-hospital Medical Officer without arbitrary defaults', async () => {
			// Associate MO1 with Hospital B as well
			const assocMO1_B = await MedicalOfficerHospital.create({
				medicalOfficerUserId: testMO1._id,
				hospitalId: testHospitalB._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			cleanup.associations.push(assocMO1_B._id)

			// With both authorizedHospitalIds, MO1 can view request at B
			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString(), testHospitalB._id.toString()],
				params: { id: requestHospB._id.toString() },
			})

			await medicalOfficerController.getRequestDetails(req, res, next)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.data.request._id.toString(), requestHospB._id.toString())

			await MedicalOfficerHospital.deleteOne({ _id: assocMO1_B._id })
		})
	})

	describe('3. Verification State Machine Invariants & Transitions', () => {
		let testRequest = null

		beforeEach(async () => {
			testRequest = await EmergencyBloodRequest.create({
				requesterUserId: testUserRequester._id,
				hospitalId: testHospitalA._id,
				patientName: 'Priya Mani',
				patientAge: 33,
				patientGender: 'Female',
				requiredBloodGroup: 'AB_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				hospitalName: testHospitalA.hospitalName,
				hospitalAddress: testHospitalA.address.street,
				hospitalCity: testHospitalA.address.city,
				hospitalState: testHospitalA.address.state,
				hospitalPinCode: 600006,
				attendingDoctor: { doctorName: 'Dr. Attending', doctorPhone: '9840111111' },
				verificationStatus: 'Pending_Verification',
				verificationVersion: 0,
			})
			cleanup.requests.push(testRequest._id)
		})

		it('should APPROVE request from Pending_Verification to Verified (atomic audit written)', async () => {
			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: testRequest._id.toString() },
				body: { remarks: 'Patient has acute blood loss. Clinically verified.' },
			})

			await medicalOfficerController.approveEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.data.request.verificationStatus, 'Verified')
			assert.strictEqual(res.responseData.data.request.verificationVersion, 1)

			// Verify append-only audit record was created
			const audit = await EmergencyRequestVerification.findOne({
				emergencyRequestId: testRequest._id,
				action: 'APPROVED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.actorRole, 'MEDICAL_OFFICER')
			assert.strictEqual(audit.newVerificationStatus, 'Verified')
			cleanup.verifications.push(audit._id)
		})

		it('should REJECT request from Pending_Verification to Rejected with mandatory reason', async () => {
			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: testRequest._id.toString() },
				body: {
					rejectionReason: 'Clinical indicators do not substantiate emergency transfusion threshold.',
					reasonCode: 'INSUFFICIENT_CLINICAL_INDICATORS',
				},
			})

			await medicalOfficerController.rejectEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.data.request.verificationStatus, 'Rejected')
			assert.strictEqual(res.responseData.data.request.rejectionReason, 'Clinical indicators do not substantiate emergency transfusion threshold.')

			const audit = await EmergencyRequestVerification.findOne({
				emergencyRequestId: testRequest._id,
				action: 'REJECTED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.actorRole, 'MEDICAL_OFFICER')
			cleanup.verifications.push(audit._id)
		})

		it('should fail REJECT if rejectionReason is missing or shorter than 5 chars', async () => {
			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: testRequest._id.toString() },
				body: { rejectionReason: 'No' }, // too short
			})

			await medicalOfficerController.rejectEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /minimum 5 characters/)
		})

		it('should transition to More_Information_Required with requestedInformation', async () => {
			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: testRequest._id.toString() },
				body: { requestedInformation: 'Please provide patient baseline hemoglobin and current pulse rate.' },
			})

			await medicalOfficerController.requestAdditionalInformation(req, res, next)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.data.request.verificationStatus, 'More_Information_Required')
			assert.strictEqual(res.responseData.data.request.additionalInformationRequested, 'Please provide patient baseline hemoglobin and current pulse rate.')

			const audit = await EmergencyRequestVerification.findOne({
				emergencyRequestId: testRequest._id,
				action: 'MORE_INFORMATION_REQUESTED',
			})
			assert.ok(audit)
			cleanup.verifications.push(audit._id)
		})

		it('should allow original requester to RESUBMIT details, returning status to Pending_Verification', async () => {
			// First, transition to More_Information_Required
			testRequest.verificationStatus = 'More_Information_Required'
			testRequest.additionalInformationRequested = 'Need hemoglobin'
			await testRequest.save()

			const { req, res, next } = createMockReqRes({
				user: testUserRequester, // Original requester
				userRole: 'USER',
				params: { id: testRequest._id.toString() },
				body: { additionalInformationResponse: 'Baseline Hb is 6.5 g/dL and pulse is 120 bpm.' },
			})

			await provideAdditionalInformation(req, res, next)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.data.request.verificationStatus, 'Pending_Verification')
			assert.strictEqual(res.responseData.data.request.additionalInformationResponse, 'Baseline Hb is 6.5 g/dL and pulse is 120 bpm.')

			const audit = await EmergencyRequestVerification.findOne({
				emergencyRequestId: testRequest._id,
				action: 'RESUBMITTED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.actorRole, 'USER')
			cleanup.verifications.push(audit._id)
		})

		it('should REJECT third-party user attempting to resubmit information with 403 Forbidden', async () => {
			testRequest.verificationStatus = 'More_Information_Required'
			await testRequest.save()

			const { req, res, next } = createMockReqRes({
				user: testUserOther, // Different user!
				userRole: 'USER',
				params: { id: testRequest._id.toString() },
				body: { additionalInformationResponse: 'Unauthorized response.' },
			})

			await provideAdditionalInformation(req, res, next)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Only the original requester may provide additional clinical information/)
		})

		it('should BLOCK re-verification on already Verified request with 400', async () => {
			testRequest.verificationStatus = 'Verified'
			await testRequest.save()

			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: testRequest._id.toString() },
				body: { remarks: 'Trying to re-verify' },
			})

			await medicalOfficerController.approveEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /already verified/)
		})

		it('should BLOCK actions on Flagged_Suspicious request with 400', async () => {
			testRequest.verificationStatus = 'Flagged_Suspicious'
			await testRequest.save()

			const { req, res, next } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: testRequest._id.toString() },
				body: { remarks: 'Trying to approve flagged request' },
			})

			await medicalOfficerController.approveEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /flagged suspicious and quarantined/)
		})
	})

	describe('4. Optimistic Concurrency Control (OCC) Conflict Handling', () => {
		it('should return HTTP 409 when concurrent approval attempt has stale verificationVersion', async () => {
			const reqDoc = await EmergencyBloodRequest.create({
				requesterUserId: testUserRequester._id,
				hospitalId: testHospitalA._id,
				patientName: 'OCC Patient',
				patientAge: 50,
				patientGender: 'Male',
				requiredBloodGroup: 'O_Negative',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				hospitalName: testHospitalA.hospitalName,
				hospitalAddress: testHospitalA.address.street,
				hospitalCity: testHospitalA.address.city,
				hospitalState: testHospitalA.address.state,
				hospitalPinCode: 600006,
				attendingDoctor: { doctorName: 'Dr. Concurrency', doctorPhone: '9840111111' },
				verificationStatus: 'Pending_Verification',
				verificationVersion: 0,
			})
			cleanup.requests.push(reqDoc._id)

			// First actor approves request (increments version to 1)
			const { req: req1, res: res1, next: next1 } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: reqDoc._id.toString() },
				body: { remarks: 'First approval' },
			})
			await medicalOfficerController.approveEmergencyRequest(req1, res1, next1)
			assert.strictEqual(res1.statusCode, 200)

			// Second actor attempts to reject based on stale version 0
			// (Simulated by modifying the request document back to Pending_Verification with version 2 to trigger version mismatch)
			await EmergencyBloodRequest.updateOne(
				{ _id: reqDoc._id },
				{ verificationStatus: 'Pending_Verification', verificationVersion: 5 }
			)

			const { req: req2, res: res2, next: next2 } = createMockReqRes({
				user: testMO1,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [testHospitalA._id.toString()],
				params: { id: reqDoc._id.toString() },
				body: { rejectionReason: 'Second concurrent rejection attempt', verificationVersion: 0 },
			})

			await medicalOfficerController.rejectEmergencyRequest(req2, res2, next2)
			// OCC conflict must yield 409
			assert.strictEqual(res2.statusCode, 409)
			assert.match(res2.responseData.message, /Conflict: Request was modified by another user/)
		})
	})

	describe('5. Matching Safety Gate Invariants', () => {
		it('should REJECT matching on More_Information_Required request with 400 REQUEST_MORE_INFORMATION_REQUIRED', async () => {
			const reqDoc = await EmergencyBloodRequest.create({
				requesterUserId: testUserRequester._id,
				hospitalId: testHospitalA._id,
				patientName: 'Matching Safety Patient',
				patientAge: 40,
				patientGender: 'Female',
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 1,
				hospitalName: testHospitalA.hospitalName,
				hospitalAddress: testHospitalA.address.street,
				hospitalCity: testHospitalA.address.city,
				hospitalState: testHospitalA.address.state,
				hospitalPinCode: 600006,
				location: { type: 'Point', coordinates: [80.25, 13.06] },
				attendingDoctor: { doctorName: 'Dr. Match', doctorPhone: '9840111111' },
				verificationStatus: 'More_Information_Required',
			})
			cleanup.requests.push(reqDoc._id)

			const { req, res, next } = createMockReqRes({
				user: testUserRequester,
				userRole: 'USER',
				params: { id: reqDoc._id.toString() },
			})

			await getRequestMatches(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_MORE_INFORMATION_REQUIRED')
			assert.match(res.responseData.message, /requires additional clinical information/)
		})

		it('should ALLOW matching only when verificationStatus is Verified', async () => {
			const reqDoc = await EmergencyBloodRequest.create({
				requesterUserId: testUserRequester._id,
				hospitalId: testHospitalA._id,
				patientName: 'Verified Matching Patient',
				patientAge: 40,
				patientGender: 'Female',
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 1,
				hospitalName: testHospitalA.hospitalName,
				hospitalAddress: testHospitalA.address.street,
				hospitalCity: testHospitalA.address.city,
				hospitalState: testHospitalA.address.state,
				hospitalPinCode: 600006,
				location: { type: 'Point', coordinates: [80.25, 13.06] },
				attendingDoctor: { doctorName: 'Dr. Match', doctorPhone: '9840111111' },
				verificationStatus: 'Verified',
			})
			cleanup.requests.push(reqDoc._id)

			const { req, res, next } = createMockReqRes({
				user: testUserRequester,
				userRole: 'USER',
				params: { id: reqDoc._id.toString() },
			})

			await getRequestMatches(req, res, next)
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert.ok(res.responseData.data.emergencyRequest)
			assert.strictEqual(res.responseData.data.emergencyRequest.verificationStatus, 'Verified')
		})
	})
})
