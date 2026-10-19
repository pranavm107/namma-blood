const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const donateController = require('../BloodDonate/bloodDonateController')
const receiveController = require('../BloodReceive/bloodReceiveController')
const DonateRequests = require('../BloodDonate/bloodDonateModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const bloodStockController = require('../BloodStock/bloodStockController')
const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const { canUseTransactions, withTransaction } = require('../Utils/transactionHelper')

// Helper to create mock req, res, next
function createMockReqRes({ user, body = {}, query = {}, params = {} } = {}) {
	const req = {
		user: user || { _id: new mongoose.Types.ObjectId().toString() },
		body,
		query,
		params,
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

// Helper to create a spy mock session that tracks transaction lifecycle
function createMockSession() {
	let inTxn = false
	let committed = false
	let aborted = false
	let ended = false
	let operations = []

	const session = {
		id: new mongoose.Types.ObjectId().toString(),
		async startTransaction() {
			inTxn = true
			operations.push('startTransaction')
		},
		async commitTransaction() {
			committed = true
			inTxn = false
			operations.push('commitTransaction')
		},
		async abortTransaction() {
			aborted = true
			inTxn = false
			operations.push('abortTransaction')
		},
		async endSession() {
			ended = true
			operations.push('endSession')
		},
		async withTransaction(fn) {
			await this.startTransaction()
			try {
				const result = await fn()
				await this.commitTransaction()
				return result
			} catch (err) {
				await this.abortTransaction()
				throw err
			}
		},
		get isCommitted() {
			return committed
		},
		get isAborted() {
			return aborted
		},
		get isEnded() {
			return ended
		},
		get operationLog() {
			return operations
		},
	}
	return session
}

describe('MongoDB Multi-Document Transaction Safety', () => {
	const bloodbankId = new mongoose.Types.ObjectId().toString()
	const bloodbankUser = { _id: bloodbankId }
	const requestId = new mongoose.Types.ObjectId().toString()

	// -------------------------------------------------------------
	// 1. Successful Transactions & Database State Integrity
	// -------------------------------------------------------------
	describe('1. Successful Transactions & Commit Lifecycle', () => {
		it('should execute blood donation fulfillment inside a single transaction session and commit', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let sessionPassedToFind = null
			let sessionPassedToUpdate = null
			let sessionPassedToUnitFind = null
			let sessionPassedToUnitSave = null
			let sessionPassedToAudit = null

			DonateRequests.findOne = async (query, proj, opts) => {
				sessionPassedToFind = opts?.session
				return {
					_id: requestId,
					bloodbankId,
					status: 'Accepted',
					bloodType: 'O_Positive',
				}
			}

			DonateRequests.findOneAndUpdate = async (query, update, opts) => {
				sessionPassedToUpdate = opts?.session
				return {
					_id: requestId,
					status: 'Fulfilled',
					bloodType: 'O_Positive',
				}
			}

			BloodUnit.findOne = async (query, proj, opts) => {
				sessionPassedToUnitFind = opts?.session
				return null
			}

			BloodUnit.prototype.save = async function (opts) {
				sessionPassedToUnitSave = opts?.session
				this._id = new mongoose.Types.ObjectId()
				return this
			}

			BloodUnitAuditLog.prototype.save = async function (opts) {
				sessionPassedToAudit = opts?.session
				this._id = new mongoose.Types.ObjectId()
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId, bloodType: 'O_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'Request Fulfilled.')
				assert.ok(res.responseData.unit, 'Traceable unit details returned')
				assert.strictEqual(res.responseData.unit.status, 'Quarantined')

				// Verify all operations shared the exact same transaction session
				assert.strictEqual(sessionPassedToFind, mockSession)
				assert.strictEqual(sessionPassedToUpdate, mockSession)
				assert.strictEqual(sessionPassedToUnitFind, mockSession)
				assert.strictEqual(sessionPassedToUnitSave, mockSession)
				assert.strictEqual(sessionPassedToAudit, mockSession)

				// Verify transaction committed and session ended
				assert.strictEqual(mockSession.isCommitted, true)
				assert.strictEqual(mockSession.isAborted, false)
				assert.strictEqual(mockSession.isEnded, true)
			} finally {
				mongoose.startSession = originalStartSession
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should execute blood receive fulfillment inside a single transaction session and commit', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = ReceiveRequests.findOne
			const originalCheckAvailability = bloodStockController.checkAvailability
			const originalDecreaseStock = bloodStockController.decreaseStock
			const originalFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			let sessionPassedToFind = null
			let sessionPassedToCheck = null
			let sessionPassedToStock = null
			let sessionPassedToUpdate = null

			ReceiveRequests.findOne = async (query, proj, opts) => {
				sessionPassedToFind = opts?.session
				return {
					_id: requestId,
					bloodbankId,
					status: 'Accepted',
					bloodType: 'A_Positive',
					unit: 2,
				}
			}

			bloodStockController.checkAvailability = async (bbId, bType, units, opts) => {
				sessionPassedToCheck = opts?.session
				return true
			}

			bloodStockController.decreaseStock = async (bbId, bType, units, opts) => {
				sessionPassedToStock = opts?.session
				return { [bType]: 5 }
			}

			ReceiveRequests.findOneAndUpdate = async (query, update, opts) => {
				sessionPassedToUpdate = opts?.session
				return {
					_id: requestId,
					status: 'Fulfilled',
					unit: 2,
				}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId, bloodType: 'A_Positive', unit: 2 },
				})

				await receiveController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'Request Fulfilled.')

				// Verify session propagated through availability check, stock decrement, and request update
				assert.strictEqual(sessionPassedToFind, mockSession)
				assert.strictEqual(sessionPassedToCheck, mockSession)
				assert.strictEqual(sessionPassedToStock, mockSession)
				assert.strictEqual(sessionPassedToUpdate, mockSession)

				assert.strictEqual(mockSession.isCommitted, true)
				assert.strictEqual(mockSession.isAborted, false)
				assert.strictEqual(mockSession.isEnded, true)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalFindOne
				bloodStockController.checkAvailability = originalCheckAvailability
				bloodStockController.decreaseStock = originalDecreaseStock
				ReceiveRequests.findOneAndUpdate = originalFindOneAndUpdate
			}
		})
	})

	// -------------------------------------------------------------
	// 2. Transaction Rollback When a Related Operation Fails
	// -------------------------------------------------------------
	describe('2. Transaction Rollback on Failure', () => {
		it('should abort transaction and rollback changes when unit creation fails in donation', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save

			DonateRequests.findOne = async () => ({
				_id: requestId,
				bloodbankId,
				status: 'Accepted',
				bloodType: 'B_Positive',
			})

			DonateRequests.findOneAndUpdate = async () => ({
				_id: requestId,
				status: 'Fulfilled',
			})

			BloodUnit.findOne = async () => null

			BloodUnit.prototype.save = async function () {
				throw new Error('Database disk write failure during unit creation')
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId, bloodType: 'B_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.match(res.responseData.message, /Transaction rolled back/)

				// Crucial: Transaction MUST have aborted and MUST NOT have committed
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

		it('should abort transaction and not commit stock decrement when receive request update fails', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = ReceiveRequests.findOne
			const originalCheckAvailability = bloodStockController.checkAvailability
			const originalDecreaseStock = bloodStockController.decreaseStock
			const originalFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			ReceiveRequests.findOne = async () => ({
				_id: requestId,
				bloodbankId,
				status: 'Accepted',
				bloodType: 'AB_Positive',
				unit: 1,
			})

			bloodStockController.checkAvailability = async () => true
			bloodStockController.decreaseStock = async () => ({ AB_Positive: 3 })

			// Simulate request update crash / write conflict (returns null)
			ReceiveRequests.findOneAndUpdate = async () => null

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId, bloodType: 'AB_Positive', unit: 1 },
				})

				await receiveController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /conflict/)

				// In a transaction, failure aborts the session, naturally rolling back the stock decrement
				assert.strictEqual(mockSession.isAborted, true)
				assert.strictEqual(mockSession.isCommitted, false)
				assert.strictEqual(mockSession.isEnded, true)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalFindOne
				bloodStockController.checkAvailability = originalCheckAvailability
				bloodStockController.decreaseStock = originalDecreaseStock
				ReceiveRequests.findOneAndUpdate = originalFindOneAndUpdate
			}
		})
	})

	// -------------------------------------------------------------
	// 3. Insufficient Stock Handling
	// -------------------------------------------------------------
	describe('3. Insufficient Stock Prevention', () => {
		it('should abort transaction and leave database untouched if stock is insufficient', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = ReceiveRequests.findOne
			const originalCheckAvailability = bloodStockController.checkAvailability
			const originalDecreaseStock = bloodStockController.decreaseStock
			const originalFindOneAndUpdate = ReceiveRequests.findOneAndUpdate

			let decreaseCalled = false

			ReceiveRequests.findOne = async () => ({
				_id: requestId,
				bloodbankId,
				status: 'Accepted',
				bloodType: 'O_Negative',
				unit: 5,
			})

			bloodStockController.checkAvailability = async () => false // Insufficient stock
			bloodStockController.decreaseStock = async () => {
				decreaseCalled = true
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId, bloodType: 'O_Negative', unit: 5 },
				})

				await receiveController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Insufficient stock/)

				// Stock decrement must not even be attempted
				assert.strictEqual(decreaseCalled, false)
				assert.strictEqual(mockSession.isAborted, true)
				assert.strictEqual(mockSession.isCommitted, false)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalFindOne
				bloodStockController.checkAvailability = originalCheckAvailability
				bloodStockController.decreaseStock = originalDecreaseStock
				ReceiveRequests.findOneAndUpdate = originalFindOneAndUpdate
			}
		})
	})

	// -------------------------------------------------------------
	// 4. Repeated Fulfillment & Duplicate Stock Prevention
	// -------------------------------------------------------------
	describe('4. Repeated Fulfillment Protection', () => {
		it('should reject already Fulfilled donation request and abort without modifying stock', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = DonateRequests.findOne
			const originalIncreaseStock = bloodStockController.increaseStock

			let increaseStockCalled = false

			DonateRequests.findOne = async () => ({
				_id: requestId,
				bloodbankId,
				status: 'Fulfilled', // Already fulfilled
				bloodType: 'A_Positive',
			})

			bloodStockController.increaseStock = async () => {
				increaseStockCalled = true
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already been fulfilled/)
				assert.strictEqual(increaseStockCalled, false)
				assert.strictEqual(mockSession.isAborted, true)
				assert.strictEqual(mockSession.isCommitted, false)
			} finally {
				mongoose.startSession = originalStartSession
				DonateRequests.findOne = originalFindOne
				bloodStockController.increaseStock = originalIncreaseStock
			}
		})

		it('should reject already Fulfilled receive request and abort without deducting stock', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = ReceiveRequests.findOne
			const originalDecreaseStock = bloodStockController.decreaseStock

			let decreaseStockCalled = false

			ReceiveRequests.findOne = async () => ({
				_id: requestId,
				bloodbankId,
				status: 'Fulfilled', // Already fulfilled
				bloodType: 'B_Positive',
				unit: 2,
			})

			bloodStockController.decreaseStock = async () => {
				decreaseStockCalled = true
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId },
				})

				await receiveController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already been fulfilled/)
				assert.strictEqual(decreaseStockCalled, false)
				assert.strictEqual(mockSession.isAborted, true)
				assert.strictEqual(mockSession.isCommitted, false)
			} finally {
				mongoose.startSession = originalStartSession
				ReceiveRequests.findOne = originalFindOne
				bloodStockController.decreaseStock = originalDecreaseStock
			}
		})
	})

	// -------------------------------------------------------------
	// 5. MongoDB Topology Compatibility & Standalone Fallback
	// -------------------------------------------------------------
	describe('5. Topology Detection and Compatibility', () => {
		it('should accurately detect standalone vs replica set topologies in canUseTransactions', () => {
			// Save current state
			const originalConnection = mongoose.connection

			// Case 1: Disconnected
			const disconnectedMock = { readyState: 0 }
			Object.defineProperty(mongoose, 'connection', {
				value: disconnectedMock,
				configurable: true,
			})
			assert.strictEqual(canUseTransactions(), false)

			// Case 2: Standalone 'Single' topology
			const standaloneMock = {
				readyState: 1,
				client: {
					topology: {
						description: { type: 'Single' },
					},
				},
			}
			Object.defineProperty(mongoose, 'connection', {
				value: standaloneMock,
				configurable: true,
			})
			assert.strictEqual(canUseTransactions(), false)

			// Case 3: ReplicaSet topology (e.g. MongoDB Atlas)
			const replicaSetMock = {
				readyState: 1,
				client: {
					topology: {
						description: { type: 'ReplicaSetWithPrimary' },
					},
				},
			}
			Object.defineProperty(mongoose, 'connection', {
				value: replicaSetMock,
				configurable: true,
			})
			assert.strictEqual(canUseTransactions(), true)

			// Case 4: Sharded cluster topology
			const shardedMock = {
				readyState: 1,
				client: {
					topology: {
						description: { type: 'Sharded' },
					},
				},
			}
			Object.defineProperty(mongoose, 'connection', {
				value: shardedMock,
				configurable: true,
			})
			assert.strictEqual(canUseTransactions(), true)

			// Restore
			Object.defineProperty(mongoose, 'connection', {
				value: originalConnection,
				configurable: true,
			})
		})

		it('should safely execute fallback in withTransaction when running on standalone deployment in non-production', async () => {
			const originalConnection = mongoose.connection
			const originalEnv = process.env.NODE_ENV
			process.env.NODE_ENV = 'development'

			const standaloneMock = {
				readyState: 1,
				client: {
					topology: {
						description: { type: 'Single' },
					},
				},
			}
			Object.defineProperty(mongoose, 'connection', {
				value: standaloneMock,
				configurable: true,
			})

			try {
				let executed = false
				const result = await withTransaction(async (session) => {
					executed = true
					assert.strictEqual(session, null, 'Standalone deployment must pass null session in dev')
					return 'fallback-success'
				})

				assert.strictEqual(executed, true)
				assert.strictEqual(result, 'fallback-success')
			} finally {
				process.env.NODE_ENV = originalEnv
				Object.defineProperty(mongoose, 'connection', {
					value: originalConnection,
					configurable: true,
				})
			}
		})

		it('should fail-closed in production if topology is standalone (Single), rejecting before executing work callback', async () => {
			const originalConnection = mongoose.connection
			const standaloneMock = {
				readyState: 1,
				client: {
					topology: {
						description: { type: 'Single' },
					},
				},
			}
			Object.defineProperty(mongoose, 'connection', {
				value: standaloneMock,
				configurable: true,
			})

			let callbackExecuted = false
			try {
				await withTransaction(
					async () => {
						callbackExecuted = true
					},
					{ isProduction: true }
				)
				assert.fail('Should have thrown an error in production for standalone topology')
			} catch (err) {
				assert.strictEqual(err.statusCode, 500)
				assert.match(
					err.message,
					/Production deployment requires a MongoDB Replica Set or Sharded Cluster/
				)
				assert.strictEqual(
					callbackExecuted,
					false,
					'Work callback must not execute when transactions are unsupported in production'
				)
			} finally {
				Object.defineProperty(mongoose, 'connection', {
					value: originalConnection,
					configurable: true,
				})
			}
		})

		it('should fail-closed in production if connection is disconnected, rejecting before executing work callback', async () => {
			const originalConnection = mongoose.connection
			const disconnectedMock = { readyState: 0 }
			Object.defineProperty(mongoose, 'connection', {
				value: disconnectedMock,
				configurable: true,
			})

			let callbackExecuted = false
			try {
				await withTransaction(
					async () => {
						callbackExecuted = true
					},
					{ isProduction: true }
				)
				assert.fail('Should have thrown in production when disconnected')
			} catch (err) {
				assert.strictEqual(err.statusCode, 500)
				assert.match(err.message, /Production deployment requires a MongoDB Replica Set/)
				assert.strictEqual(
					callbackExecuted,
					false,
					'Work callback must not execute when disconnected in production'
				)
			} finally {
				Object.defineProperty(mongoose, 'connection', {
					value: originalConnection,
					configurable: true,
				})
			}
		})

		it('should execute inside transaction in production when replica set topology is active', async () => {
			const originalConnection = mongoose.connection
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const replicaSetMock = {
				readyState: 1,
				client: {
					topology: {
						description: { type: 'ReplicaSetWithPrimary' },
					},
				},
			}
			Object.defineProperty(mongoose, 'connection', {
				value: replicaSetMock,
				configurable: true,
			})

			try {
				let sessionPassed = null
				const result = await withTransaction(
					async (session) => {
						sessionPassed = session
						return 'prod-txn-success'
					},
					{ isProduction: true }
				)

				assert.strictEqual(result, 'prod-txn-success')
				assert.strictEqual(sessionPassed, mockSession)
				assert.strictEqual(mockSession.isCommitted, true)
				assert.strictEqual(mockSession.isEnded, true)
			} finally {
				mongoose.startSession = originalStartSession
				Object.defineProperty(mongoose, 'connection', {
					value: originalConnection,
					configurable: true,
				})
			}
		})

		it('should fail-closed through donation controller in production on standalone deployment', async () => {
			const originalConnection = mongoose.connection
			const originalEnv = process.env.NODE_ENV
			process.env.NODE_ENV = 'production'

			const standaloneMock = {
				readyState: 1,
				client: {
					topology: {
						description: { type: 'Single' },
					},
				},
			}
			Object.defineProperty(mongoose, 'connection', {
				value: standaloneMock,
				configurable: true,
			})

			let findCalled = false
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async () => {
				findCalled = true
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId, bloodType: 'A_Positive' },
				})

				await donateController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.match(res.responseData.message, /Production deployment requires a MongoDB Replica Set/)
				assert.strictEqual(
					findCalled,
					false,
					'Database operation must not be reached when fail-closed in production'
				)
			} finally {
				process.env.NODE_ENV = originalEnv
				DonateRequests.findOne = originalFindOne
				Object.defineProperty(mongoose, 'connection', {
					value: originalConnection,
					configurable: true,
				})
			}
		})

		it('should fail-closed through receive controller in production on standalone deployment', async () => {
			const originalConnection = mongoose.connection
			const originalEnv = process.env.NODE_ENV
			process.env.NODE_ENV = 'production'

			const standaloneMock = {
				readyState: 1,
				client: {
					topology: {
						description: { type: 'Single' },
					},
				},
			}
			Object.defineProperty(mongoose, 'connection', {
				value: standaloneMock,
				configurable: true,
			})

			let findCalled = false
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async () => {
				findCalled = true
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					body: { id: requestId, bloodType: 'B_Positive', unit: 2 },
				})

				await receiveController.fulfilledRequest(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.match(res.responseData.message, /Production deployment requires a MongoDB Replica Set/)
				assert.strictEqual(
					findCalled,
					false,
					'Database operation must not be reached when fail-closed in production'
				)
			} finally {
				process.env.NODE_ENV = originalEnv
				ReceiveRequests.findOne = originalFindOne
				Object.defineProperty(mongoose, 'connection', {
					value: originalConnection,
					configurable: true,
				})
			}
		})
	})
})
