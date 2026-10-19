const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const bloodUnitController = require('../BloodUnit/bloodUnitController')
const receiveController = require('../BloodReceive/bloodReceiveController')
const {
	issueUnitsForRequest,
	recordCrossmatchForUnit,
	validateCrossmatchResult,
} = require('../BloodUnit/issuanceService')
const {
	protectBloodbankOrStaff,
	generateStaffToken,
} = require('../BloodBank/bloodbankStaffMiddleware')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const Bloodstock = require('../BloodStock/bloodStockModel')

// Mock Request & Response Helper
function createMockReqRes({ user, staff, body = {}, query = {}, params = {}, headers = {}, ip = '127.0.0.1' } = {}) {
	const req = {
		user: user || (staff ? { _id: staff.bloodbankId, staffId: staff._id, isStaff: true } : { _id: new mongoose.Types.ObjectId().toString() }),
		staff: staff || null,
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

describe('Phase 3.4 — Final Issuance & Physical Dispatch', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId().toString()
	const otherBloodbankId = new mongoose.Types.ObjectId().toString()
	const mockUserId = new mongoose.Types.ObjectId().toString()
	const mockRequestId = new mongoose.Types.ObjectId().toString()

	const bloodbankUser = {
		_id: mockBloodbankId,
		bloodbankName: 'City Central Blood Bank',
	}

	const otherBloodbankUser = {
		_id: otherBloodbankId,
		bloodbankName: 'Metropolitan Hospital Blood Bank',
	}

	function mockChainableFind(results = []) {
		const obj = {
			then(resolve, reject) {
				return Promise.resolve(results).then(resolve, reject)
			},
			sort() {
				return this
			},
			limit() {
				return this
			},
		}
		return obj
	}

	// Helper to create a reserved unit
	function createReservedUnit(overrides = {}) {
		const doc = new BloodUnit({
			_id: new mongoose.Types.ObjectId(),
			unitNumber: `DIN-2026-${Math.random().toString(36).substring(2, 8).toUpperCase()}-WB`,
			bloodbankId: mockBloodbankId,
			bloodGroup: 'O_Positive',
			componentType: 'Whole_Blood',
			status: 'Reserved',
			volumeMl: 350,
			collectionDate: new Date('2026-10-10T10:00:00Z'),
			expiryDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000), // 15 days in future
			testing: {
				hiv: 'Non_Reactive',
				hbv: 'Non_Reactive',
				hcv: 'Non_Reactive',
				syphilis: 'Non_Reactive',
				malaria: 'Non_Reactive',
				testedBy: mockBloodbankId,
				testedAt: new Date('2026-10-11T10:00:00Z'),
			},
			clearance: {
				isVerified: true,
				verifiedBy: mockBloodbankId,
				verifiedAt: new Date('2026-10-12T10:00:00Z'),
			},
			reservation: {
				receiveRequestId: mockRequestId,
				reservedAt: new Date('2026-10-15T10:00:00Z'),
				reservedExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // Active hold
			},
			issuance: {
				issuedToReceiveRequestId: null,
				recipientPatientName: '',
				hospitalName: '',
				crossmatchResult: 'Pending',
				issuedAt: null,
				issuedBy: null,
			},
			...overrides,
		})
		return doc
	}

	// Helper to create a receive request
	function createReceiveRequestDoc(overrides = {}) {
		const doc = new ReceiveRequests({
			_id: mockRequestId,
			userId: mockUserId,
			bloodbankId: mockBloodbankId,
			bloodType: 'O_Positive',
			unit: 1,
			status: 'Accepted',
			whenDoYouWant: new Date(Date.now() + 48 * 60 * 60 * 1000),
			reservedUnitIds: [],
			message: 'Urgent surgery allocation',
			...overrides,
		})
		return doc
	}

	describe('1. Successful Issuance & Dispatch Workflow', () => {
		it('should atomically issue reserved unit, record compatible crossmatch, populate dispatch metadata, and transition request to Fulfilled', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save
			const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])

			let updatedUnitData = null
			BloodUnit.findOneAndUpdate = async (filter, update) => {
				assert.strictEqual(filter._id.toString(), reservedUnit._id.toString())
				assert.strictEqual(filter.status, 'Reserved')
				assert.strictEqual(filter['reservation.receiveRequestId'].toString(), requestDoc._id.toString())
				assert.strictEqual(update.$set.status, 'Issued')
				assert.strictEqual(update.$set['issuance.crossmatchResult'], 'Compatible')
				assert.strictEqual(update.$set['issuance.recipientPatientName'], 'John Doe')
				assert.strictEqual(update.$set['issuance.hospitalName'], 'Apollo Hospital')
				reservedUnit.status = 'Issued'
				reservedUnit.issuance = {
					issuedToReceiveRequestId: requestDoc._id,
					recipientPatientName: 'John Doe',
					hospitalName: 'Apollo Hospital',
					crossmatchResult: 'Compatible',
					issuedAt: new Date(),
					issuedBy: mockBloodbankId,
				}
				updatedUnitData = reservedUnit
				return reservedUnit
			}

			const recordedAudits = []
			BloodUnitAuditLog.prototype.save = async function () {
				recordedAudits.push(this.toObject())
				return this
			}

			ReceiveRequests.findOneAndUpdate = async (filter, update) => {
				assert.strictEqual(filter._id.toString(), requestDoc._id.toString())
				assert.strictEqual(update.$set.status, 'Fulfilled')
				requestDoc.status = 'Fulfilled'
				return requestDoc
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						recipientPatientName: 'John Doe',
						hospitalName: 'Apollo Hospital',
						crossmatchResult: 'Compatible',
						dispatchNotes: 'Delivered via cold box #4',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.issuance.status, 'Fulfilled')
				assert.strictEqual(res.responseData.issuance.recipientPatientName, 'John Doe')
				assert.strictEqual(res.responseData.issuance.hospitalName, 'Apollo Hospital')
				assert.strictEqual(res.responseData.issuance.unitsCount, 1)

				// Verify donor privacy: No donorUserId or donor contact info in response
				const issuedUnitSummary = res.responseData.issuance.units[0]
				assert.strictEqual(issuedUnitSummary.unitNumber, reservedUnit.unitNumber)
				assert.strictEqual(issuedUnitSummary.crossmatchResult, 'Compatible')
				assert.strictEqual(issuedUnitSummary.donorUserId, undefined)
				assert.strictEqual(issuedUnitSummary.donorPhone, undefined)

				// Verify audit log
				assert.strictEqual(recordedAudits.length, 1)
				assert.strictEqual(recordedAudits[0].action, 'UNIT_ISSUED')
				assert.strictEqual(recordedAudits[0].previousStatus, 'Reserved')
				assert.strictEqual(recordedAudits[0].newStatus, 'Issued')
				assert.strictEqual(recordedAudits[0].metadata.crossmatchResult, 'Compatible')
				assert.strictEqual(recordedAudits[0].metadata.hospitalName, 'Apollo Hospital')
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
				ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
			}
		})

		it('should successfully issue multiple reserved units using per-unit crossmatch mappings', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save
			const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			const unit1 = createReservedUnit()
			const unit2 = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				unit: 2,
				reservedUnitIds: [unit1._id, unit2._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([unit1, unit2])

			BloodUnit.findOneAndUpdate = async (filter, update) => {
				const matched = filter._id.toString() === unit1._id.toString() ? unit1 : unit2
				matched.status = 'Issued'
				matched.issuance = {
					issuedToReceiveRequestId: requestDoc._id,
					crossmatchResult: update.$set['issuance.crossmatchResult'],
					issuedAt: new Date(),
				}
				return matched
			}

			BloodUnitAuditLog.prototype.save = async function () { return this }
			ReceiveRequests.findOneAndUpdate = async () => {
				requestDoc.status = 'Fulfilled'
				return requestDoc
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						recipientPatientName: 'Jane Smith',
						hospitalName: 'Memorial Medical Center',
						unitCrossmatches: [
							{ unitId: unit1._id, crossmatchResult: 'Compatible' },
							{ unitId: unit2._id, crossmatchResult: 'Compatible' },
						],
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.issuance.unitsCount, 2)
				assert.strictEqual(res.responseData.issuance.status, 'Fulfilled')
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
				ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
			}
		})
	})

	describe('2. Cross-Tenant Access Denial (BOLA)', () => {
		it('should reject issuance if receive request belongs to blood bank A and caller is blood bank B (404)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			// Query checks bloodbankId: otherBloodbankId, returns null
			ReceiveRequests.findOne = async () => null

			try {
				const { req, res, next } = createMockReqRes({
					user: otherBloodbankUser,
					body: {
						requestId: mockRequestId,
						recipientPatientName: 'Target Patient',
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 404)
				assert.match(res.responseData.message, /not found or not owned/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
			}
		})
	})

	describe('3. Wrong Request / Unit Association Guards', () => {
		it('should reject issuance if reserved unit belongs to a different receive request', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const foreignRequestId = new mongoose.Types.ObjectId().toString()
			const wrongUnit = createReservedUnit({
				reservation: {
					receiveRequestId: foreignRequestId, // Belongs to different request!
					reservedExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
				},
			})

			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [wrongUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([wrongUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Wrong request\/unit association/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should reject issuance if request has no reserved units assigned', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [], // Empty!
			})

			ReceiveRequests.findOne = async () => requestDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Insufficient reserved units/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
			}
		})

		it('should reject issuing units for a request in Pending status (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				status: 'Pending', // Must be Accepted!
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /must be in 'Accepted' status before issuance/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
			}
		})

		it('should reject issuing units if requested units count exceeds reserved units count (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				status: 'Accepted',
				unit: 3, // Requires 3 units!
				reservedUnitIds: [reservedUnit._id], // Only 1 reserved!
			})

			ReceiveRequests.findOne = async () => requestDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Insufficient reserved units/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
			}
		})
	})

	describe('4. Expiry & Shelf-Life Safety Gates', () => {
		it('should strictly reject issuing a clinically expired unit (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const expiredUnit = createReservedUnit({
				expiryDate: new Date('2026-10-01T10:00:00Z'), // Past date!
			})
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [expiredUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([expiredUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /expired clinically/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should strictly reject issuing a unit whose reservation hold has expired (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const holdExpiredUnit = createReservedUnit({
				reservation: {
					receiveRequestId: mockRequestId,
					reservedExpiresAt: new Date(Date.now() - 3600 * 1000), // Hold expired 1 hour ago
				},
			})
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [holdExpiredUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([holdExpiredUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Reservation hold expired/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})
	})

	describe('5. Crossmatch Validation Safeguards', () => {
		it('should strictly forbid issuing an Incompatible blood unit under any circumstances (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Incompatible', // FATAL if issued!
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Incompatible blood units can NEVER be issued/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should strictly reject issuing a unit with Pending crossmatch result (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Pending',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Crossmatch result is 'Pending'/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should strictly reject issuing without any crossmatch result provided or recorded (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const reservedUnit = createReservedUnit() // Has default crossmatchResult: 'Pending'
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						// No crossmatchResult
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Crossmatch result is 'Pending'/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should reject Emergency_Uncrossmatched issuance if isEmergency flag is false (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Emergency_Uncrossmatched',
						isEmergency: false, // Not authorized
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /requires explicit emergency protocol authorization/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should reject Emergency_Uncrossmatched issuance if emergencyReason is missing or under 10 characters (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])

			const verifiedMOStaff = {
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: mockBloodbankId,
				role: 'Medical_Officer',
				fullName: 'Dr. Sarah Connor',
				medicalLicense: {
					isVerified: true,
				},
			}

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMOStaff,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Emergency_Uncrossmatched',
						isEmergency: true,
						emergencyReason: 'Short', // Under 10 chars!
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /requires clinical justification/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should reject Emergency_Uncrossmatched issuance if staff is a Lab Technician rather than a verified Medical Officer (403)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])

			const labTechStaff = {
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: mockBloodbankId,
				role: 'Lab_Technician', // Not a Medical Officer!
				fullName: 'Lab Tech John',
			}

			try {
				const { req, res, next } = createMockReqRes({
					staff: labTechStaff,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Emergency_Uncrossmatched',
						isEmergency: true,
						emergencyReason: 'Exsanguinating hemorrhage in trauma center',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 403)
				assert.match(res.responseData.message, /strictly requires authorization by a verified Medical Officer/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should reject Emergency_Uncrossmatched issuance if caller lacks an authenticated verified Medical Officer staff record (403)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save
			const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])
			BloodUnit.findOneAndUpdate = async (filter, update) => {
				reservedUnit.status = 'Issued'
				reservedUnit.issuance.crossmatchResult = update.$set['issuance.crossmatchResult']
				reservedUnit.issuance.emergency = update.$set['issuance.emergency']
				return reservedUnit
			}
			BloodUnitAuditLog.prototype.save = async function () { return this }
			ReceiveRequests.findOneAndUpdate = async () => requestDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser, // Institutional caller with no req.staff
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Emergency_Uncrossmatched',
						isEmergency: true,
						emergencyReason: 'Massive internal trauma resuscitation in ER bay 3',
						dispatchNotes: 'Delivered stat to trauma team',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 403)
				assert.match(
					res.responseData.message,
					/strictly requires authorization by a verified Medical Officer/i
				)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
				ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
			}
		})

		it('should permit Emergency_Uncrossmatched issuance when authorized by verified Medical Officer with clinical justification', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save
			const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])
			BloodUnit.findOneAndUpdate = async (filter, update) => {
				reservedUnit.status = 'Issued'
				reservedUnit.issuance.crossmatchResult = update.$set['issuance.crossmatchResult']
				reservedUnit.issuance.emergency = update.$set['issuance.emergency']
				return reservedUnit
			}
			BloodUnitAuditLog.prototype.save = async function () { return this }
			ReceiveRequests.findOneAndUpdate = async () => requestDoc

			const verifiedMOStaff = {
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: mockBloodbankId,
				role: 'Medical_Officer',
				fullName: 'Dr. Sarah Connor',
				medicalLicense: {
					isVerified: true,
				},
			}

			try {
				const { req, res, next } = createMockReqRes({
					staff: verifiedMOStaff,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Emergency_Uncrossmatched',
						isEmergency: true,
						emergencyReason: 'Severe thoracic trauma with hemorrhagic shock',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.issuance.units[0].crossmatchResult, 'Emergency_Uncrossmatched')
				assert.strictEqual(res.responseData.issuance.isEmergency, true)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
				ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
			}
		})
	})

	describe('6. Duplicate Issuance & Concurrency Conflict Protection', () => {
		it('should reject duplicate issuance if request is already in Fulfilled status (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne

			const requestDoc = createReceiveRequestDoc({
				status: 'Fulfilled', // Already fulfilled!
			})

			ReceiveRequests.findOne = async () => requestDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Request has already been fulfilled/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
			}
		})

		it('should abort and return 409 conflict when conditional unit update returns null (concurrent race)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])
			// Concurrent transaction claimed or modified unit: returns null!
			BloodUnit.findOneAndUpdate = async () => null

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 409)
				assert.match(res.responseData.message, /Concurrent issuance conflict/i)
				assert.strictEqual(mockSession.isAborted, true)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
			}
		})

		it('should enforce { "issuance.crossmatchResult": { $ne: "Incompatible" } } in atomic conditional update filter to prevent concurrent bypass', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			let capturedFilter = null
			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])
			BloodUnit.findOneAndUpdate = async (filter, update) => {
				capturedFilter = filter
				// Simulate concurrent race: another thread recorded crossmatch as Incompatible,
				// so atomic filter condition matching { $ne: 'Incompatible' } returns null.
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 409)
				assert.deepStrictEqual(capturedFilter['issuance.crossmatchResult'], { $ne: 'Incompatible' })
				assert.match(res.responseData.message, /Concurrent issuance conflict/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
			}
		})
	})

	describe('7. Transaction Integrity & Rollback Protection', () => {
		it('should abort transaction and rollback when audit log creation fails inside replica set', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])
			BloodUnit.findOneAndUpdate = async () => reservedUnit

			BloodUnitAuditLog.prototype.save = async function () {
				const err = new Error('Disk write error during audit log persistence')
				err.statusCode = 500
				throw err
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.strictEqual(mockSession.isAborted, true)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should execute compensating rollback in standalone fallback mode if request update fails', async () => {
			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalUnitUpdateOne = BloodUnit.updateOne
			const originalAuditSave = BloodUnitAuditLog.prototype.save
			const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])
			BloodUnit.findOneAndUpdate = async () => reservedUnit
			BloodUnitAuditLog.prototype.save = async function () { return this }

			// Request update fails
			ReceiveRequests.findOneAndUpdate = async () => null

			let rollbackUnitCalled = false
			BloodUnit.updateOne = async (filter, update) => {
				rollbackUnitCalled = true
				assert.strictEqual(filter._id.toString(), reservedUnit._id.toString())
				assert.strictEqual(update.$set.status, 'Reserved')
				return { modifiedCount: 1 }
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 409)
				assert.strictEqual(rollbackUnitCalled, true)
			} finally {
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
				BloodUnit.updateOne = originalUnitUpdateOne
				BloodUnitAuditLog.prototype.save = originalAuditSave
				ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
			}
		})
	})

	describe('8. Role-Based Access Control & Staff Governance', () => {
		it('should forbid unverified Medical Officers from issuing blood units (403)', async () => {
			const unverifiedMO = {
				_id: new mongoose.Types.ObjectId().toString(),
				fullName: 'Dr. Fake License',
				role: 'Medical_Officer',
				status: 'Active',
				bloodbankId: mockBloodbankId,
				mustChangePassword: false,
				medicalLicense: {
					isVerified: false, // Unverified credentials!
				},
			}

			const token = generateStaffToken(unverifiedMO)
			const originalStaffFindById = BloodbankStaff.findById
			BloodbankStaff.findById = async () => ({
				...unverifiedMO,
				changedPasswordAfter: () => false,
			})

			try {
				const { req, res, next } = createMockReqRes({
					headers: { authorization: `Bearer ${token}` },
				})

				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				await middleware(req, res, next)

				assert.strictEqual(res.statusCode, 403)
				assert.match(res.responseData.message, /Medical Officer credentials have not been verified/i)
			} finally {
				BloodbankStaff.findById = originalStaffFindById
			}
		})

		it('should forbid staff who have not changed initial password (mustChangePassword: true) (403)', async () => {
			const initialPasswordStaff = {
				_id: new mongoose.Types.ObjectId().toString(),
				fullName: 'Tech Newbie',
				role: 'Lab_Technician',
				status: 'Active',
				bloodbankId: mockBloodbankId,
				mustChangePassword: true, // Gate!
			}

			const token = generateStaffToken(initialPasswordStaff)
			const originalStaffFindById = BloodbankStaff.findById
			BloodbankStaff.findById = async () => ({
				...initialPasswordStaff,
				changedPasswordAfter: () => false,
			})

			try {
				const { req, res, next } = createMockReqRes({
					headers: { authorization: `Bearer ${token}` },
				})

				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				await middleware(req, res, next)

				assert.strictEqual(res.statusCode, 403)
				assert.match(res.responseData.message, /Initial password change required/i)
			} finally {
				BloodbankStaff.findById = originalStaffFindById
			}
		})

		it('should reject suspended staff members (401)', async () => {
			const suspendedStaff = {
				_id: new mongoose.Types.ObjectId().toString(),
				fullName: 'Suspended Tech',
				role: 'Lab_Technician',
				status: 'Suspended',
				bloodbankId: mockBloodbankId,
				mustChangePassword: false,
			}

			const token = generateStaffToken(suspendedStaff)
			const originalStaffFindById = BloodbankStaff.findById
			BloodbankStaff.findById = async () => ({
				...suspendedStaff,
				changedPasswordAfter: () => false,
			})

			try {
				const { req, res, next } = createMockReqRes({
					headers: { authorization: `Bearer ${token}` },
				})

				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				await middleware(req, res, next)

				assert.strictEqual(res.statusCode, 401)
				assert.match(res.responseData.message, /currently suspended/i)
			} finally {
				BloodbankStaff.findById = originalStaffFindById
			}
		})

		it('should allow verified Medical Officer to authorize issuance', async () => {
			const verifiedMO = {
				_id: new mongoose.Types.ObjectId().toString(),
				fullName: 'Dr. John Watson',
				role: 'Medical_Officer',
				status: 'Active',
				bloodbankId: mockBloodbankId,
				mustChangePassword: false,
				medicalLicense: {
					isVerified: true,
				},
			}

			const token = generateStaffToken(verifiedMO)
			const originalStaffFindById = BloodbankStaff.findById
			BloodbankStaff.findById = async () => ({
				...verifiedMO,
				changedPasswordAfter: () => false,
			})

			try {
				const { req, res, next } = createMockReqRes({
					headers: { authorization: `Bearer ${token}` },
				})

				let nextCalled = false
				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(nextCalled, true)
				assert.strictEqual(req.staffRole, 'Medical_Officer')
			} finally {
				BloodbankStaff.findById = originalStaffFindById
			}
		})
	})

	describe('9. Audit Trail & Immutability Verification', () => {
		it('should record an append-only audit record and block updates or deletes on audit entries', async () => {
			const auditEntry = new BloodUnitAuditLog({
				unitId: new mongoose.Types.ObjectId(),
				unitNumber: 'DIN-2026-AUDIT1-WB',
				bloodbankId: mockBloodbankId,
				action: 'UNIT_ISSUED',
				previousStatus: 'Reserved',
				newStatus: 'Issued',
				actor: {
					actorId: new mongoose.Types.ObjectId(),
					actorModel: 'bloodbank',
				},
				metadata: {
					crossmatchResult: 'Compatible',
					recipientPatientName: 'Test Recipient',
				},
			})

			assert.strictEqual(auditEntry.action, 'UNIT_ISSUED')
			assert.strictEqual(auditEntry.previousStatus, 'Reserved')
			assert.strictEqual(auditEntry.newStatus, 'Issued')

			// Verify mutation guard
			let updateRejected = false
			try {
				await BloodUnitAuditLog.updateOne({ _id: auditEntry._id }, { action: 'UNIT_DISCARDED' })
			} catch (err) {
				updateRejected = true
				assert.match(err.message, /append-only and cannot be modified/i)
			}
			assert.strictEqual(updateRejected, true)
		})
	})

	describe('10. Legacy Inventory Stock Isolation', () => {
		it('should issue traceable units without checking, decrementing, or mutating aggregate Bloodstock', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save
			const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			let bloodStockTouched = false
			const originalBloodstockFindOne = Bloodstock.findOne
			const originalBloodstockFindOneAndUpdate = Bloodstock.findOneAndUpdate
			Bloodstock.findOne = async () => {
				bloodStockTouched = true
				return null
			}
			Bloodstock.findOneAndUpdate = async () => {
				bloodStockTouched = true
				return null
			}

			const reservedUnit = createReservedUnit()
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [reservedUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([reservedUnit])
			BloodUnit.findOneAndUpdate = async () => reservedUnit
			BloodUnitAuditLog.prototype.save = async function () { return this }
			ReceiveRequests.findOneAndUpdate = async () => requestDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						requestId: mockRequestId,
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.issueBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(bloodStockTouched, false) // Zero legacy stock calls!
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
				ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
				Bloodstock.findOne = originalBloodstockFindOne
				Bloodstock.findOneAndUpdate = originalBloodstockFindOneAndUpdate
			}
		})
	})

	describe('11. Backward Compatibility for Legacy Requests', () => {
		it('should fulfill legacy receive requests without traceable units via aggregate Bloodstock decrement', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			let stockDecreased = false
			const originalStockFindOne = Bloodstock.findOne
			const originalStockFindOneAndUpdate = Bloodstock.findOneAndUpdate

			// Legacy request has NO reservedUnitIds
			const legacyRequest = createReceiveRequestDoc({
				bloodType: 'A_Positive',
				unit: 2,
				status: 'Pending',
				reservedUnitIds: [], // Empty!
			})

			ReceiveRequests.findOne = async () => legacyRequest

			// Mock stock availability check
			Bloodstock.findOne = async () => ({
				A_Positive: 10,
			})

			// Mock stock decrease
			Bloodstock.findOneAndUpdate = async () => {
				stockDecreased = true
				return { bloodType: 'A_Positive', unit: 8 }
			}

			ReceiveRequests.findOneAndUpdate = async (filter, update) => {
				legacyRequest.status = 'Fulfilled'
				return legacyRequest
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						id: mockRequestId,
						bloodType: 'A_Positive',
						unit: 2,
					},
				})

				await receiveController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(stockDecreased, true) // Decremented aggregate stock for legacy request!
				assert.strictEqual(legacyRequest.status, 'Fulfilled')
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
				Bloodstock.findOne = originalStockFindOne
				Bloodstock.findOneAndUpdate = originalStockFindOneAndUpdate
			}
		})

		it('should reject legacy fulfillment if reserved unit has an Incompatible crossmatch result (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const incompatibleUnit = createReservedUnit({
				issuance: { crossmatchResult: 'Incompatible' },
			})
			const requestWithIncompatibleUnit = createReceiveRequestDoc({
				bloodType: 'A_Positive',
				unit: 1,
				status: 'Pending',
				reservedUnitIds: [incompatibleUnit._id],
			})

			ReceiveRequests.findOne = async () => requestWithIncompatibleUnit
			BloodUnit.find = () => mockChainableFind([incompatibleUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						id: mockRequestId,
						bloodType: 'A_Positive',
						unit: 1,
					},
				})

				await receiveController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /has an Incompatible crossmatch result/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})
	})

	describe('12. Pre-Issuance Crossmatch Recording Endpoint', () => {
		it('should record Compatible crossmatch on a reserved unit', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalUnitFindOne = BloodUnit.findOne
			const reservedUnit = createReservedUnit()

			let saveCalled = false
			reservedUnit.save = async function () {
				saveCalled = true
				return this
			}

			const originalAuditSave = BloodUnitAuditLog.prototype.save
			BloodUnitAuditLog.prototype.save = async function () { return this }

			BloodUnit.findOne = async () => reservedUnit

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: reservedUnit._id.toString() },
					body: {
						crossmatchResult: 'Compatible',
						notes: 'Major and minor crossmatch confirmed compatible via gel card method.',
					},
				})

				await bloodUnitController.recordCrossmatchResult(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(saveCalled, true)
				assert.strictEqual(reservedUnit.issuance.crossmatchResult, 'Compatible')
				assert.strictEqual(res.responseData.unit.crossmatchResult, 'Compatible')
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalUnitFindOne
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should reject recording crossmatch if unit is already Discarded (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalUnitFindOne = BloodUnit.findOne
			const discardedUnit = createReservedUnit({
				status: 'Discarded',
			})

			BloodUnit.findOne = async () => discardedUnit

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: discardedUnit._id.toString() },
					body: {
						crossmatchResult: 'Compatible',
					},
				})

				await bloodUnitController.recordCrossmatchResult(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot record crossmatch on a unit in status 'Discarded'/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalUnitFindOne
			}
		})

		it('should strictly reject overwriting a confirmed Incompatible crossmatch to Compatible (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalUnitFindOne = BloodUnit.findOne
			const incompatibleUnit = createReservedUnit({
				issuance: {
					crossmatchResult: 'Incompatible', // Confirmed incompatible!
				},
			})

			BloodUnit.findOne = async () => incompatibleUnit

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: incompatibleUnit._id.toString() },
					body: {
						crossmatchResult: 'Compatible', // Attempting to bypass/overwrite!
					},
				})

				await bloodUnitController.recordCrossmatchResult(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Failed crossmatch results cannot be overwritten/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalUnitFindOne
			}
		})

		it('should reject recording crossmatch if unit is reserved for a different receive request (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalUnitFindOne = BloodUnit.findOne
			const foreignRequestId = new mongoose.Types.ObjectId().toString()
			const reservedUnit = createReservedUnit({
				reservation: {
					receiveRequestId: foreignRequestId,
				},
			})

			BloodUnit.findOne = async () => reservedUnit

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: reservedUnit._id.toString() },
					body: {
						crossmatchResult: 'Compatible',
						receiveRequestId: mockRequestId, // Does not match foreignRequestId!
					},
				})

				await bloodUnitController.recordCrossmatchResult(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /reserved for a different receive request/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalUnitFindOne
			}
		})
	})

	describe('13. Physical Dispatch Operational Workflow', () => {
		it('should record physical dispatch on issued units with actual dispatcher staff ID and chain-of-custody metadata', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalUnitFind = BloodUnit.find
			const originalUnitFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const dispatcherStaffId = new mongoose.Types.ObjectId().toString()
			const dispatcherStaff = {
				_id: dispatcherStaffId,
				bloodbankId: mockBloodbankId,
				role: 'Lab_Technician',
				fullName: 'Courier Tech Sam',
			}

			const issuedUnit = createReservedUnit({
				status: 'Issued',
				issuance: {
					issuedToReceiveRequestId: mockRequestId,
					crossmatchResult: 'Compatible',
					issuedAt: new Date(Date.now() - 3600 * 1000),
					issuedBy: mockBloodbankId,
					dispatch: {
						isDispatched: false,
					},
				},
			})

			BloodUnit.find = () => mockChainableFind([issuedUnit])

			let findOneAndUpdateCalled = false
			BloodUnit.findOneAndUpdate = async (filter, update) => {
				findOneAndUpdateCalled = true
				assert.strictEqual(filter._id.toString(), issuedUnit._id.toString())
				assert.strictEqual(filter.status, 'Issued')
				assert.strictEqual(filter['issuance.dispatch.isDispatched'].$ne, true)
				assert.strictEqual(update.$set['issuance.dispatch.isDispatched'], true)
				assert.strictEqual(update.$set['issuance.dispatch.dispatchedByStaffId'].toString(), dispatcherStaffId)
				assert.strictEqual(update.$set['issuance.dispatch.dispatchedToRecipient'], 'Nurse Dave, ICU')
				assert.strictEqual(update.$set['issuance.dispatch.transportBoxId'], 'COLD-BOX-99')

				issuedUnit.issuance.dispatch = {
					isDispatched: true,
					dispatchedAt: new Date(),
					dispatchedByStaffId: dispatcherStaffId,
					dispatchedToRecipient: 'Nurse Dave, ICU',
					transportBoxId: 'COLD-BOX-99',
				}
				return issuedUnit
			}

			const recordedAudits = []
			BloodUnitAuditLog.prototype.save = async function () {
				recordedAudits.push(this.toObject())
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					staff: dispatcherStaff,
					body: {
						unitIds: [issuedUnit._id.toString()],
						dispatchedToRecipient: 'Nurse Dave, ICU',
						transportBoxId: 'COLD-BOX-99',
						dispatchNotes: 'Delivered directly to ICU charge nurse',
					},
				})

				await bloodUnitController.dispatchBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(findOneAndUpdateCalled, true)
				assert.strictEqual(res.responseData.dispatch.dispatchedCount, 1)
				assert.strictEqual(res.responseData.dispatch.dispatchedToRecipient, 'Nurse Dave, ICU')
				assert.strictEqual(res.responseData.dispatch.transportBoxId, 'COLD-BOX-99')

				// Verify actual dispatcher staff ID recorded
				assert.strictEqual(
					res.responseData.dispatch.units[0].dispatchedByStaffId.toString(),
					dispatcherStaffId
				)

				// Verify UNIT_DISPATCHED audit log
				assert.strictEqual(recordedAudits.length, 1)
				assert.strictEqual(recordedAudits[0].action, 'UNIT_DISPATCHED')
				assert.strictEqual(recordedAudits[0].previousStatus, 'Issued')
				assert.strictEqual(recordedAudits[0].newStatus, 'Issued')
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalUnitFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should reject physical dispatch on a unit that is not in Issued status (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalUnitFind = BloodUnit.find

			const reservedUnit = createReservedUnit({
				status: 'Reserved', // Not yet issued!
			})

			BloodUnit.find = () => mockChainableFind([reservedUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						unitIds: [reservedUnit._id.toString()],
						dispatchedToRecipient: 'Hospital Runner',
					},
				})

				await bloodUnitController.dispatchBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Unit must be in 'Issued' status before physical dispatch/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.find = originalUnitFind
			}
		})

		it('should reject duplicate physical dispatch on an already dispatched unit (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalUnitFind = BloodUnit.find

			const alreadyDispatchedUnit = createReservedUnit({
				status: 'Issued',
				issuance: {
					dispatch: {
						isDispatched: true, // Already dispatched!
						dispatchedAt: new Date(Date.now() - 3600 * 1000),
					},
				},
			})

			BloodUnit.find = () => mockChainableFind([alreadyDispatchedUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						unitIds: [alreadyDispatchedUnit._id.toString()],
						dispatchedToRecipient: 'Hospital Runner',
					},
				})

				await bloodUnitController.dispatchBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Duplicate dispatch is rejected/i)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.find = originalUnitFind
			}
		})
	})
})
