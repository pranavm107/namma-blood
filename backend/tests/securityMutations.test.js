const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

// Controllers and models under test
const donateController = require('../BloodDonate/bloodDonateController')
const receiveController = require('../BloodReceive/bloodReceiveController')
const DonateRequests = require('../BloodDonate/bloodDonateModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const bloodStockController = require('../BloodStock/bloodStockController')
const Bloodstock = require('../BloodStock/bloodStockModel')
const { BloodUnit } = require('../BloodUnit/bloodUnitModel')

// Helper to mock req, res, next
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

describe('Blood Donation & Receive Handlers Security Hardening', () => {
	const userA = { _id: new mongoose.Types.ObjectId().toString() }
	const userB = { _id: new mongoose.Types.ObjectId().toString() }
	const bloodbankA = { _id: new mongoose.Types.ObjectId().toString() }
	const bloodbankB = { _id: new mongoose.Types.ObjectId().toString() }
	const validRequestId = new mongoose.Types.ObjectId().toString()

	// -------------------------------------------------------------
	// 1. Cross-User Access Tests
	// -------------------------------------------------------------
	describe('1. Cross-User Access Control', () => {
		it('should forbid User B from editing User A\'s donation request (returns 404, no data leak)', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async (query) => {
				assert.strictEqual(query.userId, userB._id)
				assert.strictEqual(query._id, validRequestId)
				return null // Request not owned by userB
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: userB,
					body: { id: validRequestId, bloodType: 'O_Positive' },
				})
				await donateController.editDonateRequest(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should forbid User B from cancelling User A\'s donation request (returns 404, no data leak)', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async (query) => {
				assert.strictEqual(query.userId, userB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: userB,
					body: { id: validRequestId, message: 'I want to cancel' },
				})
				await donateController.rejectRequestByUser(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should forbid User B from editing User A\'s receive request (returns 404, no data leak)', async () => {
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async (query) => {
				assert.strictEqual(query.userId, userB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: userB,
					body: { id: validRequestId, unit: 2 },
				})
				await receiveController.editReceiveRequest(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				ReceiveRequests.findOne = originalFindOne
			}
		})

		it('should forbid User B from cancelling User A\'s receive request (returns 404, no data leak)', async () => {
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async (query) => {
				assert.strictEqual(query.userId, userB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: userB,
					body: { id: validRequestId, message: 'Cancel please' },
				})
				await receiveController.rejectRequestByUser(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				ReceiveRequests.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 2. Cross-Blood-Bank Access Tests
	// -------------------------------------------------------------
	describe('2. Cross-Blood-Bank Access Control', () => {
		it('should forbid Blood Bank B from accepting Blood Bank A\'s donation request (returns 404)', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, bloodbankB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankB,
					body: { id: validRequestId },
				})
				await donateController.acceptRequest(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should forbid Blood Bank B from rejecting Blood Bank A\'s donation request (returns 404)', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, bloodbankB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankB,
					body: { id: validRequestId, message: 'Reject' },
				})
				await donateController.rejectRequest(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should forbid Blood Bank B from fulfilling Blood Bank A\'s donation request (returns 404)', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, bloodbankB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankB,
					body: { id: validRequestId, bloodType: 'O_Positive' },
				})
				await donateController.fulfilledRequest(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should forbid Blood Bank B from accepting Blood Bank A\'s receive request (returns 404)', async () => {
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, bloodbankB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankB,
					body: { id: validRequestId },
				})
				await receiveController.acceptRequest(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				ReceiveRequests.findOne = originalFindOne
			}
		})

		it('should forbid Blood Bank B from rejecting Blood Bank A\'s receive request (returns 404)', async () => {
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, bloodbankB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankB,
					body: { id: validRequestId, message: 'Reject' },
				})
				await receiveController.rejectRequest(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				ReceiveRequests.findOne = originalFindOne
			}
		})

		it('should forbid Blood Bank B from fulfilling Blood Bank A\'s receive request (returns 404)', async () => {
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, bloodbankB._id)
				assert.strictEqual(query._id, validRequestId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankB,
					body: { id: validRequestId },
				})
				await receiveController.fulfilledRequest(req, res, next)
				assert.strictEqual(res.statusCode, 404)
				assert.strictEqual(res.responseData.message, 'Request not found.')
			} finally {
				ReceiveRequests.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 3. Status Transition Validations
	// -------------------------------------------------------------
	describe('3. Status Transition Enforcement', () => {
		it('should reject accepting an already Accepted or Fulfilled donation request', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Accepted',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId },
				})
				await donateController.acceptRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Only Pending requests can be accepted/)
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should prevent rejecting an already Fulfilled donation request', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Fulfilled',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId },
				})
				await donateController.rejectRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot reject an already fulfilled/)
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should prevent editing a non-pending donation request by user', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async () => ({
				_id: validRequestId,
				userId: userA._id,
				status: 'Accepted',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: userA,
					body: { id: validRequestId, bloodType: 'B_Positive' },
				})
				await donateController.editDonateRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Only Pending requests can be edited/)
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should prevent cancelling an already Fulfilled donation request by user', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async () => ({
				_id: validRequestId,
				userId: userA._id,
				status: 'Fulfilled',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: userA,
					body: { id: validRequestId },
				})
				await donateController.rejectRequestByUser(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot cancel an already fulfilled/)
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should prevent accepting an already Accepted receive request', async () => {
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Accepted',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId },
				})
				await receiveController.acceptRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Only Pending requests can be accepted/)
			} finally {
				ReceiveRequests.findOne = originalFindOne
			}
		})

		it('should prevent rejecting an already Fulfilled receive request', async () => {
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Fulfilled',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId },
				})
				await receiveController.rejectRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot reject an already fulfilled/)
			} finally {
				ReceiveRequests.findOne = originalFindOne
			}
		})

		it('should prevent editing a non-pending receive request by user', async () => {
			const originalFindOne = ReceiveRequests.findOne
			ReceiveRequests.findOne = async () => ({
				_id: validRequestId,
				userId: userA._id,
				status: 'Accepted',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: userA,
					body: { id: validRequestId, unit: 3 },
				})
				await receiveController.editReceiveRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Only Pending requests can be edited/)
			} finally {
				ReceiveRequests.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 4. Repeated Fulfillment & Stock Consistency
	// -------------------------------------------------------------
	describe('4. Repeated Fulfillment and Stock Consistency', () => {
		it('should block repeated fulfillment on already Fulfilled donation request and not increment stock', async () => {
			let stockIncrements = 0
			const originalFindOne = DonateRequests.findOne
			const originalIncreaseStock = bloodStockController.increaseStock

			DonateRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Fulfilled',
				bloodType: 'A_Positive',
			})
			bloodStockController.increaseStock = async () => {
				stockIncrements++
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId },
				})
				await donateController.fulfilledRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already been fulfilled/)
				assert.strictEqual(stockIncrements, 0, 'Stock must not be incremented on duplicate fulfill')
			} finally {
				DonateRequests.findOne = originalFindOne
				bloodStockController.increaseStock = originalIncreaseStock
			}
		})

		it('should rollback donation request status if unit creation fails', async () => {
			let rolledBackTo = null
			const originalFindOne = DonateRequests.findOne
			const originalFindOneAndUpdate = DonateRequests.findOneAndUpdate
			const originalFindByIdAndUpdate = DonateRequests.findByIdAndUpdate
			const originalUnitFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save

			DonateRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Accepted',
				bloodType: 'O_Positive',
			})

			DonateRequests.findOneAndUpdate = async () => ({
				_id: validRequestId,
				status: 'Fulfilled',
			})

			DonateRequests.findByIdAndUpdate = async (id, update) => {
				rolledBackTo = update.status
				return {}
			}

			BloodUnit.findOne = async () => null

			BloodUnit.prototype.save = async function () {
				throw new Error('Database write failure during unit creation')
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId, bloodType: 'O_Positive' },
				})
				await donateController.fulfilledRequest(req, res, next)
				assert.strictEqual(res.statusCode, 500)
				assert.strictEqual(rolledBackTo, 'Accepted', 'Request status must be rolled back on unit failure')
			} finally {
				DonateRequests.findOne = originalFindOne
				DonateRequests.findOneAndUpdate = originalFindOneAndUpdate
				DonateRequests.findByIdAndUpdate = originalFindByIdAndUpdate
				BloodUnit.findOne = originalUnitFindOne
				BloodUnit.prototype.save = originalUnitSave
			}
		})

		it('should block repeated fulfillment on already Fulfilled receive request and not decrement stock', async () => {
			let stockDecrements = 0
			const originalFindOne = ReceiveRequests.findOne
			const originalDecreaseStock = bloodStockController.decreaseStock

			ReceiveRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Fulfilled',
				bloodType: 'B_Positive',
				unit: 1,
			})
			bloodStockController.decreaseStock = async () => {
				stockDecrements++
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId },
				})
				await receiveController.fulfilledRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already been fulfilled/)
				assert.strictEqual(stockDecrements, 0, 'Stock must not be decremented on duplicate fulfill')
			} finally {
				ReceiveRequests.findOne = originalFindOne
				bloodStockController.decreaseStock = originalDecreaseStock
			}
		})

		it('should prevent receive fulfillment when stock is insufficient', async () => {
			const originalFindOne = ReceiveRequests.findOne
			const originalCheckAvailability = bloodStockController.checkAvailability

			ReceiveRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Accepted',
				bloodType: 'AB_Negative',
				unit: 5,
			})
			bloodStockController.checkAvailability = async () => false // Insufficient stock

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId },
				})
				await receiveController.fulfilledRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Insufficient stock/)
			} finally {
				ReceiveRequests.findOne = originalFindOne
				bloodStockController.checkAvailability = originalCheckAvailability
			}
		})

		it('should restore decremented stock if concurrent conflict occurs when fulfilling receive request', async () => {
			let reimbursedUnits = 0
			const originalFindOne = ReceiveRequests.findOne
			const originalCheckAvailability = bloodStockController.checkAvailability
			const originalDecreaseStock = bloodStockController.decreaseStock
			const originalFindOneAndUpdate = ReceiveRequests.findOneAndUpdate
			const originalIncreaseStock = bloodStockController.increaseStock

			ReceiveRequests.findOne = async () => ({
				_id: validRequestId,
				bloodbankId: bloodbankA._id,
				status: 'Accepted',
				bloodType: 'O_Negative',
				unit: 2,
			})
			bloodStockController.checkAvailability = async () => true
			bloodStockController.decreaseStock = async () => ({})
			// Simulate conflict where another process fulfilled it in the interim
			ReceiveRequests.findOneAndUpdate = async () => null
			bloodStockController.increaseStock = async (bbId, bType, units) => {
				reimbursedUnits = units
				return {}
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankA,
					body: { id: validRequestId },
				})
				await receiveController.fulfilledRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.strictEqual(reimbursedUnits, 2, 'Decremented stock must be reimbursed if update conflicts')
			} finally {
				ReceiveRequests.findOne = originalFindOne
				bloodStockController.checkAvailability = originalCheckAvailability
				bloodStockController.decreaseStock = originalDecreaseStock
				ReceiveRequests.findOneAndUpdate = originalFindOneAndUpdate
				bloodStockController.increaseStock = originalIncreaseStock
			}
		})
	})

	// -------------------------------------------------------------
	// 5. Input Validation Tests
	// -------------------------------------------------------------
	describe('5. Input Validation', () => {
		it('should reject invalid ObjectId format for request ID', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankA,
				body: { id: 'invalid-non-object-id' },
			})
			await donateController.acceptRequest(req, res, next)
			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Valid request ID is required/)
		})

		it('should reject invalid blood type during donation edit', async () => {
			const originalFindOne = DonateRequests.findOne
			DonateRequests.findOne = async () => ({
				_id: validRequestId,
				userId: userA._id,
				status: 'Pending',
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: userA,
					body: { id: validRequestId, bloodType: 'INVALID_TYPE' },
				})
				await donateController.editDonateRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Invalid blood type/)
			} finally {
				DonateRequests.findOne = originalFindOne
			}
		})

		it('should reject non-positive unit count for receive request creation', async () => {
			const { req, res, next } = createMockReqRes({
				user: userA,
				body: {
					bloodbankId: bloodbankA._id,
					bloodType: 'O_Positive',
					unit: -5,
					whenDoYouWant: new Date(),
				},
			})
			const originalFindById = Bloodbank.findById
			Bloodbank.findById = async () => ({ _id: bloodbankA._id })

			try {
				await receiveController.addRequest(req, res, next)
				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /positive integer of at least 1/)
			} finally {
				Bloodbank.findById = originalFindById
			}
		})
	})
})
