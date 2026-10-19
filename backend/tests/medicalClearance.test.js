const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const bloodUnitController = require('../BloodUnit/bloodUnitController')
const { BloodUnit, MANDATORY_TTI_TESTS } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const {
	protectStaff,
	restrictToStaffRole,
	generateStaffToken,
} = require('../BloodBank/bloodbankStaffMiddleware')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')

// Mock Request & Response Helper
function createMockReqRes({ staff, body = {}, query = {}, params = {}, headers = {}, ip = '127.0.0.1' } = {}) {
	const req = {
		staff: staff || null,
		user: staff
			? {
					_id: staff.bloodbankId,
					staffId: staff._id,
					staffName: staff.fullName,
					staffRole: staff.role,
					isStaff: true,
			  }
			: null,
		body,
		query,
		params,
		headers,
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
	}
	const next = (err) => {
		if (err) {
			res.statusCode = err.statusCode || 500
			res.responseData = { message: err.message }
		}
	}
	return { req, res, next }
}

// Mock ClientSession Helper
function createMockSession() {
	const session = {
		id: new mongoose.Types.ObjectId().toString(),
		isCommitted: false,
		isAborted: false,
		isEnded: false,
		async startTransaction() {},
		async commitTransaction() {
			this.isCommitted = true
		},
		async abortTransaction() {
			this.isAborted = true
		},
		async endSession() {
			this.isEnded = true
		},
		async withTransaction(fn) {
			try {
				await fn()
				this.isCommitted = true
			} catch (err) {
				this.isAborted = true
				throw err
			}
		},
	}
	return session
}

describe('Phase 3.3C — Medical Officer Clearance Endpoint (Unit & Controller Tests)', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId().toString()
	const otherBloodbankId = new mongoose.Types.ObjectId().toString()
	const mockStaffId = new mongoose.Types.ObjectId().toString()
	const mockUnitId = new mongoose.Types.ObjectId().toString()
	const mockDIN = 'DIN-2026292-ABC123-WB'

	// Active, Verified Medical Officer Fixture
	const verifiedMedicalOfficer = {
		_id: mockStaffId,
		fullName: 'Dr. Sarah Connor',
		email: 'dr.sarah@citycentral.org',
		role: 'Medical_Officer',
		status: 'Active',
		bloodbankId: mockBloodbankId,
		mustChangePassword: false,
		medicalLicense: {
			licenseNumber: 'KMC-2018-987654',
			issuingCouncil: 'Karnataka Medical Council',
			isVerified: true,
			verifiedBy: new mongoose.Types.ObjectId().toString(),
			verifiedAt: new Date('2026-10-18T10:00:00Z'),
			verificationNotes: 'Credentials verified by platform administrator.',
		},
	}

	// Helper to create an eligible Tested_Passed unit
	function createEligibleUnit(overrides = {}) {
		return new BloodUnit({
			_id: mockUnitId,
			unitNumber: mockDIN,
			bloodbankId: mockBloodbankId,
			bloodGroup: 'O_Positive',
			componentType: 'Whole_Blood',
			status: 'Tested_Passed',
			volumeMl: 350,
			collectionDate: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
			expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days from now
			testing: {
				hiv: 'Non_Reactive',
				hbv: 'Non_Reactive',
				hcv: 'Non_Reactive',
				syphilis: 'Non_Reactive',
				malaria: 'Non_Reactive',
				testedBy: mockBloodbankId,
				testedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
				testBatchId: 'BATCH-2026-001',
			},
			clearance: {
				isVerified: false,
				verifiedBy: null,
				verifiedByStaffId: null,
				verifiedAt: null,
				notes: '',
			},
			...overrides,
		})
	}

	// -------------------------------------------------------------
	// 1. Successful Clearance by Verified Medical Officer
	// -------------------------------------------------------------
	describe('1. Successful Medical Officer Clearance', () => {
		it('should transition Tested_Passed unit to Available and record immutable audit ledger inside transaction', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let savedUnit = null
			let savedAudit = null
			let sessionPassedToUnit = null
			let sessionPassedToAudit = null

			const unitDoc = createEligibleUnit()

			BloodUnit.findOne = async () => unitDoc

			BloodUnit.prototype.save = async function (opts) {
				sessionPassedToUnit = opts?.session
				savedUnit = this
				return this
			}

			BloodUnitAuditLog.prototype.save = async function (opts) {
				sessionPassedToAudit = opts?.session
				savedAudit = this
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
					body: { notes: 'Batch laboratory results reviewed and confirmed. Cleared for patient issue.' },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'Blood unit cleared successfully and marked Available.')
				assert.strictEqual(res.responseData.unit.status, 'Available')
				assert.strictEqual(res.responseData.unit.clearance.isVerified, true)
				assert.strictEqual(res.responseData.unit.clearance.verifiedBy.toString(), mockBloodbankId)
				assert.strictEqual(res.responseData.unit.clearance.verifiedByStaffId.toString(), mockStaffId)
				assert.ok(res.responseData.unit.clearance.verifiedAt)
				assert.match(res.responseData.unit.clearance.notes, /Dr\. Sarah Connor/)
				assert.match(res.responseData.unit.clearance.notes, /KMC-2018-987654/)

				// Verify Unit Save
				assert.ok(savedUnit, 'BloodUnit should be saved')
				assert.strictEqual(savedUnit.status, 'Available')
				assert.strictEqual(savedUnit.clearance.isVerified, true)
				assert.strictEqual(sessionPassedToUnit, mockSession)

				// Verify Audit Record
				assert.ok(savedAudit, 'BloodUnitAuditLog record should be created')
				assert.strictEqual(savedAudit.action, 'MEDICAL_OFFICER_CLEARED')
				assert.strictEqual(savedAudit.previousStatus, 'Tested_Passed')
				assert.strictEqual(savedAudit.newStatus, 'Available')
				assert.strictEqual(savedAudit.actor.actorId.toString(), mockStaffId)
				assert.strictEqual(savedAudit.actor.actorModel, 'bloodbank')
				assert.strictEqual(savedAudit.metadata.staffName, 'Dr. Sarah Connor')
				assert.strictEqual(savedAudit.metadata.licenseNumber, 'KMC-2018-987654')
				assert.strictEqual(savedAudit.metadata.issuingCouncil, 'Karnataka Medical Council')
				assert.strictEqual(sessionPassedToAudit, mockSession)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should allow unit lookup and clearance by DIN barcode string', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const unitDoc = createEligibleUnit()

			BloodUnit.findOne = async () => unitDoc
			BloodUnit.prototype.save = async function () { return this }
			BloodUnitAuditLog.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockDIN },
					body: {},
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.unit.unitNumber, mockDIN)
				assert.strictEqual(res.responseData.unit.status, 'Available')
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})
	})

	// -------------------------------------------------------------
	// 2. Authorization, Role & Governance Enforcement
	// -------------------------------------------------------------
	describe('2. Authorization, Role & Governance Gates', () => {
		it('should reject clearance attempts by Lab_Technician role (403)', async () => {
			const labTech = {
				...verifiedMedicalOfficer,
				role: 'Lab_Technician',
			}

			const { req, res, next } = createMockReqRes({
				staff: labTech,
				params: { id: mockUnitId },
			})

			// Test restrictToStaffRole guard
			restrictToStaffRole('Medical_Officer')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Access forbidden: Your role 'Lab_Technician' is not authorized/i)

			// Test controller defense-in-depth guard
			const res2 = createMockReqRes({ staff: labTech, params: { id: mockUnitId } }).res
			await bloodUnitController.verifyBloodUnitClearance(req, res2, next)
			assert.strictEqual(res2.statusCode, 403)
			assert.match(res2.responseData.message, /Only an authorized Medical Officer can verify blood unit clearance/i)
		})

		it('should reject clearance attempts by unverified Medical Officer (medicalLicense.isVerified !== true) (403)', async () => {
			const unverifiedMO = {
				...verifiedMedicalOfficer,
				medicalLicense: {
					...verifiedMedicalOfficer.medicalLicense,
					isVerified: false,
				},
			}

			const { req, res, next } = createMockReqRes({
				staff: unverifiedMO,
				params: { id: mockUnitId },
			})

			// Test restrictToStaffRole guard
			restrictToStaffRole('Medical_Officer')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Medical Officer credentials have not been verified/i)

			// Test controller defense-in-depth guard
			const res2 = createMockReqRes({ staff: unverifiedMO, params: { id: mockUnitId } }).res
			await bloodUnitController.verifyBloodUnitClearance(req, res2, next)
			assert.strictEqual(res2.statusCode, 403)
			assert.match(res2.responseData.message, /Medical Officer credentials have not been verified/i)
		})

		it('should reject Medical Officer who has not completed initial password change (mustChangePassword === true) (403)', async () => {
			const pendingPasswordMO = {
				...verifiedMedicalOfficer,
				mustChangePassword: true,
			}

			const { req, res, next } = createMockReqRes({
				staff: pendingPasswordMO,
				params: { id: mockUnitId },
			})

			restrictToStaffRole('Medical_Officer')(req, res, () => {})
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Initial password change required/i)

			const res2 = createMockReqRes({ staff: pendingPasswordMO, params: { id: mockUnitId } }).res
			await bloodUnitController.verifyBloodUnitClearance(req, res2, next)
			assert.strictEqual(res2.statusCode, 403)
			assert.match(res2.responseData.message, /Initial password change required/i)
		})

		it('should reject clearance attempts by suspended Medical Officer account (401)', async () => {
			const suspendedMO = {
				...verifiedMedicalOfficer,
				status: 'Suspended',
			}

			const { req, res, next } = createMockReqRes({
				staff: suspendedMO,
				params: { id: mockUnitId },
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /Staff account is inactive/i)
		})

		it('should reject clearance attempts by revoked Medical Officer account (401)', async () => {
			const revokedMO = {
				...verifiedMedicalOfficer,
				status: 'Revoked',
			}

			const { req, res, next } = createMockReqRes({
				staff: revokedMO,
				params: { id: mockUnitId },
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /Staff account is inactive/i)
		})

		it('should reject clearance attempts without authenticated staff context (403)', async () => {
			const { req, res, next } = createMockReqRes({
				staff: null,
				params: { id: mockUnitId },
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)
			assert.strictEqual(res.statusCode, 403)
			assert.match(res.responseData.message, /Only an authorized Medical Officer/i)
		})
	})

	// -------------------------------------------------------------
	// 3. Multi-Tenant Isolation & Ownership (BOLA Guard)
	// -------------------------------------------------------------
	describe('3. Multi-Tenant Isolation & BOLA Protection', () => {
		it('should forbid Medical Officer of Blood Bank B from clearing unit of Blood Bank A (returns safe 404)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			// Unit belongs to mockBloodbankId
			// Staff belongs to otherBloodbankId
			// findOne with { bloodbankId: otherBloodbankId } returns null
			BloodUnit.findOne = async () => null

			const foreignMO = {
				...verifiedMedicalOfficer,
				bloodbankId: otherBloodbankId,
			}

			try {
				const { req, res, next } = createMockReqRes({
					staff: foreignMO,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 404)
				assert.match(res.responseData.message, /Blood unit not found or not owned by your blood bank/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 4. Blood Unit Eligibility & Clinical Safety Gates
	// -------------------------------------------------------------
	describe('4. Blood Unit Clinical State & Eligibility Gates', () => {
		it('should reject clearance if unit is not found in database (404)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			BloodUnit.findOne = async () => null

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 404)
				assert.match(res.responseData.message, /Blood unit not found or not owned by your blood bank/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject invalid or malformed unit identifier format (400)', async () => {
			const { req, res, next } = createMockReqRes({
				staff: verifiedMedicalOfficer,
				params: { id: '   ' },
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unit identifier \(ID or DIN\) is required/i)
		})

		it('should reject clearance when unit is still Quarantined (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const quarantinedUnit = createEligibleUnit({ status: 'Quarantined' })
			BloodUnit.findOne = async () => quarantinedUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot clear blood unit for availability: current status is 'Quarantined'\. Expected 'Tested_Passed'/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject duplicate clearance if unit has already been verified (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const alreadyClearedUnit = createEligibleUnit({
				clearance: {
					isVerified: true,
					verifiedBy: mockBloodbankId,
					verifiedAt: new Date(),
				},
			})
			BloodUnit.findOne = async () => alreadyClearedUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Blood unit has already received Medical Officer clearance/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when any mandatory screening test is not Non_Reactive (e.g. Reactive) (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const reactiveUnit = createEligibleUnit({
				testing: {
					hiv: 'Reactive', // Contaminated!
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			BloodUnit.findOne = async () => reactiveUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Mandatory screening test 'hiv' is 'Reactive'\. All tests must be confirmed 'Non_Reactive'/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when any mandatory screening test is still Pending (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const pendingUnit = createEligibleUnit({
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Pending', // Incomplete panel!
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			BloodUnit.findOne = async () => pendingUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Mandatory screening test 'hcv' is 'Pending'\. All tests must be confirmed 'Non_Reactive'/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when unit testing records are completely missing (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const unitNoTesting = createEligibleUnit()
			unitNoTesting.testing = null
			BloodUnit.findOne = async () => unitNoTesting

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Blood unit has no screening testing records|Mandatory screening test 'hiv' is 'Missing'/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when blood unit is expired (expiryDate <= now) (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const expiredUnit = createEligibleUnit({
				collectionDate: new Date('2026-08-01T10:00:00Z'),
				expiryDate: new Date('2026-09-05T10:00:00Z'), // Already expired!
			})
			BloodUnit.findOne = async () => expiredUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Blood unit has expired and cannot be cleared for availability/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when collectionDate is in the future (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const futureUnit = createEligibleUnit({
				collectionDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5 days in future!
				expiryDate: new Date(Date.now() + 40 * 24 * 60 * 60 * 1000),
			})
			BloodUnit.findOne = async () => futureUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Unit collection date cannot be in the future/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when collectionDate is after expiryDate (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const invalidDatesUnit = createEligibleUnit({
				collectionDate: new Date('2026-10-18T10:00:00Z'),
				expiryDate: new Date('2026-10-10T10:00:00Z'), // Expiry before collection!
			})
			BloodUnit.findOne = async () => invalidDatesUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Safety violation/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when unit is in Reserved status (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const reservedUnit = createEligibleUnit({ status: 'Reserved' })
			BloodUnit.findOne = async () => reservedUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /current status is 'Reserved'\. Expected 'Tested_Passed'/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when unit is in Issued status (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const issuedUnit = createEligibleUnit({ status: 'Issued' })
			BloodUnit.findOne = async () => issuedUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /current status is 'Issued'\. Expected 'Tested_Passed'/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject clearance when unit is in Discarded status (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const discardedUnit = createEligibleUnit({ status: 'Discarded' })
			BloodUnit.findOne = async () => discardedUnit

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /current status is 'Discarded'\. Expected 'Tested_Passed'/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 5. Request Body Tampering & Injection Protection
	// -------------------------------------------------------------
	describe('5. Request Body Tampering & Field Injection Defense', () => {
		it('should reject request containing injected status field (400)', async () => {
			const { req, res, next } = createMockReqRes({
				staff: verifiedMedicalOfficer,
				params: { id: mockUnitId },
				body: { status: 'Available' }, // Field injection attempt!
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unrecognized or forbidden field: 'status'/i)
		})

		it('should reject request containing injected isVerified or clearance field (400)', async () => {
			const { req, res, next } = createMockReqRes({
				staff: verifiedMedicalOfficer,
				params: { id: mockUnitId },
				body: { isVerified: true }, // Field injection attempt!
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unrecognized or forbidden field: 'isVerified'/i)
		})

		it('should reject request containing injected staff or bloodbank IDs (400)', async () => {
			const { req, res, next } = createMockReqRes({
				staff: verifiedMedicalOfficer,
				params: { id: mockUnitId },
				body: { bloodbankId: otherBloodbankId }, // BOLA injection attempt!
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unrecognized or forbidden field: 'bloodbankId'/i)
		})

		it('should reject request when notes is not a string (400)', async () => {
			const { req, res, next } = createMockReqRes({
				staff: verifiedMedicalOfficer,
				params: { id: mockUnitId },
				body: { notes: { malicious: 'payload' } },
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /'notes' must be a string/i)
		})

		it('should reject request when notes exceeds 500 characters (400)', async () => {
			const { req, res, next } = createMockReqRes({
				staff: verifiedMedicalOfficer,
				params: { id: mockUnitId },
				body: { notes: 'A'.repeat(501) },
			})

			await bloodUnitController.verifyBloodUnitClearance(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /'notes' exceeds maximum permitted length/i)
		})
	})

	// -------------------------------------------------------------
	// 6. Transaction Rollback & Failure Recovery
	// -------------------------------------------------------------
	describe('6. Transaction Rollback & Failure Recovery', () => {
		it('should abort transaction and rollback changes when audit log save fails', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const unitDoc = createEligibleUnit()
			BloodUnit.findOne = async () => unitDoc
			BloodUnit.prototype.save = async function () { return this }

			// Audit save fails with disk/database error
			BloodUnitAuditLog.prototype.save = async function () {
				throw new Error('Database disk full: unable to append audit log.')
			}

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.match(res.responseData.message, /Database disk full/i)
				assert.strictEqual(mockSession.isAborted, true, 'Transaction must be aborted on audit failure')
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should abort transaction and rollback when unit save fails', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save

			const unitDoc = createEligibleUnit()
			BloodUnit.findOne = async () => unitDoc

			// Unit save fails with validation error
			BloodUnit.prototype.save = async function () {
				throw new Error('Safety violation: Simulated validation failure during save.')
			}

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMedicalOfficer,
					params: { id: mockUnitId },
				})

				await bloodUnitController.verifyBloodUnitClearance(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Simulated validation failure/i)
				assert.strictEqual(mockSession.isAborted, true, 'Transaction must be aborted on unit save failure')
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
			}
		})
	})

	// -------------------------------------------------------------
	// 7. Schema Invariant Guards & Query-Level Bypass Rejection
	// -------------------------------------------------------------
	describe('7. Schema Invariant Guards & Query-Level Bypass Rejection', () => {
		it('should reject transitioning unit to Available in model pre-save without explicit clearance.isVerified', async () => {
			const unit = createEligibleUnit()
			unit.status = 'Available'
			unit.clearance.isVerified = false // Unverified!

			await assert.rejects(
				async () => {
					await unit.save()
				},
				(err) => {
					assert.match(err.message, /Safety violation: BloodUnit cannot be Available without explicit Medical Officer clearance verification/i)
					return true
				}
			)
		})

		it('should reject transitioning unit to Available in model pre-save if any screening test is not Non_Reactive', async () => {
			const unit = createEligibleUnit()
			unit.status = 'Available'
			unit.clearance.isVerified = true
			unit.testing.hiv = 'Reactive' // Contaminated!

			await assert.rejects(
				async () => {
					await unit.save()
				},
				(err) => {
					assert.match(err.message, /Safety violation: BloodUnit cannot be Available: mandatory screening test 'hiv' is 'Reactive'/i)
					return true
				}
			)
		})

		it('should reject query-level status update to Available via updateOne', async () => {
			await assert.rejects(
				async () => {
					await BloodUnit.updateOne({ _id: mockUnitId }, { status: 'Available' })
				},
				(err) => {
					assert.match(err.message, /Query-based transition to status 'Available' is strictly forbidden/i)
					return true
				}
			)
		})

		it('should reject query-level status update to Available via findOneAndUpdate', async () => {
			await assert.rejects(
				async () => {
					await BloodUnit.findOneAndUpdate({ _id: mockUnitId }, { $set: { status: 'Available' } })
				},
				(err) => {
					assert.match(err.message, /Query-based transition to status 'Available' is strictly forbidden/i)
					return true
				}
			)
		})

		it('should strictly reject mutation or deletion of BloodUnitAuditLog records (immutable ledger)', async () => {
			await assert.rejects(
				async () => {
					await BloodUnitAuditLog.updateOne({ _id: new mongoose.Types.ObjectId() }, { action: 'TAMPERED' })
				},
				(err) => {
					assert.match(err.message, /BloodUnitAuditLog records are append-only/i)
					return true
				}
			)

			await assert.rejects(
				async () => {
					await BloodUnitAuditLog.deleteOne({ _id: new mongoose.Types.ObjectId() })
				},
				(err) => {
					assert.match(err.message, /BloodUnitAuditLog records are append-only/i)
					return true
				}
			)
		})
	})
})
