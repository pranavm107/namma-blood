/**
 * Stage B3.4.3 Automated Test Suite
 * Namma Blood — Administrative Medical Officer Credential Review APIs
 *
 * Comprehensive Test Coverage (40 Scenarios):
 * 1. Authentication & Authorization Guards (Unauthorized, USER, MEDICAL_OFFICER, HOSPITAL_ADMIN, Self-Review)
 * 2. Credential Review Queue (Read-Only, Pagination, Status/Council/State/Date Filtering, Search)
 * 3. Credential Review Dossier Details (Sanitized Projections, Invalid ID, Non-Existent, Anti-SSRF)
 * 4. Start Credential Review (Pending_Verification -> Under_Review, State Preconditions, Audit & Outbox)
 * 5. Request Additional Information (Under_Review -> Pending_Verification, Notes Validation, Audit & Outbox)
 * 6. Approve Professional Credentials (Under_Review -> Verified, Invariant: Zero Hospital Association)
 * 7. Reject Professional Credentials (Under_Review -> Rejected, Reason Validation, Resubmission Eligibility)
 * 8. Credential Suspension (Verified -> Suspended, Reason Validation, Clinical Gate Invalidation)
 * 9. Invariants, Concurrency, ACID Safety & Integration (Mass-Assignment, Races, Rollback, B3.4.2 Compatibility, Three-Gate)
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const http = require('http')

const userModel = require('../User/userModel')
const Admin = require('../Admin/adminModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const { Hospital } = require('../Hospital/hospitalModel')
const { MedicalOfficerHospital } = require('../Hospital/medicalOfficerHospitalModel')
const { AdministrativeDecisionAudit } = require('../Hospital/administrativeDecisionAuditModel')
const { AuditChainHead } = require('../Hospital/auditChainHeadModel')
const { NotificationOutbox } = require('../Hospital/notificationOutboxModel')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const adminCredentialReviewController = require('../Hospital/adminCredentialReviewController')
const medicalOfficerCredentialController = require('../Hospital/medicalOfficerCredentialController')
const { withTransaction } = require('../Utils/transactionHelper')
const { verifyAuditChainIntegrity } = require('../Hospital/auditIntegrityService')

const TEST_SECRET =
	process.env.JWT_SECRET || 'test_jwt_secret_key_12345_super_secure_min_32'
process.env.JWT_SECRET = TEST_SECRET

const TEST_DB_URI =
	process.env.MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

function signToken(userId, extraClaims = {}) {
	return jwt.sign(
		{ id: userId, tokenVersion: 0, userType: 'user', ...extraClaims },
		TEST_SECRET,
		{ expiresIn: '1h' }
	)
}

function createMockReqRes({
	headers = {},
	params = {},
	query = {},
	body = {},
	user = null,
	userRole = null,
} = {}) {
	const req = {
		headers: { ...headers },
		params: { ...params },
		query: { ...query },
		body: { ...body },
		user,
		userRole,
		ip: '127.0.0.1',
		get: (h) => headers[h.toLowerCase()],
	}

	let statusCode = 200
	let responseData = null

	const res = {
		status(code) {
			statusCode = code
			return this
		},
		json(data) {
			responseData = data
			return this
		},
		send(data) {
			responseData = data
			return this
		},
		get statusCode() {
			return statusCode
		},
		set statusCode(c) {
			statusCode = c
		},
		get responseData() {
			return responseData
		},
		set responseData(d) {
			responseData = d
		},
	}

	return { req, res }
}

const requireAdmin = (req, res, next) => {
	if (req.userRole !== 'ADMIN') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Platform Administrator privileges required.',
		})
	}
	next()
}

/**
 * Executes a request through the Admin authentication and authorization pipeline
 */
async function executeAdminPipeline(controllerFn, reqOptions) {
	const { req, res } = createMockReqRes(reqOptions)

	await new Promise((resolve) => {
		let resolved = false
		const finish = () => {
			if (!resolved) {
				resolved = true
				resolve()
			}
		}

		const origJson = res.json.bind(res)
		const origSend = res.send.bind(res)

		res.json = (data) => {
			origJson(data)
			finish()
			return res
		}
		res.send = (data) => {
			origSend(data)
			finish()
			return res
		}

		protectEmergencyAuth(req, res, (authErr) => {
			if (authErr) {
				if (!res.responseData) {
					res.statusCode = authErr.statusCode || 500
					res.responseData = { status: 'error', message: authErr.message }
				}
				finish()
				return
			}

			requireAdmin(req, res, async (adminErr) => {
				if (adminErr) {
					if (!res.responseData) {
						res.statusCode = adminErr.statusCode || 403
						res.responseData = { status: 'error', message: adminErr.message }
					}
					finish()
					return
				}

				try {
					await controllerFn(req, res, (cErr) => {
						if (cErr) {
							res.statusCode = cErr.statusCode || 500
							res.responseData = { status: 'error', message: cErr.message }
						}
						finish()
					})
				} catch (cEx) {
					res.statusCode = cEx.statusCode || 500
					res.responseData = { status: 'error', message: cEx.message }
					finish()
				}
			})
		})
	})

	return { req, res }
}

describe('Stage B3.4.3: Administrative Medical Officer Credential Review APIs', () => {
	let testAdmin
	let adminToken
	let testHospital
	const createdUserIds = []
	const createdAdminIds = []
	const createdHospitalIds = []

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}

		await userModel.init()
		await Admin.init()
		await AdministrativeDecisionAudit.init()
		await AuditChainHead.init()
		await NotificationOutbox.init()

		testAdmin = await Admin.create({
			phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			email: `admin.b343.${Date.now()}@nammablood.test`,
			password: 'AdminPassword123!',
		})
		createdAdminIds.push(testAdmin._id)
		adminToken = signToken(testAdmin._id)

		testHospital = await Hospital.create({
			hospitalCode: `HOSP-B343-${Date.now()}`,
			hospitalName: 'Apollo City Hospital B343',
			hospitalType: 'Private',
			address: {
				street: '42 Medical Square',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600002',
			},
			contactPhone: '9876543210',
			contactEmail: `contact.b343.${Date.now()}@test-hospital.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		createdHospitalIds.push(testHospital._id)
	})

	after(async () => {
		if (createdHospitalIds.length > 0) {
			await Hospital.deleteMany({ _id: { $in: createdHospitalIds } })
		}
		if (createdUserIds.length > 0) {
			await userModel.deleteMany({ _id: { $in: createdUserIds } })
		}
		if (createdAdminIds.length > 0) {
			await Admin.deleteMany({ _id: { $in: createdAdminIds } })
		}

		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
		await mongoose.connection.collection('notificationoutboxes').deleteMany({})

		await mongoose.disconnect()
	})

	beforeEach(async () => {
		await mongoose.connection.collection('administrativedecisionaudits').deleteMany({})
		await mongoose.connection.collection('auditchainheads').deleteMany({})
		await mongoose.connection.collection('notificationoutboxes').deleteMany({})
	})

	async function createDoctor(status = 'Pending_Verification', extra = {}) {
		const doc = await userModel.create({
			firstName: 'Dr. Test',
			lastName: 'Physician',
			email: `dr.b343.${status.toLowerCase()}.${Date.now()}.${Math.floor(Math.random() * 10000)}@test-doctor.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'DoctorPassword123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: status,
			verificationStatus: status === 'Verified' ? 'Verified' : 'Pending',
			status: true,
			medicalRegistrationNumber: `REG-B343-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
			medicalCouncil: 'Tamil Nadu Medical Council',
			registrationState: 'Tamil Nadu',
			registrationYear: 2020,
			qualification: 'MBBS, MD',
			supportingEvidence: 'https://example.com/cert.pdf',
			credentialLastSubmittedAt: new Date(),
			...extra,
		})
		createdUserIds.push(doc._id)
		const token = signToken(doc._id)
		return { doc, token }
	}

	// =========================================================================
	// 1. Authentication & Authorization Guards
	// =========================================================================
	describe('1. Authentication & Authorization Guards', () => {
		it('Scenario 1: Unauthorized access without token rejected with HTTP 401', async () => {
			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getCredentialReviewQueue,
				{}
			)
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /Authentication required/i)
		})

		it('Scenario 2: Non-ADMIN role USER denied access with HTTP 403', async () => {
			const regularUser = await userModel.create({
				firstName: 'Regular',
				lastName: 'User',
				email: `user.b343.${Date.now()}@test.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'UserPassword123!',
				role: 'USER',
				status: true,
				gender: 'Male',
				dob: new Date('1994-01-01'),
				age: 30,
				state: 'Tamil Nadu',
				city: 'Chennai',
				address: '10 Main Road',
				pinCode: 600001,
			})
			createdUserIds.push(regularUser._id)
			const userToken = signToken(regularUser._id)

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getCredentialReviewQueue,
				{ headers: { authorization: `Bearer ${userToken}` } }
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
		})

		it('Scenario 3: Non-ADMIN role MEDICAL_OFFICER denied access with HTTP 403', async () => {
			const { token } = await createDoctor('Pending_Verification')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getCredentialReviewQueue,
				{ headers: { authorization: `Bearer ${token}` } }
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
		})

		it('Scenario 4: Non-ADMIN role HOSPITAL_ADMIN denied access with HTTP 403', async () => {
			const hospitalRep = await userModel.create({
				firstName: 'Hospital',
				lastName: 'Admin',
				email: `hosp.admin.b343.${Date.now()}@test.org`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'HospPassword123!',
				role: 'HOSPITAL_ADMIN',
				accountStatus: 'Active',
				status: true,
			})
			createdUserIds.push(hospitalRep._id)
			const repToken = signToken(hospitalRep._id)

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getCredentialReviewQueue,
				{ headers: { authorization: `Bearer ${repToken}` } }
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform Administrator privileges required/i)
		})

		it('Scenario 5: Self-review violation: Administrator cannot review own doctor account (HTTP 403)', async () => {
			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.startCredentialReview,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: testAdmin._id.toString() },
				}
			)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Self-review violation/i)
		})
	})

	// =========================================================================
	// 2. Credential Review Queue (Read-Only)
	// =========================================================================
	describe('2. Credential Review Queue (Read-Only)', () => {
		it('Scenario 6: Retrieve default review queue returns Pending_Verification and Under_Review doctors', async () => {
			await createDoctor('Pending_Verification')
			await createDoctor('Under_Review')
			await createDoctor('Verified')
			await createDoctor('Rejected')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getCredentialReviewQueue,
				{ headers: { authorization: `Bearer ${adminToken}` } }
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.status, 'success')
			assert.ok(Array.isArray(res.responseData?.data?.medicalOfficers))
			assert.ok(res.responseData?.data?.totalRecords >= 2)

			// Verify all returned doctors are either Pending_Verification or Under_Review
			const statuses = res.responseData.data.medicalOfficers.map((d) => d.credentialStatus)
			for (const st of statuses) {
				assert.ok(st === 'Pending_Verification' || st === 'Under_Review')
			}
		})

		it('Scenario 7: Supports pagination with page, limit, and totalPages metadata', async () => {
			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getCredentialReviewQueue,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					query: { page: 1, limit: 2 },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.page, 1)
			assert.strictEqual(res.responseData?.data?.limit, 2)
			assert.ok(res.responseData?.data?.medicalOfficers.length <= 2)
		})

		it('Scenario 8: Supports filtering by status, medicalCouncil, and registrationState', async () => {
			const { doc } = await createDoctor('Pending_Verification', {
				medicalCouncil: 'Karnataka State Council Specific',
				registrationState: 'Karnataka',
			})

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getCredentialReviewQueue,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					query: {
						status: 'Pending_Verification',
						medicalCouncil: 'Karnataka State Council Specific',
						registrationState: 'Karnataka',
					},
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.ok(res.responseData?.data?.medicalOfficers.some((d) => d._id.toString() === doc._id.toString()))
		})

		it('Scenario 9: Supports queue search by doctor name or registration number', async () => {
			const uniqueReg = `REG-SEARCH-${Date.now()}`
			const { doc } = await createDoctor('Pending_Verification', {
				medicalRegistrationNumber: uniqueReg,
			})

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getCredentialReviewQueue,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					query: { search: uniqueReg },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.totalRecords, 1)
			assert.strictEqual(res.responseData?.data?.medicalOfficers[0]._id.toString(), doc._id.toString())
		})

		it('Scenario 10: GET review queue is strictly read-only and never mutates document state', async () => {
			const { doc } = await createDoctor('Pending_Verification')

			for (let i = 0; i < 3; i++) {
				const { res } = await executeAdminPipeline(
					adminCredentialReviewController.getCredentialReviewQueue,
					{ headers: { authorization: `Bearer ${adminToken}` } }
				)
				assert.strictEqual(res.statusCode, 200)
			}

			const reloaded = await userModel.findById(doc._id)
			assert.strictEqual(reloaded.credentialStatus, 'Pending_Verification')
		})
	})

	// =========================================================================
	// 3. Credential Review Dossier Details (Read-Only)
	// =========================================================================
	describe('3. Credential Review Dossier Details (Read-Only)', () => {
		it('Scenario 11: Retrieve individual doctor credential dossier with sanitized fields', async () => {
			const { doc } = await createDoctor('Pending_Verification')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getDoctorCredentialDetails,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			const dossier = res.responseData?.data
			assert.strictEqual(dossier.medicalOfficerId.toString(), doc._id.toString())
			assert.strictEqual(dossier.credentialStatus, 'Pending_Verification')
			assert.strictEqual(dossier.medicalRegistrationNumber, doc.medicalRegistrationNumber)
			assert.strictEqual(dossier.password, undefined)
			assert.strictEqual(dossier.tokenVersion, undefined)
		})

		it('Scenario 12: Invalid ObjectId format rejected with HTTP 400 Bad Request', async () => {
			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getDoctorCredentialDetails,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: 'invalid-mongo-id-123' },
				}
			)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Invalid Medical Officer ID format/i)
		})

		it('Scenario 13: Non-existent doctor ID returns HTTP 404 Not Found', async () => {
			const randomId = new mongoose.Types.ObjectId()
			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.getDoctorCredentialDetails,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: randomId.toString() },
				}
			)

			assert.strictEqual(res.statusCode, 404)
			assert.match(res.responseData?.message, /Medical Officer account not found/i)
		})

		it('Scenario 14: Anti-SSRF verification: backend NEVER fetches or downloads submitted evidence URL', async () => {
			let networkPinged = false
			const testServer = http.createServer((req, res) => {
				networkPinged = true
				res.writeHead(200, { 'Content-Type': 'text/plain' })
				res.end('OK')
			})

			await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve))
			const port = testServer.address().port

			try {
				const ssrfTargetUrl = `https://127.0.0.1:${port}/ssrf-canary-dossier.pdf`
				const { doc } = await createDoctor('Pending_Verification', {
					supportingEvidence: ssrfTargetUrl,
				})

				const { res } = await executeAdminPipeline(
					adminCredentialReviewController.getDoctorCredentialDetails,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: { id: doc._id.toString() },
					}
				)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(networkPinged, false, 'Backend must never fetch the evidence URL')
			} finally {
				await new Promise((resolve) => testServer.close(resolve))
			}
		})
	})

	// =========================================================================
	// 4. Start Credential Review (Pending_Verification -> Under_Review)
	// =========================================================================
	describe('4. Start Credential Review (Pending_Verification -> Under_Review)', () => {
		it('Scenario 15: Successful review claiming (Pending_Verification -> Under_Review, HTTP 200)', async () => {
			const { doc } = await createDoctor('Pending_Verification')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.startCredentialReview,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'Platform admin claiming dossier for verification' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Under_Review')
			assert.ok(res.responseData?.data?.credentialReviewStartedAt)

			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialStatus, 'Under_Review')
			assert.strictEqual(updated.credentialReviewStartedBy.toString(), testAdmin._id.toString())
		})

		it('Scenario 16: Rejects review-start when credentials already Under_Review (HTTP 409 Conflict)', async () => {
			const { doc } = await createDoctor('Under_Review')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.startCredentialReview,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /already under active administrative review/i)
		})

		it('Scenario 17: Rejects review-start when credentials are Unsubmitted, Verified, Rejected, or Suspended (HTTP 409)', async () => {
			const invalidStatuses = ['Unsubmitted', 'Verified', 'Rejected', 'Suspended']

			for (const st of invalidStatuses) {
				const { doc } = await createDoctor(st)

				const { res } = await executeAdminPipeline(
					adminCredentialReviewController.startCredentialReview,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: { id: doc._id.toString() },
					}
				)

				assert.strictEqual(res.statusCode, 409, `review-start from ${st} must reject with 409`)
			}
		})

		it('Scenario 18: Review-start persists CREDENTIAL_REVIEW_STARTED audit and outbox event', async () => {
			const { doc } = await createDoctor('Pending_Verification')

			await executeAdminPipeline(
				adminCredentialReviewController.startCredentialReview,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
				}
			)

			const audit = await AdministrativeDecisionAudit.findOne({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_REVIEW_STARTED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.previousStatus, 'Pending_Verification')
			assert.strictEqual(audit.newStatus, 'Under_Review')
			assert.strictEqual(audit.actorRole, 'ADMIN')
			assert.strictEqual(audit.actorModel, 'admin')

			const outbox = await NotificationOutbox.findOne({
				recipientUserId: doc._id,
				eventType: 'CREDENTIALS_REVIEW_STARTED',
			})
			assert.ok(outbox)
		})
	})

	// =========================================================================
	// 5. Request Additional Information / Clarification
	// =========================================================================
	describe('5. Request Additional Information / Clarification', () => {
		it('Scenario 19: Successful clarification request (Under_Review -> Pending_Verification, HTTP 200)', async () => {
			const { doc } = await createDoctor('Under_Review')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.requestAdditionalInfo,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { notes: 'Please provide state medical registration renewal receipt.' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Pending_Verification')
			assert.strictEqual(res.responseData?.data?.credentialClarificationRequested, true)
			assert.strictEqual(
				res.responseData?.data?.credentialClarificationNotes,
				'Please provide state medical registration renewal receipt.'
			)

			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialStatus, 'Pending_Verification')
			assert.strictEqual(updated.credentialClarificationRequested, true)
		})

		it('Scenario 20: Missing or short clarification notes (<5 chars) rejected with HTTP 400 Bad Request', async () => {
			const { doc } = await createDoctor('Under_Review')

			const invalidNotes = ['', '   ', 'fix', null, undefined]
			for (const notes of invalidNotes) {
				const { res } = await executeAdminPipeline(
					adminCredentialReviewController.requestAdditionalInfo,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: { id: doc._id.toString() },
						body: { notes },
					}
				)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData?.message, /at least 5 characters/i)
			}
		})

		it('Scenario 21: Rejects clarification request when status is not Under_Review (HTTP 409 Conflict)', async () => {
			const { doc } = await createDoctor('Pending_Verification')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.requestAdditionalInfo,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { notes: 'Clarify registration details' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /must be in 'Under_Review'/i)
		})

		it('Scenario 22: Clarification request persists CREDENTIAL_INFO_REQUESTED audit and outbox event', async () => {
			const { doc } = await createDoctor('Under_Review')

			await executeAdminPipeline(
				adminCredentialReviewController.requestAdditionalInfo,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { notes: 'Please upload council renewal endorsement.' },
				}
			)

			const audit = await AdministrativeDecisionAudit.findOne({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_INFO_REQUESTED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.previousStatus, 'Under_Review')
			assert.strictEqual(audit.newStatus, 'Pending_Verification')
			assert.strictEqual(audit.actorRole, 'ADMIN')

			const outbox = await NotificationOutbox.findOne({
				recipientUserId: doc._id,
				eventType: 'CREDENTIALS_INFO_REQUESTED',
			})
			assert.ok(outbox)
		})
	})

	// =========================================================================
	// 6. Approve Professional Credentials (Under_Review -> Verified)
	// =========================================================================
	describe('6. Approve Professional Credentials (Under_Review -> Verified)', () => {
		it('Scenario 23: Successful credential approval (Under_Review -> Verified, HTTP 200)', async () => {
			const { doc } = await createDoctor('Under_Review')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.approveCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'Council verification complete and confirmed' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Verified')
			assert.strictEqual(res.responseData?.data?.verificationStatus, 'Verified')
			assert.ok(res.responseData?.data?.credentialVerifiedAt)

			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialStatus, 'Verified')
			assert.strictEqual(updated.verificationStatus, 'Verified')
			assert.strictEqual(updated.credentialVerifiedBy.toString(), testAdmin._id.toString())
		})

		it('Scenario 24: Rejects approval when credentials are not Under_Review (HTTP 409 Conflict)', async () => {
			const { doc } = await createDoctor('Pending_Verification')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.approveCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /must be in 'Under_Review' status/i)
		})

		it('Scenario 25: Approval persists CREDENTIAL_APPROVED audit and outbox event', async () => {
			const { doc } = await createDoctor('Under_Review')

			await executeAdminPipeline(
				adminCredentialReviewController.approveCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
				}
			)

			const audit = await AdministrativeDecisionAudit.findOne({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_APPROVED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.previousStatus, 'Under_Review')
			assert.strictEqual(audit.newStatus, 'Verified')

			const outbox = await NotificationOutbox.findOne({
				recipientUserId: doc._id,
				eventType: 'CREDENTIALS_APPROVED',
			})
			assert.ok(outbox)
		})

		it('Scenario 26: Professional credential approval does NOT activate hospital association or bypass Gate 3', async () => {
			const { doc } = await createDoctor('Under_Review')

			await executeAdminPipeline(
				adminCredentialReviewController.approveCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
				}
			)

			// Zero hospital associations must exist
			const associations = await MedicalOfficerHospital.find({ medicalOfficerUserId: doc._id })
			assert.strictEqual(associations.length, 0)
		})
	})

	// =========================================================================
	// 7. Reject Professional Credentials (Under_Review -> Rejected)
	// =========================================================================
	describe('7. Reject Professional Credentials (Under_Review -> Rejected)', () => {
		it('Scenario 27: Successful credential rejection with reason (Under_Review -> Rejected, HTTP 200)', async () => {
			const { doc } = await createDoctor('Under_Review')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.rejectCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'Registration number mismatch with state council records.' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Rejected')
			assert.strictEqual(
				res.responseData?.data?.credentialRejectionReason,
				'Registration number mismatch with state council records.'
			)

			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialStatus, 'Rejected')
			assert.strictEqual(updated.verificationStatus, 'Rejected')
			assert.strictEqual(
				updated.credentialRejectionReason,
				'Registration number mismatch with state council records.'
			)
		})

		it('Scenario 28: Missing or short rejection reason (<5 chars) rejected with HTTP 400 Bad Request', async () => {
			const { doc } = await createDoctor('Under_Review')

			const invalidReasons = ['', '   ', 'bad', null, undefined]
			for (const reason of invalidReasons) {
				const { res } = await executeAdminPipeline(
					adminCredentialReviewController.rejectCredentials,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: { id: doc._id.toString() },
						body: { reason },
					}
				)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData?.message, /at least 5 characters/i)
			}
		})

		it('Scenario 29: Rejects rejection when credentials are not Under_Review (HTTP 409 Conflict)', async () => {
			const { doc } = await createDoctor('Pending_Verification')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.rejectCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'Invalid registration' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /must be in 'Under_Review'/i)
		})

		it('Scenario 30: Rejection persists CREDENTIAL_REJECTED audit and outbox event', async () => {
			const { doc } = await createDoctor('Under_Review')

			await executeAdminPipeline(
				adminCredentialReviewController.rejectCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'Illegible registration document' },
				}
			)

			const audit = await AdministrativeDecisionAudit.findOne({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_REJECTED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.previousStatus, 'Under_Review')
			assert.strictEqual(audit.newStatus, 'Rejected')

			const outbox = await NotificationOutbox.findOne({
				recipientUserId: doc._id,
				eventType: 'CREDENTIALS_REJECTED',
			})
			assert.ok(outbox)
		})
	})

	// =========================================================================
	// 8. Credential Suspension (Verified -> Suspended)
	// =========================================================================
	describe('8. Credential Suspension (Verified -> Suspended)', () => {
		it('Scenario 31: Successful credential suspension (Verified -> Suspended, HTTP 200)', async () => {
			const { doc } = await createDoctor('Verified')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.suspendCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'State medical council license temporarily suspended pending inquiry.' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Suspended')
			assert.strictEqual(res.responseData?.data?.verificationStatus, 'Suspended')
			assert.ok(res.responseData?.data?.credentialSuspendedAt)

			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialStatus, 'Suspended')
			assert.strictEqual(updated.verificationStatus, 'Suspended')
			assert.strictEqual(updated.credentialSuspendedBy.toString(), testAdmin._id.toString())
		})

		it('Scenario 32: Missing or short suspension reason (<5 chars) rejected with HTTP 400 Bad Request', async () => {
			const { doc } = await createDoctor('Verified')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.suspendCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'bad' },
				}
			)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /at least 5 characters/i)
		})

		it('Scenario 33: Rejects suspension when credentials are not Verified (HTTP 409 Conflict)', async () => {
			const { doc } = await createDoctor('Under_Review')

			const { res } = await executeAdminPipeline(
				adminCredentialReviewController.suspendCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'Suspension attempt' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /Only 'Verified' credentials can be suspended/i)
		})

		it('Scenario 34: Suspension persists CREDENTIAL_SUSPENDED audit and outbox event', async () => {
			const { doc } = await createDoctor('Verified')

			await executeAdminPipeline(
				adminCredentialReviewController.suspendCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'Administrative disciplinary suspension' },
				}
			)

			const audit = await AdministrativeDecisionAudit.findOne({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_SUSPENDED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.previousStatus, 'Verified')
			assert.strictEqual(audit.newStatus, 'Suspended')

			const outbox = await NotificationOutbox.findOne({
				recipientUserId: doc._id,
				eventType: 'CREDENTIALS_SUSPENDED',
			})
			assert.ok(outbox)
		})
	})

	// =========================================================================
	// 9. Invariants, Concurrency, ACID Safety & Integration
	// =========================================================================
	describe('9. Invariants, Concurrency, ACID Safety & Integration', () => {
		it('Scenario 35: Mass-assignment attempts with protected lifecycle fields strictly rejected (HTTP 400)', async () => {
			const forbiddenFields = [
				{ role: 'ADMIN' },
				{ credentialStatus: 'Verified' },
				{ verificationStatus: 'Verified' },
				{ accountStatus: 'Active' },
				{ permissions: ['VERIFY_EMERGENCY_REQUESTS'] },
				{ isVerified: true },
				{ actorId: testAdmin._id },
				{ hospitalId: testHospital._id },
				{ associationStatus: 'Approved' },
			]

			for (const payload of forbiddenFields) {
				const { doc } = await createDoctor('Pending_Verification')
				const { res } = await executeAdminPipeline(
					adminCredentialReviewController.startCredentialReview,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: { id: doc._id.toString() },
						body: { reason: 'Legitimate reason', ...payload },
					}
				)
				assert.strictEqual(res.statusCode, 400, `Payload with ${Object.keys(payload)[0]} must return 400`)
				assert.match(res.responseData?.message, /Mass-assignment violation/i)
			}
		})

		it('Scenario 36: Concurrency Race Condition: Simultaneous review-start calls safely resolve with one 200 and one 409', async () => {
			const { doc } = await createDoctor('Pending_Verification')

			const runClaim = async () => {
				return await executeAdminPipeline(
					adminCredentialReviewController.startCredentialReview,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: { id: doc._id.toString() },
						body: { reason: 'Concurrent claim attempt' },
					}
				)
			}

			const [res1, res2] = await Promise.all([runClaim(), runClaim()])
			const statusCodes = [res1.res.statusCode, res2.res.statusCode].sort()

			assert.deepStrictEqual(statusCodes, [200, 409], 'Exactly one review-start succeeds with 200; concurrent attempt returns 409')

			const audits = await AdministrativeDecisionAudit.find({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_REVIEW_STARTED',
			})
			assert.strictEqual(audits.length, 1, 'Only one audit record must be committed')
		})

		it('Scenario 37: Concurrency Race Condition: Simultaneous approval calls safely resolve with one 200 and one 409', async () => {
			const { doc } = await createDoctor('Under_Review')

			const runApprove = async () => {
				return await executeAdminPipeline(
					adminCredentialReviewController.approveCredentials,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: { id: doc._id.toString() },
						body: { reason: 'Concurrent approval attempt' },
					}
				)
			}

			const [res1, res2] = await Promise.all([runApprove(), runApprove()])
			const statusCodes = [res1.res.statusCode, res2.res.statusCode].sort()

			assert.deepStrictEqual(statusCodes, [200, 409], 'Exactly one approval succeeds with 200; concurrent attempt returns 409')

			const audits = await AdministrativeDecisionAudit.find({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_APPROVED',
			})
			assert.strictEqual(audits.length, 1, 'Only one audit record must be committed')
		})

		it('Scenario 38: Transaction Rollback & ACID Safety: Outbox creation failure rolls back credential status and audit entry', async () => {
			const { doc } = await createDoctor('Under_Review')

			// Intercept NotificationOutbox.create once to force failure
			const originalCreate = NotificationOutbox.create
			NotificationOutbox.create = async function () {
				throw new Error('SIMULATED_OUTBOX_CRASH_DURING_APPROVAL')
			}

			try {
				const { res } = await executeAdminPipeline(
					adminCredentialReviewController.approveCredentials,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: { id: doc._id.toString() },
						body: { reason: 'Test approval rollback' },
					}
				)

				assert.strictEqual(res.statusCode, 500)
			} finally {
				NotificationOutbox.create = originalCreate
			}

			// Doctor status remains Under_Review
			const reloaded = await userModel.findById(doc._id)
			assert.strictEqual(reloaded.credentialStatus, 'Under_Review')

			// No audit record created
			const audits = await AdministrativeDecisionAudit.countDocuments({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_APPROVED',
			})
			assert.strictEqual(audits, 0)
		})

		it('Scenario 39: Existing Stage B3.4.2 Resubmission Compatibility: Doctor resubmits after clarification and rejection', async () => {
			// Doctor starts Under_Review
			const { doc, token } = await createDoctor('Under_Review')

			// 1. Admin requests clarification
			await executeAdminPipeline(
				adminCredentialReviewController.requestAdditionalInfo,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { notes: 'Please provide updated specialization certificate.' },
				}
			)

			// Doctor resubmits via B3.4.2 PATCH /credentials/resubmit
			const { req: rReq, res: rRes } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
				user: await userModel.findById(doc._id),
				body: {
					qualification: 'MBBS, MD Cardiology',
					supportingEvidence: 'https://example.com/updated-cardio.pdf',
				},
			})

			await medicalOfficerCredentialController.resubmitCredentials(rReq, rRes, () => {})
			assert.strictEqual(rRes.statusCode, 200)
			assert.strictEqual(rRes.responseData?.data?.credentialStatus, 'Pending_Verification')

			// 2. Admin claims again
			await executeAdminPipeline(
				adminCredentialReviewController.startCredentialReview,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
				}
			)

			// 3. Admin rejects
			await executeAdminPipeline(
				adminCredentialReviewController.rejectCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { id: doc._id.toString() },
					body: { reason: 'Specialization certificate was expired' },
				}
			)

			// Doctor resubmits again after rejection
			const { req: rReq2, res: rRes2 } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
				user: await userModel.findById(doc._id),
				body: {
					qualification: 'MBBS, MD Cardiology Fellow',
					supportingEvidence: 'https://example.com/new-valid-cardio.pdf',
				},
			})

			await medicalOfficerCredentialController.resubmitCredentials(rReq2, rRes2, () => {})
			assert.strictEqual(rRes2.statusCode, 200)
			assert.strictEqual(rRes2.responseData?.data?.credentialStatus, 'Pending_Verification')

			// 4. Verify end-to-end audit ledger integrity
			const integrity = await verifyAuditChainIntegrity()
			assert.strictEqual(integrity.isValid, true, `Audit chain must be valid. Errors: ${integrity.errors?.join(', ')}`)
			assert.ok(integrity.totalRecords >= 4)
		})

		it('Scenario 40: Three-Gate Clinical Authorization Regression: Under_Review, Rejected, and Suspended doctors strictly fail Gate 2', async () => {
			const statuses = ['Under_Review', 'Rejected', 'Suspended']

			for (const st of statuses) {
				const { token } = await createDoctor(st)

				const { req, res } = createMockReqRes({
					headers: { authorization: `Bearer ${token}` },
				})

				await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
				assert.strictEqual(res.statusCode, 403, `Doctor in ${st} must be blocked from clinical gate with HTTP 403`)
			}
		})
	})
})
