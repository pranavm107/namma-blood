const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const donateController = require('../BloodDonate/bloodDonateController')
const DonateRequests = require('../BloodDonate/bloodDonateModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const bloodStockController = require('../BloodStock/bloodStockController')
const stockService = require('../BloodStock/stockService')
const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const { saveWithDINRetry, generateUniqueDIN } = require('../BloodUnit/dinGenerator')

// Mock Request & Response Helper
function createMockReqRes({ user, body = {}, query = {}, params = {}, ip = '127.0.0.1' } = {}) {
	const req = {
		user: user || { _id: new mongoose.Types.ObjectId().toString() },
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

describe('Phase 3.2 — Transactional Donation Intake & Quarantine Isolation', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId().toString()
	const otherBloodbankId = new mongoose.Types.ObjectId().toString()
	const mockUserId = new mongoose.Types.ObjectId().toString()
	const mockRequestId = new mongoose.Types.ObjectId().toString()

	const bloodbankUser = {
		_id: mockBloodbankId,
		bloodbankName: 'City Central Blood Bank',
		email: 'contact@citycentral.org',
	}

	const otherBloodbankUser = {
		_id: otherBloodbankId,
		bloodbankName: 'Metro Red Cross',
		email: 'contact@metroredcross.org',
	}

	// -------------------------------------------------------------
	// 1. Successful Transactional Donation Intake
	// -------------------------------------------------------------
	describe('1. Successful Intake & Quarantined Unit Provisioning', () => {
		it('should create exactly one traceable BloodUnit in Quarantined status and record audit log inside transaction', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save
			const originalIncreaseStock = bloodStockController.increaseStock

			let savedUnit = null
			let savedAudit = null
			let sessionPassedToUnitSave = null
			let sessionPassedToAuditSave = null
			let increaseStockCalled = false

			DonateRequests.findOne = async (query, proj, opts) => {
				return {
					_id: mockRequestId,
					bloodbankId: mockBloodbankId,
					userId: mockUserId,
					status: 'Accepted',
					bloodType: 'A_Positive',
				}
			}

			DonateRequests.findOneAndUpdate = async (query, update, opts) => {
				return {
					_id: mockRequestId,
					bloodbankId: mockBloodbankId,
					status: 'Fulfilled',
					bloodType: 'A_Positive',
				}
			}

			BloodUnit.findOne = async () => null

			BloodUnit.prototype.save = async function (opts) {
				sessionPassedToUnitSave = opts?.session
				this._id = new mongoose.Types.ObjectId()
				savedUnit = this
				return this
			}

			BloodUnitAuditLog.prototype.save = async function (opts) {
				sessionPassedToAuditSave = opts?.session
				this._id = new mongoose.Types.ObjectId()
				savedAudit = this
				return this
			}

			bloodStockController.increaseStock = async () => {
				increaseStockCalled = true
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: {
						id: mockRequestId,
						bloodType: 'A_Positive',
						volumeMl: 450,
					},
				})

				await donateController.fulfilledRequest(req, res, next)

				// 1. Response status and payload
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'Request Fulfilled.')
				assert.ok(res.responseData.unit, 'Unit payload returned')

				// 2. Unit clinical safety invariants: MUST be Quarantined
				assert.strictEqual(savedUnit.status, 'Quarantined')
				assert.strictEqual(savedUnit.bloodGroup, 'A_Positive')
				assert.strictEqual(savedUnit.volumeMl, 450)
				assert.strictEqual(savedUnit.componentType, 'Whole_Blood')
				assert.strictEqual(savedUnit.clearance.isVerified, false)
				assert.strictEqual(savedUnit.testing.hiv, 'Pending')
				assert.strictEqual(savedUnit.testing.hbv, 'Pending')
				assert.strictEqual(savedUnit.testing.hcv, 'Pending')
				assert.strictEqual(savedUnit.testing.syphilis, 'Pending')
				assert.strictEqual(savedUnit.testing.malaria, 'Pending')
				assert.match(savedUnit.unitNumber, /^DIN-\d{7}-[A-F0-9]{6}-WB$/)

				// 3. Expiry date set to clinical default (~35 days from now for CPDA-1 Whole Blood)
				const diffDays = Math.round(
					(new Date(savedUnit.expiryDate) - new Date(savedUnit.collectionDate)) /
						(1000 * 60 * 60 * 24)
				)
				assert.strictEqual(diffDays, 35)

				// 4. Audit Log invariant
				assert.ok(savedAudit, 'Audit log was created')
				assert.strictEqual(savedAudit.action, 'UNIT_INTAKE_COLLECTED')
				assert.strictEqual(savedAudit.previousStatus, 'None')
				assert.strictEqual(savedAudit.newStatus, 'Quarantined')
				assert.strictEqual(savedAudit.unitNumber, savedUnit.unitNumber)
				assert.strictEqual(savedAudit.actor.actorModel, 'bloodbank')
				assert.strictEqual(savedAudit.actor.actorId.toString(), mockBloodbankId)

				// 5. Transaction session integrity: unit and audit share the transaction session
				assert.strictEqual(sessionPassedToUnitSave, mockSession)
				assert.strictEqual(sessionPassedToAuditSave, mockSession)
				assert.strictEqual(mockSession.isCommitted, true)
				assert.strictEqual(mockSession.isAborted, false)

				// 6. Transitional Bridge Invariant: Legacy aggregate stock is NOT incremented on intake
				assert.strictEqual(
					increaseStockCalled,
					false,
					'Legacy Bloodstock must NOT be incremented on initial intake (unit is Quarantined)'
				)
			} finally {
				mongoose.startSession = originalStartSession
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
				bloodStockController.increaseStock = originalIncreaseStock
			}
		})
	})

	// -------------------------------------------------------------
	// 2. Idempotency & Duplicate Prevention
	// -------------------------------------------------------------
	describe('2. Idempotency & Duplicate Unit Prevention', () => {
		it('should reject already Fulfilled donation request and not create a duplicate unit', async () => {
			let unitSaveCalled = false
			const originalFindOne = DonateRequests.findOne
			const originalUnitSave = BloodUnit.prototype.save

			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Fulfilled',
				bloodType: 'O_Positive',
			})

			BloodUnit.prototype.save = async function () {
				unitSaveCalled = true
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'O_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already been fulfilled/)
				assert.strictEqual(unitSaveCalled, false, 'No unit must be created for already fulfilled request')
			} finally {
				DonateRequests.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
			}
		})

		it('should reject if a BloodUnit already references this donationRequestId', async () => {
			let unitSaveCalled = false
			const originalFindOne = DonateRequests.findOne
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save

			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Accepted',
				bloodType: 'B_Positive',
			})

			// Simulated existing unit referencing this request
			BloodUnit.findOne = async (query) => {
				if (query.donationRequestId) {
					return {
						_id: new mongoose.Types.ObjectId(),
						unitNumber: 'DIN-2026292-112233-WB',
						donationRequestId: mockRequestId,
						status: 'Quarantined',
					}
				}
				return null
			}

			BloodUnit.prototype.save = async function () {
				unitSaveCalled = true
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'B_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already been fulfilled|Traceable unit has already been created/)
				assert.strictEqual(unitSaveCalled, false, 'Duplicate unit creation must be blocked by idempotency check')
			} finally {
				DonateRequests.findOne = originalFindOne
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
			}
		})

		it('should handle concurrent fulfillment conflict safely when findOneAndUpdate returns null', async () => {
			let unitSaveCalled = false
			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save

			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Accepted',
				bloodType: 'AB_Positive',
			})

			BloodUnit.findOne = async () => null

			// Concurrent race: another worker updated status to Fulfilled first
			DonateRequests.findOneAndUpdate = async () => null

			BloodUnit.prototype.save = async function () {
				unitSaveCalled = true
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'AB_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /conflict/i)
				assert.strictEqual(unitSaveCalled, false, 'No unit must be created if state update conflict occurs')
			} finally {
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
			}
		})
	})

	// -------------------------------------------------------------
	// 3. Authorization & Input Validation
	// -------------------------------------------------------------
	describe('3. Authorization & State Transition Validation', () => {
		it('should forbid blood bank B from fulfilling blood bank A\'s donation request (BOLA guard)', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, otherBloodbankId)
				return null // Request not found for blood bank B
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: otherBloodbankUser,
					body: { id: mockRequestId, bloodType: 'O_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should reject fulfilling a Rejected donation request', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Rejected',
				bloodType: 'A_Positive',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'A_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot fulfill a rejected request/)
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should reject invalid ObjectId format for request ID', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				body: { id: 'invalid-hex-id', bloodType: 'A_Positive' },
			})

			await donateController.fulfilledRequest(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Valid request ID is required/)
		})

		it('should reject invalid blood type during fulfillment', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Accepted',
				bloodType: '',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'INVALID_TYPE' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Valid Blood Type is required/)
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 4. Transaction Rollback on Failure
	// -------------------------------------------------------------
	describe('4. Transaction Rollback & Failure Recovery', () => {
		it('should abort transaction and not commit changes when unit save fails inside replica set transaction', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save

			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Accepted',
				bloodType: 'O_Positive',
			})

			DonateRequests.findOneAndUpdate = async () => ({
				_id: mockRequestId,
				status: 'Fulfilled',
			})

			BloodUnit.findOne = async () => null

			BloodUnit.prototype.save = async function () {
				throw new Error('Disk write error: failed to persist BloodUnit')
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'O_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.match(res.responseData.message, /Transaction rolled back/)

				// Transaction must be aborted
				assert.strictEqual(mockSession.isAborted, true)
				assert.strictEqual(mockSession.isCommitted, false)
				assert.strictEqual(mockSession.isEnded, true)
			} finally {
				mongoose.startSession = originalStartSession
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
			}
		})

		it('should execute compensating rollback on DonateRequests when unit save fails in standalone fallback mode', async () => {
			let rolledBackTo = null
			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalFindByIdAndUpdate = DonateRequests.findByIdAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save

			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Accepted',
				bloodType: 'B_Positive',
			})

			DonateRequests.findOneAndUpdate = async () => ({
				_id: mockRequestId,
				status: 'Fulfilled',
			})

			DonateRequests.findByIdAndUpdate = async (id, update) => {
				rolledBackTo = update.status
				return {}
			}

			BloodUnit.findOne = async () => null

			BloodUnit.prototype.save = async function () {
				throw new Error('Database connection interrupted during unit save')
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'B_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.strictEqual(
					rolledBackTo,
					'Accepted',
					'Compensating rollback must reset status to previous Accepted state'
				)
			} finally {
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				DonateRequests.findByIdAndUpdate = originalFindByIdAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
			}
		})
	})

	// -------------------------------------------------------------
	// 5. DIN Collision Retry & Side Effect Isolation
	// -------------------------------------------------------------
	describe('5. DIN Collision Retry & Side Effect Isolation', () => {
		it('should recover from an E11000 duplicate key collision on save without repeating DonateRequests updates', async () => {
			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let requestUpdateCount = 0
			let saveAttempts = 0
			let finalSavedDIN = null
			const dinList = []

			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Accepted',
				bloodType: 'O_Positive',
			})

			DonateRequests.findOneAndUpdate = async () => {
				requestUpdateCount++
				return { _id: mockRequestId, status: 'Fulfilled' }
			}

			BloodUnit.findOne = async () => null // Pre-check passes

			BloodUnit.prototype.save = async function () {
				saveAttempts++
				dinList.push(this.unitNumber)
				if (saveAttempts === 1) {
					// Simulate concurrent race collision: duplicate key error on first attempt
					const err = new Error('E11000 duplicate key error collection: bloodunits index: unitNumber_1 dup key')
					err.code = 11000
					throw err
				}
				finalSavedDIN = this.unitNumber
				this._id = new mongoose.Types.ObjectId()
				return this
			}

			BloodUnitAuditLog.prototype.save = async function () {
				this._id = new mongoose.Types.ObjectId()
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'O_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(saveAttempts, 2, 'Save was retried after initial E11000 collision')
				assert.strictEqual(
					requestUpdateCount,
					1,
					'DonateRequests update must happen EXACTLY ONCE and not be repeated during retry'
				)
				assert.strictEqual(dinList.length, 2)
				assert.notStrictEqual(
					dinList[0],
					dinList[1],
					'Retry must generate a brand new distinct DIN'
				)
				assert.strictEqual(res.responseData.unit.unitNumber, finalSavedDIN)
			} finally {
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should fail-closed immediately on non-collision database errors without retrying save', async () => {
			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalFindByIdAndUpdate = DonateRequests.findByIdAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save

			let saveAttempts = 0

			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Accepted',
				bloodType: 'A_Positive',
			})

			DonateRequests.findOneAndUpdate = async () => ({ _id: mockRequestId, status: 'Fulfilled' })
			DonateRequests.findByIdAndUpdate = async () => ({})
			BloodUnit.findOne = async () => null

			BloodUnit.prototype.save = async function () {
				saveAttempts++
				throw new Error('CastError: malformed field type') // NOT an E11000 collision
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'A_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.strictEqual(saveAttempts, 1, 'Non-collision errors must NOT trigger a retry')
			} finally {
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				DonateRequests.findByIdAndUpdate = originalFindByIdAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
			}
		})
	})

	// -------------------------------------------------------------
	// 6. Legacy Aggregate Inventory Consistency (Transitional Bridge)
	// -------------------------------------------------------------
	describe('6. Legacy Stock Compatibility & Quarantine Isolation', () => {
		it('should verify that intake leaves legacy Bloodstock unmutated and classifies inventory as LEGACY_WITH_QUARANTINE_INTAKE', async () => {
			// Test the full stock consolidation behavior when a blood bank with 10 legacy units ingests 1 new unit
			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save
			const originalBloodstockFindOne = Bloodstock.findOne
			const originalBloodUnitAggregate = BloodUnit.aggregate

			let legacyBloodstockIncremented = false
			let quarantinedUnitsCount = 0

			DonateRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				status: 'Accepted',
				bloodType: 'O_Positive',
			})

			DonateRequests.findOneAndUpdate = async () => ({
				_id: mockRequestId,
				status: 'Fulfilled',
				bloodType: 'O_Positive',
			})

			BloodUnit.findOne = async () => null

			BloodUnit.prototype.save = async function () {
				this._id = new mongoose.Types.ObjectId()
				quarantinedUnitsCount++
				return this
			}

			BloodUnitAuditLog.prototype.save = async function () {
				this._id = new mongoose.Types.ObjectId()
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: mockRequestId, bloodType: 'O_Positive' },
				})

				// Execute intake
				await donateController.fulfilledRequest(req, res, next)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(quarantinedUnitsCount, 1)

				// Now simulate stockService.getConsolidatedStock after this intake:
				// Bloodstock still has its original 10 units (not 11!)
				Bloodstock.findOne = async () => ({
					_id: new mongoose.Types.ObjectId(),
					bloodbankId: mockBloodbankId,
					O_Positive: 10,
					A_Positive: 5,
				})

				// BloodUnit aggregate: 0 verified available, 1 Quarantined
				let aggregateCallCount = 0
				BloodUnit.aggregate = () => {
					aggregateCallCount++
					if (aggregateCallCount === 1) {
						// getTraceableAvailableStock: 0 verified (unit is still in Quarantine!)
						return []
					}
					// getTraceableStatusBreakdown: 1 Quarantined unit
					return [{ _id: 'Quarantined', count: 1 }]
				}

				const consolidated = await stockService.getConsolidatedStock(mockBloodbankId)

				// Invariant: Top-level count preserves legacy operational number (10)
				assert.strictEqual(consolidated.O_Positive, 10)
				assert.strictEqual(consolidated.legacyUnverifiedStock.O_Positive, 10)

				// Invariant: Traceable verified available stock strictly remains 0 (quarantined unit NOT counted)
				assert.strictEqual(consolidated.traceableVerifiedStock.O_Positive, 0)

				// Invariant: Status breakdown captures the 1 newly quarantined unit
				assert.strictEqual(consolidated.traceableStatusBreakdown.Quarantined, 1)

				// Invariant: Explicit classification demarcates the transitional intake state
				assert.strictEqual(
					consolidated.inventoryClassification,
					'LEGACY_WITH_QUARANTINE_INTAKE'
				)
				assert.strictEqual(consolidated.isVerifiedStock, false)
				assert.strictEqual(consolidated.isTraceableActive, true)
				assert.match(
					consolidated.legacyNotice,
					/1 unit\(s\) are currently Quarantined awaiting infectious screening/
				)
			} finally {
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
				Bloodstock.findOne = originalBloodstockFindOne
				BloodUnit.aggregate = originalBloodUnitAggregate
			}
		})
	})
})
