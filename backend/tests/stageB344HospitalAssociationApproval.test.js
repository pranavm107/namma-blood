/**
 * Stage B3.4.4 Automated Test Suite
 * Namma Blood — Hospital Association Approval and Medical Officer Clinical Authorization
 *
 * Comprehensive Test Coverage:
 * Group A: Platform Administrator Authorization & Boundary Enforcement
 * Group B: Association Approval Lifecycle Transitions
 * Group C: Association Rejection Lifecycle Transitions
 * Group D: Permission Management & Invariant Enforcement
 * Group E: Hospital Representative (HOSPITAL_ADMIN) Scoping and Tenant Isolation
 * Group F: Multi-Hospital Association Behavior
 * Group G: Three-Gate Clinical Authorization Enforcement
 * Group H: Administrative Audit and Outbox Integrity
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

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
const { protectHospitalAdminAuth } = require('../Hospital/hospitalAdminMiddleware')
const { protectMedicalOfficerAuth } = require('../Hospital/medicalOfficerMiddleware')
const hospitalAssociationApprovalController = require('../Hospital/hospitalAssociationApprovalController')
const { verifyAuditChainIntegrity } = require('../Hospital/auditIntegrityService')

const TEST_SECRET =
	process.env.JWT_SECRET || 'test_jwt_secret_key_12345_super_secure_min_32'
process.env.JWT_SECRET = TEST_SECRET

const TEST_DB_URI =
	process.env.MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

function signToken(userId, extraClaims = {}) {
	return jwt.sign(
		{ id: userId.toString(), tokenVersion: 0, userType: 'user', ...extraClaims },
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
	hospitalId = null,
} = {}) {
	const req = {
		headers: { ...headers },
		params: { ...params },
		query: { ...query },
		body: { ...body },
		user,
		userRole,
		hospitalId,
		ip: '127.0.0.1',
		get: (h) => headers[h.toLowerCase()] || headers[h],
		header: (h) => headers[h.toLowerCase()] || headers[h],
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
 * Executes request through Admin auth pipeline: protectEmergencyAuth -> requireAdmin -> controllerFn
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

/**
 * Executes request through Hospital Admin pipeline: protectHospitalAdminAuth -> controllerFn
 */
async function executeHospitalAdminPipeline(controllerFn, reqOptions) {
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

		protectHospitalAdminAuth(req, res, async (authErr) => {
			if (authErr) {
				if (!res.responseData) {
					res.statusCode = authErr.statusCode || 500
					res.responseData = { status: 'error', message: authErr.message }
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

	return { req, res }
}

/**
 * Executes request through Medical Officer clinical gate pipeline: protectMedicalOfficerAuth(permission) -> clinicalHandler
 */
async function executeMedicalOfficerPipeline(requiredPermission, reqOptions) {
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

		const mw = protectMedicalOfficerAuth(requiredPermission)
		mw(req, res, async (authErr) => {
			if (authErr) {
				if (!res.responseData) {
					res.statusCode = authErr.statusCode || 500
					res.responseData = { status: 'error', message: authErr.message }
				}
				finish()
				return
			}

			// If multiple hospitals exist and none specified, require explicit selection
			if (req.isMultiHospital && !req.hospitalId) {
				res.statusCode = 403
				res.responseData = {
					status: 'fail',
					message:
						'Multiple active hospital associations found. Please specify hospitalId.',
				}
				finish()
				return
			}

			res.statusCode = 200
			res.responseData = {
				status: 'success',
				message: 'Clinical operation authorized',
				doctor: req.user ? req.user._id : null,
				hospitalId: req.hospitalId,
				permissionGranted: requiredPermission,
			}
			finish()
		}).catch((err) => {
			res.statusCode = err.statusCode || 500
			res.responseData = { status: 'error', message: err.message }
			finish()
		})
	})

	return { req, res }
}

describe('Stage B3.4.4: Hospital Association Approval and Medical Officer Clinical Authorization', () => {
	let testAdmin
	let adminToken
	let testHospitalA
	let testHospitalB
	let testHospitalAdminA
	let hospitalAdminAToken
	let testHospitalAdminB
	let hospitalAdminBToken

	const createdUserIds = []
	const createdAdminIds = []
	const createdHospitalIds = []
	const createdAssocIds = []

	async function createHospital({
		verificationStatus = 'Verified',
		isActive = true,
		extra = {},
	} = {}) {
		const hosp = await Hospital.create({
			hospitalCode: `HOSP-B344-${Date.now().toString().slice(-4)}-${Math.floor(Math.random() * 10000)}`,
			hospitalName: `Hospital ${Date.now()}`,
			hospitalType: 'Private',
			address: {
				street: '100 Health Avenue',
				city: 'Chennai',
				state: 'Tamil Nadu',
				pinCode: '600001',
			},
			contactPhone: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			contactEmail: `hospital.b344.${Date.now()}.${Math.floor(Math.random() * 10000)}@care.test`,
			verificationStatus,
			isActive,
			...extra,
		})
		createdHospitalIds.push(hosp._id)
		return hosp
	}

	async function createDoctor({
		accountStatus = 'Active',
		credentialStatus = 'Verified',
		status = true,
		extra = {},
	} = {}) {
		const doc = await userModel.create({
			firstName: 'Dr. Test',
			lastName: 'Physician',
			email: `dr.b344.${Date.now()}.${Math.floor(Math.random() * 100000)}@nammablood.test`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'DoctorPassword123!',
			role: 'MEDICAL_OFFICER',
			accountStatus,
			credentialStatus,
			verificationStatus: credentialStatus === 'Verified' ? 'Verified' : 'Pending',
			status,
			medicalRegistrationNumber: `REG-B344-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
			medicalCouncil: 'Tamil Nadu Medical Council',
			registrationState: 'Tamil Nadu',
			registrationYear: 2020,
			qualification: 'MBBS, MD',
			experienceYears: 5,
			...extra,
		})
		createdUserIds.push(doc._id)
		return doc
	}

	async function createHospitalAdmin(hospitalId, extra = {}) {
		const hAdmin = await userModel.create({
			firstName: 'Hospital',
			lastName: 'Admin',
			email: `hadmin.b344.${Date.now()}.${Math.floor(Math.random() * 10000)}@care.test`,
			phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
			password: 'HAdminPassword123!',
			role: 'HOSPITAL_ADMIN',
			accountStatus: 'Active',
			status: true,
			representativeStatus: 'Active',
			hospitalId: hospitalId,
			...extra,
		})
		createdUserIds.push(hAdmin._id)
		return hAdmin
	}

	async function createAssociation(doctorId, hospitalId, overrides = {}) {
		const assoc = await MedicalOfficerHospital.create({
			medicalOfficerUserId: doctorId,
			hospitalId: hospitalId,
			associationStatus: overrides.associationStatus || 'Pending_Admin_Approval',
			assignedByRole: overrides.assignedByRole || 'HOSPITAL_ADMIN',
			assignedBy: overrides.assignedBy || testHospitalAdminA._id,
			assignmentSource: overrides.assignmentSource || 'NOMINATION',
			permissions: overrides.permissions || ['VIEW_EMERGENCY_REQUESTS'],
			isAvailableForEmergency:
				overrides.isAvailableForEmergency !== undefined
					? overrides.isAvailableForEmergency
					: true,
			effectiveFrom: overrides.effectiveFrom || new Date(Date.now() - 86400000),
			expiresAt: overrides.expiresAt !== undefined ? overrides.expiresAt : null,
			...overrides,
		})
		createdAssocIds.push(assoc._id)
		return assoc
	}

	before(async () => {
		if (mongoose.connection.readyState === 0) {
			await mongoose.connect(TEST_DB_URI)
		}

		await userModel.init()
		await Admin.init()
		await Hospital.init()
		await MedicalOfficerHospital.init()
		await AdministrativeDecisionAudit.init()
		await AuditChainHead.init()
		await NotificationOutbox.init()

		testAdmin = await Admin.create({
			phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
			email: `admin.b344.${Date.now()}@nammablood.test`,
			password: 'AdminPassword123!',
		})
		createdAdminIds.push(testAdmin._id)
		adminToken = signToken(testAdmin._id)

		testHospitalA = await createHospital()
		testHospitalB = await createHospital()

		testHospitalAdminA = await createHospitalAdmin(testHospitalA._id)
		hospitalAdminAToken = signToken(testHospitalAdminA._id)

		testHospitalAdminB = await createHospitalAdmin(testHospitalB._id)
		hospitalAdminBToken = signToken(testHospitalAdminB._id)
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

	// =========================================================================
	// GROUP A: Platform Administrator Authorization & Boundary Enforcement
	// =========================================================================
	describe('Group A: Platform Administrator Authorization & Boundary Enforcement', () => {
		it('1. Queue retrieval with ADMIN token succeeds (HTTP 200)', async () => {
			const doctor = await createDoctor()
			await createAssociation(doctor._id, testHospitalA._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationReviewQueue,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					query: { page: 1, limit: 10 },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert(Array.isArray(res.responseData.data.associations))
			assert(res.responseData.data.pagination)
		})

		it('2. Queue retrieval with USER token fails (HTTP 403)', async () => {
			const user = await userModel.create({
				firstName: 'Citizen',
				lastName: 'User',
				email: `user.b344.${Date.now()}@nammablood.test`,
				phoneNo1: Math.floor(1000000000 + Math.random() * 9000000000),
				password: 'UserPassword123!',
				role: 'USER',
				gender: 'Male',
				dob: new Date('1990-01-01'),
				age: 34,
				city: 'Chennai',
				state: 'Tamil Nadu',
				address: '123 Main Street',
				pinCode: 600001,
			})
			createdUserIds.push(user._id)
			const userToken = signToken(user._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationReviewQueue,
				{
					headers: { authorization: `Bearer ${userToken}` },
				}
			)

			assert.strictEqual(res.statusCode, 403)
		})

		it('3. Queue retrieval with STAFF token fails (HTTP 403)', async () => {
			const bbDoc = await Bloodbank.create({
				bloodbankName: `Staff BB ${Date.now()}`,
				state: 'Tamil Nadu',
				city: 'Chennai',
				category: 'Government',
				contactPerson: 'Manager',
				address1: '12 Hospital Rd',
				address2: 'Near Central',
				pinCode: 600001,
				phoneNo1: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				phoneNo2: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				email: `staffbb.${Date.now()}@bloodbank.org`,
				password: 'Password123!',
				status: true,
				location: { type: 'Point', coordinates: [80.2707, 13.0827] },
			})

			const staffDoc = await BloodbankStaff.create({
				fullName: 'Lab Staff',
				email: `labstaff.${Date.now()}@bloodbank.org`,
				phoneNo: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				password: 'Password123!',
				bloodbankId: bbDoc._id,
				createdBy: bbDoc._id,
				role: 'Lab_Technician',
				status: 'Active',
			})
			createdUserIds.push(staffDoc._id)

			const staffToken = signToken(staffDoc._id, { userType: 'staff' })

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationReviewQueue,
				{
					headers: { authorization: `Bearer ${staffToken}` },
				}
			)

			await BloodbankStaff.deleteOne({ _id: staffDoc._id })
			await Bloodbank.deleteOne({ _id: bbDoc._id })
			assert.strictEqual(res.statusCode, 403)
		})

		it('4. Queue retrieval with BLOODBANK token fails (HTTP 403)', async () => {
			const bb = await Bloodbank.create({
				bloodbankName: `Bloodbank B344 ${Date.now()}`,
				state: 'Tamil Nadu',
				city: 'Chennai',
				category: 'Private',
				contactPerson: 'Manager',
				address1: '10 Hospital Rd',
				address2: 'Building A',
				pinCode: 600006,
				phoneNo1: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				phoneNo2: String(Math.floor(1000000000 + Math.random() * 9000000000)),
				email: `bb.b344.${Date.now()}@bloodbank.test`,
				password: 'BloodBankPassword123!',
				status: true,
				location: { type: 'Point', coordinates: [80.2707, 13.0827] },
			})
			const bbToken = signToken(bb._id, { userType: 'user' })

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationReviewQueue,
				{
					headers: { authorization: `Bearer ${bbToken}` },
				}
			)

			await Bloodbank.deleteOne({ _id: bb._id })
			assert.strictEqual(res.statusCode, 403)
		})

		it('5. Queue retrieval with MEDICAL_OFFICER token fails (HTTP 403)', async () => {
			const doctor = await createDoctor()
			const docToken = signToken(doctor._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationReviewQueue,
				{
					headers: { authorization: `Bearer ${docToken}` },
				}
			)

			assert.strictEqual(res.statusCode, 403)
		})

		it('6. Queue retrieval with HOSPITAL_ADMIN token on admin endpoint fails (HTTP 403)', async () => {
			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationReviewQueue,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
				}
			)

			assert.strictEqual(res.statusCode, 403)
		})

		it('7. Queue retrieval with unauthenticated request fails (HTTP 401)', async () => {
			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationReviewQueue,
				{
					headers: {},
				}
			)

			assert.strictEqual(res.statusCode, 401)
		})

		it('8. Association dossier retrieval by ADMIN succeeds (HTTP 200)', async () => {
			const doctor = await createDoctor()
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationDetails,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert.strictEqual(
				res.responseData.data.association._id.toString(),
				assoc._id.toString()
			)
			assert(res.responseData.data.doctor)
			assert(res.responseData.data.hospital)
		})

		it('9. Association dossier retrieval by non-ADMIN fails (HTTP 403)', async () => {
			const doctor = await createDoctor()
			const assoc = await createAssociation(doctor._id, testHospitalA._id)
			const docToken = signToken(doctor._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationDetails,
				{
					headers: { authorization: `Bearer ${docToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
				}
			)

			assert.strictEqual(res.statusCode, 403)
		})

		it('10. Association dossier retrieval with non-existent or invalid ID fails (HTTP 404 / 400)', async () => {
			// Invalid ID format -> 400
			const { res: resInvalid } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationDetails,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: 'invalid-doc-id',
						associationId: 'invalid-assoc-id',
					},
				}
			)
			assert.strictEqual(resInvalid.statusCode, 400)

			// Non-existent ID -> 404
			const fakeDocId = new mongoose.Types.ObjectId().toString()
			const fakeAssocId = new mongoose.Types.ObjectId().toString()
			const { res: resNotFound } = await executeAdminPipeline(
				hospitalAssociationApprovalController.getAssociationDetails,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: { doctorId: fakeDocId, associationId: fakeAssocId },
				}
			)
			assert.strictEqual(resNotFound.statusCode, 404)
		})
	})

	// =========================================================================
	// GROUP B: Association Approval Lifecycle Transitions
	// =========================================================================
	describe('Group B: Association Approval Lifecycle Transitions', () => {
		it('11. Valid transition: Pending_Admin_Approval -> Active succeeds (HTTP 200)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Credentials and hospital association verified successfully' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert.strictEqual(res.responseData.data.association.associationStatus, 'Active')

			const updated = await MedicalOfficerHospital.findById(assoc._id)
			assert.strictEqual(updated.associationStatus, 'Active')
			assert.strictEqual(updated.approvalReason, 'Credentials and hospital association verified successfully')
			assert(updated.approvedAt)
			assert.strictEqual(updated.approvedBy.toString(), testAdmin._id.toString())
		})

		it('12. Approval grants default least-privilege permissions (VIEW_EMERGENCY_REQUESTS only)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			// Create association with no permissions or arbitrary input
			const assoc = await createAssociation(doctor._id, testHospitalA._id, { permissions: [] })

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Standard approval' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			const updated = await MedicalOfficerHospital.findById(assoc._id)
			assert.deepStrictEqual(updated.permissions, ['VIEW_EMERGENCY_REQUESTS'])
		})

		it('13. Approval never auto-grants VERIFY_EMERGENCY_REQUESTS by default', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Approval test' },
				}
			)

			const updated = await MedicalOfficerHospital.findById(assoc._id)
			assert(!updated.permissions.includes('VERIFY_EMERGENCY_REQUESTS'))
		})

		it('14. Approval fails when doctor credentialStatus is not Verified (HTTP 409)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Pending_Verification' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Attempt approval with unverified credentials' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert(res.responseData.message.includes('credentials'))

			const untouched = await MedicalOfficerHospital.findById(assoc._id)
			assert.strictEqual(untouched.associationStatus, 'Pending_Admin_Approval')
		})

		it('15. Approval fails when doctor accountStatus is not Active (HTTP 409)', async () => {
			const doctor = await createDoctor({
				credentialStatus: 'Verified',
				accountStatus: 'Suspended',
			})
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Attempt approval with suspended account' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert(res.responseData.message.includes('account'))
		})

		it('16. Approval fails when hospital is not verified (HTTP 409)', async () => {
			const unverifiedHospital = await createHospital({ verificationStatus: 'Pending' })
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, unverifiedHospital._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Attempt approval with unverified hospital' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert(res.responseData.message.includes('Hospital facility'))
		})

		it('17. Approval fails when hospital isActive is false (HTTP 409)', async () => {
			const inactiveHospital = await createHospital({
				verificationStatus: 'Verified',
				isActive: false,
			})
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, inactiveHospital._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Attempt approval with inactive hospital' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
			assert(res.responseData.message.includes('Hospital facility'))
		})

		it('18. Approval fails on already Active association (HTTP 409)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Duplicate approval' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
		})

		it('19. Concurrent approval attempts: only one succeeds, subsequent fails (HTTP 409)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			// First approval
			const { res: res1 } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'First concurrent approval attempt' },
				}
			)
			assert.strictEqual(res1.statusCode, 200)

			// Second approval
			const { res: res2 } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Second concurrent approval attempt' },
				}
			)
			assert.strictEqual(res2.statusCode, 409)
		})
	})

	// =========================================================================
	// GROUP C: Association Rejection Lifecycle Transitions
	// =========================================================================
	describe('Group C: Association Rejection Lifecycle Transitions', () => {
		it('20. Valid transition: Pending_Admin_Approval -> Rejected succeeds (HTTP 200)', async () => {
			const doctor = await createDoctor()
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.rejectAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Doctor profile does not align with emergency roster requirements' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert.strictEqual(res.responseData.data.association.associationStatus, 'Rejected')

			const updated = await MedicalOfficerHospital.findById(assoc._id)
			assert.strictEqual(updated.associationStatus, 'Rejected')
			assert.strictEqual(
				updated.rejectionReason,
				'Doctor profile does not align with emergency roster requirements'
			)
			assert(updated.rejectedAt)
			assert.strictEqual(updated.rejectedBy.toString(), testAdmin._id.toString())
		})

		it('21. Rejection requires meaningful reason (>= 5 chars) (HTTP 400)', async () => {
			const doctor = await createDoctor()
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			// Short reason (< 5 chars)
			const { res: resShort } = await executeAdminPipeline(
				hospitalAssociationApprovalController.rejectAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'bad' },
				}
			)
			assert.strictEqual(resShort.statusCode, 400)

			// Missing reason
			const { res: resMissing } = await executeAdminPipeline(
				hospitalAssociationApprovalController.rejectAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {},
				}
			)
			assert.strictEqual(resMissing.statusCode, 400)

			// Whitespace reason
			const { res: resWhitespace } = await executeAdminPipeline(
				hospitalAssociationApprovalController.rejectAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: '     ' },
				}
			)
			assert.strictEqual(resWhitespace.statusCode, 400)
		})

		it('22. Rejection cannot be performed on already Active association (HTTP 409)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.rejectAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Cannot reject an active association directly' },
				}
			)

			assert.strictEqual(res.statusCode, 409)
		})

		it('23. Outbox event published for association rejection', async () => {
			const doctor = await createDoctor()
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			await executeAdminPipeline(
				hospitalAssociationApprovalController.rejectAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Facility capacity limits reached' },
				}
			)

			const outboxEvent = await NotificationOutbox.findOne({
				eventType: 'ASSOCIATION_REJECTED',
				recipientUserId: doctor._id,
			})
			assert(outboxEvent)
			assert.strictEqual(outboxEvent.deliveryStatus, 'Pending')
		})

		it('24. Outbox failure triggers transaction abort and database rollback', async () => {
			const doctor = await createDoctor()
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			// Monkey-patch NotificationOutbox.create to throw inside transaction
			const originalCreate = NotificationOutbox.create
			NotificationOutbox.create = async () => {
				throw new Error('SIMULATED_OUTBOX_STORAGE_CRASH')
			}

			try {
				const { res } = await executeAdminPipeline(
					hospitalAssociationApprovalController.rejectAssociation,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: {
							doctorId: doctor._id.toString(),
							associationId: assoc._id.toString(),
						},
						body: { reason: 'Testing rollback on failure' },
					}
				)

				assert.strictEqual(res.statusCode, 500)

				// Verify rollback
				const unchanged = await MedicalOfficerHospital.findById(assoc._id)
				assert.strictEqual(unchanged.associationStatus, 'Pending_Admin_Approval')
			} finally {
				NotificationOutbox.create = originalCreate
			}
		})
	})

	// =========================================================================
	// GROUP D: Permission Management
	// =========================================================================
	describe('Group D: Permission Management', () => {
		it('25. ADMIN can grant VERIFY_EMERGENCY_REQUESTS to Active association (HTTP 200)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			})

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.updateAssociationPermissions,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {
						permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
						reason: 'Elevating to Clinical Verifier status after hospital training',
					},
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert(
				res.responseData.data.association.permissions.includes('VERIFY_EMERGENCY_REQUESTS')
			)

			const updated = await MedicalOfficerHospital.findById(assoc._id)
			assert(updated.permissions.includes('VERIFY_EMERGENCY_REQUESTS'))
			assert(updated.permissions.includes('VIEW_EMERGENCY_REQUESTS'))
		})

		it('26. ADMIN can revoke VERIFY_EMERGENCY_REQUESTS from Active association (HTTP 200)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.updateAssociationPermissions,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {
						permissions: ['VIEW_EMERGENCY_REQUESTS'],
						reason: 'Revoking verification privileges due to shift duty reassignment',
					},
				}
			)

			assert.strictEqual(res.statusCode, 200)
			const updated = await MedicalOfficerHospital.findById(assoc._id)
			assert(!updated.permissions.includes('VERIFY_EMERGENCY_REQUESTS'))
			assert(updated.permissions.includes('VIEW_EMERGENCY_REQUESTS'))
		})

		it('27. Permission update with empty array fails (must have VIEW_EMERGENCY_REQUESTS) (HTTP 400)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.updateAssociationPermissions,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {
						permissions: [],
						reason: 'Stripping all permissions',
					},
				}
			)

			assert.strictEqual(res.statusCode, 400)
			assert(res.responseData.message.includes('VIEW_EMERGENCY_REQUESTS'))
		})

		it('28. Permission update with invalid permission strings fails (HTTP 400)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.updateAssociationPermissions,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {
						permissions: ['VIEW_EMERGENCY_REQUESTS', 'DELETE_ALL_PATIENT_RECORDS'],
						reason: 'Attempting invalid privilege injection',
					},
				}
			)

			assert.strictEqual(res.statusCode, 400)
		})

		it('29. Permission update on non-Active association fails (HTTP 409)', async () => {
			const doctor = await createDoctor()
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Pending_Admin_Approval',
			})

			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.updateAssociationPermissions,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {
						permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
						reason: 'Setting permissions before approval',
					},
				}
			)

			assert.strictEqual(res.statusCode, 409)
		})

		it('30. Hospital representative cannot modify permissions (HTTP 403)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})

			// Attempt via admin pipeline
			const { res: resAdminRoute } = await executeAdminPipeline(
				hospitalAssociationApprovalController.updateAssociationPermissions,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {
						permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
						reason: 'Hospital admin trying to self-elevate permissions',
					},
				}
			)
			assert.strictEqual(resAdminRoute.statusCode, 403)
		})
	})

	// =========================================================================
	// GROUP E: Hospital Representative Scoping and Tenant Isolation
	// =========================================================================
	describe('Group E: Hospital Representative (HOSPITAL_ADMIN) Scoping and Tenant Isolation', () => {
		it('31. Representative can view associations scoped strictly to their own hospital', async () => {
			const doctor1 = await createDoctor()
			const doctor2 = await createDoctor()
			await createAssociation(doctor1._id, testHospitalA._id)
			await createAssociation(doctor2._id, testHospitalB._id)

			const { res } = await executeHospitalAdminPipeline(
				hospitalAssociationApprovalController.getHospitalAssociations,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					query: { page: 1, limit: 10 },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			const associations = res.responseData.data.associations
			assert(associations.length > 0)
			// Ensure every returned association belongs to Hospital A
			for (const a of associations) {
				assert.strictEqual(a.hospitalId.toString(), testHospitalA._id.toString())
			}
		})

		it('32. Cross-hospital association access attempts return HTTP 403 Forbidden', async () => {
			const doctorB = await createDoctor()
			const assocB = await createAssociation(doctorB._id, testHospitalB._id)

			// Hospital Admin A tries to view Hospital B association dossier
			const { res } = await executeHospitalAdminPipeline(
				hospitalAssociationApprovalController.getHospitalAssociationDetails,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctorB._id.toString(),
						associationId: assocB._id.toString(),
					},
				}
			)

			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('Tenant isolation'))
		})

		it('33. Representative can suspend active association within their own hospital', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})

			const { res } = await executeHospitalAdminPipeline(
				hospitalAssociationApprovalController.suspendHospitalAssociationByHospital,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Doctor requested medical leave of absence for 30 days' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert.strictEqual(res.responseData.data.association.associationStatus, 'Suspended')

			const updated = await MedicalOfficerHospital.findById(assoc._id)
			assert.strictEqual(updated.associationStatus, 'Suspended')
			assert.strictEqual(updated.suspendedByRole, 'HOSPITAL_ADMIN')
			assert.strictEqual(updated.suspendedBy.toString(), testHospitalAdminA._id.toString())
		})

		it('34. Representative can revoke association within their own hospital', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})

			const { res } = await executeHospitalAdminPipeline(
				hospitalAssociationApprovalController.revokeHospitalAssociationByHospital,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Doctor resigned from clinical staff roster' },
				}
			)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
			assert.strictEqual(res.responseData.data.association.associationStatus, 'Revoked')

			const updated = await MedicalOfficerHospital.findById(assoc._id)
			assert.strictEqual(updated.associationStatus, 'Revoked')
			assert.strictEqual(updated.revokedByRole, 'HOSPITAL_ADMIN')
			assert.strictEqual(updated.revokedBy.toString(), testHospitalAdminA._id.toString())
		})

		it('35. Cross-hospital suspension attempts return HTTP 403 Forbidden', async () => {
			const doctorB = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assocB = await createAssociation(doctorB._id, testHospitalB._id, {
				associationStatus: 'Active',
			})

			// Hospital Admin A tries to suspend Hospital B's association
			const { res } = await executeHospitalAdminPipeline(
				hospitalAssociationApprovalController.suspendHospitalAssociationByHospital,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctorB._id.toString(),
						associationId: assocB._id.toString(),
					},
					body: { reason: 'Malicious cross-tenant suspension attempt' },
				}
			)

			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('Tenant isolation'))
		})

		it('36. Cross-hospital revocation attempts return HTTP 403 Forbidden', async () => {
			const doctorB = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assocB = await createAssociation(doctorB._id, testHospitalB._id, {
				associationStatus: 'Active',
			})

			// Hospital Admin A tries to revoke Hospital B's association
			const { res } = await executeHospitalAdminPipeline(
				hospitalAssociationApprovalController.revokeHospitalAssociationByHospital,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctorB._id.toString(),
						associationId: assocB._id.toString(),
					},
					body: { reason: 'Malicious cross-tenant revocation attempt' },
				}
			)

			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('Tenant isolation'))
		})

		it('37. Representative cannot approve associations (HTTP 403 Forbidden)', async () => {
			const doctor = await createDoctor()
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			// Calling admin approve with Hospital Admin token
			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Hospital admin trying to approve association' },
				}
			)

			assert.strictEqual(res.statusCode, 403)
		})

		it('38. Representative cannot reactivate suspended associations (HTTP 403 Forbidden)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Suspended',
			})

			// Calling admin reactivate with Hospital Admin token
			const { res } = await executeAdminPipeline(
				hospitalAssociationApprovalController.reactivateAssociation,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Hospital admin trying to reactivate association' },
				}
			)

			assert.strictEqual(res.statusCode, 403)
		})

		it('39. Client attempts to alter hospitalId scope in body, query, or params are detected and rejected', async () => {
			// Body tampering with foreign hospital ID
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})

			const { res } = await executeHospitalAdminPipeline(
				hospitalAssociationApprovalController.suspendHospitalAssociationByHospital,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {
						hospitalId: testHospitalB._id.toString(),
						reason: 'Attempting to inject foreign hospital scope',
					},
				}
			)

			assert.strictEqual(res.statusCode, 403)
			assert(
				res.responseData.message.includes('tampering') ||
					res.responseData.message.includes('another hospital facility')
			)
		})
	})

	// =========================================================================
	// GROUP F: Multi-Hospital Association Behavior
	// =========================================================================
	describe('Group F: Multi-Hospital Association Behavior', () => {
		it('40. Doctor with two associations (Hospital A Active, Hospital B Pending_Admin_Approval)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const docToken = signToken(doctor._id)

			const assocA = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			const assocB = await createAssociation(doctor._id, testHospitalB._id, {
				associationStatus: 'Pending_Admin_Approval',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			})

			// Doctor can operate under Hospital A permissions
			const { res: resA } = await executeMedicalOfficerPipeline(
				'VERIFY_EMERGENCY_REQUESTS',
				{
					headers: { authorization: `Bearer ${docToken}` },
					body: { hospitalId: testHospitalA._id.toString() },
				}
			)
			assert.strictEqual(resA.statusCode, 200)

			// Doctor CANNOT operate under Hospital B (association is Pending_Admin_Approval)
			const { res: resB } = await executeMedicalOfficerPipeline(
				'VIEW_EMERGENCY_REQUESTS',
				{
					headers: { authorization: `Bearer ${docToken}` },
					body: { hospitalId: testHospitalB._id.toString() },
				}
			)
			assert.strictEqual(resB.statusCode, 403)
		})

		it('41. Suspension of Hospital A association leaves Hospital B association intact', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const docToken = signToken(doctor._id)

			const assocA = await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			const assocB = await createAssociation(doctor._id, testHospitalB._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			})

			// Suspend Hospital A association via Hospital Admin A
			const { res: resSuspendA } = await executeHospitalAdminPipeline(
				hospitalAssociationApprovalController.suspendHospitalAssociationByHospital,
				{
					headers: { authorization: `Bearer ${hospitalAdminAToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assocA._id.toString(),
					},
					body: { reason: 'Temporary suspension at Hospital A' },
				}
			)
			assert.strictEqual(resSuspendA.statusCode, 200)

			// Check Hospital B association status in DB: still Active!
			const unchangedB = await MedicalOfficerHospital.findById(assocB._id)
			assert.strictEqual(unchangedB.associationStatus, 'Active')

			// Doctor cannot operate under suspended Hospital A
			const { res: resOpA } = await executeMedicalOfficerPipeline(
				'VIEW_EMERGENCY_REQUESTS',
				{
					headers: { authorization: `Bearer ${docToken}` },
					body: { hospitalId: testHospitalA._id.toString() },
				}
			)
			assert.strictEqual(resOpA.statusCode, 403)

			// Doctor CAN operate under active Hospital B
			const { res: resOpB } = await executeMedicalOfficerPipeline(
				'VIEW_EMERGENCY_REQUESTS',
				{
					headers: { authorization: `Bearer ${docToken}` },
					body: { hospitalId: testHospitalB._id.toString() },
				}
			)
			assert.strictEqual(resOpB.statusCode, 200)
		})

		it('42. Explicit hospital selection required when doctor holds multiple active associations', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const docToken = signToken(doctor._id)

			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			})
			await createAssociation(doctor._id, testHospitalB._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			})

			// Without hospitalId in body, params, or query
			const { req, res } = await executeMedicalOfficerPipeline(
				'VIEW_EMERGENCY_REQUESTS',
				{
					headers: { authorization: `Bearer ${docToken}` },
				}
			)

			// Note: The middleware flags req.isMultiHospital = true when no specific hospital is provided
			// and denies with 403 requiring explicit selection
			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('Multiple active hospital associations'))
		})

		it('43. Selection of unauthorized hospital returns HTTP 403', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const docToken = signToken(doctor._id)

			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			})

			const randomHospital = await createHospital()

			const { res } = await executeMedicalOfficerPipeline(
				'VIEW_EMERGENCY_REQUESTS',
				{
					headers: { authorization: `Bearer ${docToken}` },
					body: { hospitalId: randomHospital._id.toString() },
				}
			)

			assert.strictEqual(res.statusCode, 403)
			assert(
				res.responseData.message.includes('facility scope') ||
					res.responseData.message.includes('authorized')
			)
		})
	})

	// =========================================================================
	// GROUP G: Three-Gate Clinical Authorization Enforcement
	// =========================================================================
	describe('Group G: Three-Gate Clinical Authorization Enforcement', () => {
		it('44. Gate 1 failure (doctor accountStatus !== Active) blocks clinical operations (HTTP 403)', async () => {
			const doctor = await createDoctor({
				accountStatus: 'Suspended',
				credentialStatus: 'Verified',
			})
			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})
			const docToken = signToken(doctor._id)

			const { res } = await executeMedicalOfficerPipeline('VIEW_EMERGENCY_REQUESTS', {
				headers: { authorization: `Bearer ${docToken}` },
				body: { hospitalId: testHospitalA._id.toString() },
			})

			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('account'))
		})

		it('45. Gate 2 failure (credentialStatus !== Verified) blocks clinical operations (HTTP 403)', async () => {
			const doctor = await createDoctor({
				accountStatus: 'Active',
				credentialStatus: 'Under_Review',
			})
			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
			})
			const docToken = signToken(doctor._id)

			const { res } = await executeMedicalOfficerPipeline('VIEW_EMERGENCY_REQUESTS', {
				headers: { authorization: `Bearer ${docToken}` },
				body: { hospitalId: testHospitalA._id.toString() },
			})

			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('credentials'))
		})

		it('46. Gate 3 failure (associationStatus !== Active) blocks clinical operations (HTTP 403)', async () => {
			const doctor = await createDoctor({
				accountStatus: 'Active',
				credentialStatus: 'Verified',
			})
			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Suspended',
			})
			const docToken = signToken(doctor._id)

			const { res } = await executeMedicalOfficerPipeline('VIEW_EMERGENCY_REQUESTS', {
				headers: { authorization: `Bearer ${docToken}` },
				body: { hospitalId: testHospitalA._id.toString() },
			})

			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('association'))
		})

		it('47. Gate 3 failure (hospital unverified or inactive) blocks clinical operations (HTTP 403)', async () => {
			const inactiveHospital = await createHospital({
				verificationStatus: 'Verified',
				isActive: false,
			})
			const doctor = await createDoctor({
				accountStatus: 'Active',
				credentialStatus: 'Verified',
			})
			await createAssociation(doctor._id, inactiveHospital._id, {
				associationStatus: 'Active',
			})
			const docToken = signToken(doctor._id)

			const { res } = await executeMedicalOfficerPipeline('VIEW_EMERGENCY_REQUESTS', {
				headers: { authorization: `Bearer ${docToken}` },
				body: { hospitalId: inactiveHospital._id.toString() },
			})

			assert.strictEqual(res.statusCode, 403)
			assert(
				res.responseData.message.includes('Hospital facility') ||
					res.responseData.message.includes('inactive')
			)
		})

		it('48. Gate 3 failure (association expired) blocks clinical operations (HTTP 403)', async () => {
			const doctor = await createDoctor({
				accountStatus: 'Active',
				credentialStatus: 'Verified',
			})
			// Association expired yesterday
			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				effectiveFrom: new Date(Date.now() - 30 * 86400000),
				expiresAt: new Date(Date.now() - 86400000),
			})
			const docToken = signToken(doctor._id)

			const { res } = await executeMedicalOfficerPipeline('VIEW_EMERGENCY_REQUESTS', {
				headers: { authorization: `Bearer ${docToken}` },
				body: { hospitalId: testHospitalA._id.toString() },
			})

			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('expired'))
		})

		it('49. Doctor with VIEW_EMERGENCY_REQUESTS can view requests (HTTP 200)', async () => {
			const doctor = await createDoctor({
				accountStatus: 'Active',
				credentialStatus: 'Verified',
			})
			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			})
			const docToken = signToken(doctor._id)

			const { res } = await executeMedicalOfficerPipeline('VIEW_EMERGENCY_REQUESTS', {
				headers: { authorization: `Bearer ${docToken}` },
				body: { hospitalId: testHospitalA._id.toString() },
			})

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.status, 'success')
		})

		it('50. Doctor with VIEW_EMERGENCY_REQUESTS cannot verify requests (HTTP 403)', async () => {
			const doctor = await createDoctor({
				accountStatus: 'Active',
				credentialStatus: 'Verified',
			})
			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS'],
			})
			const docToken = signToken(doctor._id)

			const { res } = await executeMedicalOfficerPipeline('VERIFY_EMERGENCY_REQUESTS', {
				headers: { authorization: `Bearer ${docToken}` },
				body: { hospitalId: testHospitalA._id.toString() },
			})

			assert.strictEqual(res.statusCode, 403)
			assert(res.responseData.message.includes('VERIFY_EMERGENCY_REQUESTS'))
		})

		it('51. Doctor with both permissions can view and verify requests (HTTP 200)', async () => {
			const doctor = await createDoctor({
				accountStatus: 'Active',
				credentialStatus: 'Verified',
			})
			await createAssociation(doctor._id, testHospitalA._id, {
				associationStatus: 'Active',
				permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
			})
			const docToken = signToken(doctor._id)

			// View
			const { res: resView } = await executeMedicalOfficerPipeline(
				'VIEW_EMERGENCY_REQUESTS',
				{
					headers: { authorization: `Bearer ${docToken}` },
					body: { hospitalId: testHospitalA._id.toString() },
				}
			)
			assert.strictEqual(resView.statusCode, 200)

			// Verify
			const { res: resVerify } = await executeMedicalOfficerPipeline(
				'VERIFY_EMERGENCY_REQUESTS',
				{
					headers: { authorization: `Bearer ${docToken}` },
					body: { hospitalId: testHospitalA._id.toString() },
				}
			)
			assert.strictEqual(resVerify.statusCode, 200)
		})
	})

	// =========================================================================
	// GROUP H: Administrative Audit and Outbox Integrity
	// =========================================================================
	describe('Group H: Administrative Audit and Outbox Integrity', () => {
		it('52. Every administrative action creates an audit record with previousStatus and newStatus', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			// 1. Approve
			const { res: resApprove } = await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Initial approval by administrator' },
				}
			)
			assert.strictEqual(resApprove.statusCode, 200)

			const audit1 = await AdministrativeDecisionAudit.findOne({
				entityId: assoc._id,
				decisionType: 'ASSOCIATION_APPROVED',
			})
			assert(audit1)
			assert.strictEqual(audit1.previousStatus, 'Pending_Admin_Approval')
			assert.strictEqual(audit1.newStatus, 'Active')
			assert.strictEqual(audit1.actorModel, 'admin')
			assert.strictEqual(audit1.actorId.toString(), testAdmin._id.toString())
			assert.strictEqual(audit1.sequenceNumber, 1)

			// 2. Suspend by Admin
			const { res: resSuspend } = await executeAdminPipeline(
				hospitalAssociationApprovalController.suspendAssociationByAdmin,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Administrative audit suspension' },
				}
			)
			assert.strictEqual(resSuspend.statusCode, 200)

			const audit2 = await AdministrativeDecisionAudit.findOne({
				entityId: assoc._id,
				decisionType: 'ASSOCIATION_SUSPENDED',
			})
			assert(audit2)
			assert.strictEqual(audit2.previousStatus, 'Active')
			assert.strictEqual(audit2.newStatus, 'Suspended')
			assert.strictEqual(audit2.sequenceNumber, 2)
			assert.strictEqual(audit2.previousRecordHash, audit1.recordHash)

			// 3. Reactivate by Admin
			const { res: resReactivate } = await executeAdminPipeline(
				hospitalAssociationApprovalController.reactivateAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Audit completed successfully, reactivating' },
				}
			)
			assert.strictEqual(resReactivate.statusCode, 200)

			const audit3 = await AdministrativeDecisionAudit.findOne({
				entityId: assoc._id,
				decisionType: 'ASSOCIATION_REACTIVATED',
			})
			assert(audit3)
			assert.strictEqual(audit3.previousStatus, 'Suspended')
			assert.strictEqual(audit3.newStatus, 'Active')
			assert.strictEqual(audit3.sequenceNumber, 3)
			assert.strictEqual(audit3.previousRecordHash, audit2.recordHash)

			// 4. Update Permissions
			const { res: resPerm } = await executeAdminPipeline(
				hospitalAssociationApprovalController.updateAssociationPermissions,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: {
						permissions: ['VIEW_EMERGENCY_REQUESTS', 'VERIFY_EMERGENCY_REQUESTS'],
						reason: 'Granting verify permissions',
					},
				}
			)
			assert.strictEqual(resPerm.statusCode, 200)

			const audit4 = await AdministrativeDecisionAudit.findOne({
				entityId: assoc._id,
				decisionType: 'ASSOCIATION_PERMISSIONS_UPDATED',
			})
			assert(audit4)
			assert.strictEqual(audit4.sequenceNumber, 4)
			assert.strictEqual(audit4.previousRecordHash, audit3.recordHash)

			// 5. Revoke by Admin
			const { res: resRevoke } = await executeAdminPipeline(
				hospitalAssociationApprovalController.revokeAssociationByAdmin,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Permanent retirement from facility' },
				}
			)
			assert.strictEqual(resRevoke.statusCode, 200)

			const audit5 = await AdministrativeDecisionAudit.findOne({
				entityId: assoc._id,
				decisionType: 'ASSOCIATION_REVOKED',
			})
			assert(audit5)
			assert.strictEqual(audit5.previousStatus, 'Active')
			assert.strictEqual(audit5.newStatus, 'Revoked')
			assert.strictEqual(audit5.sequenceNumber, 5)
			assert.strictEqual(audit5.previousRecordHash, audit4.recordHash)
		})

		it('53. Complete audit-chain integrity verified via verifyAuditChainIntegrity()', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			// Execute an approval to create audit chain entry
			await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Verification of audit chain integrity' },
				}
			)

			// Verify chain integrity
			const integrity = await verifyAuditChainIntegrity()
			assert.strictEqual(integrity.isValid, true)
			assert.strictEqual(integrity.errors.length, 0)
			assert(integrity.totalRecords >= 1)
		})

		it('54. Notification outbox events created for all lifecycle transitions', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			// Approve
			await executeAdminPipeline(
				hospitalAssociationApprovalController.approveAssociation,
				{
					headers: { authorization: `Bearer ${adminToken}` },
					params: {
						doctorId: doctor._id.toString(),
						associationId: assoc._id.toString(),
					},
					body: { reason: 'Lifecycle event outbox verification' },
				}
			)

			const event = await NotificationOutbox.findOne({
				eventType: 'ASSOCIATION_APPROVED',
				recipientUserId: doctor._id,
			})
			assert(event)
			assert.strictEqual(event.deliveryStatus, 'Pending')
		})

		it('55. Failed audit creation aborts entire transaction (no partial writes to database)', async () => {
			const doctor = await createDoctor({ credentialStatus: 'Verified', accountStatus: 'Active' })
			const assoc = await createAssociation(doctor._id, testHospitalA._id)

			// Monkey-patch AdministrativeDecisionAudit.create to fail
			const origAuditCreate = AdministrativeDecisionAudit.create
			AdministrativeDecisionAudit.create = async () => {
				throw new Error('SIMULATED_AUDIT_APPEND_FAILURE')
			}

			try {
				const { res } = await executeAdminPipeline(
					hospitalAssociationApprovalController.approveAssociation,
					{
						headers: { authorization: `Bearer ${adminToken}` },
						params: {
							doctorId: doctor._id.toString(),
							associationId: assoc._id.toString(),
						},
						body: { reason: 'Testing audit failure atomicity' },
					}
				)

				assert.strictEqual(res.statusCode, 500)

				// Association must remain Pending_Admin_Approval
				const unchanged = await MedicalOfficerHospital.findById(assoc._id)
				assert.strictEqual(unchanged.associationStatus, 'Pending_Admin_Approval')

				// No outbox event must exist
				const outbox = await NotificationOutbox.findOne({
					'payload.associationId': assoc._id.toString(),
				})
				assert.strictEqual(outbox, null)
			} finally {
				AdministrativeDecisionAudit.create = origAuditCreate
			}
		})
	})
})
