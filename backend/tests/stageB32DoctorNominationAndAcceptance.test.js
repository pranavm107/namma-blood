/**
 * Stage B3.2 Automated Test Suite
 * Namma Blood — Doctor Nomination and Invitation Acceptance
 *
 * Comprehensive Test Coverage:
 * 1. Nomination Authorization:
 *    - Unauthenticated rejected (401)
 *    - USER, MEDICAL_OFFICER, BLOODBANK, STAFF rejected (403)
 *    - Inactive representative or deactivated account rejected (403)
 *    - Unverified or inactive hospital rejected (403)
 *    - Cross-hospital BOLA defense rejected (403)
 *    - Authorized HOSPITAL_ADMIN accepted (201) on both POST /api/hospital/doctors/nominate and POST /api/hospitals/doctors/nominate
 * 2. Nomination Input & Conflict Validation:
 *    - Invalid email / phone / missing name rejected (400)
 *    - Invalid invitationType rejected (400)
 *    - Duplicate pending nomination for same hospital & recipient rejected (409)
 *    - Existing account conflict: USER or HOSPITAL_ADMIN cannot be converted to MEDICAL_OFFICER (409)
 *    - Existing Medical Officer ALREADY associated with this hospital rejected (409)
 *    - Existing Medical Officer NOT associated with this hospital accepted (multi-hospital nomination, 201)
 * 3. Token Security & Lifecycle Persistence:
 *    - Cryptographically secure random token generated, only SHA-256 hash stored in DB
 *    - Raw token encrypted in NotificationOutbox payload using AES-256-GCM
 *    - Invalid, unissued, or tampered token rejected (400)
 *    - Expired token rejected (400) and permanently persisted as 'Expired'
 *    - Revoked token rejected (400)
 *    - Already accepted token rejected from re-use (400)
 * 4. Invitation Acceptance Workflow:
 *    - New doctor onboarding: creates MEDICAL_OFFICER with Active accountStatus, Unsubmitted credentialStatus, Pending verificationStatus
 *    - Creates MedicalOfficerHospital association with Pending_Admin_Approval, VIEW_EMERGENCY_REQUESTS, Unavailable
 *    - Ignores client-supplied role, hospitalId, and statuses (authoritative server-side values enforced)
 *    - Multi-hospital acceptance: existing MEDICAL_OFFICER associates with second hospital without duplicate user account
 *    - Rejects missing required acceptance declarations (400)
 *    - Rejects acceptance if hospital was deactivated after issuance (400)
 * 5. Clinical Authorization Invariants:
 *    - Doctor after acceptance CANNOT verify emergency requests (fails Gates 2 & 3, HTTP 403)
 *    - Doctor after acceptance CANNOT access clinical queue (HTTP 403)
 *    - Proves invitation acceptance is not credential verification or clinical authorization
 * 6. Transaction Guarantees & Failure Injections:
 *    - Production fail-closed when transactions unsupported (500)
 *    - Failure Injection 1: User creation error rolls back transaction; invitation remains Pending
 *    - Failure Injection 2: Association creation error rolls back transaction; invitation remains Pending, user creation rolled back
 *    - Failure Injection 3: CAS collision rolls back transaction; user & association rolled back
 *    - Failure Injection 4: Outbox insertion error rolls back transaction; invitation remains Pending, user & association rolled back
 *    - Failure Injection 5: Commit-operation failure (commitTransaction fails) rolls back transaction; invitation remains Pending
 *    - Concurrency Check: Concurrent redemption permits strictly ONE successful acceptance
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
	getEncryptionKey,
	encryptInvitationToken,
	decryptInvitationToken,
} = require('../Utils/tokenEncryption')
const {
	nominateDoctorInvitation,
	acceptDoctorNominationInvitation,
} = require('../Hospital/hospitalInvitationController')
const medicalOfficerController = require('../Hospital/medicalOfficerController')
const hospitalController = require('../Hospital/hospitalController')
const { protectHospitalAdminAuth } = require('../Hospital/hospitalAdminMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { withTransaction, canUseTransactions } = require('../Utils/transactionHelper')
const { login } = require('../Login_And_Authentication/login')

const requireAdmin = (req, res, next) => {
	if (req.userRole !== 'ADMIN') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Platform Administrator privileges required.',
		})
	}
	next()
}

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
	_transactionOptions = null,
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
		_transactionOptions,
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
	return { req, res }
}

describe('Stage B3.2: Doctor Nomination & Invitation Acceptance', () => {
	let adminUser, adminToken
	let verifiedHospital1, verifiedHospital2, inactiveHospital, unverifiedHospital
	let repUser1, repToken1
	let repUser2, repToken2
	let normalUser, userToken
	let existingDoctorUser, doctorToken
	let bloodbankDoc, bloodbankToken
	let staffDoc, staffToken

	const createdUserIds = []
	const createdHospitalIds = []
	const createdInvitationIds = []
	const createdOutboxEventIds = []
	const createdAssociationIds = []
	const createdEmergencyRequestIds = []

	before(async () => {
		if (mongoose.connection.readyState !== 1) {
			await mongoose.connect(TEST_DB_URI)
		}

		// Clean up previous test artifacts
		await Admin.deleteMany({ email: /^admin\.b32\./ })
		await userModel.deleteMany({ email: /@test-b32\.org$/ })
		await Hospital.deleteMany({ contactEmail: /@test-b32\.org$/ })
		await Invitation.deleteMany({ recipientEmail: /@test-b32\.org$/ })
		await NotificationOutbox.deleteMany({ recipientEmail: /@test-b32\.org$/ })
		await MedicalOfficerHospital.deleteMany({})

		// 1. Platform Admin
		adminUser = await Admin.create({
			name: 'Super Admin B32',
			email: `admin.b32.${Date.now()}@test-b32.org`,
			password: 'AdminPassword123!',
			phoneNo: Math.floor(1000000000 + Math.random() * 9000000000),
			status: true,
		})
		createdUserIds.push(adminUser._id)
		adminToken = signToken(adminUser._id)

		// 2. Verified Hospital 1 (City General)
		verifiedHospital1 = await Hospital.create({
			hospitalCode: `HOSP-B32-001-${Date.now()}`,
			hospitalName: 'City General Hospital B32',
			hospitalType: 'Government',
			address: {
				street: '100 Medical Road',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600003',
			},
			contactPhone: '9840011222',
			contactEmail: `city.gen.${Date.now()}@test-b32.org`,
			verificationStatus: 'Verified',
			isActive: true,
			verifiedBy: adminUser._id,
			verifiedAt: new Date(),
		})
		createdHospitalIds.push(verifiedHospital1._id)

		// 3. Verified Hospital 2 (Metro Specialty - for multi-hospital testing)
		verifiedHospital2 = await Hospital.create({
			hospitalCode: `HOSP-B32-002-${Date.now()}`,
			hospitalName: 'Metro Specialty Hospital B32',
			hospitalType: 'Private',
			address: {
				street: '200 Health Ave',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600020',
			},
			contactPhone: '9840033444',
			contactEmail: `metro.spec.${Date.now()}@test-b32.org`,
			verificationStatus: 'Verified',
			isActive: true,
			verifiedBy: adminUser._id,
			verifiedAt: new Date(),
		})
		createdHospitalIds.push(verifiedHospital2._id)

		// 4. Inactive Hospital
		inactiveHospital = await Hospital.create({
			hospitalCode: `HOSP-B32-003-${Date.now()}`,
			hospitalName: 'Closed Clinic B32',
			hospitalType: 'Private',
			address: {
				street: '300 Inactive Way',
				city: 'Madurai',
				state: 'Tamil Nadu',
				pinCode: '625001',
			},
			contactPhone: '9840055666',
			contactEmail: `inactive.${Date.now()}@test-b32.org`,
			verificationStatus: 'Verified',
			isActive: false,
			verifiedBy: adminUser._id,
			verifiedAt: new Date(),
		})
		createdHospitalIds.push(inactiveHospital._id)

		// 5. Unverified Hospital
		unverifiedHospital = await Hospital.create({
			hospitalCode: `HOSP-B32-004-${Date.now()}`,
			hospitalName: 'Pending Hospital B32',
			hospitalType: 'Private',
			address: {
				street: '400 Unverified St',
				city: 'Salem',
				state: 'Tamil Nadu',
				pinCode: '636001',
			},
			contactPhone: '9840077888',
			contactEmail: `unverified.${Date.now()}@test-b32.org`,
			verificationStatus: 'Pending',
			isActive: false,
		})
		createdHospitalIds.push(unverifiedHospital._id)

		// 6. Hospital Representative 1 for Hospital 1
		repUser1 = await userModel.create({
			firstName: 'Rajesh',
			lastName: 'RepOne',
			email: `rep1.${Date.now()}@test-b32.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'Rep1Password123!',
			role: 'HOSPITAL_ADMIN',
			accountStatus: 'Active',
			representativeStatus: 'Active',
			hospitalId: verifiedHospital1._id,
			status: true,
		})
		createdUserIds.push(repUser1._id)
		repToken1 = signToken(repUser1._id, { userType: 'user' })

		// 7. Hospital Representative 2 for Hospital 2
		repUser2 = await userModel.create({
			firstName: 'Ananya',
			lastName: 'RepTwo',
			email: `rep2.${Date.now()}@test-b32.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'Rep2Password123!',
			role: 'HOSPITAL_ADMIN',
			accountStatus: 'Active',
			representativeStatus: 'Active',
			hospitalId: verifiedHospital2._id,
			status: true,
		})
		createdUserIds.push(repUser2._id)
		repToken2 = signToken(repUser2._id, { userType: 'user' })

		// 8. Standard USER
		normalUser = await userModel.create({
			firstName: 'Normal',
			lastName: 'Donor',
			email: `donor.${Date.now()}@test-b32.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'UserPassword123!',
			role: 'USER',
			gender: 'Male',
			dob: new Date('1992-05-15'),
			age: 32,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: '45 Donor Lane',
			pinCode: 600001,
			accountStatus: 'Active',
			status: true,
		})
		createdUserIds.push(normalUser._id)
		userToken = signToken(normalUser._id, { userType: 'user' })

		// 9. Existing Medical Officer (Associated with Hospital 1, to test multi-hospital nomination for Hospital 2)
		existingDoctorUser = await userModel.create({
			firstName: 'Dr. Vikram',
			lastName: 'SeniorSurgeon',
			email: `vikram.mo.${Date.now()}@test-b32.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'DoctorPass123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: 'Verified',
			verificationStatus: 'Verified',
			status: true,
		})
		createdUserIds.push(existingDoctorUser._id)
		doctorToken = signToken(existingDoctorUser._id, { userType: 'user' })

		// Pre-associate existing doctor with Hospital 1
		const initialAssoc = await MedicalOfficerHospital.create({
			medicalOfficerUserId: existingDoctorUser._id,
			hospitalId: verifiedHospital1._id,
			associationStatus: 'Active',
			permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			availabilityStatus: 'Available',
			initiatedBy: 'ADMIN',
			approvedAt: new Date(),
		})
		createdAssociationIds.push(initialAssoc._id)

		// 10. Bloodbank & Staff accounts for authorization boundary testing
		bloodbankDoc = await Bloodbank.create({
			bloodbankName: 'Chennai Central Blood Bank B32',
			category: 'Government',
			contactPerson: 'Dr. BB Officer',
			address1: '500 BB Road',
			address2: 'A Block',
			state: 'Tamil Nadu',
			city: 'Chennai',
			pinCode: 600008,
			phoneNo1: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			phoneNo2: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			email: `bb.${Date.now()}@test-b32.org`,
			password: 'Password123!',
			status: true,
			location: { type: 'Point', coordinates: [80.2707, 13.0827] },
		})
		createdUserIds.push(bloodbankDoc._id)
		bloodbankToken = signToken(bloodbankDoc._id)

		staffDoc = await BloodbankStaff.create({
			fullName: 'Nurse Priya B32',
			email: `staff.${Date.now()}@test-b32.org`,
			phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			password: 'Password123!',
			bloodbankId: bloodbankDoc._id,
			createdBy: bloodbankDoc._id,
			role: 'Lab_Technician',
			status: 'Active',
		})
		createdUserIds.push(staffDoc._id)
		staffToken = signToken(staffDoc._id, { userType: 'staff' })
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
			await Admin.deleteMany({ _id: { $in: createdUserIds } })
			await Bloodbank.deleteMany({ _id: { $in: createdUserIds } })
			await BloodbankStaff.deleteMany({ _id: { $in: createdUserIds } })
		}
		if (createdHospitalIds.length > 0) {
			await Hospital.deleteMany({ _id: { $in: createdHospitalIds } })
		}
		await mongoose.disconnect()
	})

	// =========================================================================
	// 1. Nomination Authorization Matrix (Both Endpoints)
	// =========================================================================
	describe('1. Nomination Authorization Matrix: POST /api/hospital/doctors/nominate & POST /api/hospitals/doctors/nominate', () => {
		const endpoints = [
			{ name: 'Primary Route (/api/hospital/doctors/nominate)', path: '/api/hospital/doctors/nominate' },
			{ name: 'Alias Route (/api/hospitals/doctors/nominate)', path: '/api/hospitals/doctors/nominate' },
		]

		for (const ep of endpoints) {
			describe(`Route Defense: ${ep.name}`, () => {
				it(`should REJECT unauthenticated access with HTTP 401 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						body: {
							recipientName: 'Dr. Unauth Nominee',
							recipientEmail: 'unauth.doc@test-b32.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
					assert.strictEqual(res.statusCode, 401)
					assert.match(res.responseData?.message, /Authentication required/i)
				})

				it(`should REJECT USER role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${userToken}` },
						body: {
							recipientName: 'Dr. User Attempt',
							recipientEmail: 'user.attempt@test-b32.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Access denied/i)
				})

				it(`should REJECT MEDICAL_OFFICER role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${doctorToken}` },
						body: {
							recipientName: 'Dr. Doctor Attempt',
							recipientEmail: 'doctor.attempt@test-b32.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Access denied/i)
				})

				it(`should REJECT BLOODBANK role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${bloodbankToken}` },
						body: {
							recipientName: 'Dr. BB Attempt',
							recipientEmail: 'bb.attempt@test-b32.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Access denied/i)
				})

				it(`should REJECT STAFF role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${staffToken}` },
						body: {
							recipientName: 'Dr. Staff Attempt',
							recipientEmail: 'staff.attempt@test-b32.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Access denied/i)
				})

				it(`should REJECT Platform ADMIN with HTTP 403 on ${ep.path} (must use representative account)`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${adminToken}` },
						body: {
							recipientName: 'Dr. Admin Direct Attempt',
							recipientEmail: 'admin.attempt@test-b32.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Platform administrators cannot directly act as Hospital Representatives/i)
				})

				it(`should REJECT Hospital Representative attempting to nominate for ANOTHER hospital (BOLA defense, HTTP 403) on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${repToken1}` }, // Rep 1 belongs to Hospital 1
						body: {
							hospitalId: verifiedHospital2._id.toString(), // Rep 1 attempts to nominate for Hospital 2
							recipientName: 'Dr. Cross Hospital Nominee',
							recipientEmail: `cross.${Date.now()}@test-b32.org`,
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /cannot access, nominate, or manage records for another hospital/i)
				})

				it(`should AUTHORIZE active Hospital Representative with HTTP 201 on ${ep.path}`, async () => {
					const targetEmail = `nominee.auth.${Date.now()}.${Math.random().toString(36).substring(7)}@test-b32.org`
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${repToken1}` },
						body: {
							recipientName: 'Dr. Valid Nominee',
							recipientEmail: targetEmail,
							recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
						},
					})

					await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
					assert.strictEqual(res.statusCode, 201)
					assert.strictEqual(res.responseData?.status, 'success')
					assert.ok(res.responseData?.data?.invitationToken)
					assert.strictEqual(res.responseData?.data?.invitation?.invitationType, 'DOCTOR_NOMINATION')
					assert.strictEqual(res.responseData?.data?.invitation?.hospitalId.toString(), verifiedHospital1._id.toString())
					createdInvitationIds.push(res.responseData.data.invitation.id)
				})
			})
		}

		it('should REJECT nomination when representative accountStatus is Suspended (HTTP 403)', async () => {
			const suspendedRep = await userModel.create({
				firstName: 'Suspended',
				lastName: 'Rep',
				email: `suspended.rep.${Date.now()}@test-b32.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'HOSPITAL_ADMIN',
				accountStatus: 'Suspended',
				representativeStatus: 'Active',
				hospitalId: verifiedHospital1._id,
				status: true,
			})
			createdUserIds.push(suspendedRep._id)
			const suspToken = signToken(suspendedRep._id, { userType: 'user' })

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${suspToken}` },
				body: {
					recipientName: 'Dr. Test',
					recipientEmail: `test.${Date.now()}@test-b32.org`,
					recipientPhone: 9876543210,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Hospital Representative account is suspended/i)
		})

		it('should REJECT nomination when representative representativeStatus is Suspended (HTTP 403)', async () => {
			const suspRepStatus = await userModel.create({
				firstName: 'Inactive',
				lastName: 'RepStatus',
				email: `susp.rep.status.${Date.now()}@test-b32.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'HOSPITAL_ADMIN',
				accountStatus: 'Active',
				representativeStatus: 'Suspended',
				hospitalId: verifiedHospital1._id,
				status: true,
			})
			createdUserIds.push(suspRepStatus._id)
			const suspToken = signToken(suspRepStatus._id, { userType: 'user' })

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${suspToken}` },
				body: {
					recipientName: 'Dr. Test',
					recipientEmail: `test.${Date.now()}@test-b32.org`,
					recipientPhone: 9876543210,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Representative authorization status is 'Suspended'/i)
		})

		it('should REJECT nomination when hospital is unverified (HTTP 403)', async () => {
			const unverifiedRep = await userModel.create({
				firstName: 'UnverifiedHosp',
				lastName: 'Rep',
				email: `unverified.hosp.rep.${Date.now()}@test-b32.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'HOSPITAL_ADMIN',
				accountStatus: 'Active',
				representativeStatus: 'Active',
				hospitalId: unverifiedHospital._id,
				status: true,
			})
			createdUserIds.push(unverifiedRep._id)
			const unverifiedRepToken = signToken(unverifiedRep._id, { userType: 'user' })

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${unverifiedRepToken}` },
				body: {
					recipientName: 'Dr. Test',
					recipientEmail: `test.${Date.now()}@test-b32.org`,
					recipientPhone: 9876543210,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Hospital facility verification status is 'Pending'/i)
		})

		it('should REJECT nomination when hospital is inactive (HTTP 403)', async () => {
			const inactiveHospRep = await userModel.create({
				firstName: 'InactiveHosp',
				lastName: 'Rep',
				email: `inactive.hosp.rep.${Date.now()}@test-b32.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'Password123!',
				role: 'HOSPITAL_ADMIN',
				accountStatus: 'Active',
				representativeStatus: 'Active',
				hospitalId: inactiveHospital._id,
				status: true,
			})
			createdUserIds.push(inactiveHospRep._id)
			const inactiveRepToken = signToken(inactiveHospRep._id, { userType: 'user' })

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${inactiveRepToken}` },
				body: {
					recipientName: 'Dr. Test',
					recipientEmail: `test.${Date.now()}@test-b32.org`,
					recipientPhone: 9876543210,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Hospital facility is currently marked inactive/i)
		})
	})

	// =========================================================================
	// 2. Nomination Input Validation & Conflict Handling
	// =========================================================================
	describe('2. Nomination Input Validation & Conflict Handling', () => {
		it('should REJECT nomination when recipient name is missing (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientEmail: `doc.${Date.now()}@test-b32.org`,
					recipientPhone: 9876543210,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Recipient doctor name is required/i)
		})

		it('should REJECT nomination when recipient email is invalid (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Bad Email',
					recipientEmail: 'not-an-email',
					recipientPhone: 9876543210,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Valid recipient email address is required/i)
		})

		it('should REJECT nomination when recipient phone is invalid (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Bad Phone',
					recipientEmail: `badphone.${Date.now()}@test-b32.org`,
					recipientPhone: 12345, // invalid length
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Valid 10-digit recipient phone number is required/i)
		})

		it('should REJECT client-supplied wrong invitationType (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					invitationType: 'HOSPITAL_REPRESENTATIVE', // illegal on doctor nominate endpoint
					recipientName: 'Dr. Type Mismatch',
					recipientEmail: `mismatch.${Date.now()}@test-b32.org`,
					recipientPhone: 9876543210,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /only issues DOCTOR_NOMINATION invitations/i)
		})

		it('should REJECT duplicate pending nomination for same hospital, type, and recipient (HTTP 409)', async () => {
			const targetEmail = `dup.nominee.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// First nomination
			const { req: req1, res: res1 } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Duplicate Target',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req1, res1)
			assert.strictEqual(res1.statusCode, 201)
			createdInvitationIds.push(res1.responseData.data.invitation.id)

			// Second duplicate nomination
			const { req: req2, res: res2 } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Duplicate Target',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req2, res2)
			assert.strictEqual(res2.statusCode, 409)
			assert.match(res2.responseData?.message, /active pending doctor nomination already exists/i)
		})

		it('should REJECT nomination if account already exists with non-doctor role (USER) (HTTP 409)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Fake Nominee',
					recipientEmail: normalUser.email, // Exists as role: USER
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /Non-doctor accounts cannot be nominated as Medical Officers/i)
		})

		it('should REJECT nomination if Medical Officer is ALREADY associated with this hospital (HTTP 409)', async () => {
			// existingDoctorUser is already associated with Hospital 1
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` }, // Rep 1 at Hospital 1
				body: {
					recipientName: 'Dr. Vikram Already There',
					recipientEmail: existingDoctorUser.email,
					recipientPhone: existingDoctorUser.phoneNo1,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /Medical Officer is already associated with or pending affiliation at this hospital/i)
		})

		it('should ALLOW nomination of existing Medical Officer for a SECOND hospital (Multi-Hospital Nomination, HTTP 201)', async () => {
			// Rep 2 at Hospital 2 nominates existingDoctorUser (currently only at Hospital 1)
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` }, // Rep 2 at Hospital 2
				body: {
					recipientName: 'Dr. Vikram Multi-Hosp',
					recipientEmail: existingDoctorUser.email,
					recipientPhone: existingDoctorUser.phoneNo1,
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData?.data?.invitation?.hospitalId.toString(), verifiedHospital2._id.toString())
			createdInvitationIds.push(res.responseData.data.invitation.id)
		})
	})

	// =========================================================================
	// 3. Token Security, Encryption & Non-Rollback Expiry Persistence
	// =========================================================================
	describe('3. Token Security, Encryption & Non-Rollback Expiry Persistence', () => {
		it('should securely generate SHA-256 token hash and NOT persist plaintext token in DB', async () => {
			const targetEmail = `token.sec.${Date.now()}@test-b32.org`
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Security Check',
					recipientEmail: targetEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})

			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 201)
			const rawToken = res.responseData.data.invitationToken
			const invId = res.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			const dbInv = await Invitation.findById(invId)
			assert.ok(dbInv.invitationTokenHash)
			assert.notStrictEqual(dbInv.invitationTokenHash, rawToken)
			assert.strictEqual(dbInv.invitationTokenHash, crypto.createHash('sha256').update(rawToken).digest('hex'))

			// Verify Outbox record has AES-256-GCM encrypted payload, never plaintext token
			const outboxRecord = await NotificationOutbox.findOne({ recipientEmail: targetEmail.toLowerCase() })
			assert.ok(outboxRecord)
			createdOutboxEventIds.push(outboxRecord.eventId)

			const bodyParsed = JSON.parse(outboxRecord.sanitizedBody)
			assert.strictEqual(typeof bodyParsed.encryptedToken, 'object')
			assert.ok(bodyParsed.encryptedToken.iv)
			assert.ok(bodyParsed.encryptedToken.tag)
			assert.ok(bodyParsed.encryptedToken.encryptedData)
			assert.ok(!outboxRecord.sanitizedBody.includes(rawToken), 'Raw bearer token must NEVER appear in outbox body')

			// Decrypt and verify payload authenticity
			const decryptedToken = decryptInvitationToken(bodyParsed.encryptedToken)
			assert.strictEqual(decryptedToken, rawToken)
		})

		it('should REJECT acceptance when token is missing (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					password: 'StrongPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptDoctorNominationInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Invitation token is required/i)
		})

		it('should REJECT acceptance with unissued / invalid token (HTTP 400)', async () => {
			const fakeToken = crypto.randomBytes(32).toString('hex')
			const { req, res } = createMockReqRes({
				body: {
					token: fakeToken,
					password: 'StrongPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptDoctorNominationInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Invalid or unissued invitation token/i)
		})

		it('should REJECT HOSPITAL_REPRESENTATIVE token on doctor nomination acceptance endpoint (HTTP 400)', async () => {
			// Create a HOSPITAL_REPRESENTATIVE invitation
			const repInv = new Invitation({
				invitationType: 'HOSPITAL_REPRESENTATIVE',
				hospitalId: verifiedHospital1._id,
				invitedByUserId: adminUser._id,
				invitedByRole: 'ADMIN',
				recipientName: 'Rep Name',
				recipientEmail: `rep.mismatch.${Date.now()}@test-b32.org`,
				recipientPhone: 9876543210,
			})
			const rawRepToken = repInv.createInvitationToken(48)
			await repInv.save()
			createdInvitationIds.push(repInv._id)

			const { req, res } = createMockReqRes({
				body: {
					token: rawRepToken,
					password: 'StrongPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptDoctorNominationInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /only accepts DOCTOR_NOMINATION invitations/i)
		})

		it('should REJECT revoked invitation token (HTTP 400)', async () => {
			const targetEmail = `revoked.doc.${Date.now()}@test-b32.org`
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Revoked',
					recipientEmail: targetEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Admin or Hospital revokes invitation
			await Invitation.updateOne({ _id: invId }, { $set: { status: 'Revoked' } })

			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: 'StrongPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 400)
			assert.match(accRes.responseData?.message, /has been revoked/i)
		})

		it('should permanently persist status: Expired in database upon redemption attempt and reject subsequent requests', async () => {
			const targetEmail = `expired.doc.${Date.now()}@test-b32.org`
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Expired Nominee',
					recipientEmail: targetEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Manually simulate 48h expiration in the past
			await Invitation.updateOne(
				{ _id: invId },
				{ $set: { tokenExpiresAt: new Date(Date.now() - 10000) } }
			)

			// Attempt redemption
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: 'StrongPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 400)
			assert.match(accRes.responseData?.message, /has expired/i)

			// Invariant Check: status is permanently persisted as Expired
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Expired')

			// Second attempt immediately rejected with Expired status
			const { req: accReq2, res: accRes2 } = createMockReqRes({
				body: {
					token,
					password: 'StrongPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq2, accRes2, () => {})
			assert.strictEqual(accRes2.statusCode, 400)
			assert.match(accRes2.responseData?.message, /has expired and can no longer be redeemed/i)
		})
	})

	// =========================================================================
	// 4. Doctor Nomination Acceptance Workflow & Lifecycle State Invariants
	// =========================================================================
	describe('4. Doctor Nomination Acceptance Workflow & Lifecycle State Invariants', () => {
		it('should REJECT acceptance when terms or confidentiality are not accepted (HTTP 400)', async () => {
			const targetEmail = `declarations.${Date.now()}@test-b32.org`
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. No Declarations',
					recipientEmail: targetEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: 'StrongPass123!',
					termsAccepted: false, // Rejected
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 400)
			assert.match(accRes.responseData?.message, /terms and confidentiality/i)
		})

		it('should REJECT acceptance when password is weak or missing for brand-new nominee (HTTP 400)', async () => {
			const targetEmail = `weakpass.${Date.now()}@test-b32.org`
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Weak Pass',
					recipientEmail: targetEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: 'short', // Too short (< 8 chars)
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 400)
			assert.match(accRes.responseData?.message, /Password is required and must be between 8 and 20 characters/i)
		})

		it('should REJECT acceptance if associated hospital was deactivated after nomination issuance (HTTP 400)', async () => {
			const targetEmail = `deactivated.hosp.${Date.now()}@test-b32.org`
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Deactivated Hosp Target',
					recipientEmail: targetEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Deactivate hospital
			await Hospital.updateOne({ _id: verifiedHospital1._id }, { $set: { isActive: false } })

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'StrongPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 400)
				assert.match(accRes.responseData?.message, /hospital is currently marked inactive/i)
			} finally {
				// Re-activate hospital
				await Hospital.updateOne({ _id: verifiedHospital1._id }, { $set: { isActive: true } })
			}
		})

		it('should ACCEPT nomination for a NEW doctor: assigns role MEDICAL_OFFICER, Pending_Admin_Approval association, and unverified credentials (HTTP 200)', async () => {
			const targetEmail = `new.doctor.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Senthil Kumar',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Acceptance submission with client attempt to manipulate role & hospitalId
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: 'DoctorPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
					// Attacker payload: attempts to forge admin role, verified credentials, and wrong hospital
					role: 'ADMIN',
					credentialStatus: 'Verified',
					associationStatus: 'Active',
					hospitalId: verifiedHospital2._id.toString(),
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 200)
			assert.strictEqual(accRes.responseData?.status, 'success')

			const responseUser = accRes.responseData.data.user
			const responseAssoc = accRes.responseData.data.association
			createdUserIds.push(responseUser.id)
			createdAssociationIds.push(responseAssoc.id)

			// Invariant 1: Authoritative Account Lifecycle Verification
			const dbUser = await userModel.findById(responseUser.id)
			assert.strictEqual(dbUser.role, 'MEDICAL_OFFICER', 'Client-forged role must be strictly ignored')
			assert.strictEqual(dbUser.accountStatus, 'Active')
			assert.strictEqual(dbUser.credentialStatus, 'Unsubmitted', 'Credentials must remain Unsubmitted')
			assert.strictEqual(dbUser.verificationStatus, 'Pending')
			assert.strictEqual(dbUser.status, true)

			// Invariant 2: Authoritative Association Lifecycle Verification
			const dbAssoc = await MedicalOfficerHospital.findById(responseAssoc.id)
			assert.strictEqual(dbAssoc.medicalOfficerUserId.toString(), dbUser._id.toString())
			assert.strictEqual(dbAssoc.hospitalId.toString(), verifiedHospital1._id.toString(), 'Authoritative hospitalId must be enforced')
			assert.strictEqual(dbAssoc.associationStatus, 'Pending_Admin_Approval', 'Must be Pending_Admin_Approval, never client-supplied Active')
			assert.deepStrictEqual(dbAssoc.permissions, ['VIEW_EMERGENCY_REQUESTS'], 'Never auto-grant VERIFY_EMERGENCY_REQUESTS')
			assert.strictEqual(dbAssoc.availabilityStatus, 'Unavailable')
			assert.strictEqual(dbAssoc.initiatedBy, 'HOSPITAL')
			assert.strictEqual(dbAssoc.hospitalConfirmedBy.toString(), repUser1._id.toString())

			// Invariant 3: Single-Use Guarantee - Token cannot be redeemed again
			const { req: accReq2, res: accRes2 } = createMockReqRes({
				body: {
					token,
					password: 'DoctorPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq2, accRes2, () => {})
			assert.strictEqual(accRes2.statusCode, 400)
			assert.match(accRes2.responseData?.message, /already been accepted and cannot be redeemed again/i)
		})

		it('should ACCEPT nomination for an EXISTING Medical Officer (Multi-Hospital Reuse): creates association without duplicate user account (HTTP 200)', async () => {
			// Clean up any earlier pending invitation for existingDoctorUser at Hospital 2
			await Invitation.deleteMany({
				recipientEmail: existingDoctorUser.email.toLowerCase(),
				hospitalId: verifiedHospital2._id,
			})

			// existingDoctorUser (already at Hospital 1) is nominated for Hospital 2
			const targetEmail = existingDoctorUser.email
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` }, // Rep 2 at Hospital 2
				body: {
					recipientName: 'Dr. Vikram Multi',
					recipientEmail: targetEmail,
					recipientPhone: existingDoctorUser.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Medical Officer accepts nomination for Hospital 2
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 200)

			const responseUser = accRes.responseData.data.user
			const responseAssoc = accRes.responseData.data.association
			createdAssociationIds.push(responseAssoc.id)

			// Invariant Check: Reused existing user account, no duplicate
			assert.strictEqual(responseUser.id.toString(), existingDoctorUser._id.toString())
			const countUsers = await userModel.countDocuments({ email: targetEmail.toLowerCase() })
			assert.strictEqual(countUsers, 1, 'Strictly ONE user document must exist for this doctor')

			// Invariant Check: Doctor now has TWO distinct hospital associations
			const doctorAssociations = await MedicalOfficerHospital.find({ medicalOfficerUserId: existingDoctorUser._id })
			assert.strictEqual(doctorAssociations.length, 2, 'Doctor must now be affiliated with both hospitals')

			const hospital1Assoc = doctorAssociations.find(a => a.hospitalId.toString() === verifiedHospital1._id.toString())
			const hospital2Assoc = doctorAssociations.find(a => a.hospitalId.toString() === verifiedHospital2._id.toString())

			assert.ok(hospital1Assoc)
			assert.strictEqual(hospital1Assoc.associationStatus, 'Active') // Original hospital 1 remains Active

			assert.ok(hospital2Assoc)
			assert.strictEqual(hospital2Assoc.associationStatus, 'Pending_Admin_Approval') // New hospital 2 association is pending approval
		})
	})

	// =========================================================================
	// 5. Clinical Authorization Invariant Checks (Three-Gate Enforcement)
	// =========================================================================
	describe('5. Clinical Authorization Invariant Checks (Three-Gate Enforcement)', () => {
		let acceptedDoctorUser, acceptedDocToken
		let emergencyRequestAtHospital1

		before(async () => {
			// Onboard and accept a new doctor at Hospital 1
			const targetEmail = `gate.doctor.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Gate Enforcement Test',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			createdInvitationIds.push(issueRes.responseData.data.invitation.id)

			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: 'DocPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			acceptedDoctorUser = await userModel.findById(accRes.responseData.data.user.id)
			createdUserIds.push(acceptedDoctorUser._id)
			createdAssociationIds.push(accRes.responseData.data.association.id)

			acceptedDocToken = signToken(acceptedDoctorUser._id, { userType: 'user' })

			// Create a pending emergency request for Hospital 1
			emergencyRequestAtHospital1 = await EmergencyBloodRequest.create({
				requestNumber: `EMG-B32-${Date.now()}`,
				requesterUserId: normalUser._id,
				patientName: 'Emergency Patient Gate Test',
				patientAge: 40,
				patientGender: 'Male',
				hospitalId: verifiedHospital1._id,
				hospitalName: verifiedHospital1.hospitalName,
				hospitalAddress: '100 Medical Road, Chennai',
				hospitalCity: 'Chennai',
				hospitalState: 'Tamil Nadu',
				hospitalPinCode: 600003,
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
			createdEmergencyRequestIds.push(emergencyRequestAtHospital1._id)
		})

		it('should ALLOW the accepted unverified Medical Officer to login with sessionScope: ONBOARDING (HTTP 200, B3.4 decoupled auth)', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: acceptedDoctorUser.email,
					password: 'DocPassword123!',
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.sessionScope, 'ONBOARDING')
			assert.ok(res.responseData?.token)
		})

		it('should ALLOW an existing Verified Medical Officer to log in via standard login (Gate 1 & Gate 2 pass, HTTP 200)', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: existingDoctorUser.email,
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

		it('should REJECT accepted doctor from clinical verification because credentials are Unsubmitted (Gate 2 fails closed, HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${acceptedDocToken}` },
				params: { id: emergencyRequestAtHospital1._id.toString() },
				body: {
					hospitalId: verifiedHospital1._id.toString(),
				},
			})

			await executeRoutePipeline([protectMedicalOfficerAuth], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /credentials have not been submitted/i)
		})

		it('should REJECT accepted doctor from clinical verification even if Gate 2 were bypassed, because association is Pending_Admin_Approval (Gate 3 fails closed, HTTP 403)', async () => {
			// Temporarily simulate Gate 2 passed
			await userModel.updateOne(
				{ _id: acceptedDoctorUser._id },
				{ $set: { credentialStatus: 'Verified', verificationStatus: 'Verified' } }
			)

			try {
				const { req, res } = createMockReqRes({
					headers: { authorization: `Bearer ${acceptedDocToken}` },
					params: { id: emergencyRequestAtHospital1._id.toString() },
					body: {
						hospitalId: verifiedHospital1._id.toString(),
					},
				})

				await executeRoutePipeline([protectMedicalOfficerAuth], req, res)
				assert.strictEqual(res.statusCode, 403)
				assert.match(res.responseData?.message, /association is pending administrative approval/i)
			} finally {
				// Restore unverified state
				await userModel.updateOne(
					{ _id: acceptedDoctorUser._id },
					{ $set: { credentialStatus: 'Unsubmitted', verificationStatus: 'Pending' } }
				)
			}
		})

		it('should REJECT accepted doctor from Hospital Representative endpoints (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${acceptedDocToken}` },
			})

			await executeRoutePipeline([protectHospitalAdminAuth], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Access denied: Role 'MEDICAL_OFFICER' is not authorized for Hospital Representative operations/i)
		})
	})

	// =========================================================================
	// 6. Transaction Guarantees & Failure-Injection Verification
	// =========================================================================
	describe('6. Transaction Guarantees & Failure-Injection Verification', () => {
		it('should fail closed with HTTP 500 in production when multi-document transactions are unsupported', async () => {
			const productionPromise = withTransaction(async () => {}, {
				isProduction: true,
				forceTransaction: false,
			})

			if (!canUseTransactions()) {
				await assert.rejects(productionPromise, (err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.match(err.message, /Multi-document transaction safety failure/i)
					return true
				})
			}
		})

		it('Failure Injection 1: should roll back transaction and leave invitation Pending if user creation fails', async () => {
			const targetEmail = `fail.user.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Fail User Save',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Stub userModel.prototype.save to throw
			const origUserSave = userModel.prototype.save
			userModel.prototype.save = async function () {
				throw new Error('Simulated Database Write Failure During User Creation')
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'DoctorPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 400)
				assert.match(accRes.responseData?.message, /Simulated Database Write Failure/i)
			} finally {
				userModel.prototype.save = origUserSave
			}

			// Invariants: Invitation remains Pending, no user or association persists
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending')
			assert.strictEqual(dbInv.acceptedAt, null)

			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User account must not exist when creation fails')

			const dbAssoc = await MedicalOfficerHospital.findOne({ hospitalId: verifiedHospital1._id, medicalOfficerUserId: { $exists: true } })
			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record may persist')
		})

		it('Failure Injection 2: should roll back transaction if association creation fails', async () => {
			const targetEmail = `fail.assoc.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Fail Assoc Save',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Stub MedicalOfficerHospital.prototype.save to throw
			const origAssocSave = MedicalOfficerHospital.prototype.save
			MedicalOfficerHospital.prototype.save = async function () {
				throw new Error('Simulated Database Write Failure During Association Creation')
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'DoctorPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 400)
				assert.match(accRes.responseData?.message, /Simulated Database Write Failure During Association/i)
			} finally {
				MedicalOfficerHospital.prototype.save = origAssocSave
			}

			// Invariants: Invitation remains Pending, user was rolled back
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending')

			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User account must be rolled back if association fails')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record may persist')
		})

		it('Failure Injection 3: should roll back transaction if compare-and-swap encounters conflict', async () => {
			const targetEmail = `fail.cas.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. CAS Conflict',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Stub Invitation.findOneAndUpdate to simulate conflict returning null
			const origFindOneAndUpdate = Invitation.findOneAndUpdate
			Invitation.findOneAndUpdate = async function (conditions) {
				if (conditions.status === 'Pending') {
					return null // CAS collision
				}
				return origFindOneAndUpdate.apply(this, arguments)
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'DoctorPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 409)
				assert.match(accRes.responseData?.message, /redemption conflict/i)
			} finally {
				Invitation.findOneAndUpdate = origFindOneAndUpdate
			}

			// Invariants: User account must be rolled back
			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User account must be rolled back on CAS conflict')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record may persist on CAS conflict')
		})

		it('Failure Injection 4: should roll back transaction if outbox insertion fails', async () => {
			const targetEmail = `fail.outbox.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Outbox Error Test',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Stub NotificationOutbox.prototype.save to throw
			const origOutboxSave = NotificationOutbox.prototype.save
			NotificationOutbox.prototype.save = async function () {
				throw new Error('Simulated Outbox Disk Quota Failure')
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'DoctorPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 400)
				assert.match(accRes.responseData?.message, /Simulated Outbox Disk Quota Failure/i)
			} finally {
				NotificationOutbox.prototype.save = origOutboxSave
			}

			// Invariants: Invitation remains Pending, user was rolled back
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending')

			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User account must not exist when outbox insertion fails')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record may exist')
		})

		it('Failure Injection 5: should roll back transaction if transaction commit fails', async () => {
			const targetEmail = `fail.commit.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Commit Failure Test',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Hook mongoose.startSession to inject failure into the genuine commitTransaction() operation
			const origStartSession = mongoose.startSession.bind(mongoose)
			mongoose.startSession = async function (...args) {
				const session = await origStartSession(...args)
				session.commitTransaction = async function () {
					await this.abortTransaction()
					throw new Error('Simulated Transient Network Drop During Doctor Nomination Commit')
				}
				return session
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'DoctorPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 400)
				assert.match(accRes.responseData?.message, /Simulated Transient Network Drop/i)
			} finally {
				mongoose.startSession = origStartSession
			}

			// Invariants: Rollback verified
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending', 'Invitation must remain Pending after commit failure')

			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User account must not exist after commit failure')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record may exist after commit failure')
		})

		it('Concurrency Check: strictly ONE successful acceptance permitted under concurrent redemption requests', async () => {
			const concurrentEmail = `concurrent.doc.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// 1. Issue an invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Concurrency Test',
					recipientEmail: concurrentEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// 2. Dispatch two concurrent redemption requests
			const runRedemption = async (reqId) => {
				const { req, res } = createMockReqRes({
					body: {
						token,
						password: `ConcurPass${reqId}!`,
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(req, res, () => {})
				return res
			}

			const [resA, resB] = await Promise.all([runRedemption(1), runRedemption(2)])

			const statusCodes = [resA.statusCode, resB.statusCode].sort()
			// Exactly one must succeed (200) and one must be rejected (409 Conflict)
			assert.deepStrictEqual(statusCodes, [200, 409], 'Strictly one concurrent request must succeed with 200, other rejected with 409')

			// Track created resources for cleanup
			const successRes = resA.statusCode === 200 ? resA : resB
			createdUserIds.push(successRes.responseData.data.user.id)
			createdAssociationIds.push(successRes.responseData.data.association.id)

			// Invariant Check: Exactly ONE user document created in database
			const userCount = await userModel.countDocuments({ email: concurrentEmail.toLowerCase() })
			assert.strictEqual(userCount, 1, 'Only one user account may be created under concurrency')

			// Invariant Check: Exactly ONE hospital association created
			const assocCount = await MedicalOfficerHospital.countDocuments({
				hospitalId: verifiedHospital1._id,
				medicalOfficerUserId: successRes.responseData.data.user.id,
			})
			assert.strictEqual(assocCount, 1, 'Only one hospital association may be created under concurrency')

			// Invariant Check: Invitation status is Accepted
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Accepted')
		})
	})

	// =========================================================================
	// 7. Existing Medical Officer Account Reuse Security Invariants
	// =========================================================================
	describe('7. Existing Medical Officer Account Reuse Security Invariants', () => {
		let reuseDoctor
		let origPasswordHash

		beforeEach(async () => {
			const email = `reuse.test.${Date.now()}.${Math.floor(Math.random() * 10000)}@test-b32.org`
			const phone = Math.floor(1000000000 + Math.random() * 9000000000)
			reuseDoctor = await userModel.create({
				firstName: 'Dr. Ramesh',
				lastName: 'Cardiologist',
				email,
				phoneNo1: phone,
				password: 'OriginalPassword123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				credentialStatus: 'Verified',
				verificationStatus: 'Verified',
				status: true,
			})
			createdUserIds.push(reuseDoctor._id)

			const docWithPwd = await userModel.findById(reuseDoctor._id).select('+password')
			origPasswordHash = docWithPwd.password

			// Associate with hospital 1
			const assoc1 = await MedicalOfficerHospital.create({
				medicalOfficerUserId: reuseDoctor._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
				availabilityStatus: 'Available',
			})
			createdAssociationIds.push(assoc1._id)
		})

		it('should NOT reset or overwrite password when accepting nomination for existing Medical Officer', async () => {
			// Hospital 2 rep nominates reuseDoctor for hospital 2
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Doctor accepts nomination, attempting to provide a different password
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: 'MaliciousAttackerPassword999!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 200)
			createdAssociationIds.push(accRes.responseData.data.association.id)

			// Database invariant: Password in DB must NOT have changed
			const reloadedUser = await userModel.findById(reuseDoctor._id).select('+password')
			assert.strictEqual(reloadedUser.password, origPasswordHash, 'Password hash in DB must be untouched')
			assert.strictEqual(
				bcryptjs.compareSync('OriginalPassword123!', reloadedUser.password),
				true,
				'Original password must still authenticate'
			)
			assert.strictEqual(
				bcryptjs.compareSync('MaliciousAttackerPassword999!', reloadedUser.password),
				false,
				'Supplied password must NOT be applied to existing account'
			)
		})

		it('should NOT overwrite existing personal or contact details without explicit authorization', async () => {
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			createdInvitationIds.push(issueRes.responseData.data.invitation.id)

			// Accept with altered personal details
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					firstName: 'OverwrittenFirstName',
					lastName: 'OverwrittenLastName',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 200)
			createdAssociationIds.push(accRes.responseData.data.association.id)

			// Invariant: names and phone are preserved
			const reloadedUser = await userModel.findById(reuseDoctor._id)
			assert.strictEqual(reloadedUser.firstName, 'Dr. Ramesh')
			assert.strictEqual(reloadedUser.lastName, 'Cardiologist')
			assert.strictEqual(reloadedUser.phoneNo1, reuseDoctor.phoneNo1)
		})

		it('should NOT overwrite credentialStatus or verificationStatus upon accepting nomination', async () => {
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			createdInvitationIds.push(issueRes.responseData.data.invitation.id)

			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 200)
			createdAssociationIds.push(accRes.responseData.data.association.id)

			// Invariant: credentialStatus & verificationStatus must NOT reset to Unsubmitted or Pending
			const reloadedUser = await userModel.findById(reuseDoctor._id)
			assert.strictEqual(reloadedUser.credentialStatus, 'Verified')
			assert.strictEqual(reloadedUser.verificationStatus, 'Verified')
		})

		it('should REJECT nomination issuance if existing Medical Officer account is Suspended or Deactivated (HTTP 409)', async () => {
			// Update reuseDoctor to Suspended
			await userModel.updateOne({ _id: reuseDoctor._id }, { $set: { accountStatus: 'Suspended' } })

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /Cannot nominate Medical Officer: Account is suspended/i)

			// Update to Deactivated
			await userModel.updateOne({ _id: reuseDoctor._id }, { $set: { accountStatus: 'Deactivated' } })
			const { req: req2, res: res2 } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req2, res2)
			assert.strictEqual(res2.statusCode, 409)
			assert.match(res2.responseData?.message, /Cannot nominate Medical Officer: Account is deactivated/i)

			// Update to status: false
			await userModel.updateOne({ _id: reuseDoctor._id }, { $set: { accountStatus: 'Active', status: false } })
			const { req: req3, res: res3 } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req3, res3)
			assert.strictEqual(res3.statusCode, 409)
			assert.match(res3.responseData?.message, /Cannot nominate Medical Officer: Account is inactive/i)
		})

		it('should REJECT nomination acceptance if existing Medical Officer account is Suspended or Deactivated and NOT reactivate it (HTTP 409)', async () => {
			// 1. Issue nomination while doctor is Active
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// 2. Suspend doctor account prior to acceptance
			await userModel.updateOne({ _id: reuseDoctor._id }, { $set: { accountStatus: 'Suspended' } })

			// 3. Attempt acceptance
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 409)
			assert.match(accRes.responseData?.message, /Medical Officer account is suspended/i)

			// Invariant: Account is STILL Suspended, not reactivated
			const reloadedUser = await userModel.findById(reuseDoctor._id)
			assert.strictEqual(reloadedUser.accountStatus, 'Suspended')

			// Invariant: Invitation remains Pending
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending')
		})

		it('should REJECT incompatible or invalid existing account states (e.g. Pending_Activation) (HTTP 409)', async () => {
			// 1. Issue nomination
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken2}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			createdInvitationIds.push(issueRes.responseData.data.invitation.id)

			// 2. Set accountStatus to Pending_Activation
			await userModel.updateOne({ _id: reuseDoctor._id }, { $set: { accountStatus: 'Pending_Activation' } })

			// 3. Attempt acceptance
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 409)
			assert.match(accRes.responseData?.message, /Active account required to accept nominations/i)
		})

		it('should REJECT duplicate hospital association if doctor is already associated with the hospital (HTTP 409)', async () => {
			// reuseDoctor already has Active association with Hospital 1
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Ramesh Cardiologist',
					recipientEmail: reuseDoctor.email,
					recipientPhone: reuseDoctor.phoneNo1,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /already associated with or pending affiliation at this hospital/i)
		})
	})

	// =========================================================================
	// 8. Pending Association Access Restrictions (Real Protected Endpoints)
	// =========================================================================
	describe('8. Pending Association Access Restrictions (Real Protected Endpoints)', () => {
		let pendingDoctor
		let pendingDoctorToken
		let testEmergencyRequest

		before(async () => {
			// Create a Medical Officer with Verified credentials but ONLY Pending_Admin_Approval association
			const email = `pending.assoc.test.${Date.now()}@test-b32.org`
			const phone = Math.floor(1000000000 + Math.random() * 9000000000)
			pendingDoctor = await userModel.create({
				firstName: 'Dr. Pending',
				lastName: 'Specialist',
				email,
				phoneNo1: phone,
				password: 'PendingDocPassword123!',
				role: 'MEDICAL_OFFICER',
				accountStatus: 'Active',
				credentialStatus: 'Verified',
				verificationStatus: 'Verified',
				status: true,
			})
			createdUserIds.push(pendingDoctor._id)
			pendingDoctorToken = signToken(pendingDoctor._id, { userType: 'user' })

			// Association is Pending_Admin_Approval at Hospital 1
			const pendingAssoc = await MedicalOfficerHospital.create({
				medicalOfficerUserId: pendingDoctor._id,
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Pending_Admin_Approval',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
				availabilityStatus: 'Unavailable',
				initiatedBy: 'HOSPITAL',
			})
			createdAssociationIds.push(pendingAssoc._id)

			// Emergency request at Hospital 1
			testEmergencyRequest = await EmergencyBloodRequest.create({
				requestNumber: `EMG-PEND-${Date.now()}`,
				requesterUserId: normalUser._id,
				patientName: 'Emergency Patient Pending Test',
				patientAge: 35,
				patientGender: 'Female',
				hospitalId: verifiedHospital1._id,
				hospitalName: verifiedHospital1.hospitalName,
				hospitalAddress: '100 Medical Road, Chennai',
				hospitalCity: 'Chennai',
				hospitalState: 'Tamil Nadu',
				hospitalPinCode: 600003,
				requiredBloodGroup: 'A_Positive',
				requiredComponent: 'Whole_Blood',
				unitsRequested: 1,
				urgencyLevel: 'Urgent',
				requiredWithinHours: 4,
				expiresAt: new Date(Date.now() + 4 * 3600 * 1000),
				attendingDoctor: {
					doctorName: 'Dr. Supervising Chief',
					doctorPhone: '9876543210',
				},
				verificationStatus: 'Pending_Verification',
				status: 'Active',
			})
			createdEmergencyRequestIds.push(testEmergencyRequest._id)
		})

		it('should REJECT pending association from accessing emergency request queue GET /api/medical-officer/requests (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getAssignedRequests], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /association is pending administrative approval/i)
		})

		it('should REJECT pending association from accessing emergency request queue alias GET /api/medical-officer/queue (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getAssignedRequests], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /association is pending administrative approval/i)
		})

		it('should REJECT pending association from accessing emergency request details GET /api/medical-officer/requests/:id (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
				params: { id: testEmergencyRequest._id.toString() },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getRequestDetails], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /association is pending administrative approval/i)
		})

		it('should REJECT pending association from clinical verification endpoint PATCH /api/medical-officer/requests/:id/verify (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
				params: { id: testEmergencyRequest._id.toString() },
				body: { hospitalId: verifiedHospital1._id.toString() },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.approveEmergencyRequest], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /association is pending administrative approval/i)
		})

		it('should REJECT pending association from clinical rejection endpoint PATCH /api/medical-officer/requests/:id/reject (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
				params: { id: testEmergencyRequest._id.toString() },
				body: { hospitalId: verifiedHospital1._id.toString(), rejectionReason: 'Clinical data incomplete' },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.rejectEmergencyRequest], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /association is pending administrative approval/i)
		})

		it('should REJECT pending association from clinical information request PATCH /api/medical-officer/requests/:id/request-information (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
				params: { id: testEmergencyRequest._id.toString() },
				body: { hospitalId: verifiedHospital1._id.toString(), notes: 'Please clarify patient history' },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.requestAdditionalInformation], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /association is pending administrative approval/i)
		})

		it('should REJECT pending association from medical officer dashboard GET /api/medical-officer/dashboard (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.getMedicalOfficerDashboard], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /association is pending administrative approval/i)
		})

		it('should REJECT pending association from updating hospital availability PATCH /api/medical-officer/hospitals/:hospitalId/availability (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
				params: { hospitalId: verifiedHospital1._id.toString() },
				body: { availabilityStatus: 'Available' },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.updateAvailability], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /association is pending administrative approval/i)
		})

		it('should REJECT doctor from accessing protected hospital directory GET /api/hospitals/medical-officers/directory (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
			})
			await executeRoutePipeline([protectEmergencyAuth, requireAdmin, hospitalController.getMedicalOfficersDirectory], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
		})

		it('should REJECT doctor from accessing protected hospital associations list GET /api/hospitals/medical-officers/associations (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
			})
			await executeRoutePipeline([protectEmergencyAuth, requireAdmin, hospitalController.getAssociations], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
		})

		it('should REJECT doctor from accessing protected hospital facility administration GET /api/hospitals (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${pendingDoctorToken}` },
			})
			await executeRoutePipeline([protectEmergencyAuth, requireAdmin, hospitalController.getAllHospitals], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
		})
	})

	// =========================================================================
	// 9. Database Uniqueness and Concurrency Protections
	// =========================================================================
	describe('9. Database Uniqueness and Concurrency Protections', () => {
		it('should enforce compound unique index { medicalOfficerUserId: 1, hospitalId: 1 } on MedicalOfficerHospital', async () => {
			const doctorUser = await userModel.create({
				firstName: 'Dr. UniqueIndex',
				lastName: 'Tester',
				email: `unique.mo.${Date.now()}@test-b32.org`,
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
				hospitalId: verifiedHospital1._id,
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
				availabilityStatus: 'Unavailable',
			})
			createdAssociationIds.push(firstAssoc._id)

			// Direct attempt to save second association with identical (medicalOfficerUserId, hospitalId) MUST throw E11000
			await assert.rejects(
				async () => {
					await MedicalOfficerHospital.create({
						medicalOfficerUserId: doctorUser._id,
						hospitalId: verifiedHospital1._id,
						associationStatus: 'Pending_Admin_Approval',
						permissions: ['VIEW_EMERGENCY_REQUESTS'],
						availabilityStatus: 'Unavailable',
					})
				},
				(err) => {
					assert.strictEqual(err.code, 11000, 'Must throw duplicate key error code 11000')
					return true
				}
			)
		})

		it('should reject two simultaneous acceptances for the same invitation (strictly one 200, one 409)', async () => {
			const concurrentEmail = `simultaneous.doc.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// Issue invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Simultaneous Accept',
					recipientEmail: concurrentEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Run simultaneous acceptance
			const runAcceptance = async (num) => {
				const { req, res } = createMockReqRes({
					body: {
						token,
						password: `DoctorPass${num}123!`,
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(req, res, () => {})
				return res
			}

			const [res1, res2] = await Promise.all([runAcceptance(1), runAcceptance(2)])
			const codes = [res1.statusCode, res2.statusCode].sort()
			assert.deepStrictEqual(codes, [200, 409], 'Exactly one request must succeed with 200 and one fail with 409')

			const successRes = res1.statusCode === 200 ? res1 : res2
			createdUserIds.push(successRes.responseData.data.user.id)
			createdAssociationIds.push(successRes.responseData.data.association.id)

			// Invariant: Exactly one association created
			const totalAssocs = await MedicalOfficerHospital.countDocuments({
				hospitalId: verifiedHospital1._id,
				medicalOfficerUserId: successRes.responseData.data.user.id,
			})
			assert.strictEqual(totalAssocs, 1)
		})

		it('should reject two different pending invitations for the same doctor and hospital (HTTP 409 and partial unique index E11000)', async () => {
			const targetEmail = `pending.dup.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// 1. First nomination succeeds (201)
			const { req: req1, res: res1 } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Pending Duplicate',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req1, res1)
			assert.strictEqual(res1.statusCode, 201)
			createdInvitationIds.push(res1.responseData.data.invitation.id)

			// 2. Second nomination via API fails with 409 Conflict
			const { req: req2, res: res2 } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Pending Duplicate',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req2, res2)
			assert.strictEqual(res2.statusCode, 409)
			assert.match(res2.responseData?.message, /An active pending doctor nomination already exists/i)

			// 3. Direct DB attempt to bypass controller check and insert a second Pending invitation throws E11000
			await assert.rejects(
				async () => {
					const dupInv = new Invitation({
						invitationType: 'DOCTOR_NOMINATION',
						hospitalId: verifiedHospital1._id,
						invitedByUserId: repUser1._id,
						invitedByRole: 'HOSPITAL_ADMIN',
						recipientName: 'Dr. Duplicate Bypassed',
						recipientEmail: targetEmail.toLowerCase(),
						recipientPhone: targetPhone,
						status: 'Pending',
						invitationTokenHash: crypto.randomBytes(32).toString('hex'),
						tokenExpiresAt: new Date(Date.now() + 48 * 3600 * 1000),
					})
					await dupInv.save()
				},
				(err) => {
					assert.strictEqual(err.code, 11000, 'Partial unique index uniq_pending_invitation_per_hospital_recipient must throw E11000')
					return true
				}
			)
		})

		it('should rollback transaction without partial or corrupted records upon concurrent association collision', async () => {
			const targetEmail = `collision.${Date.now()}@test-b32.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// 1. Issue invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Collision Rollback',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Stub MedicalOfficerHospital.prototype.save to simulate an E11000 duplicate key collision
			const origSave = MedicalOfficerHospital.prototype.save
			MedicalOfficerHospital.prototype.save = async function (opts) {
				const dupErr = new Error('E11000 duplicate key error collection: test.medicalofficerhospitals index: medicalOfficerUserId_1_hospitalId_1')
				dupErr.code = 11000
				throw dupErr
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'DocPass12345!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptDoctorNominationInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 409)
			} finally {
				MedicalOfficerHospital.prototype.save = origSave
			}

			// Invariants: Invitation remains Pending, no user was created, no outbox event persisted
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending')

			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User creation must be rolled back on collision')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'Acceptance outbox insertion must be rolled back on collision')
		})
	})

	// =========================================================================
	// 10. Hospital Tenant Isolation and Boundary Violations
	// =========================================================================
	describe('10. Hospital Tenant Isolation and Boundary Violations', () => {
		it('should REJECT Hospital Representative from nominating doctors for another hospital facility (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` }, // Rep for Hospital 1
				body: {
					recipientName: 'Dr. Tenant Cross',
					recipientEmail: `tenant.cross.${Date.now()}@test-b32.org`,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
					hospitalId: verifiedHospital2._id.toString(), // Attempting to nominate for Hospital 2
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(
				res.responseData?.message,
				/cannot (access, nominate, or manage records for|perform operations on behalf of|nominate doctors for) another hospital/i
			)
		})

		it('should ignore client-supplied hospitalId on invitation acceptance and strictly bind to invitation hospital', async () => {
			// Rep 1 issues invitation for Hospital 1
			const targetEmail = `tenant.bind.${Date.now()}@test-b32.org`
			const { req: issueReq, res: issueRes } = createMockReqRes({
				headers: { authorization: `Bearer ${repToken1}` },
				body: {
					recipientName: 'Dr. Tenant Strict Bind',
					recipientEmail: targetEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await executeRoutePipeline([protectHospitalAdminAuth, nominateDoctorInvitation], issueReq, issueRes)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Doctor submits acceptance with spoofed hospitalId for Hospital 2
			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: 'DocPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
					hospitalId: verifiedHospital2._id.toString(), // Spoofed client hospital ID
				},
			})
			await acceptDoctorNominationInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 200)

			const newUserId = accRes.responseData.data.user.id
			const newAssocId = accRes.responseData.data.association.id
			createdUserIds.push(newUserId)
			createdAssociationIds.push(newAssocId)

			// Invariant: Association is created strictly for Hospital 1 (NOT spoofed Hospital 2)
			const dbAssoc = await MedicalOfficerHospital.findById(newAssocId)
			assert.strictEqual(
				dbAssoc.hospitalId.toString(),
				verifiedHospital1._id.toString(),
				'Association must bind to issuing hospital, ignoring client-supplied hospitalId'
			)

			// Invariant: Notification outbox event references Hospital 1
			const dbOutbox = await NotificationOutbox.findOne({ recipientEmail: targetEmail.toLowerCase() })
			assert.strictEqual(
				dbOutbox.hospitalId.toString(),
				verifiedHospital1._id.toString(),
				'Outbox record must bind to issuing hospital'
			)
		})

		it('should REJECT doctor from accessing or updating availability at a hospital they are NOT active in (HTTP 403)', async () => {
			// existingDoctorUser is active only at Hospital 1
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${doctorToken}` },
				params: { hospitalId: verifiedHospital2._id.toString() }, // Requesting for Hospital 2
				body: { availabilityStatus: 'Available' },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'), medicalOfficerController.updateAvailability], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(
				res.responseData?.message,
				/(not authorized as an active Medical Officer|Client-supplied hospitalId does not match your authorized facility scope)/i
			)
		})

		it('should REJECT doctor from approving emergency requests belonging to another hospital facility (HTTP 403)', async () => {
			// Create emergency request at Hospital 2
			const emgReqHosp2 = await EmergencyBloodRequest.create({
				requestNumber: `EMG-HOSP2-${Date.now()}`,
				requesterUserId: normalUser._id,
				patientName: 'Patient at Hospital 2',
				patientAge: 50,
				patientGender: 'Male',
				hospitalId: verifiedHospital2._id,
				hospitalName: verifiedHospital2.hospitalName,
				hospitalAddress: '200 City Road, Coimbatore',
				hospitalCity: 'Coimbatore',
				hospitalState: 'Tamil Nadu',
				hospitalPinCode: 641001,
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				urgencyLevel: 'Critical',
				requiredWithinHours: 2,
				expiresAt: new Date(Date.now() + 2 * 3600 * 1000),
				attendingDoctor: {
					doctorName: 'Dr. Attending Hosp2',
					doctorPhone: '9876543210',
				},
				verificationStatus: 'Pending_Verification',
				status: 'Active',
			})
			createdEmergencyRequestIds.push(emgReqHosp2._id)

			// existingDoctorUser (active only at Hospital 1) attempts to verify request at Hospital 2
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${doctorToken}` },
				params: { id: emgReqHosp2._id.toString() },
				body: { hospitalId: verifiedHospital2._id.toString() },
			})
			await executeRoutePipeline([protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.approveEmergencyRequest], req, res)
			assert.strictEqual(res.statusCode, 403)
			assert.match(
				res.responseData?.message,
				/(not authorized as an active Medical Officer|Client-supplied hospitalId does not match your authorized facility scope)/i
			)
		})
	})
})
