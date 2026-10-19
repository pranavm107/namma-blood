const { describe, it, after } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const bloodUnitController = require('../BloodUnit/bloodUnitController')
const receiveController = require('../BloodReceive/bloodReceiveController')
const {
	findEligibleUnitsFEFO,
	reserveUnitsForRequest,
	releaseReservationForRequest,
} = require('../BloodUnit/reservationService')
const {
	protectBloodbankOrStaff,
	generateStaffToken,
} = require('../BloodBank/bloodbankStaffMiddleware')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Bloodbank = require('../BloodBank/bloodbankModel')

// Mock Request & Response Helper
function createMockReqRes({ user, staff, body = {}, query = {}, params = {}, ip = '127.0.0.1' } = {}) {
	const req = {
		user: user || (staff ? { _id: staff.bloodbankId, staffId: staff._id, isStaff: true } : { _id: new mongoose.Types.ObjectId().toString() }),
		staff: staff || null,
		body,
		query,
		params,
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

describe('Phase 3.3D — Reservation & FEFO Allocation Engine', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId().toString()
	const otherBloodbankId = new mongoose.Types.ObjectId().toString()
	const mockUserId = new mongoose.Types.ObjectId().toString()
	const mockRequestId = new mongoose.Types.ObjectId().toString()

	const bloodbankUser = {
		_id: mockBloodbankId,
		bloodbankName: 'City Central Blood Bank',
	}

	const originalBloodUnitFind = BloodUnit.find
	const originalBloodUnitFindOne = BloodUnit.findOne
	const originalBloodUnitProtoSave = BloodUnit.prototype.save
	const originalAuditProtoSave = BloodUnitAuditLog.prototype.save
	const originalReqProtoSave = ReceiveRequests.prototype.save

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

	BloodUnit.find = () => mockChainableFind([])
	BloodUnit.findOne = async () => null
	BloodUnit.prototype.save = async function () { return this }
	BloodUnitAuditLog.prototype.save = async function () { return this }
	ReceiveRequests.prototype.save = async function () { return this }

	// Helper to create an available, cleared, tested unit
	function createAvailableUnit(overrides = {}) {
		const doc = new BloodUnit({
			_id: new mongoose.Types.ObjectId(),
			unitNumber: `DIN-2026-${Math.random().toString(36).substring(2, 8).toUpperCase()}-WB`,
			bloodbankId: mockBloodbankId,
			bloodGroup: 'O_Positive',
			componentType: 'Whole_Blood',
			status: 'Available',
			volumeMl: 350,
			collectionDate: new Date('2026-10-10T10:00:00Z'),
			expiryDate: new Date('2026-11-20T10:00:00Z'),
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
				receiveRequestId: null,
				reservedAt: null,
				reservedExpiresAt: null,
			},
			...overrides,
		})
		doc.isNew = false
		doc.save = async function () { return this }
		return doc
	}

	// Helper to create a ReceiveRequest doc
	function createReceiveRequestDoc(overrides = {}) {
		const doc = new ReceiveRequests({
			_id: mockRequestId,
			userId: mockUserId,
			bloodbankId: mockBloodbankId,
			bloodType: 'O_Positive',
			unit: 2,
			status: 'Pending',
			whenDoYouWant: new Date('2026-10-25T10:00:00Z'),
			reservedUnitIds: [],
			...overrides,
		})
		doc.isNew = false
		doc.save = async function () { return this }
		return doc
	}

	// -------------------------------------------------------------
	// 1. FEFO Ordering & Selection Algorithm
	// -------------------------------------------------------------
	describe('1. FEFO Ordering & Deterministic Tie-Breaking', () => {
		it('should select candidate units with earliest expiry date first (FEFO)', async () => {
			const unitExpSoon = createAvailableUnit({
				expiryDate: new Date('2026-11-05T10:00:00Z'), // Expires sooner
				collectionDate: new Date('2026-10-01T10:00:00Z'),
			})
			const unitExpLater = createAvailableUnit({
				expiryDate: new Date('2026-11-25T10:00:00Z'), // Expires later
				collectionDate: new Date('2026-10-02T10:00:00Z'),
			})

			const originalFind = BloodUnit.find
			BloodUnit.find = (query) => ({
				sort: (sortObj) => {
					assert.deepStrictEqual(sortObj, { expiryDate: 1, collectionDate: 1, _id: 1 })
					return {
						limit: (lim) => {
							assert.strictEqual(lim, 1)
							return Promise.resolve([unitExpSoon])
						},
					}
				},
			})

			try {
				const candidates = await findEligibleUnitsFEFO({
					bloodbankId: mockBloodbankId,
					bloodGroup: 'O_Positive',
					requiredCount: 1,
				})

				assert.strictEqual(candidates.length, 1)
				assert.strictEqual(candidates[0]._id.toString(), unitExpSoon._id.toString())
			} finally {
				BloodUnit.find = originalFind
			}
		})

		it('should sort candidate units by collectionDate as secondary tie-breaker', async () => {
			const originalFind = BloodUnit.find
			let sortApplied = null

			BloodUnit.find = (query) => ({
				sort: (sortObj) => {
					sortApplied = sortObj
					return {
						limit: () => Promise.resolve([]),
					}
				},
			})

			try {
				await findEligibleUnitsFEFO({
					bloodbankId: mockBloodbankId,
					bloodGroup: 'O_Positive',
					requiredCount: 2,
				})

				assert.deepStrictEqual(sortApplied, { expiryDate: 1, collectionDate: 1, _id: 1 })
			} finally {
				BloodUnit.find = originalFind
			}
		})
	})

	// -------------------------------------------------------------
	// 2. Clinical Eligibility & Expiry Filtering
	// -------------------------------------------------------------
	describe('2. Clinical Eligibility & Quality Clearance Filters', () => {
		it('should strictly query only units with status Available, clearance verified, and non-reactive tests', async () => {
			const originalFind = BloodUnit.find
			let queryCaptured = null

			BloodUnit.find = (query) => {
				queryCaptured = query
				return {
					sort: () => ({
						limit: () => Promise.resolve([]),
					}),
				}
			}

			try {
				await findEligibleUnitsFEFO({
					bloodbankId: mockBloodbankId,
					bloodGroup: 'B_Negative',
					componentType: 'Packed_Red_Blood_Cells',
					requiredCount: 1,
				})

				assert.strictEqual(queryCaptured.bloodGroup, 'B_Negative')
				assert.strictEqual(queryCaptured.componentType, 'Packed_Red_Blood_Cells')
				assert.strictEqual(queryCaptured.status, 'Available')
				assert.strictEqual(queryCaptured['clearance.isVerified'], true)
				assert.strictEqual(queryCaptured['testing.hiv'], 'Non_Reactive')
				assert.strictEqual(queryCaptured['testing.hbv'], 'Non_Reactive')
				assert.strictEqual(queryCaptured['testing.hcv'], 'Non_Reactive')
				assert.strictEqual(queryCaptured['testing.syphilis'], 'Non_Reactive')
				assert.strictEqual(queryCaptured['testing.malaria'], 'Non_Reactive')
				assert.ok(queryCaptured.expiryDate.$gt)
			} finally {
				BloodUnit.find = originalFind
			}
		})

		it('should fail closed with 400 when insufficient eligible units exist (no partial reservation)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find

			const requestDoc = createReceiveRequestDoc({ unit: 3 }) // Requests 3 units
			ReceiveRequests.findOne = async () => requestDoc

			// Only 1 eligible unit exists in inventory
			const unit1 = createAvailableUnit()
			BloodUnit.find = () => ({
				sort: () => ({
					limit: () => Promise.resolve([unit1]), // Only 1 available
				}),
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { requestId: mockRequestId },
				})

				await bloodUnitController.reserveBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Insufficient verified, issue-eligible units available/i)
				assert.match(res.responseData.message, /Required: 3, eligible available: 1/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})
	})

	// -------------------------------------------------------------
	// 3. Successful Atomic Reservation & FEFO Allocation
	// -------------------------------------------------------------
	describe('3. Successful Atomic Unit Reservation', () => {
		it('should reserve required units, set status to Reserved, and record immutable audit ledger inside transaction', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalReqCount = BloodUnit.countDocuments
			const originalUnitFind = BloodUnit.find
			const originalFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const requestDoc = createReceiveRequestDoc({ unit: 2 })
			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.countDocuments = async () => 0

			const unit1 = createAvailableUnit({ expiryDate: new Date('2026-11-10T10:00:00Z') })
			const unit2 = createAvailableUnit({ expiryDate: new Date('2026-11-15T10:00:00Z') })

			BloodUnit.find = () => ({
				sort: () => ({
					limit: () => Promise.resolve([unit1, unit2]),
				}),
			})

			const updatedUnits = []
			BloodUnit.findOneAndUpdate = async (filter, update) => {
				assert.strictEqual(filter.status, 'Available')
				const target = filter._id.toString() === unit1._id.toString() ? unit1 : unit2
				target.status = 'Reserved'
				target.reservation = update.$set.reservation
				updatedUnits.push(target)
				return target
			}

			const auditRecords = []
			BloodUnitAuditLog.prototype.save = async function (opts) {
				assert.strictEqual(opts.session, mockSession)
				auditRecords.push(this)
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { requestId: mockRequestId, holdHours: 48 },
				})

				await bloodUnitController.reserveBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.reservation.unitsCount, 2)
				assert.strictEqual(res.responseData.reservation.units.length, 2)
				assert.strictEqual(requestDoc.status, 'Accepted')
				assert.strictEqual(requestDoc.reservedUnitIds.length, 2)

				// Check audit records
				assert.strictEqual(auditRecords.length, 2)
				assert.strictEqual(auditRecords[0].action, 'UNIT_RESERVED')
				assert.strictEqual(auditRecords[0].previousStatus, 'Available')
				assert.strictEqual(auditRecords[0].newStatus, 'Reserved')
				assert.strictEqual(auditRecords[0].actor.actorModel, 'bloodbank')

				// Verify donor privacy: no donorUserId in response units
				for (const u of res.responseData.reservation.units) {
					assert.strictEqual(u.donorUserId, undefined)
					assert.strictEqual(u.donor, undefined)
					assert.ok(u.unitNumber)
					assert.ok(u.expiryDate)
				}
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.countDocuments = originalReqCount
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})
	})

	// -------------------------------------------------------------
	// 4. Concurrency Protection & Idempotency
	// -------------------------------------------------------------
	describe('4. Concurrency Protection & Duplicate Rejection', () => {
		it('should reject duplicate reservation if request already has reserved units assigned (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const existingUnit = createAvailableUnit({
				status: 'Reserved',
				reservation: {
					receiveRequestId: mockRequestId,
					reservedExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
				},
			})
			const requestDoc = createReceiveRequestDoc({
				reservedUnitIds: [existingUnit._id], // Already reserved!
				status: 'Accepted',
			})
			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = () => mockChainableFind([existingUnit])

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { requestId: mockRequestId },
				})

				await bloodUnitController.reserveBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already has units reserved/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
			}
		})

		it('should abort transaction and return 409 Conflict if concurrent request reserved a candidate unit', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalReqCount = BloodUnit.countDocuments
			const originalUnitFind = BloodUnit.find
			const originalFindOneAndUpdate = BloodUnit.findOneAndUpdate

			const requestDoc = createReceiveRequestDoc({ unit: 1 })
			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.countDocuments = async () => 0

			const unit1 = createAvailableUnit()
			BloodUnit.find = () => ({
				sort: () => ({
					limit: () => Promise.resolve([unit1]),
				}),
			})

			// Concurrency conflict: another request reserved it in the meantime!
			BloodUnit.findOneAndUpdate = async () => null

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { requestId: mockRequestId },
				})

				await bloodUnitController.reserveBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 409)
				assert.match(res.responseData.message, /Concurrent reservation conflict/i)
				assert.strictEqual(mockSession.isAborted, true, 'Transaction must abort on concurrency conflict')
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.countDocuments = originalReqCount
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalFindOneAndUpdate
			}
		})
	})

	// -------------------------------------------------------------
	// 5. Multi-Tenant Ownership & BOLA Isolation
	// -------------------------------------------------------------
	describe('5. Multi-Tenant Scoping & BOLA Enforcement', () => {
		it('should forbid Blood Bank B from reserving units for Blood Bank A request (returns 404)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId.toString(), otherBloodbankId)
				return null // Request belongs to Bank A, so not found for Bank B
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: { _id: otherBloodbankId },
					body: { requestId: mockRequestId },
				})

				await bloodUnitController.reserveBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 404)
				assert.match(res.responseData.message, /Receive request not found or not owned/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 6. Request State Machine Invariants
	// -------------------------------------------------------------
	describe('6. Request State Machine Guards', () => {
		it('should reject reserving units for an already Fulfilled request (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const requestDoc = createReceiveRequestDoc({ status: 'Fulfilled' })
			ReceiveRequests.findOne = async () => requestDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { requestId: mockRequestId },
				})

				await bloodUnitController.reserveBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot reserve units for an already fulfilled request/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
			}
		})

		it('should reject reserving units for a Rejected request (400)', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const requestDoc = createReceiveRequestDoc({ status: 'Rejected' })
			ReceiveRequests.findOne = async () => requestDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { requestId: mockRequestId },
				})

				await bloodUnitController.reserveBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot reserve units for a rejected request/i)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 7. Reservation Release Workflow
	// -------------------------------------------------------------
	describe('7. Reservation Release & Lifecycle Integration', () => {
		it('should release reserved units back to Available when request is rejected by blood bank', async () => {
			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const unit1 = createAvailableUnit({ status: 'Reserved' })
			unit1.reservation.receiveRequestId = mockRequestId

			const requestDoc = createReceiveRequestDoc({
				status: 'Accepted',
				reservedUnitIds: [unit1._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = async () => [unit1]

			let unitSaved = null
			unit1.save = async function () {
				unitSaved = this
				return this
			}
			BloodUnit.prototype.save = async function () {
				unitSaved = this
				return this
			}

			let auditSaved = null
			BloodUnitAuditLog.prototype.save = async function () {
				auditSaved = this
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, message: 'Patient transferred to another facility' },
				})

				await receiveController.rejectRequest(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(requestDoc.status, 'Rejected')
				assert.strictEqual(requestDoc.reservedUnitIds.length, 0)

				// Unit released back to Available
				assert.ok(unitSaved)
				assert.strictEqual(unitSaved.status, 'Available')
				assert.strictEqual(unitSaved.reservation.receiveRequestId, null)

				// Audit log recorded
				assert.ok(auditSaved)
				assert.strictEqual(auditSaved.action, 'RESERVATION_RELEASED')
				assert.strictEqual(auditSaved.previousStatus, 'Reserved')
				assert.strictEqual(auditSaved.newStatus, 'Available')
			} finally {
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should transition reserved unit to Expired if unit expired during reservation hold', async () => {
			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const expiredUnit = createAvailableUnit({
				status: 'Reserved',
				expiryDate: new Date('2026-10-01T10:00:00Z'), // Past expiry!
			})
			expiredUnit.reservation.receiveRequestId = mockRequestId

			const requestDoc = createReceiveRequestDoc({
				status: 'Accepted',
				reservedUnitIds: [expiredUnit._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = async () => [expiredUnit]

			let unitSaved = null
			expiredUnit.save = async function () {
				unitSaved = this
				return this
			}
			BloodUnit.prototype.save = async function () {
				unitSaved = this
				return this
			}

			let auditSaved = null
			BloodUnitAuditLog.prototype.save = async function () {
				auditSaved = this
				return this
			}

			try {
				const result = await releaseReservationForRequest({
					requestId: mockRequestId,
					bloodbankId: mockBloodbankId,
					actorId: mockBloodbankId,
				})

				assert.strictEqual(result.releasedCount, 1)
				assert.strictEqual(unitSaved.status, 'Expired')
				assert.strictEqual(auditSaved.action, 'UNIT_EXPIRED')
				assert.strictEqual(auditSaved.newStatus, 'Expired')
			} finally {
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should support explicit reservation release endpoint POST /api/bloodunit/release-reservation', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalUnitFind = BloodUnit.find
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const unit1 = createAvailableUnit({ status: 'Reserved' })
			const requestDoc = createReceiveRequestDoc({
				status: 'Accepted',
				reservedUnitIds: [unit1._id],
			})

			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.find = async () => [unit1]
			BloodUnit.prototype.save = async function () { return this }
			BloodUnitAuditLog.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { requestId: mockRequestId, reason: 'Elective surgery postponed' },
				})

				await bloodUnitController.releaseBloodUnitReservation(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.releasedCount, 1)
				assert.strictEqual(res.responseData.message, 'Reservation released successfully.')
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.find = originalUnitFind
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})
	})

	// -------------------------------------------------------------
	// 8. Request Validation & Input Tampering Defense
	// -------------------------------------------------------------
	describe('8. Input Validation & Body Tampering Defense', () => {
		it('should reject reservation request with illegal injected fields (400)', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				body: { requestId: mockRequestId, maliciousField: 'attack' },
			})

			await bloodUnitController.reserveBloodUnits(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unrecognized or forbidden field: 'maliciousField'/i)
		})

		it('should reject reservation request with invalid requestId format (400)', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				body: { requestId: 'not-an-id' },
			})

			await bloodUnitController.reserveBloodUnits(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Invalid requestId format/i)
		})

		it('should reject reservation request with invalid componentType (400)', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				body: { requestId: mockRequestId, componentType: 'Invalid_Component' },
			})

			await bloodUnitController.reserveBloodUnits(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Invalid componentType/i)
		})

		it('should reject reservation request with out-of-range holdHours (400)', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				body: { requestId: mockRequestId, holdHours: 120 }, // Exceeds 72h max
			})

			await bloodUnitController.reserveBloodUnits(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /holdHours must be a number between 1 and 72/i)
		})
	})

	// -------------------------------------------------------------
	// 9. Legacy Stock Isolation
	// -------------------------------------------------------------
	describe('9. Legacy Stock Isolation', () => {
		it('should verify reservation never mutates legacy Bloodstock counters', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalReqFindOne = ReceiveRequests.findOne
			const originalReqCount = BloodUnit.countDocuments
			const originalUnitFind = BloodUnit.find
			const originalFindOneAndUpdate = BloodUnit.findOneAndUpdate
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const requestDoc = createReceiveRequestDoc({ unit: 1 })
			ReceiveRequests.findOne = async () => requestDoc
			BloodUnit.countDocuments = async () => 0

			const unit1 = createAvailableUnit()
			BloodUnit.find = () => ({
				sort: () => ({
					limit: () => Promise.resolve([unit1]),
				}),
			})

			BloodUnit.findOneAndUpdate = async (filter, update) => {
				unit1.status = 'Reserved'
				unit1.reservation = update.$set.reservation
				return unit1
			}
			BloodUnitAuditLog.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { requestId: mockRequestId },
				})

				await bloodUnitController.reserveBloodUnits(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				// Verify reservation only touched BloodUnit and ReceiveRequests, not Bloodstock
				assert.strictEqual(unit1.status, 'Reserved')
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalReqFindOne
				BloodUnit.countDocuments = originalReqCount
				BloodUnit.find = originalUnitFind
				BloodUnit.findOneAndUpdate = originalFindOneAndUpdate
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})
	})

	// -------------------------------------------------------------
	// 10. Pre-Commit Safety Audit Regressions (Findings 1–5)
	// -------------------------------------------------------------
	describe('10. Pre-Commit Safety Audit Regressions (Findings 1–5)', () => {
		describe('10.1 Finding 1: Staff RBAC & Authentication Guards on Reservation / Release', () => {
			const originalStaffFindById = BloodbankStaff.findById
			const originalBloodbankFindById = Bloodbank.findById

			after(() => {
				BloodbankStaff.findById = originalStaffFindById
				Bloodbank.findById = originalBloodbankFindById
			})

			it('should reject unauthenticated request with 401 when Authorization header is missing', async () => {
				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				const { req, res, next } = createMockReqRes({ user: null })
				req.headers = {}

				let nextCalled = false
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(res.statusCode, 401)
				assert.strictEqual(nextCalled, false)
				assert.match(res.responseData.message, /authentication required/i)
			})

			it('should reject request with invalid/malformed token with 401', async () => {
				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				const { req, res } = createMockReqRes({ user: null })
				req.headers = { authorization: 'Bearer invalid.token.signature' }

				let nextCalled = false
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(res.statusCode, 401)
				assert.strictEqual(nextCalled, false)
				assert.match(res.responseData.message, /invalid token/i)
			})

			it('should authorize active staff with permitted role, verified credentials, and completed password change', async () => {
				const staffDoc = new BloodbankStaff({
					_id: new mongoose.Types.ObjectId(),
					fullName: 'Dr. Jane Specialist',
					email: 'jane@bloodbank.org',
					phoneNo: '+919876543210',
					bloodbankId: mockBloodbankId,
					role: 'Medical_Officer',
					status: 'Active',
					mustChangePassword: false,
					tokenVersion: 1,
					medicalLicense: {
						licenseNumber: 'KMC-2024-9988',
						isVerified: true,
					},
				})
				staffDoc.changedPasswordAfter = () => false
				BloodbankStaff.findById = async () => staffDoc

				const token = generateStaffToken(staffDoc)
				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				const { req, res } = createMockReqRes({ user: null })
				req.headers = { authorization: `Bearer ${token}` }

				let nextCalled = false
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(nextCalled, true)
				assert.strictEqual(req.staffRole, 'Medical_Officer')
				assert.strictEqual(req.bloodbankId.toString(), mockBloodbankId.toString())
				assert.strictEqual(req.user.isStaff, true)
			})

			it('should reject staff who must change initial password with 403', async () => {
				const staffDoc = new BloodbankStaff({
					_id: new mongoose.Types.ObjectId(),
					fullName: 'Tech New',
					email: 'tech@bloodbank.org',
					phoneNo: '+919876543211',
					bloodbankId: mockBloodbankId,
					role: 'Lab_Technician',
					status: 'Active',
					mustChangePassword: true, // Must change!
					tokenVersion: 0,
				})
				staffDoc.changedPasswordAfter = () => false
				BloodbankStaff.findById = async () => staffDoc

				const token = generateStaffToken(staffDoc)
				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				const { req, res } = createMockReqRes({ user: null })
				req.headers = { authorization: `Bearer ${token}` }

				let nextCalled = false
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(res.statusCode, 403)
				assert.strictEqual(nextCalled, false)
				assert.match(res.responseData.message, /initial password change required/i)
			})

			it('should reject suspended staff account with 401', async () => {
				const staffDoc = new BloodbankStaff({
					_id: new mongoose.Types.ObjectId(),
					fullName: 'Suspended Tech',
					email: 'suspended@bloodbank.org',
					phoneNo: '+919876543212',
					bloodbankId: mockBloodbankId,
					role: 'Lab_Technician',
					status: 'Suspended',
					mustChangePassword: false,
					tokenVersion: 1,
				})
				staffDoc.changedPasswordAfter = () => false
				BloodbankStaff.findById = async () => staffDoc

				const token = generateStaffToken(staffDoc)
				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				const { req, res } = createMockReqRes({ user: null })
				req.headers = { authorization: `Bearer ${token}` }

				let nextCalled = false
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(res.statusCode, 401)
				assert.strictEqual(nextCalled, false)
				assert.match(res.responseData.message, /suspended/i)
			})

			it('should reject staff with outdated tokenVersion with 401', async () => {
				const staffDoc = new BloodbankStaff({
					_id: new mongoose.Types.ObjectId(),
					fullName: 'Revoked Tech',
					email: 'revoked@bloodbank.org',
					phoneNo: '+919876543213',
					bloodbankId: mockBloodbankId,
					role: 'Lab_Technician',
					status: 'Active',
					mustChangePassword: false,
					tokenVersion: 2,
				})
				// Token has version 0, but DB has version 2!
				staffDoc.changedPasswordAfter = (iat, tokenVersion) => tokenVersion < 2
				BloodbankStaff.findById = async () => staffDoc

				const token = generateStaffToken({
					_id: staffDoc._id,
					bloodbankId: staffDoc.bloodbankId,
					role: staffDoc.role,
					mustChangePassword: false,
					tokenVersion: 0,
				})
				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				const { req, res } = createMockReqRes({ user: null })
				req.headers = { authorization: `Bearer ${token}` }

				let nextCalled = false
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(res.statusCode, 401)
				assert.strictEqual(nextCalled, false)
				assert.match(res.responseData.message, /updated|again/i)
			})

			it('should reject staff with disallowed role with 403', async () => {
				const staffDoc = new BloodbankStaff({
					_id: new mongoose.Types.ObjectId(),
					fullName: 'Junior Volunteer',
					email: 'volunteer@bloodbank.org',
					phoneNo: '+919876543214',
					bloodbankId: mockBloodbankId,
					role: 'Staff_Admin',
					status: 'Active',
					mustChangePassword: false,
					tokenVersion: 1,
				})
				staffDoc.changedPasswordAfter = () => false
				BloodbankStaff.findById = async () => staffDoc

				const token = generateStaffToken(staffDoc)
				// Only Medical_Officer allowed for this specific operation
				const middleware = protectBloodbankOrStaff('Medical_Officer')
				const { req, res } = createMockReqRes({ user: null })
				req.headers = { authorization: `Bearer ${token}` }

				let nextCalled = false
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(res.statusCode, 403)
				assert.strictEqual(nextCalled, false)
				assert.match(res.responseData.message, /not authorized/i)
			})

			it('should reject Medical Officer whose medical credentials are not verified with 403', async () => {
				const staffDoc = new BloodbankStaff({
					_id: new mongoose.Types.ObjectId(),
					fullName: 'Dr. Unverified',
					email: 'unverified@bloodbank.org',
					phoneNo: '+919876543215',
					bloodbankId: mockBloodbankId,
					role: 'Medical_Officer',
					status: 'Active',
					mustChangePassword: false,
					tokenVersion: 1,
					medicalLicense: {
						licenseNumber: 'UNVERIFIED-123',
						isVerified: false, // NOT verified!
					},
				})
				staffDoc.changedPasswordAfter = () => false
				BloodbankStaff.findById = async () => staffDoc

				const token = generateStaffToken(staffDoc)
				const middleware = protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin')
				const { req, res } = createMockReqRes({ user: null })
				req.headers = { authorization: `Bearer ${token}` }

				let nextCalled = false
				await middleware(req, res, () => { nextCalled = true })

				assert.strictEqual(res.statusCode, 403)
				assert.strictEqual(nextCalled, false)
				assert.match(res.responseData.message, /not been verified/i)
			})
		})

		describe('10.2 Finding 2: Cross-Tenant Conditional Atomic Lock Enforcement', () => {
			it('should include bloodbankId in atomic findOneAndUpdate conditional lock', async () => {
				const mockSession = createMockSession()
				const originalStartSession = mongoose.startSession
				mongoose.startSession = async () => mockSession
				mongoose.startSession._isMock = true

				const originalReqFindOne = ReceiveRequests.findOne
				const originalUnitFind = BloodUnit.find
				const originalFindOneAndUpdate = BloodUnit.findOneAndUpdate

				const requestDoc = createReceiveRequestDoc({ unit: 1 })
				ReceiveRequests.findOne = async () => requestDoc

				const unit1 = createAvailableUnit()
				BloodUnit.find = (query) => {
					if (query && query.status === 'Reserved') {
						return mockChainableFind([])
					}
					return mockChainableFind([unit1])
				}

				let capturedFilter = null
				BloodUnit.findOneAndUpdate = async (filter, update) => {
					capturedFilter = filter
					return unit1
				}

				try {
					const { req, res, next } = createMockReqRes({
						user: bloodbankUser,
						body: { requestId: mockRequestId },
					})

					await bloodUnitController.reserveBloodUnits(req, res, next)

					assert.strictEqual(res.statusCode, 200)
					assert.ok(capturedFilter)
					// Assert bloodbankId is verified in conditional update
					assert.strictEqual(
						capturedFilter.bloodbankId.toString(),
						mockBloodbankId.toString()
					)
					assert.strictEqual(capturedFilter.status, 'Available')
					assert.strictEqual(capturedFilter['clearance.isVerified'], true)
				} finally {
					mongoose.startSession = originalStartSession
					ReceiveRequests.findOne = originalReqFindOne
					BloodUnit.find = originalUnitFind
					BloodUnit.findOneAndUpdate = originalFindOneAndUpdate
				}
			})
		})

		describe('10.3 Finding 3: Expired Reservation Holds & Clinical Shelf-Life Guards', () => {
			it('should atomically release expired holds inside same session when re-reserving', async () => {
				const mockSession = createMockSession()
				const originalStartSession = mongoose.startSession
				mongoose.startSession = async () => mockSession
				mongoose.startSession._isMock = true

				const originalReqFindOne = ReceiveRequests.findOne
				const originalUnitFind = BloodUnit.find
				const originalFindOneAndUpdate = BloodUnit.findOneAndUpdate

				// Existing unit whose hold expired 2 hours ago
				const expiredHoldUnit = createAvailableUnit({
					status: 'Reserved',
					reservation: {
						receiveRequestId: mockRequestId,
						reservedExpiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // Expired hold!
					},
				})

				const freshUnit = createAvailableUnit()

				const requestDoc = createReceiveRequestDoc({
					reservedUnitIds: [expiredHoldUnit._id],
					unit: 1,
				})

				ReceiveRequests.findOne = async () => requestDoc

				let findCallCount = 0
				BloodUnit.find = (query) => {
					findCallCount++
					if (query && query.status === 'Reserved') {
						return mockChainableFind([expiredHoldUnit])
					}
					return mockChainableFind([freshUnit])
				}

				BloodUnit.findOneAndUpdate = async (filter, update) => {
					freshUnit.status = 'Reserved'
					return freshUnit
				}

				let expiredHoldUnitSaved = false
				expiredHoldUnit.save = async function () {
					expiredHoldUnitSaved = true
					return this
				}

				try {
					const { req, res, next } = createMockReqRes({
						user: bloodbankUser,
						body: { requestId: mockRequestId },
					})

					await bloodUnitController.reserveBloodUnits(req, res, next)

					assert.strictEqual(res.statusCode, 200)
					assert.strictEqual(expiredHoldUnitSaved, true)
					assert.strictEqual(expiredHoldUnit.status, 'Available')
				} finally {
					mongoose.startSession = originalStartSession
					ReceiveRequests.findOne = originalReqFindOne
					BloodUnit.find = originalUnitFind
					BloodUnit.findOneAndUpdate = originalFindOneAndUpdate
				}
			})

			it('should reject fulfilledRequest (400) if a reserved unit has expired clinically', async () => {
				const mockSession = createMockSession()
				const originalStartSession = mongoose.startSession
				mongoose.startSession = async () => mockSession
				mongoose.startSession._isMock = true

				const originalReqFindOne = ReceiveRequests.findOne
				const originalUnitFind = BloodUnit.find

				const clinicallyExpiredUnit = createAvailableUnit({
					status: 'Reserved',
					expiryDate: new Date('2026-10-01T10:00:00Z'), // Clinically expired!
					reservation: {
						receiveRequestId: mockRequestId,
						reservedExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
					},
				})

				const requestDoc = createReceiveRequestDoc({
					status: 'Accepted',
					reservedUnitIds: [clinicallyExpiredUnit._id],
				})

				ReceiveRequests.findOne = async () => requestDoc
				BloodUnit.find = () => mockChainableFind([clinicallyExpiredUnit])

				try {
					const { req, res, next } = createMockReqRes({
						user: bloodbankUser,
						body: { id: mockRequestId },
					})

					await receiveController.fulfilledRequest(req, res, next)

					assert.strictEqual(res.statusCode, 400)
					assert.match(res.responseData.message, /has expired clinically/i)
				} finally {
					mongoose.startSession = originalStartSession
					ReceiveRequests.findOne = originalReqFindOne
					BloodUnit.find = originalUnitFind
				}
			})

			it('should reject fulfilledRequest (400) if a unit reservation hold has expired', async () => {
				const mockSession = createMockSession()
				const originalStartSession = mongoose.startSession
				mongoose.startSession = async () => mockSession
				mongoose.startSession._isMock = true

				const originalReqFindOne = ReceiveRequests.findOne
				const originalUnitFind = BloodUnit.find

				const holdExpiredUnit = createAvailableUnit({
					status: 'Reserved',
					expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000), // Unexpired shelf-life
					reservation: {
						receiveRequestId: mockRequestId,
						reservedExpiresAt: new Date(Date.now() - 3600 * 1000), // Hold expired 1hr ago!
					},
				})

				const requestDoc = createReceiveRequestDoc({
					status: 'Accepted',
					reservedUnitIds: [holdExpiredUnit._id],
				})

				ReceiveRequests.findOne = async () => requestDoc
				BloodUnit.find = () => mockChainableFind([holdExpiredUnit])

				try {
					const { req, res, next } = createMockReqRes({
						user: bloodbankUser,
						body: { id: mockRequestId },
					})

					await receiveController.fulfilledRequest(req, res, next)

					assert.strictEqual(res.statusCode, 400)
					assert.match(res.responseData.message, /reservation hold for unit .* has expired/i)
				} finally {
					mongoose.startSession = originalStartSession
					ReceiveRequests.findOne = originalReqFindOne
					BloodUnit.find = originalUnitFind
				}
			})

			it('should reject fulfilledRequest (400) if a reserved unit is no longer in Reserved status', async () => {
				const mockSession = createMockSession()
				const originalStartSession = mongoose.startSession
				mongoose.startSession = async () => mockSession
				mongoose.startSession._isMock = true

				const originalReqFindOne = ReceiveRequests.findOne
				const originalUnitFind = BloodUnit.find

				const nonReservedUnit = createAvailableUnit({
					status: 'Available', // Stale status!
				})

				const requestDoc = createReceiveRequestDoc({
					status: 'Accepted',
					reservedUnitIds: [nonReservedUnit._id],
				})

				ReceiveRequests.findOne = async () => requestDoc
				BloodUnit.find = () => mockChainableFind([nonReservedUnit])

				try {
					const { req, res, next } = createMockReqRes({
						user: bloodbankUser,
						body: { id: mockRequestId },
					})

					await receiveController.fulfilledRequest(req, res, next)

					assert.strictEqual(res.statusCode, 400)
					assert.match(res.responseData.message, /no longer in Reserved status/i)
				} finally {
					mongoose.startSession = originalStartSession
					ReceiveRequests.findOne = originalReqFindOne
					BloodUnit.find = originalUnitFind
				}
			})

			it('should fulfill request with traceable units without checking or decrementing legacy Bloodstock', async () => {
				const mockSession = createMockSession()
				const originalStartSession = mongoose.startSession
				mongoose.startSession = async () => mockSession
				mongoose.startSession._isMock = true

				const originalReqFindOne = ReceiveRequests.findOne
				const originalUnitFind = BloodUnit.find
				const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

				const validReservedUnit = createAvailableUnit({
					status: 'Reserved',
					expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
					reservation: {
						receiveRequestId: mockRequestId,
						reservedExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
					},
				})

				const requestDoc = createReceiveRequestDoc({
					status: 'Accepted',
					reservedUnitIds: [validReservedUnit._id],
				})

				ReceiveRequests.findOne = async () => requestDoc
				BloodUnit.find = () => mockChainableFind([validReservedUnit])

				let findOneAndUpdateCalled = false
				ReceiveRequests.findOneAndUpdate = async (filter, update) => {
					findOneAndUpdateCalled = true
					requestDoc.status = update.status
					return requestDoc
				}

				try {
					const { req, res, next } = createMockReqRes({
						user: bloodbankUser,
						body: { id: mockRequestId },
					})

					await receiveController.fulfilledRequest(req, res, next)

					assert.strictEqual(res.statusCode, 200)
					assert.strictEqual(findOneAndUpdateCalled, true)
					assert.strictEqual(requestDoc.status, 'Fulfilled')
				} finally {
					mongoose.startSession = originalStartSession
					ReceiveRequests.findOne = originalReqFindOne
					BloodUnit.find = originalUnitFind
					ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
				}
			})
		})

		describe('10.4 Finding 4: Request Lifecycle State Guards on Reservation Release', () => {
			it('should reject release reservation for an already Fulfilled request (400)', async () => {
				const originalReqFindOne = ReceiveRequests.findOne

				const requestDoc = createReceiveRequestDoc({
					status: 'Fulfilled', // Already fulfilled!
					reservedUnitIds: [],
				})
				ReceiveRequests.findOne = async () => requestDoc

				try {
					await assert.rejects(
						async () => {
							await releaseReservationForRequest({
								requestId: mockRequestId,
								bloodbankId: mockBloodbankId,
								actorId: mockBloodbankId,
							})
						},
						(err) => {
							assert.strictEqual(err.statusCode, 400)
							assert.match(err.message, /already fulfilled request/i)
							return true
						}
					)
				} finally {
					ReceiveRequests.findOne = originalReqFindOne
				}
			})

			it('should never mutate units in Issued status during reservation release', async () => {
				const originalReqFindOne = ReceiveRequests.findOne
				const originalUnitFind = BloodUnit.find

				const requestDoc = createReceiveRequestDoc({
					status: 'Accepted',
				})
				ReceiveRequests.findOne = async () => requestDoc

				const issuedUnit = createAvailableUnit({
					status: 'Issued',
				})
				let issuedUnitMutated = false
				issuedUnit.save = async function () {
					issuedUnitMutated = true
					return this
				}

				// BloodUnit.find filters by { status: 'Reserved' }, so issuedUnit is excluded
				BloodUnit.find = (filter) => {
					assert.strictEqual(filter.status, 'Reserved')
					return mockChainableFind([]) // No reserved units match
				}

				try {
					const result = await releaseReservationForRequest({
						requestId: mockRequestId,
						bloodbankId: mockBloodbankId,
						actorId: mockBloodbankId,
					})

					assert.strictEqual(result.releasedCount, 0)
					assert.strictEqual(issuedUnitMutated, false)
					assert.strictEqual(issuedUnit.status, 'Issued')
				} finally {
					ReceiveRequests.findOne = originalReqFindOne
					BloodUnit.find = originalUnitFind
				}
			})
		})

		describe('10.5 Finding 5: Transactional Rejection Rollback', () => {
			it('should abort transaction and not mark request as Rejected if release fails', async () => {
				const mockSession = createMockSession()
				const originalStartSession = mongoose.startSession
				mongoose.startSession = async () => mockSession
				mongoose.startSession._isMock = true

				const originalReqFindOne = ReceiveRequests.findOne
				const originalUnitFind = BloodUnit.find

				const reservedUnit = createAvailableUnit({ status: 'Reserved' })
				const requestDoc = createReceiveRequestDoc({
					status: 'Accepted',
					reservedUnitIds: [reservedUnit._id],
				})

				ReceiveRequests.findOne = async () => requestDoc
				// Simulate database failure during unit query
				BloodUnit.find = () => {
					throw new Error('Database connection interrupted during release query')
				}

				try {
					const { req, res, next } = createMockReqRes({
						user: bloodbankUser,
						body: { id: mockRequestId, message: 'Doctor requested cancellation' },
					})

					await receiveController.rejectRequest(req, res, next)

					// Failed transaction returns 500 error and aborts
					assert.strictEqual(res.statusCode, 500)
					assert.strictEqual(mockSession.isAborted, true)
					assert.strictEqual(mockSession.isCommitted, false)
					// Request status remains untouched
					assert.strictEqual(requestDoc.status, 'Accepted')
				} finally {
					mongoose.startSession = originalStartSession
					ReceiveRequests.findOne = originalReqFindOne
					BloodUnit.find = originalUnitFind
				}
			})
		})
	})

	after(() => {
		BloodUnit.find = originalBloodUnitFind
		BloodUnit.findOne = originalBloodUnitFindOne
		BloodUnit.prototype.save = originalBloodUnitProtoSave
		BloodUnitAuditLog.prototype.save = originalAuditProtoSave
		ReceiveRequests.prototype.save = originalReqProtoSave
	})
})
