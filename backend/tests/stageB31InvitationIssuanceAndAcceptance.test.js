/**
 * Stage B3.1 Integration Test Suite: Hospital Representative Invitation Issuance & Acceptance
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Phase 4.3.5)
 *
 * Comprehensive verification of:
 * 1. Authenticated token encryption (AES-256-GCM, fail-closed, tamper resistance)
 * 2. Route Authorization for both issuance endpoints (/api/admin/hospital-invitations & /api/invitations/hospital-representative)
 *    Enforcing denial for unauthenticated, USER, MEDICAL_OFFICER, HOSPITAL_ADMIN, BLOODBANK, and STAFF.
 * 3. Expired Invitation Lifecycle State Persistence (persists Expired state outside redemption transaction)
 * 4. Transaction Guarantees & Failure Injection (Atomicity across User creation, Invitation CAS, and Outbox)
 * 5. Role and hospital ID tamper resistance
 * 6. Post-acceptance authentication and authorization boundary enforcement
 */

const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const bcryptjs = require('bcryptjs')

require('dotenv').config()

const userModel = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { Invitation } = require('../Hospital/invitationModel')
const { NotificationOutbox } = require('../Hospital/notificationOutboxModel')
const {
	getEncryptionKey,
	encryptInvitationToken,
	decryptInvitationToken,
} = require('../Utils/tokenEncryption')
const {
	issueHospitalRepresentativeInvitation,
	acceptHospitalRepresentativeInvitation,
} = require('../Hospital/hospitalInvitationController')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { protectHospitalAdminAuth } = require('../Hospital/hospitalAdminMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const { withTransaction, canUseTransactions } = require('../Utils/transactionHelper')
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

// Admin authorization guard matching adminRoute & invitationRoute
const requireAdmin = (req, res, next) => {
	if (req.userRole !== 'ADMIN') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Platform Administrator privileges required.',
		})
	}
	next()
}

// Executes pipeline of Express middlewares
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

describe('Stage B3.1: Hospital Representative Invitation Issuance & Acceptance', () => {
	let adminUser
	let adminToken
	let verifiedHospital
	let verifiedHospital2
	let inactiveHospital
	let unverifiedHospital

	// Diverse non-admin entities for route defense tests
	let normalUser, userToken
	let doctorUser, doctorToken
	let repUser, repToken
	let bloodbankDoc, bloodbankToken
	let staffDoc, staffToken

	const createdUserIds = []
	const createdHospitalIds = []
	const createdInvitationIds = []
	const createdOutboxEventIds = []

	before(async () => {
		if (mongoose.connection.readyState !== 1) {
			await mongoose.connect(TEST_DB_URI)
		}

		// Clean up any test artifacts from prior runs
		await Admin.deleteMany({ email: /^admin\.b31\./ })
		await userModel.deleteMany({ email: /@test\.org$/ })
		await Invitation.deleteMany({ recipientEmail: /@test\.org$/ })
		await NotificationOutbox.deleteMany({ recipientEmail: /@test\.org$/ })

		// 1. Setup Platform Admin Account
		adminUser = await Admin.create({
			name: 'Platform Administrator',
			email: `admin.b31.${Date.now()}@test.org`,
			password: 'AdminPassword123!',
			phoneNo: Math.floor(1000000000 + Math.random() * 9000000000),
			status: true,
		})
		createdUserIds.push(adminUser._id)
		adminToken = signToken(adminUser._id)

		// 2. Setup Verified & Active Hospital 1
		verifiedHospital = await Hospital.create({
			hospitalCode: `HOSP-B31-0001-${Date.now()}`,
			hospitalName: 'Apollo Speciality Hospital B31',
			hospitalType: 'Private',
			address: {
				street: '124 Greams Road',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600006',
			},
			contactPhone: '9840011111',
			contactEmail: 'apollo.b31@test.org',
			verificationStatus: 'Verified',
			isActive: true,
			verifiedBy: adminUser._id,
			verifiedAt: new Date(),
		})
		createdHospitalIds.push(verifiedHospital._id)

		// 3. Setup Verified & Active Hospital 2 (for tenant isolation tests)
		verifiedHospital2 = await Hospital.create({
			hospitalCode: `HOSP-B31-0002-${Date.now()}`,
			hospitalName: 'Fortis Malar Hospital B31',
			hospitalType: 'Private',
			address: {
				street: '52 1st Main Rd',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600020',
			},
			contactPhone: '9840022222',
			contactEmail: 'fortis.b31@test.org',
			verificationStatus: 'Verified',
			isActive: true,
			verifiedBy: adminUser._id,
			verifiedAt: new Date(),
		})
		createdHospitalIds.push(verifiedHospital2._id)

		// 4. Setup Inactive Hospital
		inactiveHospital = await Hospital.create({
			hospitalCode: `HOSP-B31-0003-${Date.now()}`,
			hospitalName: 'Inactive Medical Center B31',
			hospitalType: 'Private',
			address: {
				street: '77 Old Rd',
				city: 'Coimbatore',
				state: 'Tamil Nadu',
				pinCode: '641001',
			},
			contactPhone: '9840033333',
			contactEmail: 'inactive.b31@test.org',
			verificationStatus: 'Verified',
			isActive: false,
		})
		createdHospitalIds.push(inactiveHospital._id)

		// 5. Setup Unverified Hospital
		unverifiedHospital = await Hospital.create({
			hospitalCode: `HOSP-B31-0004-${Date.now()}`,
			hospitalName: 'Unverified Clinic B31',
			hospitalType: 'Private',
			address: {
				street: '88 New Rd',
				city: 'Madurai',
				state: 'Tamil Nadu',
				pinCode: '625001',
			},
			contactPhone: '9840044444',
			contactEmail: 'unverified.b31@test.org',
			verificationStatus: 'Pending',
			isActive: false,
		})
		createdHospitalIds.push(unverifiedHospital._id)

		// 6. Setup Non-Admin Accounts for Route Defense Matrix
		normalUser = await userModel.create({
			firstName: 'Normal',
			lastName: 'User',
			email: `user.route.${Date.now()}@test.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			gender: 'Male',
			dob: new Date('1990-01-01'),
			age: 34,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: '123 Main St',
			pinCode: 600001,
			password: 'Password123!',
			role: 'USER',
			accountStatus: 'Active',
			status: true,
		})
		createdUserIds.push(normalUser._id)
		userToken = signToken(normalUser._id, { userType: 'user' })

		doctorUser = await userModel.create({
			firstName: 'Dr. Physician',
			lastName: 'Route',
			email: `doctor.route.${Date.now()}@test.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'Password123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: 'Verified',
			status: true,
		})
		createdUserIds.push(doctorUser._id)
		doctorToken = signToken(doctorUser._id, { userType: 'user' })

		repUser = await userModel.create({
			firstName: 'Dr. Representative',
			lastName: 'Route',
			email: `rep.route.${Date.now()}@test.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'Password123!',
			role: 'HOSPITAL_ADMIN',
			accountStatus: 'Active',
			representativeStatus: 'Active',
			hospitalId: verifiedHospital._id,
			status: true,
		})
		createdUserIds.push(repUser._id)
		repToken = signToken(repUser._id, { userType: 'user' })

		bloodbankDoc = await Bloodbank.create({
			bloodbankName: 'City Central Blood Bank Route',
			category: 'Government',
			contactPerson: 'Dr. Ramesh',
			address1: '400 Blood Bank Road',
			address2: 'Central Block',
			state: 'Tamil Nadu',
			city: 'Chennai',
			pinCode: 600008,
			phoneNo1: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			phoneNo2: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			email: `bb.route.${Date.now()}@test.org`,
			password: 'Password123!',
			status: true,
			location: { type: 'Point', coordinates: [80.2707, 13.0827] },
		})
		createdUserIds.push(bloodbankDoc._id)
		bloodbankToken = signToken(bloodbankDoc._id)

		staffDoc = await BloodbankStaff.create({
			fullName: 'Nurse Staff Route',
			email: `staff.route.${Date.now()}@test.org`,
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
		// Clean up test data
		if (createdInvitationIds.length > 0) {
			await Invitation.deleteMany({ _id: { $in: createdInvitationIds } })
		}
		if (createdOutboxEventIds.length > 0) {
			await NotificationOutbox.deleteMany({ eventId: { $in: createdOutboxEventIds } })
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
	// 1. Authenticated Encryption Unit Tests
	// =========================================================================
	describe('1. Authenticated Encryption of Bearer Tokens', () => {
		it('should encrypt and decrypt a raw invitation token correctly using AES-256-GCM', () => {
			const rawToken = crypto.randomBytes(32).toString('hex')
			const encrypted = encryptInvitationToken(rawToken)

			assert.strictEqual(encrypted.algorithm, 'aes-256-gcm')
			assert.ok(encrypted.iv && typeof encrypted.iv === 'string')
			assert.ok(encrypted.tag && typeof encrypted.tag === 'string')
			assert.ok(encrypted.encryptedData && typeof encrypted.encryptedData === 'string')
			assert.notStrictEqual(encrypted.encryptedData, rawToken)

			const decrypted = decryptInvitationToken(encrypted)
			assert.strictEqual(decrypted, rawToken)
		})

		it('should fail closed immediately when INVITATION_TOKEN_ENCRYPTION_KEY is missing', () => {
			const savedKey = process.env.INVITATION_TOKEN_ENCRYPTION_KEY
			delete process.env.INVITATION_TOKEN_ENCRYPTION_KEY
			try {
				assert.throws(() => getEncryptionKey(), (err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.match(err.message, /not configured/i)
					return true
				})
			} finally {
				process.env.INVITATION_TOKEN_ENCRYPTION_KEY = savedKey
			}
		})

		it('should fail closed when encryption key has invalid length', () => {
			const savedKey = process.env.INVITATION_TOKEN_ENCRYPTION_KEY
			process.env.INVITATION_TOKEN_ENCRYPTION_KEY = 'short_insecure_key'
			try {
				assert.throws(() => getEncryptionKey(), (err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.match(err.message, /must be a valid 32-byte key/i)
					return true
				})
			} finally {
				process.env.INVITATION_TOKEN_ENCRYPTION_KEY = savedKey
			}
		})

		it('should reject tampered ciphertext with authentication error', () => {
			const rawToken = crypto.randomBytes(32).toString('hex')
			const encrypted = encryptInvitationToken(rawToken)

			// Tamper with encryptedData
			const tampered = { ...encrypted, encryptedData: 'a' + encrypted.encryptedData.slice(1) }
			assert.throws(() => decryptInvitationToken(tampered))
		})

		it('should reject tampered authentication tag', () => {
			const rawToken = crypto.randomBytes(32).toString('hex')
			const encrypted = encryptInvitationToken(rawToken)

			// Tamper with tag
			const tampered = { ...encrypted, tag: '00' + encrypted.tag.slice(2) }
			assert.throws(() => decryptInvitationToken(tampered))
		})
	})

	// =========================================================================
	// 2. Issuance Route Authorization Matrix (Both Endpoints)
	// =========================================================================
	describe('2. Dual Issuance Route Security: POST /api/admin/hospital-invitations & POST /api/invitations/hospital-representative', () => {
		const testEndpoints = [
			{ name: 'POST /api/admin/hospital-invitations (Primary)', path: '/api/admin/hospital-invitations' },
			{ name: 'POST /api/invitations/hospital-representative (Alias)', path: '/api/invitations/hospital-representative' },
		]

		for (const ep of testEndpoints) {
			describe(`Route Security Matrix: ${ep.name}`, () => {
				it(`should REJECT unauthenticated access with HTTP 401 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						body: {
							hospitalId: verifiedHospital._id.toString(),
							recipientName: 'Dr. Unauth',
							recipientEmail: 'unauth@test.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline(
						[protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation],
						req,
						res
					)
					assert.strictEqual(res.statusCode, 401)
					assert.match(res.responseData?.message, /Authentication required/i)
				})

				it(`should REJECT USER role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${userToken}` },
						body: {
							hospitalId: verifiedHospital._id.toString(),
							recipientName: 'Dr. UserAttempt',
							recipientEmail: 'user.attempt@test.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline(
						[protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation],
						req,
						res
					)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
				})

				it(`should REJECT MEDICAL_OFFICER role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${doctorToken}` },
						body: {
							hospitalId: verifiedHospital._id.toString(),
							recipientName: 'Dr. DoctorAttempt',
							recipientEmail: 'doctor.attempt@test.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline(
						[protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation],
						req,
						res
					)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
				})

				it(`should REJECT HOSPITAL_ADMIN role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${repToken}` },
						body: {
							hospitalId: verifiedHospital._id.toString(),
							recipientName: 'Dr. RepAttempt',
							recipientEmail: 'rep.attempt@test.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline(
						[protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation],
						req,
						res
					)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
				})

				it(`should REJECT BLOODBANK role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${bloodbankToken}` },
						body: {
							hospitalId: verifiedHospital._id.toString(),
							recipientName: 'Dr. BBAttempt',
							recipientEmail: 'bb.attempt@test.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline(
						[protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation],
						req,
						res
					)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
				})

				it(`should REJECT STAFF role with HTTP 403 on ${ep.path}`, async () => {
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${staffToken}` },
						body: {
							hospitalId: verifiedHospital._id.toString(),
							recipientName: 'Dr. StaffAttempt',
							recipientEmail: 'staff.attempt@test.org',
							recipientPhone: 9876543210,
						},
					})

					await executeRoutePipeline(
						[protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation],
						req,
						res
					)
					assert.strictEqual(res.statusCode, 403)
					assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
				})

				it(`should AUTHORIZE Platform ADMIN with HTTP 201 on ${ep.path}`, async () => {
					const recipientEmail = `admin.auth.${Date.now()}.${Math.random().toString(36).substring(7)}@test.org`
					const { req, res } = createMockReqRes({
						headers: { authorization: `Bearer ${adminToken}` },
						body: {
							hospitalId: verifiedHospital._id.toString(),
							recipientName: 'Dr. Authorized Rep',
							recipientEmail,
							recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
						},
					})

					await executeRoutePipeline(
						[protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation],
						req,
						res
					)
					assert.strictEqual(res.statusCode, 201)
					assert.strictEqual(res.responseData?.status, 'success')
					assert.ok(res.responseData?.data?.invitationToken)
					createdInvitationIds.push(res.responseData.data.invitation.id)
				})
			})
		}
	})

	// =========================================================================
	// 3. Platform Admin Invitation Issuance Business Validations
	// =========================================================================
	describe('3. Platform Admin Invitation Issuance Invariant Checks', () => {
		it('should reject invitation issuance for an unverified hospital (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: unverifiedHospital._id.toString(),
					recipientName: 'Dr. Unverified',
					recipientEmail: 'unverified.rep@test.org',
					recipientPhone: 9876543210,
				},
			})

			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /not Verified/i)
		})

		it('should reject invitation issuance for an inactive hospital (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: inactiveHospital._id.toString(),
					recipientName: 'Dr. Inactive',
					recipientEmail: 'inactive.rep@test.org',
					recipientPhone: 9876543210,
				},
			})

			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /inactive/i)
		})

		it('should reject invalid recipient email format (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. BadEmail',
					recipientEmail: 'not-an-email',
					recipientPhone: 9876543210,
				},
			})

			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /email/i)
		})

		it('should reject invalid recipient phone format (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. BadPhone',
					recipientEmail: 'badphone@test.org',
					recipientPhone: '1234', // not 10 digits
				},
			})

			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /phone/i)
		})

		it('should reject client-supplied wrong invitationType (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					invitationType: 'DOCTOR_NOMINATION',
					recipientName: 'Dr. WrongType',
					recipientEmail: 'wrongtype@test.org',
					recipientPhone: 9876543210,
				},
			})

			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /only issues HOSPITAL_REPRESENTATIVE invitations/i)
		})

		it('should reject invitation issuance when account with email already exists (HTTP 409)', async () => {
			const existingEmail = `existing.account.${Date.now()}@test.org`
			const existingUser = await userModel.create({
				firstName: 'Existing',
				lastName: 'User',
				email: existingEmail,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				gender: 'Male',
				dob: new Date('1990-01-01'),
				age: 34,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: '123 Main St',
				pinCode: 600001,
				password: 'Password123!',
				role: 'USER',
				accountStatus: 'Active',
			})
			createdUserIds.push(existingUser._id)

			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Existing',
					recipientEmail: existingEmail,
					recipientPhone: 9876543210,
				},
			})

			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /already exists/i)
		})

		it('should successfully issue a HOSPITAL_REPRESENTATIVE invitation by ADMIN (HTTP 201)', async () => {
			const recipientEmail = `rep.invite.success.${Date.now()}@test.org`
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Rajesh Sharma',
					recipientEmail: `  ${recipientEmail.toUpperCase()}  `,
					recipientPhone: '9840112233',
				},
			})

			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData?.status, 'success')

			const { invitation, invitationToken } = res.responseData.data
			assert.ok(invitation)
			assert.ok(invitationToken && typeof invitationToken === 'string')
			createdInvitationIds.push(invitation.id)

			// 1. Verify Invitation document in DB
			const dbInvitation = await Invitation.findById(invitation.id)
			assert.ok(dbInvitation)
			assert.strictEqual(dbInvitation.invitationType, 'HOSPITAL_REPRESENTATIVE')
			assert.strictEqual(dbInvitation.status, 'Pending')
			assert.strictEqual(dbInvitation.recipientEmail, recipientEmail.toLowerCase())
			assert.strictEqual(dbInvitation.hospitalId.toString(), verifiedHospital._id.toString())

			// 2. Verify token hash was stored, NEVER raw token
			assert.notStrictEqual(dbInvitation.invitationTokenHash, invitationToken)
			const expectedHash = Invitation.hashToken(invitationToken)
			assert.strictEqual(dbInvitation.invitationTokenHash, expectedHash)

			// 3. Verify 48-hour expiration
			const now = Date.now()
			const expiresAt = new Date(dbInvitation.tokenExpiresAt).getTime()
			const diffHours = (expiresAt - now) / (1000 * 60 * 60)
			assert.ok(diffHours >= 47.9 && diffHours <= 48.1, 'Expiry should be 48 hours')

			// 4. Verify NotificationOutbox event creation
			const outboxRecord = await NotificationOutbox.findOne({
				hospitalId: verifiedHospital._id,
				recipientEmail: recipientEmail.toLowerCase(),
				eventType: 'REPRESENTATIVE_INVITED',
			})
			assert.ok(outboxRecord, 'Notification outbox record must be created')
			createdOutboxEventIds.push(outboxRecord.eventId)
			assert.strictEqual(outboxRecord.deliveryStatus, 'Pending')
			assert.strictEqual(outboxRecord.channel, 'EMAIL')

			// 5. Critical Token Confidentiality: Verify raw token is NOT in sanitizedBody
			assert.strictEqual(
				outboxRecord.sanitizedBody.includes(invitationToken),
				false,
				'Raw bearer token must NEVER appear in outbox sanitizedBody'
			)

			// 6. Verify outbox body holds encrypted token that decrypts back to rawToken
			const bodyParsed = JSON.parse(outboxRecord.sanitizedBody)
			assert.ok(bodyParsed.encryptedToken)
			const decryptedToken = decryptInvitationToken(bodyParsed.encryptedToken)
			assert.strictEqual(decryptedToken, invitationToken)
		})

		it('should reject duplicate pending invitation for the same hospital, type, and recipient (HTTP 409)', async () => {
			const recipientEmail = `duplicate.pending.${Date.now()}@test.org`

			// First issuance
			const { req: req1, res: res1 } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. First Invite',
					recipientEmail,
					recipientPhone: 9840112244,
				},
			})
			await issueHospitalRepresentativeInvitation(req1, res1, () => {})
			assert.strictEqual(res1.statusCode, 201)
			createdInvitationIds.push(res1.responseData.data.invitation.id)

			// Second issuance for identical hospital + recipient
			const { req: req2, res: res2 } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Second Invite',
					recipientEmail: recipientEmail.toUpperCase(),
					recipientPhone: 9840112255,
				},
			})
			await issueHospitalRepresentativeInvitation(req2, res2, () => {})
			assert.strictEqual(res2.statusCode, 409)
			assert.match(res2.responseData?.message, /active pending invitation already exists/i)
		})
	})

	// =========================================================================
	// 4. Invitation Acceptance & State Persistence
	// =========================================================================
	describe('4. Hospital Representative Invitation Acceptance (POST /api/invitations/accept-hospital-representative)', () => {
		let validRawToken
		let issuedInvitation
		const recipientEmail = `rep.accept.target.${Date.now()}@test.org`

		before(async () => {
			const { req, res } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Senthil Nathan',
					recipientEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			validRawToken = res.responseData.data.invitationToken
			issuedInvitation = res.responseData.data.invitation
			createdInvitationIds.push(issuedInvitation.id)
		})

		it('should reject acceptance without invitation token (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					password: 'StrongPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /token is required/i)
		})

		it('should reject invalid / unissued invitation token (HTTP 400)', async () => {
			const fakeToken = crypto.randomBytes(32).toString('hex')
			const { req, res } = createMockReqRes({
				body: {
					token: fakeToken,
					password: 'StrongPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /invalid/i)
		})

		it('should reject acceptance when password is weak or missing (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					token: validRawToken,
					password: 'short',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /8 to 20 characters/i)
		})

		it('should reject acceptance when confidentiality or platform terms are not accepted (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					token: validRawToken,
					password: 'StrongPassword123!',
					termsAccepted: false,
					confidentialityAccepted: false,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /confidentiality agreement and platform terms/i)
		})

		it('should reject DOCTOR_NOMINATION invitation type on hospital representative acceptance endpoint (HTTP 400)', async () => {
			const doctorInv = new Invitation({
				invitationType: 'DOCTOR_NOMINATION',
				hospitalId: verifiedHospital._id,
				invitedByUserId: adminUser._id,
				invitedByRole: 'ADMIN',
				recipientName: 'Dr. Physician',
				recipientEmail: `physician.${Date.now()}@test.org`,
				recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
			})
			const doctorToken = doctorInv.createInvitationToken(48)
			await doctorInv.save()
			createdInvitationIds.push(doctorInv._id)

			const { req, res } = createMockReqRes({
				body: {
					token: doctorToken,
					password: 'StrongPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Invalid invitation type 'DOCTOR_NOMINATION'/i)
		})

		it('should reject revoked invitation token (HTTP 400)', async () => {
			const revokedInv = new Invitation({
				invitationType: 'HOSPITAL_REPRESENTATIVE',
				hospitalId: verifiedHospital._id,
				invitedByUserId: adminUser._id,
				invitedByRole: 'ADMIN',
				recipientName: 'Dr. Revoked',
				recipientEmail: `revoked.rep.${Date.now()}@test.org`,
				recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
			})
			const revokedToken = revokedInv.createInvitationToken(48)
			revokedInv.status = 'Revoked'
			await revokedInv.save()
			createdInvitationIds.push(revokedInv._id)

			const { req, res } = createMockReqRes({
				body: {
					token: revokedToken,
					password: 'StrongPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /revoked/i)
		})

		it('should reject acceptance if associated hospital was deactivated after issuance (HTTP 400)', async () => {
			const tempHospital = await Hospital.create({
				hospitalCode: `HOSP-TEMP-${Date.now()}`,
				hospitalName: 'Temporarily Active Hospital',
				hospitalType: 'Private',
				address: { street: '1 Rd', city: 'Salem', state: 'Tamil Nadu', pinCode: '636001' },
				contactPhone: '9840055555',
				contactEmail: 'temp.hosp@test.org',
				verificationStatus: 'Verified',
				isActive: true,
			})
			createdHospitalIds.push(tempHospital._id)

			const inv = new Invitation({
				invitationType: 'HOSPITAL_REPRESENTATIVE',
				hospitalId: tempHospital._id,
				invitedByUserId: adminUser._id,
				invitedByRole: 'ADMIN',
				recipientName: 'Dr. Deactivated Hosp Rep',
				recipientEmail: `deact.hosp.${Date.now()}@test.org`,
				recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
			})
			const token = inv.createInvitationToken(48)
			await inv.save()
			createdInvitationIds.push(inv._id)

			// Deactivate hospital
			tempHospital.isActive = false
			await tempHospital.save()

			const { req, res } = createMockReqRes({
				body: {
					token,
					password: 'StrongPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /inactive/i)
		})

		it('should reject client-supplied role and hospitalId manipulation, enforcing authoritative values (HTTP 200)', async () => {
			const maliciousRole = 'ADMIN'
			const spoofedHospitalId = verifiedHospital2._id.toString()

			const { req, res } = createMockReqRes({
				body: {
					token: validRawToken,
					password: 'RepPass123!',
					role: maliciousRole,
					hospitalId: spoofedHospitalId,
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.status, 'success')

			const repUser = res.responseData.data.user
			createdUserIds.push(repUser.id)

			// Verify authoritative role is HOSPITAL_ADMIN (NOT spoofed ADMIN)
			assert.strictEqual(repUser.role, 'HOSPITAL_ADMIN')
			assert.notStrictEqual(repUser.role, maliciousRole)

			// Verify authoritative hospitalId is verifiedHospital 1 (NOT spoofed Hospital 2)
			assert.strictEqual(repUser.hospitalId.toString(), verifiedHospital._id.toString())
			assert.notStrictEqual(repUser.hospitalId.toString(), spoofedHospitalId)

			// Verify account and representative lifecycle statuses
			assert.strictEqual(repUser.accountStatus, 'Active')
			assert.strictEqual(repUser.representativeStatus, 'Active')

			// Verify password is fully hashed with bcrypt
			const dbUser = await userModel.findById(repUser.id).select('+password')
			assert.ok(dbUser.password.startsWith('$2a$') || dbUser.password.startsWith('$2b$'))
			const passwordValid = await bcryptjs.compare('RepPass123!', dbUser.password)
			assert.strictEqual(passwordValid, true)

			// Verify Invitation document is updated to Accepted
			const dbInv = await Invitation.findById(issuedInvitation.id)
			assert.strictEqual(dbInv.status, 'Accepted')
			assert.ok(dbInv.acceptedAt)
			assert.strictEqual(dbInv.metadata.acceptedByUserId.toString(), repUser.id.toString())

			// Verify NotificationOutbox acceptance record created
			const acceptOutbox = await NotificationOutbox.findOne({
				hospitalId: verifiedHospital._id,
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.ok(acceptOutbox)
			createdOutboxEventIds.push(acceptOutbox.eventId)
			assert.strictEqual(acceptOutbox.recipientEmail, repUser.email)
		})

		it('should reject already accepted invitation token (cannot be redeemed again) (HTTP 400)', async () => {
			const { req, res } = createMockReqRes({
				body: {
					token: validRawToken,
					password: 'AnotherPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})

			await acceptHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /already been accepted/i)
		})
	})

	// =========================================================================
	// 5. Expired Invitation Lifecycle Persistence (Item 3 Review Verification)
	// =========================================================================
	describe('5. Expired Invitation State Persistence: Verification of Non-Rollback Lifecycle Transition', () => {
		it('should permanently persist status: Expired in database upon redemption attempt and reject subsequent requests', async () => {
			// 1. Issue an invitation
			const expiredTargetEmail = `expired.persist.${Date.now()}@test.org`
			const expiredTargetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			const { req: issueReq, res: issueRes } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Expired Persistence Test',
					recipientEmail: expiredTargetEmail,
					recipientPhone: expiredTargetPhone,
				},
			})
			await issueHospitalRepresentativeInvitation(issueReq, issueRes, () => {})
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// 2. Force expiration timestamp to past while status is still Pending
			const initialInv = await Invitation.findById(invId)
			assert.strictEqual(initialInv.status, 'Pending')
			initialInv.tokenExpiresAt = new Date(Date.now() - 5 * 60 * 1000) // 5 minutes ago
			await initialInv.save()

			// 3. Attempt redemption with expired token
			const { req: redeemReq1, res: redeemRes1 } = createMockReqRes({
				body: {
					token,
					password: 'ExpiredPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptHospitalRepresentativeInvitation(redeemReq1, redeemRes1, () => {})
			assert.strictEqual(redeemRes1.statusCode, 400)
			assert.match(redeemRes1.responseData?.message, /expired/i)

			// 4. Critical Invariant Check: Confirm status: Expired was PERSISTED and NOT rolled back
			const persistedInv = await Invitation.findById(invId)
			assert.strictEqual(
				persistedInv.status,
				'Expired',
				'Expired status must be permanently persisted in MongoDB, not rolled back by an error'
			)

			// Confirm zero user account was created
			const userCount = await userModel.countDocuments({ email: expiredTargetEmail.toLowerCase() })
			assert.strictEqual(userCount, 0, 'No user account may exist for expired invitation')

			// 5. Subsequent redemption attempt on the now-Expired invitation must fail immediately
			const { req: redeemReq2, res: redeemRes2 } = createMockReqRes({
				body: {
					token,
					password: 'ExpiredPassword123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptHospitalRepresentativeInvitation(redeemReq2, redeemRes2, () => {})
			assert.strictEqual(redeemRes2.statusCode, 400)
			assert.match(redeemRes2.responseData?.message, /expired/i)

			const finalInv = await Invitation.findById(invId)
			assert.strictEqual(finalInv.status, 'Expired')
		})
	})

	// =========================================================================
	// 6. Transaction Guarantees & Failure Injection (Item 2 Review Verification)
	// =========================================================================
	describe('6. Transaction Guarantees & Failure Injection', () => {
		it('should fail closed with HTTP 500 in production when multi-document transactions are unsupported', async () => {
			// Tests fail-closed production guarantee from transactionHelper.js
			const productionPromise = withTransaction(async () => {}, {
				isProduction: true,
				forceTransaction: false,
			})

			// If local test runner is connected to a replica set, withTransaction uses transactions.
			// When transactions cannot be used in production, it throws HTTP 500 before mutation.
			if (!canUseTransactions()) {
				await assert.rejects(productionPromise, (err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.match(err.message, /Multi-document transaction safety failure/i)
					return true
				})
			}
		})

		it('Failure Injection 1: should roll back transaction and leave invitation Pending if user creation fails', async () => {
			const targetEmail = `fail.user.${Date.now()}@test.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// Issue invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. User Save Failure Test',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await issueHospitalRepresentativeInvitation(issueReq, issueRes, () => {})
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Inject failure in userModel.prototype.save
			const origUserSave = userModel.prototype.save
			userModel.prototype.save = async function () {
				throw new Error('Simulated Database Write Failure During Account Creation')
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'StrongPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptHospitalRepresentativeInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 400)
				assert.match(accRes.responseData?.message, /Simulated Database Write Failure/i)
			} finally {
				userModel.prototype.save = origUserSave
			}

			// Invariant Checks: Rollback integrity
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending', 'Invitation must remain Pending after user creation failure')
			assert.strictEqual(dbInv.acceptedAt, null)

			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'No user account may persist when transaction aborts')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record may persist when transaction aborts')

			// Recovery verification: The unredeemed invitation can now be successfully redeemed
			const { req: recoverReq, res: recoverRes } = createMockReqRes({
				body: {
					token,
					password: 'StrongPass123!',
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptHospitalRepresentativeInvitation(recoverReq, recoverRes, () => {})
			assert.strictEqual(recoverRes.statusCode, 200)
			createdUserIds.push(recoverRes.responseData.data.user.id)

			const recoveredInv = await Invitation.findById(invId)
			assert.strictEqual(recoveredInv.status, 'Accepted')
		})

		it('Failure Injection 2: should roll back transaction if compare-and-swap update encounters conflict', async () => {
			const targetEmail = `fail.cas.${Date.now()}@test.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// Issue invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. CAS Collision Test',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await issueHospitalRepresentativeInvitation(issueReq, issueRes, () => {})
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Stub Invitation.findOneAndUpdate to simulate CAS returning null (another request grabbed it)
			const origFindOneAndUpdate = Invitation.findOneAndUpdate
			Invitation.findOneAndUpdate = async function (conditions) {
				if (conditions.status === 'Pending') {
					return null // Simulate CAS failure
				}
				return origFindOneAndUpdate.apply(this, arguments)
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'StrongPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptHospitalRepresentativeInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 409)
				assert.match(accRes.responseData?.message, /redemption conflict/i)
			} finally {
				Invitation.findOneAndUpdate = origFindOneAndUpdate
			}

			// Invariant Check: Rollback integrity - user must NOT persist
			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User account must be rolled back on CAS conflict')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record may persist on CAS conflict')
		})

		it('Failure Injection 3: should roll back transaction if outbox insertion fails', async () => {
			const targetEmail = `fail.outbox.${Date.now()}@test.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// Issue invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Outbox Error Test',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await issueHospitalRepresentativeInvitation(issueReq, issueRes, () => {})
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Stub NotificationOutbox.prototype.save to fail
			const origOutboxSave = NotificationOutbox.prototype.save
			NotificationOutbox.prototype.save = async function () {
				throw new Error('Simulated Outbox Disk Quota Failure')
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'StrongPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptHospitalRepresentativeInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 400)
				assert.match(accRes.responseData?.message, /Simulated Outbox Disk Quota Failure/i)
			} finally {
				NotificationOutbox.prototype.save = origOutboxSave
			}

			// Invariant Checks: Transaction was rolled back
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending', 'Invitation must remain Pending after outbox failure')

			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User account must not exist when outbox insertion fails')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record should exist when outbox insertion fails')
		})

		it('Failure Injection 4: should roll back transaction if transaction commit fails', async () => {
			const targetEmail = `fail.commit.${Date.now()}@test.org`
			const targetPhone = Math.floor(1000000000 + Math.random() * 9000000000)

			// Issue invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Commit Failure Test',
					recipientEmail: targetEmail,
					recipientPhone: targetPhone,
				},
			})
			await issueHospitalRepresentativeInvitation(issueReq, issueRes, () => {})
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// Hook mongoose.startSession to inject failure into the genuine commitTransaction() operation
			// while retaining the real session.withTransaction() driver implementation and withTransaction() control flow
			const origStartSession = mongoose.startSession.bind(mongoose)
			mongoose.startSession = async function (...args) {
				const session = await origStartSession(...args)
				session.commitTransaction = async function () {
					await this.abortTransaction()
					throw new Error('Simulated Transient Network Drop During Transaction Commit')
				}
				return session
			}

			try {
				const { req: accReq, res: accRes } = createMockReqRes({
					body: {
						token,
						password: 'StrongPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				await acceptHospitalRepresentativeInvitation(accReq, accRes, () => {})
				assert.strictEqual(accRes.statusCode, 400)
				assert.match(accRes.responseData?.message, /Simulated Transient Network Drop/i)
			} finally {
				mongoose.startSession = origStartSession
			}

			// Invariant Checks: Rollback verified
			const dbInv = await Invitation.findById(invId)
			assert.strictEqual(dbInv.status, 'Pending', 'Invitation must remain Pending after commit failure')

			const dbUser = await userModel.findOne({ email: targetEmail.toLowerCase() })
			assert.strictEqual(dbUser, null, 'User account must not exist after commit failure')

			const dbOutbox = await NotificationOutbox.findOne({
				recipientEmail: targetEmail.toLowerCase(),
				eventType: 'INVITATION_ACCEPTED',
			})
			assert.strictEqual(dbOutbox, null, 'No acceptance outbox record should exist after commit failure')
		})

		it('Concurrency Check: strictly ONE successful acceptance permitted under concurrent redemption requests', async () => {
			const concurrentEmail = `concurrent.rep.${Date.now()}@test.org`

			// 1. Issue an invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Concurrency Race',
					recipientEmail: concurrentEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await issueHospitalRepresentativeInvitation(issueReq, issueRes, () => {})
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			const invId = issueRes.responseData.data.invitation.id
			createdInvitationIds.push(invId)

			// 2. Dispatch 3 concurrent acceptance requests simultaneously
			const requests = [1, 2, 3].map(() => {
				const { req, res } = createMockReqRes({
					body: {
						token,
						password: 'ConcurrentPass123!',
						termsAccepted: true,
						confidentialityAccepted: true,
					},
				})
				return acceptHospitalRepresentativeInvitation(req, res, () => {}).then(() => res)
			})

			const responses = await Promise.all(requests)

			const successResponses = responses.filter((r) => r.statusCode === 200)
			const conflictOrErrorResponses = responses.filter((r) => r.statusCode !== 200)

			// Exactly one must succeed
			assert.strictEqual(
				successResponses.length,
				1,
				'Exactly one concurrent acceptance must succeed'
			)
			assert.strictEqual(
				conflictOrErrorResponses.length,
				2,
				'Remaining concurrent requests must fail with conflict / error'
			)

			// Verify only one user account exists for this email
			const userCount = await userModel.countDocuments({ email: concurrentEmail })
			assert.strictEqual(userCount, 1, 'Strictly one user account must be created')

			// Clean up created user
			const createdU = await userModel.findOne({ email: concurrentEmail })
			if (createdU) createdUserIds.push(createdU._id)
		})
	})

	// =========================================================================
	// 7. Post-Acceptance Authentication & Authorization Bounds
	// =========================================================================
	describe('7. Post-Acceptance Authentication & Authorization Enforcement', () => {
		let repAccount
		let repAuthToken
		const repEmail = `auth.rep.${Date.now()}@test.org`
		const repPassword = 'RepAuthPass123!'

		before(async () => {
			// Issue and accept invitation
			const { req: issueReq, res: issueRes } = createMockReqRes({
				user: adminUser,
				userRole: 'ADMIN',
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Auth Rep',
					recipientEmail: repEmail,
					recipientPhone: Math.floor(1000000000 + Math.random() * 9000000000),
				},
			})
			await issueHospitalRepresentativeInvitation(issueReq, issueRes, () => {})
			assert.strictEqual(issueRes.statusCode, 201)
			const token = issueRes.responseData.data.invitationToken
			createdInvitationIds.push(issueRes.responseData.data.invitation.id)

			const { req: accReq, res: accRes } = createMockReqRes({
				body: {
					token,
					password: repPassword,
					termsAccepted: true,
					confidentialityAccepted: true,
				},
			})
			await acceptHospitalRepresentativeInvitation(accReq, accRes, () => {})
			assert.strictEqual(accRes.statusCode, 200)
			repAccount = accRes.responseData.data.user
			createdUserIds.push(repAccount.id)
		})

		it('should permit the accepted representative to authenticate via standard login', async () => {
			const { req, res } = createMockReqRes({
				model: userModel,
				body: {
					email: repEmail,
					password: repPassword,
				},
			})

			await login(req, res, () => {})
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.role, 'HOSPITAL_ADMIN')
			assert.ok(res.responseData?.token)
			assert.strictEqual(
				res.responseData?.user?.hospitalId?.toString(),
				verifiedHospital._id.toString()
			)
			assert.strictEqual(res.responseData?.user?.accountStatus, 'Active')
			assert.strictEqual(res.responseData?.user?.representativeStatus, 'Active')

			repAuthToken = res.responseData.token
		})

		it('should authorize the representative for their own hospital via protectHospitalAdminAuth', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repAuthToken}` },
				params: { hospitalId: verifiedHospital._id.toString() },
			})

			let nextCalled = false
			await protectHospitalAdminAuth(req, res, () => {
				nextCalled = true
			})

			assert.strictEqual(nextCalled, true, 'Next middleware must be called')
			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(req.userRole, 'HOSPITAL_ADMIN')
			assert.strictEqual(req.hospital._id.toString(), verifiedHospital._id.toString())
		})

		it('should REJECT representative when attempting cross-hospital access (BOLA defense) (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repAuthToken}` },
				params: { hospitalId: verifiedHospital2._id.toString() },
			})

			await protectHospitalAdminAuth(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /another hospital/i)
		})

		it('should REJECT representative from Medical Officer clinical endpoints (protectMedicalOfficerAuth) (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repAuthToken}` },
			})

			await protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Hospital Representatives are not authorized|not authorized/i)
		})

		it('should REJECT representative from Platform Admin endpoints (HTTP 403)', async () => {
			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${repAuthToken}` },
				body: {
					hospitalId: verifiedHospital._id.toString(),
					recipientName: 'Dr. Illicit Invite',
					recipientEmail: 'illicit@test.org',
					recipientPhone: 9876543210,
				},
			})

			let nextCalled = false
			await protectEmergencyAuth(req, res, () => {
				nextCalled = true
			})
			assert.strictEqual(nextCalled, true)

			await issueHospitalRepresentativeInvitation(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
		})
	})
})
