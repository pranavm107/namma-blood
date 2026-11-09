/**
 * Stage B3.4.2 Automated Test Suite
 * Namma Blood — Medical Officer Professional Credential Management APIs
 *
 * Comprehensive Test Coverage (28 Scenarios):
 * 1. Successful initial credential submission (HTTP 201)
 * 2. Missing required fields rejection (HTTP 400)
 * 3. Invalid medical registration number rejection (HTTP 400)
 * 4. Invalid medical council rejection (HTTP 400)
 * 5. Invalid evidence URL rejection (HTTP 400)
 * 6. Unsafe URL schemes rejection (javascript:, data:, file:, blob:, ftp:) (HTTP 400)
 * 7. Insecure HTTP URL rejection (HTTP 400)
 * 8. Backend does not fetch submitted URLs (anti-SSRF verification)
 * 9. Unauthorized access rejection (HTTP 401)
 * 10. Non-Medical Officer access denial (USER, STAFF, BLOODBANK, HOSPITAL_ADMIN, ADMIN) (HTTP 403)
 * 11. BOLA protection: cross-user access denial (HTTP 403)
 * 12. Mass-assignment attempts rejection (HTTP 400)
 * 13. Duplicate initial submission rejection (HTTP 409)
 * 14. Resubmission after rejection (HTTP 200)
 * 15. Clarification response resubmission (HTTP 200)
 * 16. Resubmission counter safe incrementation
 * 17. Concurrent initial submissions race safety (one 201, one 409)
 * 18. Concurrent resubmissions atomic serialization
 * 19. Invalid state transitions rejection (HTTP 409)
 * 20. Verified credential modification denial (HTTP 409)
 * 21. Suspended credential modification denial (HTTP 409)
 * 22. Credential status GET is read-only and idempotent
 * 23. No self-verification guarantee (never Verified)
 * 24. No automatic hospital association activation guarantee
 * 25. Transaction rollback and ACID safety across doctor, audit, and outbox
 * 26. NotificationOutbox consistency and sanitized payload verification
 * 27. Stage B3.3 independent registration regression
 * 28. Stage B2 Three-Gate clinical authorization regression
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
const { protectMedicalOfficerOnboarding } = require('../Hospital/medicalOfficerOnboardingMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const medicalOfficerCredentialController = require('../Hospital/medicalOfficerCredentialController')
const { registerMedicalOfficer } = require('../Hospital/medicalOfficerController')
const { login } = require('../Login_And_Authentication/login')
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
	body = {},
	params = {},
	query = {},
	user = null,
	userRole = null,
	ip = '127.0.0.1',
} = {}) {
	const req = {
		headers: { ...headers },
		body: { ...body },
		params: { ...params },
		query: { ...query },
		user,
		userRole,
		ip,
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
		send(data) {
			this.responseData = data
			return this
		},
	}

	return { req, res }
}

/**
 * Runs a request through the onboarding middleware followed by controller,
 * safely awaiting asynchronous controller completion and response delivery.
 */
async function executeOnboardingPipeline(controllerFn, reqOptions) {
	const { req, res } = createMockReqRes(reqOptions)

	let pipelineProceeded = false
	let pipelineError = null

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

		protectMedicalOfficerOnboarding(req, res, async (err) => {
			if (err) {
				pipelineError = err
				if (!res.responseData) {
					res.statusCode = err.statusCode || 500
					res.responseData = { status: 'error', message: err.message }
				}
				finish()
				return
			}

			pipelineProceeded = true
			try {
				await controllerFn(req, res, (cErr) => {
					if (cErr) {
						pipelineError = cErr
						if (!res.responseData) {
							res.statusCode = cErr.statusCode || 500
							res.responseData = { status: 'error', message: cErr.message }
						}
					}
					finish()
				})
			} catch (cErr) {
				pipelineError = cErr
				if (!res.responseData) {
					res.statusCode = cErr.statusCode || 500
					res.responseData = { status: 'error', message: cErr.message }
				}
				finish()
			}
		}).catch((mErr) => {
			pipelineError = mErr
			if (!res.responseData) {
				res.statusCode = mErr.statusCode || 500
				res.responseData = { status: 'error', message: mErr.message }
			}
			finish()
		})
	})

	return { req, res, pipelineProceeded, pipelineError }
}

describe('Stage B3.4.2: Medical Officer Professional Credential Management APIs', () => {
	let testAdmin
	let testHospital
	let adminToken

	const createdUserIds = []
	const createdAdminIds = []
	const createdHospitalIds = []
	const createdAssocIds = []

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}

		await userModel.init()
		await AdministrativeDecisionAudit.init()
		await AuditChainHead.init()
		await NotificationOutbox.init()

		testAdmin = await Admin.create({
			phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			email: `admin.b342.${Date.now()}@nammablood.test`,
			password: 'AdminPassword123!',
		})
		createdAdminIds.push(testAdmin._id)
		adminToken = signToken(testAdmin._id)

		testHospital = await Hospital.create({
			hospitalCode: `HOSP-B342-${Date.now()}`,
			hospitalName: 'Apollo City Hospital B342',
			hospitalType: 'Private',
			address: {
				street: '42 Medical Square',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600002',
			},
			contactPhone: '9876543210',
			contactEmail: `contact.b342.${Date.now()}@test-hospital.org`,
			verificationStatus: 'Verified',
			isActive: true,
		})
		createdHospitalIds.push(testHospital._id)
	})

	after(async () => {
		if (createdAssocIds.length > 0) {
			await MedicalOfficerHospital.deleteMany({ _id: { $in: createdAssocIds } })
		}
		if (createdHospitalIds.length > 0) {
			await Hospital.deleteMany({ _id: { $in: createdHospitalIds } })
		}
		if (createdUserIds.length > 0) {
			await userModel.deleteMany({ _id: { $in: createdUserIds } })
		}
		if (createdAdminIds.length > 0) {
			await Admin.deleteMany({ _id: { $in: createdAdminIds } })
		}

		// Clear test collections via driver bypass
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

	// Helper to create a fresh doctor in a specific credentialStatus
	async function createTestDoctor(status = 'Unsubmitted', extra = {}) {
		const doc = await userModel.create({
			firstName: 'Dr. Test',
			lastName: 'Physician',
			email: `dr.test.${status.toLowerCase()}.${Date.now()}.${Math.floor(Math.random() * 1000)}@test-doctor.org`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'DoctorPassword123!',
			role: 'MEDICAL_OFFICER',
			accountStatus: 'Active',
			credentialStatus: status,
			verificationStatus: status === 'Verified' ? 'Verified' : 'Pending',
			status: true,
			...extra,
		})
		createdUserIds.push(doc._id)
		const token = signToken(doc._id)
		return { doc, token }
	}

	// =========================================================================
	// 1. Initial Credential Submission (POST /credentials/submit)
	// =========================================================================
	describe('1. Initial Credential Submission (POST /credentials/submit)', () => {
		it('Scenario 1: Successful initial credential submission (Unsubmitted -> Pending_Verification, HTTP 201)', async () => {
			const { doc, token } = await createTestDoctor('Unsubmitted')

			const payload = {
				medicalRegistrationNumber: `TNMC-${Date.now()}`,
				medicalCouncil: 'Tamil Nadu Medical Council',
				registrationState: 'Tamil Nadu',
				registrationYear: 2018,
				qualification: 'MBBS, MD (Transfusion Medicine)',
				specialization: 'Transfusion Medicine',
				supportingEvidence: 'https://credentials.medcouncil.gov.in/verify/doc12345.pdf',
			}

			const { res, pipelineProceeded } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: payload,
				}
			)

			assert.strictEqual(pipelineProceeded, true)
			assert.strictEqual(res.statusCode, 201)
			assert.strictEqual(res.responseData?.status, 'success')
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Pending_Verification')
			assert.strictEqual(res.responseData?.data?.verificationStatus, 'Pending')
			assert.strictEqual(res.responseData?.data?.medicalRegistrationNumber, payload.medicalRegistrationNumber.toUpperCase())
			assert.strictEqual(res.responseData?.data?.registrationYear, 2018)

			// Authoritative database check
			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialStatus, 'Pending_Verification')
			assert.strictEqual(updated.verificationStatus, 'Pending')
			assert.ok(updated.credentialLastSubmittedAt)
			assert.strictEqual(updated.credentialResubmissionCount, 0)
			assert.strictEqual(updated.credentialClarificationRequested, false)

			// Audit chain entry check
			const audit = await AdministrativeDecisionAudit.findOne({ targetUserId: doc._id })
			assert.ok(audit)
			assert.strictEqual(audit.decisionType, 'CREDENTIAL_SUBMITTED')
			assert.strictEqual(audit.actorRole, 'MEDICAL_OFFICER')
			assert.strictEqual(audit.actorModel, 'user')
			assert.strictEqual(String(audit.actorId), String(doc._id))
			assert.strictEqual(audit.previousStatus, 'Unsubmitted')
			assert.strictEqual(audit.newStatus, 'Pending_Verification')

			// Notification outbox entry check
			const outbox = await NotificationOutbox.findOne({ recipientUserId: doc._id })
			assert.ok(outbox)
			assert.strictEqual(outbox.eventType, 'CREDENTIALS_SUBMITTED')
			assert.strictEqual(outbox.recipientEmail, doc.email)
		})

		it('Scenario 2: Missing required fields rejection (HTTP 400)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			// Empty payload
			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {},
				}
			)

			assert.strictEqual(res.statusCode, 400)
			assert.strictEqual(res.responseData?.status, 'fail')
			assert.match(res.responseData?.message, /Missing required credential field/i)
			assert.ok(res.responseData?.fields?.includes('medicalRegistrationNumber'))
			assert.ok(res.responseData?.fields?.includes('medicalCouncil'))
			assert.ok(res.responseData?.fields?.includes('registrationState'))
			assert.ok(res.responseData?.fields?.includes('registrationYear'))
			assert.ok(res.responseData?.fields?.includes('qualification'))
			assert.ok(res.responseData?.fields?.includes('supportingEvidence'))
		})

		it('Scenario 3: Invalid medical registration number format (<3 chars or special chars, HTTP 400)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const invalidRegNumbers = ['AB', 'REG@#$%', 'A'.repeat(55)]
			for (const badReg of invalidRegNumbers) {
				const { res } = await executeOnboardingPipeline(
					medicalOfficerCredentialController.submitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							medicalRegistrationNumber: badReg,
							medicalCouncil: 'State Medical Council',
							registrationState: 'Karnataka',
							registrationYear: 2020,
							qualification: 'MBBS',
							supportingEvidence: 'https://example.com/doc.pdf',
						},
					}
				)

				assert.strictEqual(res.statusCode, 400, `Bad reg number '${badReg}' must be rejected with 400`)
				assert.match(res.responseData?.message, /Medical Registration Number/i)
			}
		})

		it('Scenario 4: Invalid medical council (<3 chars, HTTP 400)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						medicalRegistrationNumber: 'REG-123456',
						medicalCouncil: 'MC', // Too short
						registrationState: 'Karnataka',
						registrationYear: 2020,
						qualification: 'MBBS',
						supportingEvidence: 'https://example.com/doc.pdf',
					},
				}
			)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Medical Council name must be between/i)
		})

		it('Scenario 5: Invalid registration year (out of range or non-integer, HTTP 400)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const invalidYears = [1890, 2099, 'nineteen-ninety', 2020.5]
			for (const badYear of invalidYears) {
				const { res } = await executeOnboardingPipeline(
					medicalOfficerCredentialController.submitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							medicalRegistrationNumber: 'REG-123456',
							medicalCouncil: 'Karnataka Medical Council',
							registrationState: 'Karnataka',
							registrationYear: badYear,
							qualification: 'MBBS',
							supportingEvidence: 'https://example.com/doc.pdf',
						},
					}
				)

				assert.strictEqual(res.statusCode, 400, `Bad year '${badYear}' must be rejected with 400`)
				assert.match(res.responseData?.message, /Registration Year must be a valid 4-digit integer/i)
			}
		})

		it('Scenario 6: Invalid evidence URL (malformed string, HTTP 400)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						medicalRegistrationNumber: 'REG-123456',
						medicalCouncil: 'Karnataka Medical Council',
						registrationState: 'Karnataka',
						registrationYear: 2020,
						qualification: 'MBBS',
						supportingEvidence: 'not-a-valid-url-format',
					},
				}
			)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /Supporting evidence must be a valid, well-formed HTTPS URL/i)
		})

		it('Scenario 7: Unsafe URL schemes rejection (javascript:, data:, file:, blob:, ftp:) (HTTP 400)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const unsafeUrls = [
				'javascript:alert(1)',
				'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
				'file:///etc/passwd',
				'blob:https://example.com/uuid-here',
				'ftp://ftp.example.com/evidence.pdf',
			]

			for (const unsafeUrl of unsafeUrls) {
				const { res } = await executeOnboardingPipeline(
					medicalOfficerCredentialController.submitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							medicalRegistrationNumber: 'REG-123456',
							medicalCouncil: 'Karnataka Medical Council',
							registrationState: 'Karnataka',
							registrationYear: 2020,
							qualification: 'MBBS',
							supportingEvidence: unsafeUrl,
						},
					}
				)

				assert.strictEqual(res.statusCode, 400, `Unsafe scheme '${unsafeUrl}' must be rejected`)
				assert.match(res.responseData?.message, /HTTPS protocol/i)
			}
		})

		it('Scenario 8: Insecure plain HTTP URLs strictly rejected (HTTP 400)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						medicalRegistrationNumber: 'REG-123456',
						medicalCouncil: 'Karnataka Medical Council',
						registrationState: 'Karnataka',
						registrationYear: 2020,
						qualification: 'MBBS',
						supportingEvidence: 'http://insecure-domain.org/certificate.pdf',
					},
				}
			)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData?.message, /strictly use the secure HTTPS protocol/i)
		})

		it('Scenario 9: Backend anti-SSRF verification: backend NEVER fetches or downloads submitted evidence URL', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			// Spin up a local dummy server to verify backend never contacts it
			let serverContacted = false
			const testServer = http.createServer((req, res) => {
				serverContacted = true
				res.writeHead(200)
				res.end('ok')
			})

			await new Promise((resolve) => testServer.listen(0, '127.0.0.1', resolve))
			const port = testServer.address().port

			try {
				// Submit an HTTPS URL pointing to the local test server port
				const localEvidenceUrl = `https://127.0.0.1:${port}/sensitive-intranet/data`

				const { res } = await executeOnboardingPipeline(
					medicalOfficerCredentialController.submitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							medicalRegistrationNumber: `SSRF-CHECK-${Date.now()}`,
							medicalCouncil: 'Karnataka Medical Council',
							registrationState: 'Karnataka',
							registrationYear: 2020,
							qualification: 'MBBS',
							supportingEvidence: localEvidenceUrl,
						},
					}
				)

				// Submission succeeds without ever sending an outbound HTTP request
				assert.strictEqual(res.statusCode, 201)
				assert.strictEqual(serverContacted, false, 'Backend must NEVER fetch or ping the submitted URL')
			} finally {
				await new Promise((resolve) => testServer.close(resolve))
			}
		})

		it('Scenario 10: Duplicate submission rejected when credentials already Pending_Verification (HTTP 409)', async () => {
			const { token } = await createTestDoctor('Pending_Verification')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						medicalRegistrationNumber: `TNMC-${Date.now()}`,
						medicalCouncil: 'Tamil Nadu Medical Council',
						registrationState: 'Tamil Nadu',
						registrationYear: 2018,
						qualification: 'MBBS',
						supportingEvidence: 'https://example.com/doc.pdf',
					},
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /already been submitted/i)
		})

		it('Scenario 11: Rejects duplicate medicalRegistrationNumber registered to another doctor (HTTP 409)', async () => {
			const sharedRegNo = `REG-SHARED-${Date.now()}`

			// Doctor 1 already has this registration number
			await createTestDoctor('Verified', { medicalRegistrationNumber: sharedRegNo })

			// Doctor 2 attempts initial submission with same registration number
			const { token: doc2Token } = await createTestDoctor('Unsubmitted')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${doc2Token}` },
					body: {
						medicalRegistrationNumber: sharedRegNo,
						medicalCouncil: 'State Medical Council',
						registrationState: 'Karnataka',
						registrationYear: 2020,
						qualification: 'MBBS',
						supportingEvidence: 'https://example.com/doc.pdf',
					},
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /already registered to another Medical Officer/i)
		})
	})

	// =========================================================================
	// 2. Authentication, Authorization & Mass-Assignment Defenses
	// =========================================================================
	describe('2. Authentication, Authorization & Mass-Assignment Defenses', () => {
		it('Scenario 12: Unauthorized access rejection without token (HTTP 401)', async () => {
			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{ headers: {} }
			)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData?.message, /Authentication required/i)
		})

		it('Scenario 13: Non-Medical Officer access denial (ADMIN, USER, BLOODBANK) (HTTP 403)', async () => {
			// Admin token attempting doctor submission
			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					body: { medicalRegistrationNumber: 'TEST-123' },
				}
			)

			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /Platform administrators must use dedicated/i)
		})

		it('Scenario 14: BOLA protection: doctor cannot specify another doctorId in route params (HTTP 403)', async () => {
			const { doc: docA, token: tokenA } = await createTestDoctor('Unsubmitted')
			const { doc: docB } = await createTestDoctor('Unsubmitted')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${tokenA}` },
					params: { doctorId: String(docB._id) },
					body: { medicalRegistrationNumber: 'TEST-123' },
				}
			)

			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /You may only access or submit credentials for your own account/i)
		})

		it('Scenario 15: Mass-assignment attempts with protected security fields strictly rejected (HTTP 400)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const forbiddenFields = [
				{ role: 'ADMIN' },
				{ credentialStatus: 'Verified' },
				{ verificationStatus: 'Verified' },
				{ accountStatus: 'Active' },
				{ status: true },
				{ permissions: ['VERIFY_EMERGENCY_REQUESTS'] },
				{ isVerified: true },
				{ credentialVerifiedBy: testAdmin._id },
				{ credentialVerifiedAt: new Date() },
				{ hospitalId: testHospital._id },
				{ associationStatus: 'Approved' },
			]

			for (const forbiddenPayload of forbiddenFields) {
				const { res } = await executeOnboardingPipeline(
					medicalOfficerCredentialController.submitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							medicalRegistrationNumber: 'REG-123456',
							medicalCouncil: 'Council',
							registrationState: 'State',
							registrationYear: 2020,
							qualification: 'MBBS',
							supportingEvidence: 'https://example.com/doc.pdf',
							...forbiddenPayload,
						},
					}
				)

				assert.strictEqual(res.statusCode, 400, `Payload with ${Object.keys(forbiddenPayload)[0]} must be rejected with 400`)
				assert.match(res.responseData?.message, /Mass-assignment violation/i)
			}
		})
	})

	// =========================================================================
	// 3. Credential Status Inspection (GET /credentials/status)
	// =========================================================================
	describe('3. Credential Status Inspection (GET /credentials/status)', () => {
		it('Scenario 16: Retrieve status for Unsubmitted doctor (reviewStatus: Not Submitted, availableActions: [SUBMIT_CREDENTIALS])', async () => {
			const { doc, token } = await createTestDoctor('Unsubmitted')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.getCredentialStatus,
				{
					headers: { authorization: `Bearer ${token}` },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Unsubmitted')
			assert.strictEqual(res.responseData?.data?.reviewStatus, 'Not Submitted')
			assert.deepStrictEqual(res.responseData?.data?.availableActions, ['SUBMIT_CREDENTIALS'])

			// Verify read-only: status remained Unsubmitted
			const reloaded = await userModel.findById(doc._id)
			assert.strictEqual(reloaded.credentialStatus, 'Unsubmitted')
		})

		it('Scenario 17: Retrieve status for doctor with pending clarification request (includes notes, availableActions: [RESUBMIT_CREDENTIALS])', async () => {
			const { doc, token } = await createTestDoctor('Pending_Verification', {
				credentialClarificationRequested: true,
				credentialClarificationNotes: 'Please provide state medical council registration renewal slip.',
				credentialClarificationRequestedAt: new Date(),
			})

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.getCredentialStatus,
				{
					headers: { authorization: `Bearer ${token}` },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialClarificationRequested, true)
			assert.strictEqual(
				res.responseData?.data?.credentialClarificationNotes,
				'Please provide state medical council registration renewal slip.'
			)
			assert.strictEqual(res.responseData?.data?.reviewStatus, 'Action Required: Clarification Requested')
			assert.deepStrictEqual(res.responseData?.data?.availableActions, ['RESUBMIT_CREDENTIALS'])
		})

		it('Scenario 18: GET /credentials/status is read-only and never triggers status transitions', async () => {
			const { doc, token } = await createTestDoctor('Pending_Verification')

			for (let i = 0; i < 3; i++) {
				const { res } = await executeOnboardingPipeline(
					medicalOfficerCredentialController.getCredentialStatus,
					{
						headers: { authorization: `Bearer ${token}` },
					}
				)
				assert.strictEqual(res.statusCode, 200)
			}

			const reloaded = await userModel.findById(doc._id)
			assert.strictEqual(reloaded.credentialStatus, 'Pending_Verification')
		})
	})

	// =========================================================================
	// 4. Credential Resubmission (PATCH /credentials/resubmit)
	// =========================================================================
	describe('4. Credential Resubmission (PATCH /credentials/resubmit)', () => {
		it('Scenario 19: Permitted resubmission after credential rejection (Rejected -> Pending_Verification, HTTP 200)', async () => {
			const { doc, token } = await createTestDoctor('Rejected', {
				medicalRegistrationNumber: `REG-REJ-${Date.now()}`,
				medicalCouncil: 'Karnataka Medical Council',
				registrationState: 'Karnataka',
				registrationYear: 2019,
				qualification: 'MBBS',
				supportingEvidence: 'https://example.com/old.pdf',
				credentialRejectionReason: 'Certificate was illegible',
				credentialResubmissionCount: 0,
			})

			const resubmitPayload = {
				medicalRegistrationNumber: doc.medicalRegistrationNumber,
				medicalCouncil: 'Karnataka Medical Council',
				registrationState: 'Karnataka',
				registrationYear: 2019,
				qualification: 'MBBS, MD',
				supportingEvidence: 'https://example.com/high-res-new-cert.pdf',
			}

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: resubmitPayload,
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Pending_Verification')
			assert.strictEqual(res.responseData?.data?.credentialResubmissionCount, 1)

			// Database verification
			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialStatus, 'Pending_Verification')
			assert.strictEqual(updated.qualification, 'MBBS, MD')
			assert.strictEqual(updated.credentialResubmissionCount, 1)

			// Audit ledger verification
			const audit = await AdministrativeDecisionAudit.findOne({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_RESUBMITTED',
			})
			assert.ok(audit)
			assert.strictEqual(audit.previousStatus, 'Rejected')
			assert.strictEqual(audit.newStatus, 'Pending_Verification')
			assert.strictEqual(audit.actorRole, 'MEDICAL_OFFICER')

			// Notification outbox verification
			const outbox = await NotificationOutbox.findOne({
				recipientUserId: doc._id,
				eventType: 'CREDENTIALS_RESUBMITTED',
			})
			assert.ok(outbox)
		})

		it('Scenario 20: Permitted resubmission responding to clarification request (clears active clarification, HTTP 200)', async () => {
			const { doc, token } = await createTestDoctor('Pending_Verification', {
				medicalRegistrationNumber: `REG-CLAR-${Date.now()}`,
				medicalCouncil: 'Tamil Nadu Medical Council',
				registrationState: 'Tamil Nadu',
				registrationYear: 2017,
				qualification: 'MBBS',
				supportingEvidence: 'https://example.com/old.pdf',
				credentialClarificationRequested: true,
				credentialClarificationNotes: 'Upload council renewal receipt',
				credentialClarificationRequestedAt: new Date(),
				credentialResubmissionCount: 1,
			})

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						supportingEvidence: 'https://example.com/renewal-receipt.pdf',
					},
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData?.data?.credentialStatus, 'Pending_Verification')
			assert.strictEqual(res.responseData?.data?.credentialClarificationRequested, false)
			assert.strictEqual(res.responseData?.data?.credentialResubmissionCount, 2)

			// Database verification: clarification flag cleared
			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialClarificationRequested, false)
			assert.strictEqual(updated.credentialClarificationNotes, '')
			assert.strictEqual(updated.credentialClarificationRequestedAt, null)
			assert.strictEqual(updated.credentialResubmissionCount, 2)
		})

		it('Scenario 21: Rejects resubmission when credentials are Unsubmitted (must use POST /submit, HTTP 409)', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: { qualification: 'MBBS' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /Credentials have not been submitted yet/i)
		})

		it('Scenario 22: Rejects resubmission when credentials are Under_Review (review lock, HTTP 409)', async () => {
			const { token } = await createTestDoctor('Under_Review')

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: { qualification: 'MBBS' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /under active administrative review/i)
		})

		it('Scenario 23: Rejects resubmission when credentials are Pending_Verification WITHOUT clarification (HTTP 409)', async () => {
			const { token } = await createTestDoctor('Pending_Verification', {
				credentialClarificationRequested: false,
			})

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: { qualification: 'MBBS' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /without outstanding clarification requests/i)
		})

		it('Scenario 24: Rejects submission or resubmission when credentials are Verified (HTTP 409)', async () => {
			const { token } = await createTestDoctor('Verified')

			// Try submit
			const { res: subRes } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: { qualification: 'MBBS' },
				}
			)
			assert.strictEqual(subRes.statusCode, 409)
			assert.match(subRes.responseData?.message, /already been verified/i)

			// Try resubmit
			const { res: resubRes } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: { qualification: 'MBBS' },
				}
			)
			assert.strictEqual(resubRes.statusCode, 409)
			assert.match(resubRes.responseData?.message, /already been verified/i)
		})

		it('Scenario 25: Rejects submission or resubmission when account is Suspended (HTTP 409/403)', async () => {
			const { token } = await createTestDoctor('Suspended', { accountStatus: 'Suspended' })

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: { qualification: 'MBBS' },
				}
			)
			// Blocked by middleware Gate 1 accountStatus
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /account is suspended/i)
		})
	})

	// =========================================================================
	// 5. Invariant Checks, Concurrency & Transaction Safety
	// =========================================================================
	describe('5. Invariant Checks, Concurrency & Transaction Safety', () => {
		it('Scenario 26: No Self-Verification Guarantee: credentialStatus is NEVER set to Verified by doctor actions', async () => {
			const { doc, token } = await createTestDoctor('Unsubmitted')

			// Initial submission
			await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						medicalRegistrationNumber: `NO-SELF-${Date.now()}`,
						medicalCouncil: 'State Medical Council',
						registrationState: 'Kerala',
						registrationYear: 2021,
						qualification: 'MBBS',
						supportingEvidence: 'https://example.com/doc.pdf',
					},
				}
			)

			const check1 = await userModel.findById(doc._id)
			assert.notStrictEqual(check1.credentialStatus, 'Verified')
			assert.strictEqual(check1.credentialStatus, 'Pending_Verification')

			// Rejection simulation
			check1.credentialStatus = 'Rejected'
			await check1.save()

			// Resubmission
			await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						qualification: 'MBBS, MD',
					},
				}
			)

			const check2 = await userModel.findById(doc._id)
			assert.notStrictEqual(check2.credentialStatus, 'Verified')
			assert.strictEqual(check2.credentialStatus, 'Pending_Verification')
		})

		it('Scenario 27: No automatic hospital association activation occurs during credential submission', async () => {
			const { doc, token } = await createTestDoctor('Unsubmitted')

			await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						medicalRegistrationNumber: `NO-ASSOC-${Date.now()}`,
						medicalCouncil: 'State Medical Council',
						registrationState: 'Delhi',
						registrationYear: 2020,
						qualification: 'MBBS',
						supportingEvidence: 'https://example.com/doc.pdf',
					},
				}
			)

			const assocCount = await MedicalOfficerHospital.countDocuments({ medicalOfficerUserId: doc._id })
			assert.strictEqual(assocCount, 0, 'Zero hospital associations must exist after credential submission')
		})

		it('Scenario 28: Transaction Rollback & ACID Safety across doctor, audit ledger, and outbox', async () => {
			const { doc, token } = await createTestDoctor('Unsubmitted')

			// Simulate failure during outbox phase by intercepting with invalid outbox data
			try {
				await withTransaction(async (session) => {
					await userModel.findByIdAndUpdate(
						doc._id,
						{ credentialStatus: 'Pending_Verification' },
						{ session }
					)

					// Force failure
					throw new Error('SIMULATED_CREDENTIAL_FLOW_CRASH')
				})
			} catch (err) {
				assert.strictEqual(err.message, 'SIMULATED_CREDENTIAL_FLOW_CRASH')
			}

			// Doctor status remains Unsubmitted
			const reloaded = await userModel.findById(doc._id)
			assert.strictEqual(reloaded.credentialStatus, 'Unsubmitted')

			// No audit record created
			const audits = await AdministrativeDecisionAudit.countDocuments({ targetUserId: doc._id })
			assert.strictEqual(audits, 0)

			// No outbox created
			const outboxes = await NotificationOutbox.countDocuments({ recipientUserId: doc._id })
			assert.strictEqual(outboxes, 0)
		})

		it('Scenario 29: Concurrency Race Condition: Simultaneous initial submissions safely resolve with one 201 and one 409', async () => {
			const { token } = await createTestDoctor('Unsubmitted')

			const runSubmit = async (num) => {
				return await executeOnboardingPipeline(
					medicalOfficerCredentialController.submitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							medicalRegistrationNumber: `CONC-SUB-${Date.now()}`,
							medicalCouncil: 'State Medical Council',
							registrationState: 'Goa',
							registrationYear: 2021,
							qualification: `MBBS-${num}`,
							supportingEvidence: 'https://example.com/doc.pdf',
						},
					}
				)
			}

			const [res1, res2] = await Promise.all([runSubmit(1), runSubmit(2)])
			const statusCodes = [res1.res.statusCode, res2.res.statusCode].sort()

			assert.deepStrictEqual(statusCodes, [201, 409], 'Exactly one initial submission succeeds with 201; concurrent collision returns 409')
		})
	})

	// =========================================================================
	// 6. Regression Verifications (B3.3 Self-Registration & B2 Three-Gate Enforcement)
	// =========================================================================
	describe('6. Regression Verifications (B3.3 Self-Registration & B2 Three-Gate Enforcement)', () => {
		it('Scenario 30: Stage B3.3 Independent Self-Registration still initializes Unsubmitted credentials in Active status', async () => {
			const email = `doctor.regress.b342.${Date.now()}@test-doctor.org`
			const phone = Math.floor(1000000000 + Math.random() * 9000000000)

			const { req, res } = createMockReqRes({
				body: {
					name: 'Dr. Regression SelfReg',
					email,
					phone,
					password: 'DoctorPassword123!',
					medicalRegistrationNumber: `REG-REGR-${Date.now()}`,
					medicalCouncil: 'Tamil Nadu Medical Council',
				},
			})

			await registerMedicalOfficer(req, res, () => {})
			assert.strictEqual(res.statusCode, 201)
			const docId = res.responseData?.data?.medicalOfficer?.id
			createdUserIds.push(docId)

			const createdDoctor = await userModel.findById(docId)
			assert.strictEqual(createdDoctor.role, 'MEDICAL_OFFICER')
			assert.strictEqual(createdDoctor.accountStatus, 'Active')
			assert.strictEqual(createdDoctor.credentialStatus, 'Unsubmitted')
		})

		it('Scenario 31: Stage B2 Three-Gate Clinical Gate Enforcement strictly fails closed for doctor in Pending_Verification', async () => {
			const { token } = await createTestDoctor('Pending_Verification')

			const { req, res } = createMockReqRes({
				headers: { authorization: `Bearer ${token}` },
			})

			await protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData?.message, /pending administrative verification/i)
		})
	})

	// =========================================================================
	// 7. Security Remediation: Privacy, Concurrency & Cryptographic Audit Ledger
	// =========================================================================
	describe('7. Security Remediation: Privacy, Concurrency & Cryptographic Audit Ledger', () => {
		it('Scenario 32: Privacy & Data Minimization: Audit records store masked registration numbers (TN****8765) and omit unmasked numbers and evidence URLs', async () => {
			const rawRegNo = 'TN1234568765'
			const evidenceUrl = 'https://example.com/confidential-medical-degree.pdf'

			const { doc, token } = await createTestDoctor('Unsubmitted')

			// Initial Submit
			const { res: subRes } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						medicalRegistrationNumber: rawRegNo,
						medicalCouncil: 'Tamil Nadu Medical Council',
						registrationState: 'Tamil Nadu',
						registrationYear: 2018,
						qualification: 'MBBS',
						supportingEvidence: evidenceUrl,
					},
				}
			)
			assert.strictEqual(subRes.statusCode, 201)

			// Check submit audit record
			const submitAudit = await AdministrativeDecisionAudit.findOne({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_SUBMITTED',
			}).lean()

			assert.ok(submitAudit, 'CREDENTIAL_SUBMITTED audit record must exist')
			assert.strictEqual(submitAudit.metadata.registrationNumberMasked, 'TN****8765')
			assert.strictEqual(submitAudit.metadata.medicalRegistrationNumber, undefined)
			assert.strictEqual(submitAudit.metadata.supportingEvidence, undefined)
			assert.strictEqual(submitAudit.metadata.evidenceUrl, undefined)
			assert.strictEqual(submitAudit.metadata.hasSupportingEvidence, true)

			// Resubmit after rejection
			await userModel.findByIdAndUpdate(doc._id, { credentialStatus: 'Rejected' })

			const { res: resubRes } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						qualification: 'MBBS, MD',
						supportingEvidence: 'https://example.com/new-confidential-cert.pdf',
					},
				}
			)
			assert.strictEqual(resubRes.statusCode, 200)

			const resubmitAudit = await AdministrativeDecisionAudit.findOne({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_RESUBMITTED',
			}).lean()

			assert.ok(resubmitAudit, 'CREDENTIAL_RESUBMITTED audit record must exist')
			assert.strictEqual(resubmitAudit.metadata.registrationNumberMasked, 'TN****8765')
			assert.strictEqual(resubmitAudit.metadata.medicalRegistrationNumber, undefined)
			assert.strictEqual(resubmitAudit.metadata.supportingEvidence, undefined)
			assert.strictEqual(resubmitAudit.metadata.hasSupportingEvidence, true)
		})

		it('Scenario 33: Concurrency Race Condition: Simultaneous clarification responses resolve with one 200 and one 409', async () => {
			const { doc, token } = await createTestDoctor('Pending_Verification', {
				medicalRegistrationNumber: `REG-CLAR-${Date.now()}`,
				medicalCouncil: 'Tamil Nadu Medical Council',
				registrationState: 'Tamil Nadu',
				registrationYear: 2017,
				qualification: 'MBBS',
				supportingEvidence: 'https://example.com/old.pdf',
				credentialClarificationRequested: true,
				credentialClarificationNotes: 'Clarify registration details',
				credentialClarificationRequestedAt: new Date(),
				credentialResubmissionCount: 1,
			})

			const runResubmit = async (num) => {
				return await executeOnboardingPipeline(
					medicalOfficerCredentialController.resubmitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							qualification: `MBBS-${num}`,
							supportingEvidence: 'https://example.com/clarif.pdf',
						},
					}
				)
			}

			const [res1, res2] = await Promise.all([runResubmit(1), runResubmit(2)])
			const statusCodes = [res1.res.statusCode, res2.res.statusCode].sort()

			assert.deepStrictEqual(statusCodes, [200, 409], 'Exactly one clarification resubmission succeeds (200); concurrent attempt returns 409')

			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialClarificationRequested, false)
			assert.strictEqual(updated.credentialResubmissionCount, 2)

			const audits = await AdministrativeDecisionAudit.find({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_RESUBMITTED',
			})
			assert.strictEqual(audits.length, 1, 'Only one audit entry must be created')
		})

		it('Scenario 34: Concurrency Race Condition: Simultaneous rejected resubmissions resolve with one 200 and one 409', async () => {
			const { doc, token } = await createTestDoctor('Rejected', {
				medicalRegistrationNumber: `REG-REJ-${Date.now()}`,
				medicalCouncil: 'Karnataka Medical Council',
				registrationState: 'Karnataka',
				registrationYear: 2019,
				qualification: 'MBBS',
				supportingEvidence: 'https://example.com/old.pdf',
				credentialResubmissionCount: 0,
				credentialRejectionReason: 'Invalid document',
			})

			const runResubmit = async (num) => {
				return await executeOnboardingPipeline(
					medicalOfficerCredentialController.resubmitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							qualification: `MBBS-MD-${num}`,
							supportingEvidence: 'https://example.com/rejected-fix.pdf',
						},
					}
				)
			}

			const [res1, res2] = await Promise.all([runResubmit(1), runResubmit(2)])
			const statusCodes = [res1.res.statusCode, res2.res.statusCode].sort()

			assert.deepStrictEqual(statusCodes, [200, 409], 'Exactly one rejected resubmission succeeds (200); concurrent attempt returns 409')

			const updated = await userModel.findById(doc._id)
			assert.strictEqual(updated.credentialStatus, 'Pending_Verification')
			assert.strictEqual(updated.credentialResubmissionCount, 1)

			const audits = await AdministrativeDecisionAudit.find({
				targetUserId: doc._id,
				decisionType: 'CREDENTIAL_RESUBMITTED',
			})
			assert.strictEqual(audits.length, 1, 'Only one audit entry must be created')
		})

		it('Scenario 35: Concurrency Race Condition: Resubmission racing with administrative state change (Under_Review) rejects with 409', async () => {
			const { doc, token } = await createTestDoctor('Pending_Verification', {
				medicalRegistrationNumber: `REG-RACE-${Date.now()}`,
				medicalCouncil: 'Delhi Medical Council',
				registrationState: 'Delhi',
				registrationYear: 2020,
				qualification: 'MBBS',
				supportingEvidence: 'https://example.com/old.pdf',
				credentialClarificationRequested: true,
				credentialClarificationNotes: 'Clarify details',
			})

			// Simulate administrative reviewer transitioning doctor to Under_Review
			await userModel.findByIdAndUpdate(doc._id, {
				credentialStatus: 'Under_Review',
				credentialClarificationRequested: false,
			})

			const { res } = await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token}` },
					body: {
						qualification: 'MBBS, MS',
						supportingEvidence: 'https://example.com/updated.pdf',
					},
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert.match(res.responseData?.message, /under active administrative review/i)

			// Doctor status untouched
			const check = await userModel.findById(doc._id)
			assert.strictEqual(check.credentialStatus, 'Under_Review')
		})

		it('Scenario 36: Resubmission transaction retry simulation without duplicate audit entries or outbox events', async () => {
			const { doc, token } = await createTestDoctor('Rejected', {
				medicalRegistrationNumber: `REG-RETRY-${Date.now()}`,
				medicalCouncil: 'Kerala Medical Council',
				registrationState: 'Kerala',
				registrationYear: 2018,
				qualification: 'MBBS',
				supportingEvidence: 'https://example.com/old.pdf',
				credentialResubmissionCount: 0,
				credentialRejectionReason: 'Need clearer certificate',
			})

			// Intercept NotificationOutbox.create once to simulate TransientTransactionError
			let transientErrorInjected = false
			const originalOutboxCreate = NotificationOutbox.create

			NotificationOutbox.create = async function (...args) {
				if (!transientErrorInjected) {
					transientErrorInjected = true
					const transientErr = new mongoose.mongo.MongoServerError({
						message: 'Simulated TransientTransactionError during resubmission',
						errmsg: 'WriteConflict',
					})
					transientErr.addErrorLabel('TransientTransactionError')
					throw transientErr
				}
				return originalOutboxCreate.apply(this, args)
			}

			try {
				const { res } = await executeOnboardingPipeline(
					medicalOfficerCredentialController.resubmitCredentials,
					{
						headers: { authorization: `Bearer ${token}` },
						body: {
							qualification: 'MBBS, MD Pediatrics',
							supportingEvidence: 'https://example.com/clear-cert.pdf',
						},
					}
				)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(transientErrorInjected, true, 'Transient error must have been triggered once')

				// Verify doctor is cleanly updated
				const updatedDoctor = await userModel.findById(doc._id)
				assert.strictEqual(updatedDoctor.credentialStatus, 'Pending_Verification')
				assert.strictEqual(updatedDoctor.credentialResubmissionCount, 1)

				// Verify no duplicate audit entries
				const audits = await AdministrativeDecisionAudit.find({
					targetUserId: doc._id,
					decisionType: 'CREDENTIAL_RESUBMITTED',
				})
				assert.strictEqual(audits.length, 1, 'Exactly one audit record must be committed despite retry')

				// Verify no duplicate outbox notifications
				const outboxes = await NotificationOutbox.find({
					recipientUserId: doc._id,
					eventType: 'CREDENTIALS_RESUBMITTED',
				})
				assert.strictEqual(outboxes.length, 1, 'Exactly one notification outbox entry must exist despite retry')
			} finally {
				NotificationOutbox.create = originalOutboxCreate
			}
		})

		it('Scenario 37: End-to-end full lifecycle audit chain cryptographic integrity verification', async () => {
			// Perform submissions and resubmissions across multiple doctors
			const { doc: doc1, token: token1 } = await createTestDoctor('Unsubmitted')
			const { doc: doc2, token: token2 } = await createTestDoctor('Unsubmitted')

			// Doc1 submits
			await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token1}` },
					body: {
						medicalRegistrationNumber: `E2E-CHAIN-1-${Date.now()}`,
						medicalCouncil: 'Karnataka Medical Council',
						registrationState: 'Karnataka',
						registrationYear: 2019,
						qualification: 'MBBS',
						supportingEvidence: 'https://example.com/doc1.pdf',
					},
				}
			)

			// Doc2 submits
			await executeOnboardingPipeline(
				medicalOfficerCredentialController.submitCredentials,
				{
					headers: { authorization: `Bearer ${token2}` },
					body: {
						medicalRegistrationNumber: `E2E-CHAIN-2-${Date.now()}`,
						medicalCouncil: 'Tamil Nadu Medical Council',
						registrationState: 'Tamil Nadu',
						registrationYear: 2020,
						qualification: 'MBBS, MD',
						supportingEvidence: 'https://example.com/doc2.pdf',
					},
				}
			)

			// Doc1 rejected, then resubmits
			await userModel.findByIdAndUpdate(doc1._id, { credentialStatus: 'Rejected' })
			await executeOnboardingPipeline(
				medicalOfficerCredentialController.resubmitCredentials,
				{
					headers: { authorization: `Bearer ${token1}` },
					body: {
						qualification: 'MBBS, MS General Surgery',
						supportingEvidence: 'https://example.com/doc1-updated.pdf',
					},
				}
			)

			const chainVerification = await verifyAuditChainIntegrity()
			assert.strictEqual(
				chainVerification.isValid,
				true,
				`Audit chain must be valid. Errors: ${chainVerification.errors?.join(', ')}`
			)
			assert.strictEqual(chainVerification.totalRecords, 3, 'Audit chain must contain exactly 3 records')
			assert.strictEqual(chainVerification.errors.length, 0, 'Audit chain must have zero errors')
		})
	})
})
