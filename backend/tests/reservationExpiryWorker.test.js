const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const {
	processExpiredReservations,
	startReservationExpiryWorker,
	stopReservationExpiryWorker,
} = require('../BloodUnit/reservationExpiryWorker')

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
				const res = await fn()
				this.isCommitted = true
				return res
			} catch (err) {
				this.isAborted = true
				throw err
			}
		},
	}
	return session
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

describe('Reservation-Expiry Worker — Unit & Concurrency Safety', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId()
	const otherBloodbankId = new mongoose.Types.ObjectId()
	const mockRequestId = new mongoose.Types.ObjectId()

	const originalStartSession = mongoose.startSession
	const originalUnitFind = BloodUnit.find
	const originalUnitFindOne = BloodUnit.findOne
	const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate
	const originalAuditSave = BloodUnitAuditLog.prototype.save

	beforeEach(() => {
		mongoose.startSession = async () => createMockSession()
		mongoose.startSession._isMock = true
		BloodUnit.find = () => mockChainableFind([])
		BloodUnit.findOne = async () => null
		ReceiveRequests.findOneAndUpdate = async () => ({})
		BloodUnitAuditLog.prototype.save = async function () {
			return this
		}
	})

	afterEach(() => {
		mongoose.startSession = originalStartSession
		BloodUnit.find = originalUnitFind
		BloodUnit.findOne = originalUnitFindOne
		ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
		BloodUnitAuditLog.prototype.save = originalAuditSave
		stopReservationExpiryWorker()
	})

	function createUnitDoc(overrides = {}) {
		const now = new Date()
		const unit = {
			_id: new mongoose.Types.ObjectId(),
			unitNumber: `W000026${Math.floor(10000 + Math.random() * 90000)}`,
			bloodbankId: mockBloodbankId,
			bloodGroup: 'O_Positive',
			componentType: 'Whole_Blood',
			status: 'Reserved',
			expiryDate: new Date(now.getTime() + 30 * 24 * 3600 * 1000), // unexpired
			reservation: {
				receiveRequestId: mockRequestId,
				reservedAt: new Date(now.getTime() - 2 * 3600 * 1000),
				reservedExpiresAt: new Date(now.getTime() - 10 * 60 * 1000), // expired 10m ago
			},
			save: async function () {
				return this
			},
			...overrides,
		}
		return unit
	}

	// =========================================================================
	// 1. Normal Expiry & Unit Release
	// =========================================================================
	describe('1. Normal Expiry & Unit Release', () => {
		it('should identify expired reserved units, release them back to Available, and pull references from ReceiveRequests', async () => {
			const expiredUnit = createUnitDoc()
			BloodUnit.find = () => mockChainableFind([expiredUnit])

			let lockedFilter = null
			BloodUnit.findOne = async (filter) => {
				lockedFilter = filter
				return expiredUnit
			}

			let reqPulledUnitId = null
			ReceiveRequests.findOneAndUpdate = async (filter, update) => {
				reqPulledUnitId = update.$pull.reservedUnitIds
				return { _id: filter._id, status: 'Accepted' }
			}

			const recordedAudits = []
			BloodUnitAuditLog.prototype.save = async function () {
				recordedAudits.push(this)
				return this
			}

			const result = await processExpiredReservations({
				batchSize: 50,
				bloodbankId: mockBloodbankId,
			})

			assert.strictEqual(result.success, true)
			assert.strictEqual(result.processedCount, 1)
			assert.strictEqual(result.releasedToAvailableCount, 1)
			assert.strictEqual(result.transitionedToExpiredCount, 0)
			assert.strictEqual(result.skippedCount, 0)

			// Verify atomic conditional filter
			assert.strictEqual(lockedFilter._id.toString(), expiredUnit._id.toString())
			assert.strictEqual(lockedFilter.status, 'Reserved')
			assert.strictEqual(expiredUnit.status, 'Available')
			assert.strictEqual(expiredUnit.reservation.receiveRequestId, null)
			assert.strictEqual(expiredUnit.reservation.reservedExpiresAt, null)

			// Verify receive request reference was pulled
			assert.strictEqual(reqPulledUnitId.toString(), expiredUnit._id.toString())

			// Verify audit log
			assert.strictEqual(recordedAudits.length, 1)
			assert.strictEqual(recordedAudits[0].action, 'RESERVATION_EXPIRED')
			assert.strictEqual(recordedAudits[0].previousStatus, 'Reserved')
			assert.strictEqual(recordedAudits[0].newStatus, 'Available')
		})
	})

	// =========================================================================
	// 2. Non-Expired Reservations
	// =========================================================================
	describe('2. Non-Expired Reservations', () => {
		it('should ignore units whose reservation hold is still active (reservedExpiresAt > now)', async () => {
			let queriedFilter = null
			BloodUnit.find = (filter) => {
				queriedFilter = filter
				return mockChainableFind([]) // None found matching expired criteria
			}

			const result = await processExpiredReservations({ batchSize: 50 })
			assert.strictEqual(result.processedCount, 0)
			assert.strictEqual(result.skippedCount, 0)
			assert.strictEqual(result.candidatesFound, 0)
			assert.strictEqual(queriedFilter.status, 'Reserved')
			assert.ok(queriedFilter['reservation.reservedExpiresAt'].$lte instanceof Date)
		})
	})

	// =========================================================================
	// 3. State Guard: Already-Issued / Dispatched Units
	// =========================================================================
	describe('3. Already-Issued / Dispatched Units', () => {
		it('should never match or modify units that have already transitioned to Issued, Dispatched, or Discarded', async () => {
			let queriedStatus = null
			BloodUnit.find = (filter) => {
				queriedStatus = filter.status
				return mockChainableFind([])
			}

			await processExpiredReservations()
			assert.strictEqual(queriedStatus, 'Reserved', 'Query must strictly enforce status === "Reserved".')
		})
	})

	// =========================================================================
	// 4. Concurrent Issuance Race Protection
	// =========================================================================
	describe('4. Concurrent Issuance Race Protection', () => {
		it('should safely skip unit and not corrupt data if a concurrent transaction issues the unit before lock', async () => {
			const expiredUnit = createUnitDoc()
			BloodUnit.find = () => mockChainableFind([expiredUnit])

			// Simulate concurrent issuance: findOne returns null
			BloodUnit.findOne = async () => null

			const result = await processExpiredReservations()
			assert.strictEqual(result.success, true)
			assert.strictEqual(result.processedCount, 0)
			assert.strictEqual(result.skippedCount, 1, 'Unit claimed by concurrent issuance must be counted as skipped.')
			assert.strictEqual(result.failedCount, 0)
		})
	})

	// =========================================================================
	// 5. Concurrent Renewal Race Protection
	// =========================================================================
	describe('5. Concurrent Renewal Race Protection', () => {
		it('should safely skip unit if another thread concurrently extended/renewed the reservation hold', async () => {
			const expiredUnit = createUnitDoc()
			BloodUnit.find = () => mockChainableFind([expiredUnit])

			// Hold was extended: findOne returns null
			BloodUnit.findOne = async () => null

			const result = await processExpiredReservations()
			assert.strictEqual(result.processedCount, 0)
			assert.strictEqual(result.skippedCount, 1)
		})
	})

	// =========================================================================
	// 6. Tenant Isolation
	// =========================================================================
	describe('6. Tenant Isolation', () => {
		it('should scope queries and updates strictly to the specified blood bank tenant', async () => {
			let capturedQuery = null
			BloodUnit.find = (query) => {
				capturedQuery = query
				return mockChainableFind([])
			}

			await processExpiredReservations({ bloodbankId: mockBloodbankId })
			assert.strictEqual(capturedQuery.bloodbankId.toString(), mockBloodbankId.toString())
		})
	})

	// =========================================================================
	// 7. Transaction Rollback & Error Isolation
	// =========================================================================
	describe('7. Transaction Rollback & Error Isolation', () => {
		it('should abort transaction and isolate failures without halting the batch', async () => {
			const expiredUnit1 = createUnitDoc()
			const expiredUnit2 = createUnitDoc()

			BloodUnit.find = () => mockChainableFind([expiredUnit1, expiredUnit2])

			let callCount = 0
			BloodUnit.findOne = async (filter) => {
				callCount++
				if (callCount === 1) {
					throw new Error('Database disk error on unit 1')
				}
				return expiredUnit2
			}

			const result = await processExpiredReservations({
				logger: { error: () => {} }, // suppress expected error logging
			})

			assert.strictEqual(result.success, false)
			assert.strictEqual(result.failedCount, 1)
			assert.strictEqual(result.processedCount, 1, 'Second unit in batch must still be processed.')
			assert.strictEqual(result.errors.length, 1)
			assert.match(result.errors[0].error, /Database disk error on unit 1/)
		})
	})

	// =========================================================================
	// 8. Repeat Execution / Idempotency
	// =========================================================================
	describe('8. Repeat Execution / Idempotency', () => {
		it('should be completely idempotent when executed consecutively', async () => {
			BloodUnit.find = () => mockChainableFind([]) // Already released on prior run

			const result = await processExpiredReservations()
			assert.strictEqual(result.processedCount, 0)
			assert.strictEqual(result.candidatesFound, 0)
			assert.strictEqual(result.failedCount, 0)
		})
	})

	// =========================================================================
	// 9. Audit Consistency & Shelf-Life Discrimination
	// =========================================================================
	describe('9. Audit Consistency & Shelf-Life Discrimination', () => {
		it('should transition clinically expired units to Expired (action: UNIT_EXPIRED) instead of Available', async () => {
			const now = new Date()
			const clinicallyExpiredUnit = createUnitDoc({
				expiryDate: new Date(now.getTime() - 24 * 3600 * 1000), // Expired clinically yesterday!
			})

			BloodUnit.find = () => mockChainableFind([clinicallyExpiredUnit])
			BloodUnit.findOne = async () => clinicallyExpiredUnit

			let auditAction = null
			BloodUnitAuditLog.prototype.save = async function () {
				auditAction = this.action
				return this
			}

			const result = await processExpiredReservations({ now })
			assert.strictEqual(result.transitionedToExpiredCount, 1)
			assert.strictEqual(result.releasedToAvailableCount, 0)
			assert.strictEqual(clinicallyExpiredUnit.status, 'Expired')
			assert.strictEqual(auditAction, 'UNIT_EXPIRED')
		})
	})

	// =========================================================================
	// 10. Legacy Stock Isolation
	// =========================================================================
	describe('10. Legacy Stock Isolation', () => {
		it('should never touch, decrement, or query legacy aggregate Bloodstock during reservation expiry', async () => {
			const expiredUnit = createUnitDoc()

			let stockCalled = false
			const originalStockFindOne = Bloodstock.findOne
			const originalStockFindOneAndUpdate = Bloodstock.findOneAndUpdate

			Bloodstock.findOne = async () => {
				stockCalled = true
				return null
			}
			Bloodstock.findOneAndUpdate = async () => {
				stockCalled = true
				return null
			}

			BloodUnit.find = () => mockChainableFind([expiredUnit])
			BloodUnit.findOne = async () => expiredUnit

			try {
				await processExpiredReservations()
				assert.strictEqual(stockCalled, false, 'Legacy aggregate Bloodstock must NEVER be touched.')
			} finally {
				Bloodstock.findOne = originalStockFindOne
				Bloodstock.findOneAndUpdate = originalStockFindOneAndUpdate
			}
		})
	})

	// =========================================================================
	// 11. Scheduler Lifecycle & Overlap Prevention
	// =========================================================================
	describe('11. Scheduler Lifecycle & Overlap Prevention', () => {
		it('should start, manage concurrency lock to prevent overlapping ticks, and stop cleanly', async () => {
			let tickCount = 0
			BloodUnit.find = () => {
				tickCount++
				return mockChainableFind([])
			}

			const worker = startReservationExpiryWorker({
				intervalMs: 10000,
				logger: { info: () => {}, warn: () => {} },
			})
			assert.strictEqual(worker.isRunning(), true)

			// Trigger runOnce manually
			await worker.runOnce()
			assert.strictEqual(tickCount, 1)

			// Stop cleanly
			worker.stop()
			assert.strictEqual(worker.isRunning(), false)
		})
	})
})
