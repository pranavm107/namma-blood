const { describe, it, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const {
	discardBloodUnits,
	processClinicallyExpiredInventory,
	VALID_DISCARD_REASONS,
} = require('../BloodUnit/discardService')
const { reserveUnitsForRequest } = require('../BloodUnit/reservationService')
const { issueUnitsForRequest } = require('../BloodUnit/issuanceService')

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

describe('Phase 3.6 — Expiry, Biohazard Discard & Audit Hardening', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId()
	const otherBloodbankId = new mongoose.Types.ObjectId()
	const mockStaffId = new mongoose.Types.ObjectId()
	const mockRequestId = new mongoose.Types.ObjectId()

	const originalStartSession = mongoose.startSession
	const originalUnitFind = BloodUnit.find
	const originalUnitFindOne = BloodUnit.findOne
	const originalReqFindOne = ReceiveRequests.findOne
	const originalReqFindOneAndUpdate = ReceiveRequests.findOneAndUpdate
	const originalAuditSave = BloodUnitAuditLog.prototype.save

	beforeEach(() => {
		mongoose.startSession = async () => createMockSession()
		mongoose.startSession._isMock = true
		BloodUnit.find = () => mockChainableFind([])
		BloodUnit.findOne = async () => null
		ReceiveRequests.findOne = async () => null
		ReceiveRequests.findOneAndUpdate = async () => ({})
		BloodUnitAuditLog.prototype.save = async function () {
			return this
		}
	})

	afterEach(() => {
		mongoose.startSession = originalStartSession
		BloodUnit.find = originalUnitFind
		BloodUnit.findOne = originalUnitFindOne
		ReceiveRequests.findOne = originalReqFindOne
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
			status: 'Available',
			expiryDate: new Date(now.getTime() + 30 * 24 * 3600 * 1000), // 30 days valid
			clearance: {
				isVerified: true,
				verifiedBy: new mongoose.Types.ObjectId(),
				verifiedAt: new Date(),
			},
			testing: {
				hiv: 'Non_Reactive',
				hbv: 'Non_Reactive',
				hcv: 'Non_Reactive',
				syphilis: 'Non_Reactive',
				malaria: 'Non_Reactive',
			},
			reservation: {
				receiveRequestId: null,
				reservedAt: null,
				reservedExpiresAt: null,
			},
			discard: {
				reason: '',
				discardedAt: null,
				discardedBy: null,
				discardedByStaffId: null,
				wasteManifestNumber: '',
				discardNotes: '',
			},
			save: async function () {
				return this
			},
			...overrides,
		}
		return unit
	}

	// =========================================================================
	// 1. Expired-Unit Reservation & Issuance Prevention
	// =========================================================================
	describe('1. Expired-Unit Reservation & Issuance Prevention', () => {
		it('should reject reserving a clinically expired blood unit (400)', async () => {
			const now = new Date()
			const expiredUnit = createUnitDoc({
				expiryDate: new Date(now.getTime() - 24 * 3600 * 1000), // expired yesterday
			})

			ReceiveRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				unit: 1,
				bloodType: 'O_Positive',
				status: 'Accepted',
				reservedUnitIds: [],
				save: async function () {
					return this
				},
			})

			// findEligibleUnitsFEFO will filter out expired units
			BloodUnit.find = () => mockChainableFind([]) // none available because unit is expired

			await assert.rejects(
				async () => {
					await reserveUnitsForRequest({
						requestId: mockRequestId,
						bloodbankId: mockBloodbankId,
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Insufficient verified, issue-eligible units available/i,
				}
			)
		})

		it('should reject issuing a unit whose clinical expiry date has elapsed (400)', async () => {
			const now = new Date()
			const expiredReservedUnit = createUnitDoc({
				status: 'Reserved',
				expiryDate: new Date(now.getTime() - 10 * 60 * 1000), // expired 10m ago
				reservation: {
					receiveRequestId: mockRequestId,
					reservedAt: new Date(now.getTime() - 2 * 3600 * 1000),
					reservedExpiresAt: new Date(now.getTime() + 10 * 60 * 1000),
				},
			})

			ReceiveRequests.findOne = async () => ({
				_id: mockRequestId,
				bloodbankId: mockBloodbankId,
				unit: 1,
				status: 'Accepted',
				reservedUnitIds: [expiredReservedUnit._id],
			})

			BloodUnit.find = () => mockChainableFind([expiredReservedUnit])

			await assert.rejects(
				async () => {
					await issueUnitsForRequest({
						requestId: mockRequestId,
						bloodbankId: mockBloodbankId,
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Clinical safety violation: Unit '.*' has expired clinically/i,
				}
			)
		})
	})

	// =========================================================================
	// 2. Authorized Discard Workflow
	// =========================================================================
	describe('2. Authorized Discard Workflow', () => {
		it('should successfully discard an Available unit with valid reason and record audit event', async () => {
			const unit = createUnitDoc({ status: 'Available' })
			BloodUnit.find = () => mockChainableFind([unit])
			BloodUnit.findOne = async () => unit

			const auditEntries = []
			BloodUnitAuditLog.prototype.save = async function () {
				auditEntries.push(this)
				return this
			}

			const result = await discardBloodUnits({
				unitIds: [unit._id],
				bloodbankId: mockBloodbankId,
				reason: 'Temperature_Excursion',
				wasteManifestNumber: 'WM-2026-9901',
				notes: 'Refrigeration unit malfunction overnight.',
				actorId: mockBloodbankId,
				staffId: mockStaffId,
			})

			assert.strictEqual(result.success, true)
			assert.strictEqual(result.discardedCount, 1)
			assert.strictEqual(unit.status, 'Discarded')
			assert.strictEqual(unit.discard.reason, 'Temperature_Excursion')
			assert.strictEqual(unit.discard.wasteManifestNumber, 'WM-2026-9901')
			assert.strictEqual(unit.discard.discardedByStaffId.toString(), mockStaffId.toString())
			assert.ok(unit.discard.discardedAt instanceof Date)

			assert.strictEqual(auditEntries.length, 1)
			assert.strictEqual(auditEntries[0].action, 'UNIT_DISCARDED')
			assert.strictEqual(auditEntries[0].previousStatus, 'Available')
			assert.strictEqual(auditEntries[0].newStatus, 'Discarded')
			assert.strictEqual(auditEntries[0].actor.actorId.toString(), mockStaffId.toString())
		})

		it('should reject discard when reason is missing or invalid (400)', async () => {
			const unit = createUnitDoc()

			// Missing reason
			await assert.rejects(
				async () => {
					await discardBloodUnits({
						unitIds: [unit._id],
						bloodbankId: mockBloodbankId,
						reason: '',
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Discard reason is required and must be one of/i,
				}
			)

			// Invalid reason
			await assert.rejects(
				async () => {
					await discardBloodUnits({
						unitIds: [unit._id],
						bloodbankId: mockBloodbankId,
						reason: 'NotAValidReason',
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Discard reason is required and must be one of/i,
				}
			)
		})
	})

	// =========================================================================
	// 3. Duplicate Discard & State Machine Protection
	// =========================================================================
	describe('3. Duplicate Discard & State Machine Protection', () => {
		it('should reject attempting to discard an already Discarded unit (duplicate discard guard) (400)', async () => {
			const alreadyDiscardedUnit = createUnitDoc({
				status: 'Discarded',
				discard: {
					reason: 'Expired',
					discardedAt: new Date(),
					wasteManifestNumber: 'WM-PREV-01',
				},
			})
			BloodUnit.find = () => mockChainableFind([alreadyDiscardedUnit])

			await assert.rejects(
				async () => {
					await discardBloodUnits({
						unitIds: [alreadyDiscardedUnit._id],
						bloodbankId: mockBloodbankId,
						reason: 'Expired',
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Unit has already been discarded.*Duplicate discard is rejected/i,
				}
			)
		})

		it('should reject attempting to discard an Issued or Dispatched unit (400)', async () => {
			const issuedUnit = createUnitDoc({ status: 'Issued' })
			BloodUnit.find = () => mockChainableFind([issuedUnit])

			await assert.rejects(
				async () => {
					await discardBloodUnits({
						unitIds: [issuedUnit._id],
						bloodbankId: mockBloodbankId,
						reason: 'Hemolysis',
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Unit is in status 'Issued'.*cannot be discarded from active inventory/i,
				}
			)
		})
	})

	// =========================================================================
	// 4. Reserved-Unit Discard & Request Decoupling
	// =========================================================================
	describe('4. Reserved-Unit Discard & Request Decoupling', () => {
		it('should pull unit reference from ReceiveRequests when a Reserved unit is discarded', async () => {
			const reservedUnit = createUnitDoc({
				status: 'Reserved',
				reservation: {
					receiveRequestId: mockRequestId,
					reservedAt: new Date(),
					reservedExpiresAt: new Date(Date.now() + 3600000),
				},
			})

			BloodUnit.find = () => mockChainableFind([reservedUnit])
			BloodUnit.findOne = async () => reservedUnit

			let pulledUnitId = null
			let scopedRequestId = null
			ReceiveRequests.findOneAndUpdate = async (filter, update) => {
				scopedRequestId = filter._id
				pulledUnitId = update.$pull.reservedUnitIds
				return { _id: filter._id, status: 'Accepted' }
			}

			const result = await discardBloodUnits({
				unitIds: [reservedUnit._id],
				bloodbankId: mockBloodbankId,
				reason: 'Clotted',
				actorId: mockBloodbankId,
			})

			assert.strictEqual(result.success, true)
			assert.strictEqual(reservedUnit.status, 'Discarded')
			assert.strictEqual(reservedUnit.reservation.receiveRequestId, null)
			assert.strictEqual(pulledUnitId.toString(), reservedUnit._id.toString())
			assert.strictEqual(scopedRequestId.toString(), mockRequestId.toString())
		})
	})

	// =========================================================================
	// 5. Tenant Isolation
	// =========================================================================
	describe('5. Tenant Isolation', () => {
		it('should forbid blood bank B from discarding blood bank A units (404/BOLA)', async () => {
			const unitBankA = createUnitDoc({ bloodbankId: mockBloodbankId })

			// Queried with otherBloodbankId
			BloodUnit.find = (filter) => {
				assert.strictEqual(filter.bloodbankId.toString(), otherBloodbankId.toString())
				return mockChainableFind([]) // Not found under tenant B
			}

			await assert.rejects(
				async () => {
					await discardBloodUnits({
						unitIds: [unitBankA._id],
						bloodbankId: otherBloodbankId,
						reason: 'Bag_Leakage',
						actorId: otherBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /No matching blood units found belonging to your blood bank/i,
				}
			)
		})
	})

	// =========================================================================
	// 6. Shelf-Life Expiry Processing & Idempotency
	// =========================================================================
	describe('6. Shelf-Life Expiry Processing & Idempotency', () => {
		it('should transition available units past shelf-life to Expired and remain idempotent', async () => {
			const now = new Date()
			const expiredAvailableUnit = createUnitDoc({
				status: 'Available',
				expiryDate: new Date(now.getTime() - 3600000), // expired 1h ago
			})

			BloodUnit.find = () => mockChainableFind([expiredAvailableUnit])
			BloodUnit.findOne = async () => expiredAvailableUnit

			const auditEntries = []
			BloodUnitAuditLog.prototype.save = async function () {
				auditEntries.push(this)
				return this
			}

			const result1 = await processClinicallyExpiredInventory({
				batchSize: 50,
				now,
				bloodbankId: mockBloodbankId,
			})

			assert.strictEqual(result1.success, true)
			assert.strictEqual(result1.processedCount, 1)
			assert.strictEqual(expiredAvailableUnit.status, 'Expired')
			assert.strictEqual(auditEntries.length, 1)
			assert.strictEqual(auditEntries[0].action, 'UNIT_EXPIRED')
			assert.strictEqual(auditEntries[0].previousStatus, 'Available')
			assert.strictEqual(auditEntries[0].newStatus, 'Expired')

			// Second run: no units left to expire
			BloodUnit.find = () => mockChainableFind([])
			const result2 = await processClinicallyExpiredInventory({
				batchSize: 50,
				now,
				bloodbankId: mockBloodbankId,
			})
			assert.strictEqual(result2.processedCount, 0)
			assert.strictEqual(result2.candidatesFound, 0)
		})
	})

	// =========================================================================
	// 7. Legacy Stock Isolation
	// =========================================================================
	describe('7. Legacy Stock Isolation', () => {
		it('should never decrement or mutate legacy aggregate Bloodstock during discard or expiry', async () => {
			const unit = createUnitDoc({ status: 'Available' })
			BloodUnit.find = () => mockChainableFind([unit])
			BloodUnit.findOne = async () => unit

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

			try {
				await discardBloodUnits({
					unitIds: [unit._id],
					bloodbankId: mockBloodbankId,
					reason: 'TTI_Reactive',
					actorId: mockBloodbankId,
				})
				assert.strictEqual(stockCalled, false, 'Legacy stock must never be touched during discard.')
			} finally {
				Bloodstock.findOne = originalStockFindOne
				Bloodstock.findOneAndUpdate = originalStockFindOneAndUpdate
			}
		})
	})

	// =========================================================================
	// 8. Transaction Rollback & Failure Recovery
	// =========================================================================
	describe('8. Transaction Rollback & Failure Recovery', () => {
		it('should rollback and preserve unit state when audit log failure occurs', async () => {
			const unit = createUnitDoc({ status: 'Quarantined' })
			BloodUnit.find = () => mockChainableFind([unit])
			BloodUnit.findOne = async () => unit

			BloodUnitAuditLog.prototype.save = async function () {
				throw new Error('Audit ledger disk write failure')
			}

			await assert.rejects(
				async () => {
					await discardBloodUnits({
						unitIds: [unit._id],
						bloodbankId: mockBloodbankId,
						reason: 'TTI_Reactive',
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Audit ledger disk write failure/,
				}
			)
		})
	})

	// =========================================================================
	// 9. Concurrency Conflict Protection
	// =========================================================================
	describe('9. Concurrency Conflict Protection', () => {
		it('should abort discard with conflict error (409) if unit status was concurrently modified', async () => {
			const unit = createUnitDoc({ status: 'Available' })
			BloodUnit.find = () => mockChainableFind([unit])

			// Simulate concurrent issuance or discard: findOne inside session returns null
			BloodUnit.findOne = async () => null

			await assert.rejects(
				async () => {
					await discardBloodUnits({
						unitIds: [unit._id],
						bloodbankId: mockBloodbankId,
						reason: 'Other',
						notes: 'Concurrent test',
						actorId: mockBloodbankId,
					})
				},
				{
					name: 'Error',
					message: /Concurrent modification conflict.*Discard aborted/i,
				}
			)
		})
	})
})
