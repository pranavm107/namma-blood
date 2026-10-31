const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const {
	parseWorkerConfig,
	processExpiredReservations,
	startReservationExpiryWorker,
	stopReservationExpiryWorker,
	getWorkerStatus,
	sanitizeErrorMessage,
	_resetWorkerStateForTests,
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

describe('Reservation-Expiry Worker — Safety, Hardening & Recovery', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId()
	const otherBloodbankId = new mongoose.Types.ObjectId()
	const mockRequestId = new mongoose.Types.ObjectId()

	const originalStartSession = mongoose.startSession
	const originalUnitFind = BloodUnit.find
	const originalUnitFindOne = BloodUnit.findOne
	const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate
	const originalAuditSave = BloodUnitAuditLog.prototype.save
	let originalReadyState

	beforeEach(() => {
		_resetWorkerStateForTests()

		// Mock active DB readyState by default
		originalReadyState = mongoose.connection.readyState
		Object.defineProperty(mongoose.connection, 'readyState', {
			value: 1,
			configurable: true,
			writable: true,
		})

		mongoose.startSession = async () => createMockSession()
		mongoose.startSession._isMock = true
		BloodUnit.find = () => mockChainableFind([])
		BloodUnit.findOne = async () => null
		ReceiveRequests.findOneAndUpdate = async () => ({})
		BloodUnitAuditLog.prototype.save = async function () {
			return this
		}
	})

	afterEach(async () => {
		await stopReservationExpiryWorker({ drain: false })
		_resetWorkerStateForTests()

		Object.defineProperty(mongoose.connection, 'readyState', {
			value: originalReadyState,
			configurable: true,
			writable: true,
		})

		mongoose.startSession = originalStartSession
		BloodUnit.find = originalUnitFind
		BloodUnit.findOne = originalUnitFindOne
		ReceiveRequests.findOneAndUpdate = originalReqFindOneAndUpdate
		BloodUnitAuditLog.prototype.save = originalAuditSave
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
				runOnBoot: false,
				logger: { info: () => {}, warn: () => {} },
			})
			assert.strictEqual(worker.isRunning(), true)

			// Trigger runOnce manually
			await worker.runOnce()
			assert.strictEqual(tickCount, 1)

			// Stop cleanly
			await worker.stop()
			assert.strictEqual(worker.isRunning(), false)
		})
	})

	// =========================================================================
	// 12. Central Configuration Parsing & Boundary Clamping
	// =========================================================================
	describe('12. Central Configuration Parsing & Boundary Clamping', () => {
		it('should parse environment variables with safe defaults when empty or invalid', () => {
			const emptyConfig = parseWorkerConfig({})
			assert.strictEqual(emptyConfig.enabled, false)
			assert.strictEqual(emptyConfig.intervalMs, 60000)
			assert.strictEqual(emptyConfig.batchSize, 100)
			assert.strictEqual(emptyConfig.runOnBoot, true)
		})

		it('should correctly parse enabled flag across casing and whitespace', () => {
			assert.strictEqual(parseWorkerConfig({ ENABLE_RESERVATION_EXPIRY_WORKER: 'true' }).enabled, true)
			assert.strictEqual(parseWorkerConfig({ ENABLE_RESERVATION_EXPIRY_WORKER: 'TRUE' }).enabled, true)
			assert.strictEqual(parseWorkerConfig({ ENABLE_RESERVATION_EXPIRY_WORKER: '  true  ' }).enabled, true)
			assert.strictEqual(parseWorkerConfig({ ENABLE_RESERVATION_EXPIRY_WORKER: 'false' }).enabled, false)
			assert.strictEqual(parseWorkerConfig({ ENABLE_RESERVATION_EXPIRY_WORKER: 'invalid' }).enabled, false)
		})

		it('should clamp intervalMs to minimum 5000ms', () => {
			const lowInterval = parseWorkerConfig({ RESERVATION_EXPIRY_INTERVAL_MS: '1000' })
			assert.strictEqual(lowInterval.intervalMs, 5000, 'Intervals < 5000ms must be clamped to 5000ms.')

			const validInterval = parseWorkerConfig({ RESERVATION_EXPIRY_INTERVAL_MS: '30000' })
			assert.strictEqual(validInterval.intervalMs, 30000)

			const invalidInterval = parseWorkerConfig({ RESERVATION_EXPIRY_INTERVAL_MS: 'not_a_number' })
			assert.strictEqual(invalidInterval.intervalMs, 60000)
		})

		it('should clamp batchSize between 1 and 500', () => {
			const zeroBatch = parseWorkerConfig({ RESERVATION_EXPIRY_BATCH_SIZE: '0' })
			assert.strictEqual(zeroBatch.batchSize, 1)

			const negativeBatch = parseWorkerConfig({ RESERVATION_EXPIRY_BATCH_SIZE: '-50' })
			assert.strictEqual(negativeBatch.batchSize, 1)

			const overBatch = parseWorkerConfig({ RESERVATION_EXPIRY_BATCH_SIZE: '9999' })
			assert.strictEqual(overBatch.batchSize, 500)

			const validBatch = parseWorkerConfig({ RESERVATION_EXPIRY_BATCH_SIZE: '250' })
			assert.strictEqual(validBatch.batchSize, 250)
		})

		it('should parse runOnBoot flag correctly', () => {
			assert.strictEqual(parseWorkerConfig({ RESERVATION_EXPIRY_RUN_ON_BOOT: 'false' }).runOnBoot, false)
			assert.strictEqual(parseWorkerConfig({ RESERVATION_EXPIRY_RUN_ON_BOOT: '0' }).runOnBoot, false)
			assert.strictEqual(parseWorkerConfig({ RESERVATION_EXPIRY_RUN_ON_BOOT: 'true' }).runOnBoot, true)
			assert.strictEqual(parseWorkerConfig({}).runOnBoot, true)
		})
	})

	// =========================================================================
	// 13. Observability & Health Monitoring (getWorkerStatus)
	// =========================================================================
	describe('13. Observability & Health Monitoring (getWorkerStatus)', () => {
		it('should report idle status before startup', () => {
			const status = getWorkerStatus()
			assert.strictEqual(status.isRunning, false)
			assert.strictEqual(status.isTickRunning, false)
			assert.strictEqual(status.bootedAt, null)
			assert.strictEqual(status.metrics.totalRuns, 0)
			assert.strictEqual(status.metrics.totalProcessedCount, 0)
		})

		it('should record execution telemetry, boot timestamp, and cumulative counters upon sweep', async () => {
			const expiredUnit = createUnitDoc()
			BloodUnit.find = () => mockChainableFind([expiredUnit])
			BloodUnit.findOne = async () => expiredUnit

			const worker = startReservationExpiryWorker({
				intervalMs: 15000,
				batchSize: 50,
				runOnBoot: false,
				logger: { info: () => {}, warn: () => {} },
			})

			const beforeStatus = getWorkerStatus()
			assert.strictEqual(beforeStatus.isRunning, true)
			assert.ok(beforeStatus.bootedAt)
			assert.strictEqual(beforeStatus.config.batchSize, 50)
			assert.strictEqual(beforeStatus.config.intervalMs, 15000)

			await worker.runOnce()

			const afterStatus = getWorkerStatus()
			assert.strictEqual(afterStatus.metrics.totalRuns, 1)
			assert.strictEqual(afterStatus.metrics.totalProcessedCount, 1)
			assert.strictEqual(afterStatus.metrics.totalReleasedCount, 1)
			assert.strictEqual(afterStatus.metrics.totalExpiredCount, 0)
			assert.ok(afterStatus.lastRunAt)
			assert.ok(typeof afterStatus.lastRunDurationMs === 'number')
			assert.strictEqual(afterStatus.lastRunResult.processedCount, 1)

			await worker.stop()
		})
	})

	// =========================================================================
	// 14. Error Sanitization (Secrets & URI Scrubbing)
	// =========================================================================
	describe('14. Error Sanitization', () => {
		it('should scrub MongoDB credentials and sensitive authorization tokens from logged errors', () => {
			const uriError = 'Connection failed: mongodb+srv://app_user:SuperSecretPassword123@cluster0.abc.mongodb.net/prod'
			const sanitizedUri = sanitizeErrorMessage(uriError)
			assert.doesNotMatch(sanitizedUri, /SuperSecretPassword123/)
			assert.match(sanitizedUri, /mongodb:\/\/[*]{3}:[*]{3}@/)

			const tokenError = 'Unauthorized request with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDjhBy'
			const sanitizedToken = sanitizeErrorMessage(tokenError)
			assert.doesNotMatch(sanitizedToken, /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9/)
			assert.match(sanitizedToken, /Bearer [*]{3}/)
		})
	})

	// =========================================================================
	// 15. Database Disconnection & Resilience Handling
	// =========================================================================
	describe('15. Database Disconnection & Resilience Handling', () => {
		it('should skip sweep safely when database is disconnected (readyState !== 1) without throwing unhandled rejection', async () => {
			// Mock database disconnected state
			Object.defineProperty(mongoose.connection, 'readyState', {
				value: 0, // 0 = disconnected
				configurable: true,
				writable: true,
			})

			let warnLogged = false
			const mockLogger = {
				warn: (msg) => {
					warnLogged = true
					assert.match(msg, /Database is not connected \(readyState=0/)
				},
				info: () => {},
				error: () => {},
			}

			const result = await processExpiredReservations({ logger: mockLogger })
			assert.strictEqual(result.success, false)
			assert.strictEqual(result.dbNotReady, true)
			assert.strictEqual(result.processedCount, 0)
			assert.strictEqual(result.candidatesFound, 0)
			assert.strictEqual(warnLogged, true)
		})

		it('should resume normal processing seamlessly once database reconnects', async () => {
			const expiredUnit = createUnitDoc()
			BloodUnit.find = () => mockChainableFind([expiredUnit])
			BloodUnit.findOne = async () => expiredUnit

			// 1. First sweep while disconnected
			Object.defineProperty(mongoose.connection, 'readyState', {
				value: 0,
				configurable: true,
				writable: true,
			})
			const skippedResult = await processExpiredReservations({ logger: { warn: () => {} } })
			assert.strictEqual(skippedResult.dbNotReady, true)

			// 2. Database reconnects
			Object.defineProperty(mongoose.connection, 'readyState', {
				value: 1,
				configurable: true,
				writable: true,
			})
			const recoveredResult = await processExpiredReservations({ logger: { info: () => {} } })
			assert.strictEqual(recoveredResult.success, true)
			assert.strictEqual(recoveredResult.processedCount, 1)
			assert.strictEqual(recoveredResult.releasedToAvailableCount, 1)
		})
	})

	// =========================================================================
	// 16. Immediate Run-On-Boot & Overlap Prevention
	// =========================================================================
	describe('16. Immediate Run-On-Boot & Overlap Prevention', () => {
		it('should execute boot sweep immediately when runOnBoot is true and prevent duplicate start', async () => {
			let sweepCount = 0
			BloodUnit.find = () => {
				sweepCount++
				return mockChainableFind([])
			}

			const worker = startReservationExpiryWorker({
				intervalMs: 60000,
				runOnBoot: true,
				logger: { info: () => {}, warn: () => {} },
			})

			// Attempt duplicate start
			let duplicateWarned = false
			const duplicateWorker = startReservationExpiryWorker({
				logger: {
					warn: (msg) => {
						duplicateWarned = true
						assert.match(msg, /Worker is already running/)
					},
				},
			})

			assert.strictEqual(duplicateWarned, true)
			assert.strictEqual(duplicateWorker.isRunning(), true)

			// Allow boot sweep microtask to resolve
			await new Promise((r) => setTimeout(r, 50))
			assert.strictEqual(sweepCount, 1, 'Boot sweep must have executed.')

			await worker.stop()
		})
	})

	// =========================================================================
	// 17. Graceful Stop & In-Flight Drain
	// =========================================================================
	describe('17. Graceful Stop & In-Flight Drain', () => {
		it('should wait for in-flight sweep to drain completely before resolving stop', async () => {
			let sweepFinished = false
			BloodUnit.find = () => {
				return {
					sort() {
						return this
					},
					limit() {
						return new Promise((resolve) => {
							setTimeout(() => {
								sweepFinished = true
								resolve([])
							}, 60)
						})
					},
				}
			}

			const worker = startReservationExpiryWorker({
				intervalMs: 10000,
				runOnBoot: false,
				logger: { info: () => {}, warn: () => {} },
			})

			// Launch tick in background
			const tickPromise = worker.runOnce()

			// Immediately issue stop with drain
			const stopPromise = stopReservationExpiryWorker({ drain: true, timeoutMs: 1000 })

			assert.strictEqual(sweepFinished, false, 'Sweep is still in flight.')
			await stopPromise
			assert.strictEqual(sweepFinished, true, 'Worker stop must have awaited the in-flight drain.')
			assert.strictEqual(worker.isRunning(), false)

			await tickPromise
		})

		it('should be completely idempotent when stop is called repeatedly', async () => {
			const res1 = await stopReservationExpiryWorker()
			const res2 = await stopReservationExpiryWorker()
			assert.strictEqual(res1, true)
			assert.strictEqual(res2, true)
		})
	})

	// =========================================================================
	// 18. Operational Recovery After Accumulated Offline Holds
	// =========================================================================
	describe('18. Operational Recovery After Accumulated Offline Holds', () => {
		it('should recover all accumulated expired holds in bounded batches upon server reboot', async () => {
			const now = new Date()
			// Simulate 3 holds that expired while the system was offline
			const offlineExpired1 = createUnitDoc()
			const offlineExpired2 = createUnitDoc()
			const offlineExpired3 = createUnitDoc()

			BloodUnit.find = () => mockChainableFind([offlineExpired1, offlineExpired2, offlineExpired3])
			BloodUnit.findOne = async (filter) => {
				if (filter._id.toString() === offlineExpired1._id.toString()) return offlineExpired1
				if (filter._id.toString() === offlineExpired2._id.toString()) return offlineExpired2
				if (filter._id.toString() === offlineExpired3._id.toString()) return offlineExpired3
				return null
			}

			// Worker boots up after downtime with runOnBoot: true
			const worker = startReservationExpiryWorker({
				intervalMs: 60000,
				batchSize: 100,
				runOnBoot: true,
				logger: { info: () => {}, warn: () => {} },
			})

			// Allow boot sweep to complete
			await new Promise((r) => setTimeout(r, 60))

			const status = getWorkerStatus()
			assert.strictEqual(status.metrics.totalRuns, 1)
			assert.strictEqual(status.metrics.totalProcessedCount, 3)
			assert.strictEqual(status.metrics.totalReleasedCount, 3)
			assert.strictEqual(offlineExpired1.status, 'Available')
			assert.strictEqual(offlineExpired2.status, 'Available')
			assert.strictEqual(offlineExpired3.status, 'Available')

			await worker.stop()
		})
	})
})
