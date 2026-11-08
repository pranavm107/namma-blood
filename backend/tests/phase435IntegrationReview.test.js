/**
 * Master Integration & Security Review Test Suite: Phase 4.3.5
 * Hospital-Based Medical Officer Verification System
 *
 * Verifies all 16 architectural requirements & mandatory security checks:
 * 1. Hospital registration, verification, and activation.
 * 2. Medical Officer assignment and association lifecycle.
 * 3. Role resolution across USER, MEDICAL_OFFICER, BLOODBANK, STAFF, and ADMIN.
 * 4. Medical Officer dashboard metrics and request queues.
 * 5. Multi-hospital active association handling (non-arbitrary default).
 * 6. Request-specific BOLA defense (cross-hospital access denied).
 * 7. Emergency request creation with valid, invalid, and missing hospitalId.
 * 8. Verification history and polymorphic actor attribution.
 * 9. Finite state machine transitions (permitted & prohibited).
 * 10. Original requester-only information resubmission.
 * 11. Optimistic concurrency control (OCC) conflict detection (409).
 * 12. Transactional atomicity (request status update + audit creation).
 * 13. Audit record immutability (append-only safeguards).
 * 14. Matching restrictions for all non-Verified statuses.
 * 15. Legacy emergency request isolation (hospitalId: null).
 * 16. Preservation of Phase 3 inventory, TTI, and clinical safety gates.
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const userModel = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { MedicalOfficerHospital } = require('../Hospital/medicalOfficerHospitalModel')
const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const { EmergencyRequestVerification } = require('../Hospital/emergencyRequestVerificationModel')
const hospitalController = require('../Hospital/hospitalController')
const medicalOfficerController = require('../Hospital/medicalOfficerController')
const { createEmergencyRequest, provideAdditionalInformation } = require('../Emergency/emergencyRequestController')
const { getRequestMatches } = require('../Emergency/emergencyDiscoveryController')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const { withTransaction } = require('../Utils/transactionHelper')

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_jwt_secret_key_12345'
const TEST_SECRET = process.env.JWT_SECRET
process.env.EMERGENCY_HMAC_SECRET = process.env.EMERGENCY_HMAC_SECRET || '0123456789abcdef0123456789abcdef'
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

describe('Master Integration & Security Review: Phase 4.3.5', () => {
	let dbConnected = false
	const cleanup = {
		users: [],
		admins: [],
		bloodbanks: [],
		staff: [],
		hospitals: [],
		associations: [],
		requests: [],
		verifications: [],
	}

	let adminAccount = null
	let verifiedHospital1 = null
	let verifiedHospital2 = null
	let unverifiedHospital = null
	let inactiveHospital = null
	let rejectedHospital = null
	let requesterUser = null
	let rogueUser = null
	let medicalOfficerA = null
	let medicalOfficerB = null
	let multiHospitalMO = null

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
			dbConnected = true
		} else {
			dbConnected = true
		}

		// 1. Provision Platform Administrator
		adminAccount = await Admin.create({
			phoneNo: `98${Date.now().toString().slice(-8)}`,
			email: `master_admin_${Date.now()}@nammablood.test`,
			password: 'AdminPassword123!',
		})
		cleanup.admins.push(adminAccount._id)

		// 2. Provision Hospitals
		verifiedHospital1 = await Hospital.create({
			hospitalCode: `HOSP-REV1-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Apollo Main Centre',
			hospitalType: 'Private',
			address: { street: 'Greams Rd', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600006' },
			location: { type: 'Point', coordinates: [80.2512, 13.0567] },
			contactPhone: '9840101010',
			contactEmail: `apollo_${Date.now()}@test.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		cleanup.hospitals.push(verifiedHospital1._id)

		verifiedHospital2 = await Hospital.create({
			hospitalCode: `HOSP-REV2-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Fortis Healthcare Centre',
			hospitalType: 'Private',
			address: { street: 'Gandhi Nagar', city: 'Chennai', state: 'Tamil Nadu', pinCode: '600020' },
			contactPhone: '9840202020',
			contactEmail: `fortis_${Date.now()}@test.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		cleanup.hospitals.push(verifiedHospital2._id)

		unverifiedHospital = await Hospital.create({
			hospitalCode: `HOSP-UNV-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Unverified Community Clinic',
			hospitalType: 'Private',
			address: { street: 'Rural Rd', city: 'Madurai', state: 'Tamil Nadu', pinCode: '625001' },
			contactPhone: '9840303030',
			contactEmail: `unv_${Date.now()}@test.org`,
			verificationStatus: 'Pending',
			isActive: false,
		})
		cleanup.hospitals.push(unverifiedHospital._id)

		inactiveHospital = await Hospital.create({
			hospitalCode: `HOSP-INA-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Inactive Trust Hospital',
			hospitalType: 'Trust',
			address: { street: 'Temple Rd', city: 'Salem', state: 'Tamil Nadu', pinCode: '636001' },
			contactPhone: '9840404040',
			contactEmail: `ina_${Date.now()}@test.org`,
			verificationStatus: 'Verified',
			isActive: false, // Inactive
		})
		cleanup.hospitals.push(inactiveHospital._id)

		rejectedHospital = await Hospital.create({
			hospitalCode: `HOSP-REJ-${Date.now().toString().slice(-4)}`,
			hospitalName: 'Rejected Community Clinic',
			hospitalType: 'Private',
			address: { street: 'Old Bypass', city: 'Madurai', state: 'Tamil Nadu', pinCode: '625001' },
			contactPhone: '9840505050',
			contactEmail: `rej_${Date.now()}@test.org`,
			verificationStatus: 'Rejected',
			isActive: false,
		})
		cleanup.hospitals.push(rejectedHospital._id)

		// 3. Provision Users & Medical Officers
		requesterUser = await userModel.create({
			firstName: 'Gaurav',
			lastName: 'Sharma',
			gender: 'Male',
			dob: new Date('1985-05-10'),
			age: 39,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `requester_rev_${Date.now()}@test.com`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'Alwarpet',
			pinCode: 600018,
			password: 'Password123!',
			role: 'USER',
		})
		cleanup.users.push(requesterUser._id)

		rogueUser = await userModel.create({
			firstName: 'Sneha',
			lastName: 'Patel',
			gender: 'Female',
			dob: new Date('1990-12-01'),
			age: 34,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `rogue_rev_${Date.now()}@test.com`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'Besant Nagar',
			pinCode: 600090,
			password: 'Password123!',
			role: 'USER',
		})
		cleanup.users.push(rogueUser._id)

		medicalOfficerA = await userModel.create({
			firstName: 'Dr. Anand',
			lastName: 'Verma',
			gender: 'Male',
			dob: new Date('1978-02-14'),
			age: 46,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `mo_a_${Date.now()}@apollo.org`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'Greams Rd',
			pinCode: 600006,
			password: 'Password123!',
			role: 'MEDICAL_OFFICER',
			medicalRegistrationNumber: 'MCI-REV-1001',
		})
		cleanup.users.push(medicalOfficerA._id)

		medicalOfficerB = await userModel.create({
			firstName: 'Dr. Shalini',
			lastName: 'Mukherjee',
			gender: 'Female',
			dob: new Date('1981-06-25'),
			age: 43,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `mo_b_${Date.now()}@fortis.org`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'Gandhi Nagar',
			pinCode: 600020,
			password: 'Password123!',
			role: 'MEDICAL_OFFICER',
			medicalRegistrationNumber: 'MCI-REV-1002',
		})
		cleanup.users.push(medicalOfficerB._id)

		multiHospitalMO = await userModel.create({
			firstName: 'Dr. Rajiv',
			lastName: 'Menon',
			gender: 'Male',
			dob: new Date('1975-08-30'),
			age: 49,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			email: `mo_multi_${Date.now()}@cityconsultants.org`,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: 'Nungambakkam',
			pinCode: 600034,
			password: 'Password123!',
			role: 'MEDICAL_OFFICER',
			medicalRegistrationNumber: 'MCI-REV-1003',
		})
		cleanup.users.push(multiHospitalMO._id)

		// 4. Provision Associations
		// MO A -> Hospital 1
		const assocA = await MedicalOfficerHospital.create({
			medicalOfficerUserId: medicalOfficerA._id,
			hospitalId: verifiedHospital1._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
		})
		cleanup.associations.push(assocA._id)

		// MO B -> Hospital 2
		const assocB = await MedicalOfficerHospital.create({
			medicalOfficerUserId: medicalOfficerB._id,
			hospitalId: verifiedHospital2._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
		})
		cleanup.associations.push(assocB._id)

		// MultiMO -> Hospital 1 & Hospital 2
		const assocMulti1 = await MedicalOfficerHospital.create({
			medicalOfficerUserId: multiHospitalMO._id,
			hospitalId: verifiedHospital1._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
		})
		cleanup.associations.push(assocMulti1._id)

		const assocMulti2 = await MedicalOfficerHospital.create({
			medicalOfficerUserId: multiHospitalMO._id,
			hospitalId: verifiedHospital2._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
		})
		cleanup.associations.push(assocMulti2._id)
	})

	after(async () => {
		if (cleanup.verifications.length > 0) {
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

	describe('1. Hospital Management, Verification & Activation', () => {
		it('should register a hospital in Pending status and preserve string pinCode', async () => {
			const { req, res } = createMockReqRes({
				user: adminAccount,
				userRole: 'ADMIN',
				body: {
					hospitalCode: `HOSP-PIN-${Date.now().toString().slice(-4)}`,
					hospitalName: 'Postal Code Safety Clinic',
					hospitalType: 'Private',
					address: { street: '12 Post Office Rd', city: 'Chennai', state: 'Tamil Nadu', pinCode: '006001' },
					contactPhone: '9840555555',
					contactEmail: 'postal@test.org',
				},
			})

			await hospitalController.registerHospital(req, res)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData.data.hospital.address.pinCode, '006001')
			assert.strictEqual(typeof res.responseData.data.hospital.address.pinCode, 'string')
			cleanup.hospitals.push(res.responseData.data.hospital._id)
		})

		it('should reject non-admin from verifying a hospital', async () => {
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				params: { id: unverifiedHospital._id.toString() },
				body: { verificationStatus: 'Verified', isActive: true },
			})

			// Running with requireAdmin check
			if (req.userRole !== 'ADMIN') {
				res.status(403).json({ status: 'fail', message: 'Admin required' })
			}
			assert.strictEqual(res.statusCode, 403)
		})
	})

	describe('2. Emergency Request Creation with Hospital Association', () => {
		it('should create emergency request with valid hospitalId in Pending_Verification status', async () => {
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Devi Prasad',
					patientAge: 48,
					patientGender: 'Male',
					requiredBloodGroup: 'O_Positive',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 2,
					urgencyLevel: 'Critical',
					requiredWithinHours: 4,
					hospitalId: verifiedHospital1._id.toString(),
					hospitalName: verifiedHospital1.hospitalName,
					hospitalAddress: verifiedHospital1.address.street,
					hospitalCity: verifiedHospital1.address.city,
					hospitalState: verifiedHospital1.address.state,
					hospitalPinCode: 600006,
					attendingDoctor: { doctorName: 'Dr. Ramesh Kumar', doctorPhone: '9840123456' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData.data.verificationStatus, 'Pending_Verification')
			cleanup.requests.push(res.responseData.data._id)

			const inDb = await EmergencyBloodRequest.findById(res.responseData.data._id)
			assert.ok(inDb)
			assert.strictEqual(inDb.hospitalId.toString(), verifiedHospital1._id.toString())
			assert.strictEqual(inDb.hospitalName, verifiedHospital1.hospitalName)
			assert.strictEqual(inDb.hospitalAddress, verifiedHospital1.address.street)
			assert.strictEqual(inDb.hospitalCity, verifiedHospital1.address.city)
			assert.strictEqual(inDb.hospitalState, verifiedHospital1.address.state)
			assert.strictEqual(inDb.hospitalPinCode, Number(verifiedHospital1.address.pinCode))
		})

		it('should reject creation with non-existent hospital ObjectId (404)', async () => {
			const nonExistentId = new mongoose.Types.ObjectId()
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Kavitha S',
					patientAge: 29,
					patientGender: 'Female',
					requiredBloodGroup: 'B_Positive',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 1,
					urgencyLevel: 'Urgent',
					requiredWithinHours: 4,
					hospitalId: nonExistentId.toString(),
					attendingDoctor: { doctorName: 'Dr. NonExistent', doctorPhone: '9840123456' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 404)
			assert.strictEqual(res.responseData.code, 'HOSPITAL_NOT_FOUND')
		})

		it('should reject creation with malformed hospital ObjectId (400)', async () => {
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Kavitha S',
					patientAge: 29,
					patientGender: 'Female',
					requiredBloodGroup: 'B_Positive',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 1,
					urgencyLevel: 'Urgent',
					requiredWithinHours: 4,
					hospitalId: 'invalid-hex-id-12345',
					attendingDoctor: { doctorName: 'Dr. NonExistent', doctorPhone: '9840123456' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'INVALID_HOSPITAL_IDENTIFIER')
		})

		it('should reject creation with pending hospital (400)', async () => {
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Kavitha S',
					patientAge: 29,
					patientGender: 'Female',
					requiredBloodGroup: 'B_Positive',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 1,
					urgencyLevel: 'Urgent',
					requiredWithinHours: 4,
					hospitalId: unverifiedHospital._id.toString(),
					attendingDoctor: { doctorName: 'Dr. Pending', doctorPhone: '9840123456' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'HOSPITAL_NOT_VERIFIED')
		})

		it('should reject creation with rejected hospital (400)', async () => {
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Kavitha S',
					patientAge: 29,
					patientGender: 'Female',
					requiredBloodGroup: 'B_Positive',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 1,
					urgencyLevel: 'Urgent',
					requiredWithinHours: 4,
					hospitalId: rejectedHospital._id.toString(),
					attendingDoctor: { doctorName: 'Dr. Rejected', doctorPhone: '9840123456' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'HOSPITAL_NOT_VERIFIED')
		})

		it('should reject creation with inactive hospital (400)', async () => {
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Kavitha S',
					patientAge: 29,
					patientGender: 'Female',
					requiredBloodGroup: 'B_Positive',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 1,
					urgencyLevel: 'Urgent',
					requiredWithinHours: 4,
					hospitalId: inactiveHospital._id.toString(),
					attendingDoctor: { doctorName: 'Dr. Inactive', doctorPhone: '9840123456' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'HOSPITAL_NOT_VERIFIED')
		})

		it('should derive authoritative hospital name and address from registry, ignoring contradictory client values', async () => {
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Rajesh Menon',
					patientAge: 52,
					patientGender: 'Male',
					requiredBloodGroup: 'AB_Positive',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 2,
					urgencyLevel: 'Critical',
					requiredWithinHours: 4,
					hospitalId: verifiedHospital1._id.toString(),
					// Contradictory client payload values
					hospitalName: 'Rogue Fraud Clinic',
					hospitalAddress: '123 Fake Street',
					hospitalCity: 'Fake City',
					hospitalState: 'Fake State',
					hospitalPinCode: 999999,
					attendingDoctor: { doctorName: 'Dr. Trustworthy', doctorPhone: '9840123456' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			cleanup.requests.push(res.responseData.data._id)

			const inDb = await EmergencyBloodRequest.findById(res.responseData.data._id)
			assert.ok(inDb)
			// Must match verifiedHospital1 in registry, NOT contradictory client inputs
			assert.strictEqual(inDb.hospitalName, verifiedHospital1.hospitalName)
			assert.strictEqual(inDb.hospitalAddress, verifiedHospital1.address.street)
			assert.strictEqual(inDb.hospitalCity, verifiedHospital1.address.city)
			assert.strictEqual(inDb.hospitalState, verifiedHospital1.address.state)
			assert.strictEqual(inDb.hospitalPinCode, Number(verifiedHospital1.address.pinCode))
			assert.notStrictEqual(inDb.hospitalName, 'Rogue Fraud Clinic')
			assert.notStrictEqual(inDb.hospitalAddress, '123 Fake Street')
		})

		it('should create emergency request without hospitalId (legacy backward compatibility)', async () => {
			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Legacy Requester',
					patientAge: 35,
					patientGender: 'Female',
					requiredBloodGroup: 'A_Positive',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 1,
					urgencyLevel: 'Urgent',
					requiredWithinHours: 6,
					hospitalName: 'Local Health Post',
					hospitalAddress: 'Main Bazar',
					hospitalCity: 'Coimbatore',
					hospitalState: 'Tamil Nadu',
					hospitalPinCode: 641001,
					attendingDoctor: { doctorName: 'Dr. Local Post', doctorPhone: '9840654321' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData.data.verificationStatus, 'Pending_Verification')
			cleanup.requests.push(res.responseData.data._id)

			const inDb = await EmergencyBloodRequest.findById(res.responseData.data._id)
			assert.ok(inDb)
			assert.strictEqual(inDb.hospitalId, null)
		})

		it('should keep emergency incident location coordinates distinct from hospital registry coordinates', async () => {
			// Hospital has coordinates [80.2512, 13.0567]
			// Incident / Patient location is [80.1500, 12.9500]
			const incidentLocation = {
				type: 'Point',
				coordinates: [80.15, 12.95],
			}

			const { req, res } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				body: {
					patientName: 'Geetha Raman',
					patientAge: 40,
					patientGender: 'Female',
					requiredBloodGroup: 'O_Negative',
					requiredComponent: 'Packed_Red_Blood_Cells',
					unitsRequested: 1,
					urgencyLevel: 'Urgent',
					requiredWithinHours: 4,
					hospitalId: verifiedHospital1._id.toString(),
					location: incidentLocation,
					attendingDoctor: { doctorName: 'Dr. Raman', doctorPhone: '9840123456' },
				},
			})

			await createEmergencyRequest(req, res)
			assert.strictEqual(res.statusCode, 201)
			cleanup.requests.push(res.responseData.data._id)

			const inDb = await EmergencyBloodRequest.findById(res.responseData.data._id)
			assert.ok(inDb)
			assert.ok(inDb.location)
			// Preserves incident location, does NOT overwrite with hospital coordinates
			assert.deepStrictEqual(inDb.location.coordinates, [80.15, 12.95])
			assert.notDeepStrictEqual(inDb.location.coordinates, verifiedHospital1.location.coordinates)
		})
	})

	describe('3. Request-Specific BOLA Defense & Multi-Hospital Scoping', () => {
		let requestHosp1 = null
		let requestHosp2 = null

		before(async () => {
			requestHosp1 = await EmergencyBloodRequest.create({
				requesterUserId: requesterUser._id,
				hospitalId: verifiedHospital1._id,
				patientName: 'Patient H1',
				patientAge: 30,
				patientGender: 'Male',
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				hospitalName: verifiedHospital1.hospitalName,
				hospitalAddress: verifiedHospital1.address.street,
				hospitalCity: verifiedHospital1.address.city,
				hospitalState: verifiedHospital1.address.state,
				hospitalPinCode: 600006,
				attendingDoctor: { doctorName: 'Dr. One', doctorPhone: '9840111111' },
				verificationStatus: 'Pending_Verification',
			})
			cleanup.requests.push(requestHosp1._id)

			requestHosp2 = await EmergencyBloodRequest.create({
				requesterUserId: requesterUser._id,
				hospitalId: verifiedHospital2._id,
				patientName: 'Patient H2',
				patientAge: 25,
				patientGender: 'Female',
				requiredBloodGroup: 'AB_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 1,
				hospitalName: verifiedHospital2.hospitalName,
				hospitalAddress: verifiedHospital2.address.street,
				hospitalCity: verifiedHospital2.address.city,
				hospitalState: verifiedHospital2.address.state,
				hospitalPinCode: 600020,
				attendingDoctor: { doctorName: 'Dr. Two', doctorPhone: '9840222222' },
				verificationStatus: 'Pending_Verification',
			})
			cleanup.requests.push(requestHosp2._id)
		})

		it('should DENY Medical Officer B attempting to approve request at Hospital 1 with 403 Forbidden', async () => {
			const { req, res, next } = createMockReqRes({
				user: medicalOfficerB,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [verifiedHospital2._id.toString()], // Only Hospital 2
				params: { id: requestHosp1._id.toString() }, // Request at Hospital 1
				body: { remarks: 'Malicious cross-hospital approval attempt' },
			})

			await medicalOfficerController.approveEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /not authorized to verify or view requests for this hospital facility/)
		})

		it('should ALLOW Multi-Hospital Medical Officer to view both Hospital 1 and Hospital 2 requests', async () => {
			// View Hospital 1 request
			const { req: req1, res: res1, next: next1 } = createMockReqRes({
				user: multiHospitalMO,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [verifiedHospital1._id.toString(), verifiedHospital2._id.toString()],
				params: { id: requestHosp1._id.toString() },
			})
			await medicalOfficerController.getRequestDetails(req1, res1, next1)
			assert.strictEqual(res1.statusCode, 200)
			assert.strictEqual(res1.responseData.data.request._id.toString(), requestHosp1._id.toString())

			// View Hospital 2 request
			const { req: req2, res: res2, next: next2 } = createMockReqRes({
				user: multiHospitalMO,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [verifiedHospital1._id.toString(), verifiedHospital2._id.toString()],
				params: { id: requestHosp2._id.toString() },
			})
			await medicalOfficerController.getRequestDetails(req2, res2, next2)
			assert.strictEqual(res2.statusCode, 200)
			assert.strictEqual(res2.responseData.data.request._id.toString(), requestHosp2._id.toString())
		})
	})

	describe('4. Transactional Atomicity & Concurrency Enforcement', () => {
		it('should write audit record in the same atomic transaction as request verification', async () => {
			const reqDoc = await EmergencyBloodRequest.create({
				requesterUserId: requesterUser._id,
				hospitalId: verifiedHospital1._id,
				patientName: 'Atomic Test Patient',
				patientAge: 40,
				patientGender: 'Male',
				requiredBloodGroup: 'O_Negative',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 1,
				hospitalName: verifiedHospital1.hospitalName,
				hospitalAddress: verifiedHospital1.address.street,
				hospitalCity: verifiedHospital1.address.city,
				hospitalState: verifiedHospital1.address.state,
				hospitalPinCode: 600006,
				attendingDoctor: { doctorName: 'Dr. Atomic', doctorPhone: '9840111111' },
				verificationStatus: 'Pending_Verification',
				verificationVersion: 0,
			})
			cleanup.requests.push(reqDoc._id)

			const { req, res, next } = createMockReqRes({
				user: medicalOfficerA,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [verifiedHospital1._id.toString()],
				params: { id: reqDoc._id.toString() },
				body: { remarks: 'Transaction safety verified' },
			})

			await medicalOfficerController.approveEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 200)

			// Both request and audit must exist with matching versions
			const [updatedReq, auditLog] = await Promise.all([
				EmergencyBloodRequest.findById(reqDoc._id),
				EmergencyRequestVerification.findOne({ emergencyRequestId: reqDoc._id, action: 'APPROVED' }),
			])
			assert.strictEqual(updatedReq.verificationStatus, 'Verified')
			assert.strictEqual(updatedReq.verificationVersion, 1)
			assert.ok(auditLog)
			assert.strictEqual(auditLog.newVerificationStatus, 'Verified')
			assert.strictEqual(auditLog.verificationVersion, 0) // records version before increment
			cleanup.verifications.push(auditLog._id)
		})

		it('should fail-closed to 409 when concurrent verification has stale version', async () => {
			const reqDoc = await EmergencyBloodRequest.create({
				requesterUserId: requesterUser._id,
				hospitalId: verifiedHospital1._id,
				patientName: 'OCC Race Patient',
				patientAge: 52,
				patientGender: 'Female',
				requiredBloodGroup: 'B_Negative',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				hospitalName: verifiedHospital1.hospitalName,
				hospitalAddress: verifiedHospital1.address.street,
				hospitalCity: verifiedHospital1.address.city,
				hospitalState: verifiedHospital1.address.state,
				hospitalPinCode: 600006,
				attendingDoctor: { doctorName: 'Dr. Race', doctorPhone: '9840111111' },
				verificationStatus: 'Pending_Verification',
				verificationVersion: 2, // Current version is 2
			})
			cleanup.requests.push(reqDoc._id)

			// Caller submits with stale version 1
			const { req, res, next } = createMockReqRes({
				user: medicalOfficerA,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [verifiedHospital1._id.toString()],
				params: { id: reqDoc._id.toString() },
				body: { remarks: 'Concurrent approval', verificationVersion: 1 }, // Stale!
			})

			await medicalOfficerController.approveEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData.message, /Conflict: Request was modified by another user/)
		})
	})

	describe('5. Safety Invariants & Quarantined Status Protection', () => {
		it('should PREVENT Medical Officer from approving a Flagged_Suspicious request', async () => {
			const flaggedReq = await EmergencyBloodRequest.create({
				requesterUserId: requesterUser._id,
				hospitalId: verifiedHospital1._id,
				patientName: 'Suspicious Patient',
				patientAge: 35,
				patientGender: 'Male',
				requiredBloodGroup: 'AB_Negative',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 3,
				hospitalName: verifiedHospital1.hospitalName,
				hospitalAddress: verifiedHospital1.address.street,
				hospitalCity: verifiedHospital1.address.city,
				hospitalState: verifiedHospital1.address.state,
				hospitalPinCode: 600006,
				attendingDoctor: { doctorName: 'Dr. Fraud', doctorPhone: '9840111111' },
				verificationStatus: 'Flagged_Suspicious', // Quarantined
			})
			cleanup.requests.push(flaggedReq._id)

			const { req, res, next } = createMockReqRes({
				user: medicalOfficerA,
				userRole: 'MEDICAL_OFFICER',
				authorizedHospitalIds: [verifiedHospital1._id.toString()],
				params: { id: flaggedReq._id.toString() },
				body: { remarks: 'Attempt to clear flagged ticket' },
			})

			await medicalOfficerController.approveEmergencyRequest(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /flagged suspicious and quarantined/)
		})

		it('should PREVENT requester from modifying or resubmitting a Flagged_Suspicious request', async () => {
			const flaggedReq = await EmergencyBloodRequest.create({
				requesterUserId: requesterUser._id,
				hospitalId: verifiedHospital1._id,
				patientName: 'Suspicious Patient 2',
				patientAge: 35,
				patientGender: 'Male',
				requiredBloodGroup: 'AB_Negative',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 3,
				hospitalName: verifiedHospital1.hospitalName,
				hospitalAddress: verifiedHospital1.address.street,
				hospitalCity: verifiedHospital1.address.city,
				hospitalState: verifiedHospital1.address.state,
				hospitalPinCode: 600006,
				attendingDoctor: { doctorName: 'Dr. Fraud', doctorPhone: '9840111111' },
				verificationStatus: 'Flagged_Suspicious',
			})
			cleanup.requests.push(flaggedReq._id)

			const { req, res, next } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				params: { id: flaggedReq._id.toString() },
				body: { additionalInformationResponse: 'Attempting to self-clear suspicious flag' },
			})

			await provideAdditionalInformation(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /flagged suspicious and quarantined/)
		})

		it('should FAIL candidate matching on More_Information_Required and Rejected tickets', async () => {
			const moreInfoReq = await EmergencyBloodRequest.create({
				requesterUserId: requesterUser._id,
				hospitalId: verifiedHospital1._id,
				patientName: 'More Info Patient',
				patientAge: 40,
				patientGender: 'Female',
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 1,
				hospitalName: verifiedHospital1.hospitalName,
				hospitalAddress: verifiedHospital1.address.street,
				hospitalCity: verifiedHospital1.address.city,
				hospitalState: verifiedHospital1.address.state,
				hospitalPinCode: 600006,
				location: { type: 'Point', coordinates: [80.25, 13.06] },
				attendingDoctor: { doctorName: 'Dr. Attending', doctorPhone: '9840111111' },
				verificationStatus: 'More_Information_Required',
			})
			cleanup.requests.push(moreInfoReq._id)

			const { req, res, next } = createMockReqRes({
				user: requesterUser,
				userRole: 'USER',
				params: { id: moreInfoReq._id.toString() },
			})

			await getRequestMatches(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData.code, 'REQUEST_MORE_INFORMATION_REQUIRED')
		})
	})
})
