const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const BloodbankStaff = require('../BloodBank/bloodbankStaffModel')
const bloodbank = require('../BloodBank/bloodbankModel')
const User = require('../User/userModel')
const {
	issueUnitsForRequest,
	recordCrossmatchForUnit,
	recordPhysicalDispatch,
} = require('../BloodUnit/issuanceService')
const { reserveUnitsForRequest } = require('../BloodUnit/reservationService')
const { processExpiredReservations } = require('../BloodUnit/reservationExpiryWorker')
const {
	discardBloodUnits,
	processClinicallyExpiredInventory,
} = require('../BloodUnit/discardService')
const reconciliationService = require('../BloodStock/reconciliationService')
const { InventoryReconciliationRecord } = require('../BloodStock/reconciliationModel')
const stockService = require('../BloodStock/stockService')
const { withTransaction, canUseTransactions } = require('../Utils/transactionHelper')


const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_test_rs0_issuance?replicaSet=rs0'

describe('Phase 3.4 — Real MongoDB Replica-Set (rs0) Integration Validation', () => {
	let connection
	let testBloodbankId
	let otherBloodbankId
	let testUserId
	let verifiedMOStaffId
	let unverifiedMOStaffId
	let labTechStaffId
	let mockCounter = 1

	function getNextDIN() {
		const padded = String(mockCounter++).padStart(5, '0')
		return `W000026${padded}`
	}

	before(async () => {
		// Robust Isolation & Production Protection Guards
		assert.notStrictEqual(
			process.env.NODE_ENV,
			'production',
			'SAFETY GUARD: Replica-set integration tests must never run with NODE_ENV=production.'
		)
		assert.match(
			TEST_DB_URI,
			/test/i,
			'SAFETY GUARD: TEST_MONGODB_URI must contain "test" to prevent touching production databases.'
		)
		assert.doesNotMatch(
			TEST_DB_URI,
			/cluster0.*mongodb\.net/i,
			'SAFETY GUARD: TEST_MONGODB_URI must never point to production Atlas cluster.'
		)

		console.log('\n--- Connecting to MongoDB Replica Set ---')
		await mongoose.connect(TEST_DB_URI, {
			serverSelectionTimeoutMS: 5000,
		})
		connection = mongoose.connection
		assert.strictEqual(connection.readyState, 1, 'MongoDB connection readyState must be 1 (connected).')
		assert.match(
			connection.db.databaseName,
			/test/i,
			'SAFETY GUARD: Connected database name must contain "test".'
		)

		// 1. Verify that the test MongoDB instance is an active replica set named 'rs0'
		const admin = connection.db.admin()
		const replStatus = await admin.command({ replSetGetStatus: 1 })
		assert.strictEqual(
			replStatus.set,
			'rs0',
			`Replica set name must be 'rs0' (found: '${replStatus.set}').`
		)
		assert.strictEqual(replStatus.ok, 1, 'replSetGetStatus must return ok: 1.')

		const primaryMember = replStatus.members.find((m) => m.state === 1)
		assert.ok(primaryMember, 'Replica set must have an active PRIMARY member.')
		console.log(`Verified Real Replica Set: name='${replStatus.set}', primary='${primaryMember.name}'`)

		// 2. Verify transaction helper detects replica set topology
		const txSupported = canUseTransactions()
		assert.strictEqual(
			txSupported,
			true,
			'canUseTransactions() must return true on live rs0 replica set.'
		)

		// Create shared test entities
		testBloodbankId = new mongoose.Types.ObjectId()
		otherBloodbankId = new mongoose.Types.ObjectId()
		testUserId = new mongoose.Types.ObjectId()
		verifiedMOStaffId = new mongoose.Types.ObjectId()
		unverifiedMOStaffId = new mongoose.Types.ObjectId()
		labTechStaffId = new mongoose.Types.ObjectId()

		await BloodUnit.deleteMany({})
		if (connection.db) {
			await connection.db.collection('bloodunitauditlogs').deleteMany({}).catch(() => {})
		}
		await ReceiveRequests.deleteMany({})
		await Bloodstock.deleteMany({})
	})

	after(async () => {
		if (connection && connection.readyState === 1) {
			await connection.db.dropDatabase()
			await mongoose.disconnect()
			console.log('--- Test Database Cleaned & Disconnected ---')
		}
	})

	beforeEach(async () => {
		await BloodUnit.deleteMany({})
		if (connection && connection.db) {
			await connection.db.collection('bloodunitauditlogs').deleteMany({}).catch(() => {})
			await connection.db.collection('inventoryreconciliations').deleteMany({}).catch(() => {})
		}
		await ReceiveRequests.deleteMany({})
		await Bloodstock.deleteMany({})
	})


	// Helper to seed a valid, clearance-verified, TTI-cleared reserved BloodUnit
	async function seedReservedUnit({
		bloodbankId = testBloodbankId,
		bloodGroup = 'A_Positive',
		status = 'Reserved',
		receiveRequestId = null,
		expiryDate = null,
		reservedExpiresAt = null,
		crossmatchResult = 'Pending',
		isClearanceVerified = true,
		testingStatus = 'Non_Reactive',
	} = {}) {
		const now = new Date()
		const unit = await BloodUnit.create({
			unitNumber: getNextDIN(),
			bloodbankId,
			bloodGroup,
			componentType: 'Whole_Blood',
			volumeMl: 450,
			collectionDate: new Date(now.getTime() - 2 * 24 * 3600 * 1000),
			expiryDate: expiryDate || new Date(now.getTime() + 30 * 24 * 3600 * 1000),
			status,
			testing: {
				hiv: testingStatus,
				hbv: testingStatus,
				hcv: testingStatus,
				syphilis: testingStatus,
				malaria: testingStatus,
				testedAt: new Date(now.getTime() - 24 * 3600 * 1000),
				testBatchId: 'BATCH-RS0-TEST',
			},
			clearance: {
				isVerified: isClearanceVerified,
				verifiedByStaffId: verifiedMOStaffId,
				verifiedAt: new Date(now.getTime() - 12 * 3600 * 1000),
				notes: 'Verified clearance for testing',
			},
			reservation: {
				receiveRequestId,
				reservedAt: new Date(now.getTime() - 1 * 3600 * 1000),
				reservedExpiresAt:
					reservedExpiresAt !== undefined
						? reservedExpiresAt
						: new Date(now.getTime() + 2 * 3600 * 1000), // active hold (2h)
			},
			issuance: {
				crossmatchResult,
				dispatch: {
					isDispatched: false,
				},
			},
		})
		return unit
	}

	// Helper to seed an Accepted receive request
	async function seedReceiveRequest({
		bloodbankId = testBloodbankId,
		bloodType = 'A_Positive',
		unitCount = 1,
		status = 'Accepted',
		reservedUnitIds = [],
	} = {}) {
		const request = await ReceiveRequests.create({
			userId: testUserId,
			bloodbankId,
			bloodType,
			unit: unitCount,
			status,
			whenDoYouWant: new Date(Date.now() + 24 * 3600 * 1000),
			message: 'Replica set test receive request',
			reservedUnitIds,
		})
		return request
	}

	// =========================================================================
	// Scenario 1: Successful issuance updates blood unit & receive request consistently
	// =========================================================================
	it('Scenario 1: Successful issuance updates the reserved blood unit and receive request consistently inside a multi-document transaction', async () => {
		const reservedUnit = await seedReservedUnit()
		const request = await seedReceiveRequest({
			reservedUnitIds: [reservedUnit._id],
		})
		// Link unit reservation to request
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// Seed aggregate Bloodstock to monitor isolation
		await Bloodstock.create({
			bloodbankId: testBloodbankId,
			A_Positive: 20,
		})

		const result = await withTransaction(async (session) => {
			return await issueUnitsForRequest({
				requestId: request._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				isMOVerified: true,
				recipientPatientName: 'Patient Alice',
				hospitalName: 'Apollo Speciality Hospital',
				crossmatchResult: 'Compatible',
				session,
			})
		})

		assert.strictEqual(result.issuedUnits.length, 1)
		assert.strictEqual(result.request.status, 'Fulfilled')

		// Read back from database to verify ACID persistence
		const freshUnit = await BloodUnit.findById(reservedUnit._id)
		assert.strictEqual(freshUnit.status, 'Issued')
		assert.strictEqual(freshUnit.issuance.crossmatchResult, 'Compatible')
		assert.strictEqual(freshUnit.issuance.recipientPatientName, 'Patient Alice')
		assert.strictEqual(freshUnit.issuance.hospitalName, 'Apollo Speciality Hospital')
		assert.strictEqual(freshUnit.issuance.issuedToReceiveRequestId.toString(), request._id.toString())
		assert.strictEqual(freshUnit.issuance.issuedByStaffId.toString(), verifiedMOStaffId.toString())
		assert.strictEqual(freshUnit.issuance.dispatch.isDispatched, false)

		const freshRequest = await ReceiveRequests.findById(request._id)
		assert.strictEqual(freshRequest.status, 'Fulfilled')
	})

	// =========================================================================
	// Scenario 2: Transaction failure rolls back all related writes
	// =========================================================================
	it('Scenario 2: A transaction failure rolls back all related writes across collections', async () => {
		const reservedUnit = await seedReservedUnit()
		const request = await seedReceiveRequest({
			reservedUnitIds: [reservedUnit._id],
		})
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// Attempt transaction that intentionally aborts after partial write
		let errorCaught = false
		try {
			await withTransaction(async (session) => {
				// Perform write 1 on BloodUnit
				await BloodUnit.findOneAndUpdate(
					{ _id: reservedUnit._id },
					{ $set: { status: 'Issued' } },
					{ session }
				)

				// Perform write 2 on ReceiveRequests
				await ReceiveRequests.findOneAndUpdate(
					{ _id: request._id },
					{ $set: { status: 'Fulfilled' } },
					{ session }
				)

				// Simulate unexpected crash / validation error before commit
				throw new Error('Simulated mid-transaction failure for rollback verification')
			})
		} catch (err) {
			errorCaught = true
			assert.match(err.message, /Simulated mid-transaction failure/)
		}
		assert.strictEqual(errorCaught, true)

		// Verify that NEITHER write was committed (ACID Atomicity)
		const freshUnit = await BloodUnit.findById(reservedUnit._id)
		assert.strictEqual(freshUnit.status, 'Reserved', 'BloodUnit must remain in Reserved status after rollback.')

		const freshRequest = await ReceiveRequests.findById(request._id)
		assert.strictEqual(freshRequest.status, 'Accepted', 'ReceiveRequest must remain in Accepted status after rollback.')
	})

	// =========================================================================
	// Scenario 3: Concurrent issuance attempts cannot issue the same unit twice
	// =========================================================================
	it('Scenario 3: Concurrent issuance attempts cannot issue the same unit twice (Write Conflict / Lock Protection)', async () => {
		const reservedUnit = await seedReservedUnit()
		const request = await seedReceiveRequest({
			reservedUnitIds: [reservedUnit._id],
		})
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// Launch two concurrent issuance calls simultaneously
		const promise1 = withTransaction(async (session) => {
			return await issueUnitsForRequest({
				requestId: request._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				isMOVerified: true,
				crossmatchResult: 'Compatible',
				session,
			})
		})

		const promise2 = withTransaction(async (session) => {
			return await issueUnitsForRequest({
				requestId: request._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				isMOVerified: true,
				crossmatchResult: 'Compatible',
				session,
			})
		})

		const results = await Promise.allSettled([promise1, promise2])
		const fulfilled = results.filter((r) => r.status === 'fulfilled')
		const rejected = results.filter((r) => r.status === 'rejected')

		assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent issuance must succeed.')
		assert.strictEqual(rejected.length, 1, 'Exactly one concurrent issuance must fail with a conflict.')
		assert.match(
			rejected[0].reason.message,
			/conflict|already.*fulfilled|modified/i,
			'Rejected call must cite concurrency conflict or fulfilled status.'
		)

		// Verify in DB that only one audit entry and unit is issued
		const freshUnit = await BloodUnit.findById(reservedUnit._id)
		assert.strictEqual(freshUnit.status, 'Issued')

		const auditEntries = await BloodUnitAuditLog.find({
			unitId: reservedUnit._id,
			action: 'UNIT_ISSUED',
		})
		assert.strictEqual(auditEntries.length, 1, 'Exactly one UNIT_ISSUED audit entry must exist.')
	})

	// =========================================================================
	// Scenario 4: Incompatible crossmatch blocks issuance and cannot be overwritten
	// =========================================================================
	it('Scenario 4: Incompatible crossmatch blocks issuance and cannot be overwritten', async () => {
		const reservedUnit = await seedReservedUnit({ crossmatchResult: 'Incompatible' })
		const request = await seedReceiveRequest({
			reservedUnitIds: [reservedUnit._id],
		})
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// Part A: Issuance must be rejected
		let issuanceRejected = false
		try {
			await withTransaction(async (session) => {
				await issueUnitsForRequest({
					requestId: request._id,
					bloodbankId: testBloodbankId,
					actorId: verifiedMOStaffId,
					staffId: verifiedMOStaffId,
					isMOVerified: true,
					crossmatchResult: 'Incompatible',
					session,
				})
			})
		} catch (err) {
			issuanceRejected = true
			assert.match(err.message, /Incompatible blood units can NEVER be issued/i)
		}
		assert.strictEqual(issuanceRejected, true)

		// Part B: Overwrite protection - Attempting to overwrite Incompatible to Compatible must fail
		let overwriteRejected = false
		try {
			await withTransaction(async (session) => {
				await recordCrossmatchForUnit({
					unitId: reservedUnit._id,
					receiveRequestId: request._id,
					bloodbankId: testBloodbankId,
					actorId: verifiedMOStaffId,
					crossmatchResult: 'Compatible',
					session,
				})
			})
		} catch (err) {
			overwriteRejected = true
			assert.match(err.message, /Failed crossmatch results cannot be overwritten/i)
		}
		assert.strictEqual(overwriteRejected, true)

		// Verify unit remains Incompatible and Reserved in database
		const freshUnit = await BloodUnit.findById(reservedUnit._id)
		assert.strictEqual(freshUnit.status, 'Reserved')
		assert.strictEqual(freshUnit.issuance.crossmatchResult, 'Incompatible')
	})

	// =========================================================================
	// Scenario 5: Emergency uncrossmatched issuance requires verified MO & valid reason
	// =========================================================================
	it('Scenario 5: Emergency uncrossmatched issuance requires authenticated, verified Medical Officer authorization and a valid emergency reason', async () => {
		const reservedUnit = await seedReservedUnit()
		const request = await seedReceiveRequest({
			reservedUnitIds: [reservedUnit._id],
		})
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// 1. Non-verified MO (isMOVerified: false) must be rejected with 403
		let unverifiedRejected = false
		try {
			await withTransaction(async (session) => {
				await issueUnitsForRequest({
					requestId: request._id,
					bloodbankId: testBloodbankId,
					actorId: labTechStaffId,
					staffId: labTechStaffId,
					isMOVerified: false,
					crossmatchResult: 'Emergency_Uncrossmatched',
					isEmergency: true,
					emergencyReason: 'Severe trauma resuscitation in progress',
					session,
				})
			})
		} catch (err) {
			unverifiedRejected = true
			assert.strictEqual(err.statusCode, 403)
			assert.match(err.message, /strictly requires authorization by a verified Medical Officer/i)
		}
		assert.strictEqual(unverifiedRejected, true)

		// 2. Verified MO with short/empty reason (< 10 chars) must be rejected with 400
		let reasonRejected = false
		try {
			await withTransaction(async (session) => {
				await issueUnitsForRequest({
					requestId: request._id,
					bloodbankId: testBloodbankId,
					actorId: verifiedMOStaffId,
					staffId: verifiedMOStaffId,
					isMOVerified: true,
					crossmatchResult: 'Emergency_Uncrossmatched',
					isEmergency: true,
					emergencyReason: 'Short', // only 5 chars
					session,
				})
			})
		} catch (err) {
			reasonRejected = true
			assert.strictEqual(err.statusCode, 400)
			assert.match(err.message, /requires clinical justification.*at least 10 characters/i)
		}
		assert.strictEqual(reasonRejected, true)

		// 3. Authorized emergency issuance with verified MO and valid justification must succeed
		const result = await withTransaction(async (session) => {
			return await issueUnitsForRequest({
				requestId: request._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				isMOVerified: true,
				crossmatchResult: 'Emergency_Uncrossmatched',
				isEmergency: true,
				emergencyReason: 'Acute massive gastrointestinal hemorrhage requiring emergent uncrossmatched transfusion',
				session,
			})
		})

		assert.strictEqual(result.issuedUnits.length, 1)
		const freshUnit = await BloodUnit.findById(reservedUnit._id)
		assert.strictEqual(freshUnit.status, 'Issued')
		assert.strictEqual(freshUnit.issuance.crossmatchResult, 'Emergency_Uncrossmatched')
		assert.strictEqual(freshUnit.issuance.emergency.isEmergency, true)
		assert.strictEqual(
			freshUnit.issuance.emergency.authorizedByStaffId.toString(),
			verifiedMOStaffId.toString()
		)
		assert.ok(freshUnit.issuance.emergency.authorizedAt instanceof Date)
	})

	// =========================================================================
	// Scenario 6: Expired units and expired reservation holds cannot be issued
	// =========================================================================
	it('Scenario 6: Expired units and expired reservation holds cannot be issued', async () => {
		const now = new Date()

		// 1. Clinically expired unit (shelf-life elapsed)
		const expiredUnit = await seedReservedUnit({
			expiryDate: new Date(now.getTime() - 3600 * 1000), // 1 hour ago
		})
		const request1 = await seedReceiveRequest({
			reservedUnitIds: [expiredUnit._id],
		})
		expiredUnit.reservation.receiveRequestId = request1._id
		await expiredUnit.save()

		let expiredShelfLifeRejected = false
		try {
			await withTransaction(async (session) => {
				await issueUnitsForRequest({
					requestId: request1._id,
					bloodbankId: testBloodbankId,
					actorId: verifiedMOStaffId,
					staffId: verifiedMOStaffId,
					isMOVerified: true,
					crossmatchResult: 'Compatible',
					session,
				})
			})
		} catch (err) {
			expiredShelfLifeRejected = true
			assert.strictEqual(err.statusCode, 400)
			assert.match(err.message, /has expired clinically/i)
		}
		assert.strictEqual(expiredShelfLifeRejected, true)

		// 2. Expired reservation hold (hold elapsed)
		const expiredHoldUnit = await seedReservedUnit({
			reservedExpiresAt: new Date(now.getTime() - 1800 * 1000), // hold expired 30m ago
		})
		const request2 = await seedReceiveRequest({
			reservedUnitIds: [expiredHoldUnit._id],
		})
		expiredHoldUnit.reservation.receiveRequestId = request2._id
		await expiredHoldUnit.save()

		let expiredHoldRejected = false
		try {
			await withTransaction(async (session) => {
				await issueUnitsForRequest({
					requestId: request2._id,
					bloodbankId: testBloodbankId,
					actorId: verifiedMOStaffId,
					staffId: verifiedMOStaffId,
					isMOVerified: true,
					crossmatchResult: 'Compatible',
					session,
				})
			})
		} catch (err) {
			expiredHoldRejected = true
			assert.strictEqual(err.statusCode, 400)
			assert.match(err.message, /Reservation hold expired/i)
		}
		assert.strictEqual(expiredHoldRejected, true)
	})

	// =========================================================================
	// Scenario 7: Wrong-tenant requests and units are rejected
	// =========================================================================
	it('Scenario 7: Wrong-tenant requests and units are rejected (BOLA & Tenant Scoping)', async () => {
		const reservedUnit = await seedReservedUnit({ bloodbankId: otherBloodbankId })
		const otherRequest = await seedReceiveRequest({
			bloodbankId: otherBloodbankId,
			reservedUnitIds: [reservedUnit._id],
		})

		// Blood Bank A tries to issue Blood Bank B's request: must return 404
		let bolaRejected = false
		try {
			await withTransaction(async (session) => {
				await issueUnitsForRequest({
					requestId: otherRequest._id,
					bloodbankId: testBloodbankId, // Wrong blood bank!
					actorId: verifiedMOStaffId,
					staffId: verifiedMOStaffId,
					isMOVerified: true,
					crossmatchResult: 'Compatible',
					session,
				})
			})
		} catch (err) {
			bolaRejected = true
			assert.strictEqual(err.statusCode, 404)
			assert.match(err.message, /Receive request not found or not owned/i)
		}
		assert.strictEqual(bolaRejected, true)

		// Unit reserved for Request A attempted to be issued under Request B
		const unitForRequestA = await seedReservedUnit({ bloodbankId: testBloodbankId })
		const requestA = await seedReceiveRequest({ reservedUnitIds: [unitForRequestA._id] })
		unitForRequestA.reservation.receiveRequestId = requestA._id
		await unitForRequestA.save()

		const requestB = await seedReceiveRequest({ reservedUnitIds: [unitForRequestA._id] })

		let wrongAssocRejected = false
		try {
			await withTransaction(async (session) => {
				await issueUnitsForRequest({
					requestId: requestB._id, // Wrong request!
					bloodbankId: testBloodbankId,
					actorId: verifiedMOStaffId,
					staffId: verifiedMOStaffId,
					isMOVerified: true,
					crossmatchResult: 'Compatible',
					session,
				})
			})
		} catch (err) {
			wrongAssocRejected = true
			assert.strictEqual(err.statusCode, 400)
			assert.match(err.message, /reserved for a different receive request/i)
		}
		assert.strictEqual(wrongAssocRejected, true)
	})

	// =========================================================================
	// Scenario 8: Dispatch is allowed only for issued units
	// =========================================================================
	it('Scenario 8: Dispatch is allowed only for issued units (status guard)', async () => {
		// 1. Reserved unit cannot be dispatched
		const reservedUnit = await seedReservedUnit()
		let reservedDispatchRejected = false
		try {
			await withTransaction(async (session) => {
				await recordPhysicalDispatch({
					unitIds: [reservedUnit._id],
					bloodbankId: testBloodbankId,
					actorId: labTechStaffId,
					staffId: labTechStaffId,
					session,
				})
			})
		} catch (err) {
			reservedDispatchRejected = true
			assert.strictEqual(err.statusCode, 400)
			assert.match(err.message, /Unit must be in 'Issued' status before physical dispatch/i)
		}
		assert.strictEqual(reservedDispatchRejected, true)

		// 2. Available unit cannot be dispatched
		const availableUnit = await seedReservedUnit({ status: 'Available' })
		let availableDispatchRejected = false
		try {
			await withTransaction(async (session) => {
				await recordPhysicalDispatch({
					unitIds: [availableUnit._id],
					bloodbankId: testBloodbankId,
					actorId: labTechStaffId,
					staffId: labTechStaffId,
					session,
				})
			})
		} catch (err) {
			availableDispatchRejected = true
			assert.strictEqual(err.statusCode, 400)
			assert.match(err.message, /Unit must be in 'Issued' status before physical dispatch/i)
		}
		assert.strictEqual(availableDispatchRejected, true)
	})

	// =========================================================================
	// Scenario 9: Duplicate concurrent dispatch attempts result in only one successful dispatch
	// =========================================================================
	it('Scenario 9: Duplicate concurrent dispatch attempts result in only one successful dispatch', async () => {
		// First, issue the unit
		const reservedUnit = await seedReservedUnit()
		const request = await seedReceiveRequest({ reservedUnitIds: [reservedUnit._id] })
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		await withTransaction(async (session) => {
			await issueUnitsForRequest({
				requestId: request._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				isMOVerified: true,
				crossmatchResult: 'Compatible',
				session,
			})
		})

		// Now attempt two concurrent physical dispatches
		const promise1 = withTransaction(async (session) => {
			return await recordPhysicalDispatch({
				unitIds: [reservedUnit._id],
				bloodbankId: testBloodbankId,
				actorId: labTechStaffId,
				staffId: labTechStaffId,
				dispatchedToRecipient: 'Nurse Sarah',
				transportBoxId: 'BOX-RS0-A',
				session,
			})
		})

		const promise2 = withTransaction(async (session) => {
			return await recordPhysicalDispatch({
				unitIds: [reservedUnit._id],
				bloodbankId: testBloodbankId,
				actorId: labTechStaffId,
				staffId: labTechStaffId,
				dispatchedToRecipient: 'Nurse Sarah',
				transportBoxId: 'BOX-RS0-A',
				session,
			})
		})

		const results = await Promise.allSettled([promise1, promise2])
		const fulfilled = results.filter((r) => r.status === 'fulfilled')
		const rejected = results.filter((r) => r.status === 'rejected')

		assert.strictEqual(fulfilled.length, 1, 'Exactly one concurrent dispatch must succeed.')
		assert.strictEqual(rejected.length, 1, 'Duplicate dispatch must be rejected.')

		// Subsequent sequential call must also fail
		let secondDispatchRejected = false
		try {
			await withTransaction(async (session) => {
				await recordPhysicalDispatch({
					unitIds: [reservedUnit._id],
					bloodbankId: testBloodbankId,
					actorId: labTechStaffId,
					staffId: labTechStaffId,
					session,
				})
			})
		} catch (err) {
			secondDispatchRejected = true
			assert.strictEqual(err.statusCode, 400)
			assert.match(err.message, /Duplicate dispatch is rejected/i)
		}
		assert.strictEqual(secondDispatchRejected, true)

		// Verify audit log has only one UNIT_DISPATCHED entry
		const dispatchAudits = await BloodUnitAuditLog.find({
			unitId: reservedUnit._id,
			action: 'UNIT_DISPATCHED',
		})
		assert.strictEqual(dispatchAudits.length, 1)
	})

	// =========================================================================
	// Scenario 10: Dispatch records the actual authenticated dispatcher & transport details
	// =========================================================================
	it('Scenario 10: Dispatch records the actual authenticated dispatcher and recipient/transport details', async () => {
		const reservedUnit = await seedReservedUnit()
		const request = await seedReceiveRequest({ reservedUnitIds: [reservedUnit._id] })
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// Unit issued by Medical Officer
		await withTransaction(async (session) => {
			await issueUnitsForRequest({
				requestId: request._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				isMOVerified: true,
				crossmatchResult: 'Compatible',
				session,
			})
		})

		// Unit physically dispatched by Lab Technician
		const dispatchResult = await withTransaction(async (session) => {
			return await recordPhysicalDispatch({
				unitIds: [reservedUnit._id],
				bloodbankId: testBloodbankId,
				actorId: labTechStaffId,
				staffId: labTechStaffId,
				dispatchedToRecipient: 'Ambulance Paramedic James',
				transportBoxId: 'COLD-CHAIN-99',
				dispatchNotes: 'Stored at 3.5 deg C with continuous data logger',
				session,
			})
		})

		assert.strictEqual(dispatchResult.dispatchedCount, 1)

		// Verify database records the actual dispatcher staff ID and not the issuing doctor
		const freshUnit = await BloodUnit.findById(reservedUnit._id)
		assert.strictEqual(freshUnit.issuance.dispatch.isDispatched, true)
		assert.strictEqual(
			freshUnit.issuance.dispatch.dispatchedByStaffId.toString(),
			labTechStaffId.toString(),
			'Dispatcher staff ID must match the actual dispatcher (Lab Technician), NOT the authorizing Medical Officer.'
		)
		assert.strictEqual(
			freshUnit.issuance.issuedByStaffId.toString(),
			verifiedMOStaffId.toString(),
			'Issuance authorizer must remain the Medical Officer.'
		)
		assert.strictEqual(
			freshUnit.issuance.dispatch.dispatchedToRecipient,
			'Ambulance Paramedic James'
		)
		assert.strictEqual(freshUnit.issuance.dispatch.transportBoxId, 'COLD-CHAIN-99')
		assert.strictEqual(
			freshUnit.issuance.dispatch.dispatchNotes,
			'Stored at 3.5 deg C with continuous data logger'
		)
	})

	// =========================================================================
	// Scenario 11: Audit events are persisted consistently with the state changes
	// =========================================================================
	it('Scenario 11: Audit events are persisted consistently with state changes and enforce immutability', async () => {
		const reservedUnit = await seedReservedUnit()
		const request = await seedReceiveRequest({ reservedUnitIds: [reservedUnit._id] })
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// 1. Issue unit
		await withTransaction(async (session) => {
			await issueUnitsForRequest({
				requestId: request._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				isMOVerified: true,
				crossmatchResult: 'Compatible',
				session,
			})
		})

		// 2. Dispatch unit
		await withTransaction(async (session) => {
			await recordPhysicalDispatch({
				unitIds: [reservedUnit._id],
				bloodbankId: testBloodbankId,
				actorId: labTechStaffId,
				staffId: labTechStaffId,
				dispatchedToRecipient: 'ICU Charge Nurse',
				transportBoxId: 'BOX-IMMUTABLE-01',
				session,
			})
		})

		// Verify audit logs in database
		const auditLogs = await BloodUnitAuditLog.find({ unitId: reservedUnit._id }).sort({ timestamp: 1 })
		const actions = auditLogs.map((l) => l.action)

		assert.ok(actions.includes('UNIT_ISSUED'), 'Audit log must contain UNIT_ISSUED event.')
		assert.ok(actions.includes('UNIT_DISPATCHED'), 'Audit log must contain UNIT_DISPATCHED event.')

		const issuedLog = auditLogs.find((l) => l.action === 'UNIT_ISSUED')
		assert.strictEqual(issuedLog.previousStatus, 'Reserved')
		assert.strictEqual(issuedLog.newStatus, 'Issued')
		assert.strictEqual(issuedLog.metadata.crossmatchResult, 'Compatible')

		const dispatchedLog = auditLogs.find((l) => l.action === 'UNIT_DISPATCHED')
		assert.strictEqual(dispatchedLog.previousStatus, 'Issued')
		assert.strictEqual(dispatchedLog.newStatus, 'Issued')
		assert.strictEqual(dispatchedLog.metadata.transportBoxId, 'BOX-IMMUTABLE-01')

		// Verify Immutability: Updating or deleting audit entries must be rejected by mongoose pre-hooks
		let updateBlocked = false
		try {
			await BloodUnitAuditLog.updateOne(
				{ _id: issuedLog._id },
				{ $set: { reason: 'Attempted audit tamper' } }
			)
		} catch (err) {
			updateBlocked = true
			assert.match(err.message, /append-only and cannot be modified/i)
		}
		assert.strictEqual(updateBlocked, true, 'Audit log update must be blocked by schema hook.')
	})

	// =========================================================================
	// Scenario 12: Traceable issuance never decrements legacy aggregate Bloodstock
	// =========================================================================
	it('Scenario 12: Traceable issuance never decrements legacy aggregate Bloodstock', async () => {
		const reservedUnit = await seedReservedUnit({ bloodGroup: 'O_Positive' })
		const request = await seedReceiveRequest({
			bloodType: 'O_Positive',
			unitCount: 1,
			reservedUnitIds: [reservedUnit._id],
		})
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// Seed legacy aggregate Bloodstock
		await Bloodstock.create({
			bloodbankId: testBloodbankId,
			O_Positive: 45,
			A_Positive: 20,
		})

		// Execute traceable issuance
		await withTransaction(async (session) => {
			await issueUnitsForRequest({
				requestId: request._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				isMOVerified: true,
				crossmatchResult: 'Compatible',
				session,
			})
		})

		// Query legacy Bloodstock: must remain untouched at exactly 45 and 20!
		const stockDoc = await Bloodstock.findOne({ bloodbankId: testBloodbankId })
		assert.strictEqual(
			stockDoc.O_Positive,
			45,
			'Legacy aggregate stock must NOT be decremented when traceable blood units are issued.'
		)
		assert.strictEqual(
			stockDoc.A_Positive,
			20,
			'Legacy aggregate stock for other types must remain intact.'
		)
	})

	// =========================================================================
	// Scenario 13: Reservation-Expiry Worker Atomic Release & ACID Isolation on rs0
	// =========================================================================
	it('Scenario 13: Automated Reservation-Expiry Worker safely releases expired units, pulls request refs, preserves lifecycle status, and enforces idempotency on live rs0', async () => {
		const now = new Date()

		// Unit 1: Hold expired (15m ago), clinical shelf-life valid (+20 days) -> returns to Available
		const expiredHoldUnit = await seedReservedUnit({
			reservedExpiresAt: new Date(now.getTime() - 15 * 60 * 1000),
			expiryDate: new Date(now.getTime() + 20 * 24 * 3600 * 1000),
		})

		// Unit 2: Hold expired (20m ago), clinical shelf-life elapsed (-1 day) -> transitions to Expired
		const expiredShelfLifeUnit = await seedReservedUnit({
			reservedExpiresAt: new Date(now.getTime() - 20 * 60 * 1000),
			expiryDate: new Date(now.getTime() - 24 * 3600 * 1000),
		})

		// Unit 3: Active hold (+2 hours) -> MUST remain Reserved
		const activeHoldUnit = await seedReservedUnit({
			reservedExpiresAt: new Date(now.getTime() + 2 * 3600 * 1000),
			expiryDate: new Date(now.getTime() + 25 * 24 * 3600 * 1000),
		})

		// Associated receive request containing Unit 1 and Active Unit 3
		const request = await seedReceiveRequest({
			unitCount: 2,
			status: 'Accepted',
			reservedUnitIds: [expiredHoldUnit._id, activeHoldUnit._id],
		})
		expiredHoldUnit.reservation.receiveRequestId = request._id
		await expiredHoldUnit.save()
		activeHoldUnit.reservation.receiveRequestId = request._id
		await activeHoldUnit.save()

		// Seed legacy aggregate Bloodstock to monitor isolation
		await Bloodstock.create({
			bloodbankId: testBloodbankId,
			A_Positive: 33,
		})

		// Execute worker against live replica set
		const workerResult = await processExpiredReservations({
			batchSize: 50,
			now,
			bloodbankId: testBloodbankId,
		})

		assert.strictEqual(workerResult.success, true)
		assert.strictEqual(workerResult.processedCount, 2)
		assert.strictEqual(workerResult.releasedToAvailableCount, 1)
		assert.strictEqual(workerResult.transitionedToExpiredCount, 1)
		assert.strictEqual(workerResult.skippedCount, 0)

		// 1. Check Unit 1: Available, reservation cleared, audit logged
		const freshUnit1 = await BloodUnit.findById(expiredHoldUnit._id)
		assert.strictEqual(freshUnit1.status, 'Available')
		assert.strictEqual(freshUnit1.reservation.receiveRequestId, null)
		assert.strictEqual(freshUnit1.reservation.reservedExpiresAt, null)

		const audit1 = await BloodUnitAuditLog.findOne({
			unitId: expiredHoldUnit._id,
			action: 'RESERVATION_EXPIRED',
		})
		assert.ok(audit1, 'RESERVATION_EXPIRED audit log must be recorded on live replica set.')
		assert.strictEqual(audit1.previousStatus, 'Reserved')
		assert.strictEqual(audit1.newStatus, 'Available')

		// 2. Check Unit 2: Expired, reservation cleared, audit logged
		const freshUnit2 = await BloodUnit.findById(expiredShelfLifeUnit._id)
		assert.strictEqual(freshUnit2.status, 'Expired')
		assert.strictEqual(freshUnit2.reservation.receiveRequestId, null)

		const audit2 = await BloodUnitAuditLog.findOne({
			unitId: expiredShelfLifeUnit._id,
			action: 'UNIT_EXPIRED',
		})
		assert.ok(audit2, 'UNIT_EXPIRED audit log must be recorded for shelf-life expired unit.')
		assert.strictEqual(audit2.previousStatus, 'Reserved')
		assert.strictEqual(audit2.newStatus, 'Expired')

		// 3. Check Active Unit 3: Still Reserved, hold intact
		const freshUnit3 = await BloodUnit.findById(activeHoldUnit._id)
		assert.strictEqual(freshUnit3.status, 'Reserved')
		assert.strictEqual(
			freshUnit3.reservation.receiveRequestId.toString(),
			request._id.toString()
		)

		// 4. Check ReceiveRequest: Unit 1 pulled from reservedUnitIds, Unit 3 remains, status remains Accepted
		const freshRequest = await ReceiveRequests.findById(request._id)
		assert.strictEqual(freshRequest.status, 'Accepted', 'Request status must not be cancelled or rejected.')
		assert.strictEqual(freshRequest.reservedUnitIds.length, 1)
		assert.strictEqual(freshRequest.reservedUnitIds[0].toString(), activeHoldUnit._id.toString())

		// 5. Check Legacy Stock: Untouched
		const stockDoc = await Bloodstock.findOne({ bloodbankId: testBloodbankId })
		assert.strictEqual(stockDoc.A_Positive, 33, 'Legacy Bloodstock must remain untouched.')

		// 6. Idempotency on rs0: Consecutive run finds 0 units
		const secondRun = await processExpiredReservations({
			batchSize: 50,
			now,
			bloodbankId: testBloodbankId,
		})
		assert.strictEqual(secondRun.processedCount, 0)
		assert.strictEqual(secondRun.candidatesFound, 0)
	})

	// =========================================================================
	// Scenario 14: Phase 3.6 Biohazard Discard & Shelf-Life Expiry on live rs0
	// =========================================================================
	it('Scenario 14: Authorized discard and shelf-life expiry decouple reserved requests, enforce duplicate protection, record immutable audit logs, and isolate legacy stock on live rs0', async () => {
		const now = new Date()

		// 1. Seed units: 1 Quarantined unit (TTI reactive discard), 1 Reserved unit, 1 Available shelf-life expired unit
		const reactiveUnit = await seedReservedUnit({
			status: 'Quarantined',
			testing: {
				hiv: 'Reactive',
				hbv: 'Non_Reactive',
				hcv: 'Non_Reactive',
				syphilis: 'Non_Reactive',
				malaria: 'Non_Reactive',
			},
		})

		const reservedUnit = await seedReservedUnit({
			status: 'Reserved',
			expiryDate: new Date(now.getTime() + 15 * 24 * 3600 * 1000),
		})

		const shelfLifeExpiredUnit = await seedReservedUnit({
			status: 'Available',
			clearance: { isVerified: true, verifiedAt: new Date() },
			expiryDate: new Date(now.getTime() + 2 * 3600 * 1000),
		})
		await connection.db.collection('bloodunits').updateOne(
			{ _id: shelfLifeExpiredUnit._id },
			{ $set: { expiryDate: new Date(now.getTime() - 2 * 3600 * 1000) } }
		)

		const request = await seedReceiveRequest({
			unitCount: 1,
			status: 'Accepted',
			reservedUnitIds: [reservedUnit._id],
		})
		reservedUnit.reservation.receiveRequestId = request._id
		await reservedUnit.save()

		// 2. Discard reactive Quarantined unit inside real transaction
		await withTransaction(async (session) => {
			await discardBloodUnits({
				unitIds: [reactiveUnit._id],
				bloodbankId: testBloodbankId,
				reason: 'TTI_Reactive',
				wasteManifestNumber: 'WM-RS0-BIO-01',
				notes: 'HIV-1 Confirmatory Reactive. Biohazard incineration scheduled.',
				actorId: testBloodbankId,
				staffId: labTechStaffId,
				session,
			})
		})

		const discardedReactive = await BloodUnit.findById(reactiveUnit._id)
		assert.strictEqual(discardedReactive.status, 'Discarded')
		assert.strictEqual(discardedReactive.discard.reason, 'TTI_Reactive')
		assert.strictEqual(discardedReactive.discard.wasteManifestNumber, 'WM-RS0-BIO-01')
		assert.strictEqual(
			discardedReactive.discard.discardedByStaffId.toString(),
			labTechStaffId.toString()
		)

		const auditReactive = await BloodUnitAuditLog.findOne({
			unitId: reactiveUnit._id,
			action: 'UNIT_DISCARDED',
		})
		assert.ok(auditReactive, 'UNIT_DISCARDED audit event must be persisted.')
		assert.strictEqual(auditReactive.previousStatus, 'Quarantined')
		assert.strictEqual(auditReactive.newStatus, 'Discarded')

		// 3. Discard Reserved unit: must decouple from receive request
		await withTransaction(async (session) => {
			await discardBloodUnits({
				unitIds: [reservedUnit._id],
				bloodbankId: testBloodbankId,
				reason: 'Clotted',
				actorId: testBloodbankId,
				staffId: verifiedMOStaffId,
				session,
			})
		})

		const freshRequest = await ReceiveRequests.findById(request._id)
		assert.strictEqual(
			freshRequest.status,
			'Accepted',
			'Request status remains Accepted for re-allocation.'
		)
		assert.strictEqual(
			freshRequest.reservedUnitIds.length,
			0,
			'Reserved unit ID must be pulled upon discard.'
		)

		const freshReserved = await BloodUnit.findById(reservedUnit._id)
		assert.strictEqual(freshReserved.status, 'Discarded')
		assert.strictEqual(freshReserved.reservation.receiveRequestId, null)

		// 4. Duplicate Discard Guard on rs0: Attempting to discard again must fail
		await assert.rejects(
			async () => {
				await withTransaction(async (session) => {
					await discardBloodUnits({
						unitIds: [discardedReactive._id],
						bloodbankId: testBloodbankId,
						reason: 'TTI_Reactive',
						actorId: testBloodbankId,
						session,
					})
				})
			},
			{
				name: 'Error',
				message: /Unit has already been discarded.*Duplicate discard is rejected/i,
			}
		)

		// 5. Process Shelf-Life Expiry on rs0
		await withTransaction(async (session) => {
			const expiryResult = await processClinicallyExpiredInventory({
				batchSize: 50,
				now,
				bloodbankId: testBloodbankId,
				session,
			})
			assert.strictEqual(expiryResult.processedCount, 1)
		})

		const freshExpiredShelfUnit = await BloodUnit.findById(shelfLifeExpiredUnit._id)
		assert.strictEqual(freshExpiredShelfUnit.status, 'Expired')

		const auditExpired = await BloodUnitAuditLog.findOne({
			unitId: shelfLifeExpiredUnit._id,
			action: 'UNIT_EXPIRED',
		})
		assert.ok(
			auditExpired,
			'UNIT_EXPIRED audit event must be persisted for shelf-life elapsed unit.'
		)
		assert.strictEqual(auditExpired.previousStatus, 'Available')
		assert.strictEqual(auditExpired.newStatus, 'Expired')
	})

	// Scenario 15: Phase 3.7 Legacy Inventory Reconciliation & Safe Migration Safeguards on live rs0
	it('Scenario 15: Legacy Inventory Reconciliation and Migration Safeguards on live rs0', async () => {
		const now = new Date()

		// 1. Setup initial legacy Bloodstock on rs0
		await Bloodstock.create({
			bloodbankId: testBloodbankId,
			O_Positive: 5,
			A_Positive: 3,
			B_Negative: 0,
		})

		// 2. Generate Dry-Run Reconciliation Report
		const report = await reconciliationService.generateReconciliationReport({
			bloodbankId: testBloodbankId,
			recordAudit: true,
			actorId: testBloodbankId,
		})
		assert.strictEqual(report.status, 'COMPLETED')
		assert.strictEqual(report.isClean, true)
		assert.strictEqual(report.summary.legacyTotal, 8)
		assert.strictEqual(report.summary.traceableTotal, 0)
		assert.strictEqual(report.discrepancies.length, 1) // only UNSUPPORTED_COMPONENT_MAPPING notice
		assert.strictEqual(report.discrepancies[0].type, 'UNSUPPORTED_COMPONENT_MAPPING')

		// Confirm zero writes to inventory
		const unitsCountBefore = await BloodUnit.countDocuments({ bloodbankId: testBloodbankId })
		assert.strictEqual(unitsCountBefore, 0, 'Dry-run audit must perform zero unit writes.')

		// 3. Dry-Run Migration Simulation
		const din1 = getNextDIN()
		const din2 = getNextDIN()
		const dryRunManifest = [
			{
				unitNumber: din1,
				bloodGroup: 'O_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				expiryDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
				deductFromLegacy: true,
			},
			{
				unitNumber: din2,
				bloodGroup: 'O_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				expiryDate: new Date(now.getTime() + 25 * 24 * 60 * 60 * 1000),
				deductFromLegacy: true,
			},
		]

		const dryRunRes = await reconciliationService.executeInventoryMigration({
			bloodbankId: testBloodbankId,
			mode: 'DRY_RUN',
			migrationManifest: dryRunManifest,
		})
		assert.strictEqual(dryRunRes.mode, 'DRY_RUN')
		assert.strictEqual(dryRunRes.isExecutable, true)
		assert.strictEqual(dryRunRes.summary.validToMigrate, 2)
		assert.strictEqual(dryRunRes.simulatedLegacyStockAfter.O_Positive, 3)

		// Verify on DB that dry-run performed zero mutations
		const unitsAfterDryRun = await BloodUnit.countDocuments({ bloodbankId: testBloodbankId })
		assert.strictEqual(unitsAfterDryRun, 0)
		const stockAfterDryRun = await Bloodstock.findOne({ bloodbankId: testBloodbankId })
		assert.strictEqual(stockAfterDryRun.O_Positive, 5)

		// 4. Safe Migration Execution on rs0 inside multi-document transaction
		const execRes = await withTransaction(async (session) => {
			return await reconciliationService.executeInventoryMigration({
				bloodbankId: testBloodbankId,
				mode: 'EXECUTE',
				migrationManifest: dryRunManifest,
				actorId: verifiedMOStaffId,
				actorModel: 'bloodbankstaff',
				session,
			})
		})

		assert.strictEqual(execRes.mode, 'EXECUTE')
		assert.strictEqual(execRes.status, 'COMPLETED')
		assert.strictEqual(execRes.migratedCount, 2)

		// Verify on live DB:
		// A. Legacy stock decremented atomically
		const freshStock = await Bloodstock.findOne({ bloodbankId: testBloodbankId })
		assert.strictEqual(freshStock.O_Positive, 3, 'Legacy stock O_Positive decremented from 5 to 3')

		// B. Traceable units created strictly Quarantined and NOT issue-eligible
		const freshUnits = await BloodUnit.find({ bloodbankId: testBloodbankId }).sort({ unitNumber: 1 })
		assert.strictEqual(freshUnits.length, 2)
		for (const u of freshUnits) {
			assert.strictEqual(u.status, 'Quarantined')
			assert.strictEqual(u.isLegacyMigrated, true)
			assert.strictEqual(u.clearance.isVerified, false)
			assert.strictEqual(u.isIssueEligible(), false, 'Migrated unit must NEVER be issue-eligible')
		}

		// C. Audit logs persisted
		const auditLogs = await BloodUnitAuditLog.find({
			bloodbankId: testBloodbankId,
			action: 'LEGACY_RECONCILED',
		})
		assert.strictEqual(auditLogs.length, 2)

		const reconAudit = await InventoryReconciliationRecord.findOne({
			bloodbankId: testBloodbankId,
			runType: 'MIGRATION_EXECUTE',
		})
		assert.ok(reconAudit, 'InventoryReconciliationRecord must be persisted')
		assert.strictEqual(reconAudit.summary.migratedCount, 2)

		// 5. Double-Counting Prevention Verification
		const consolidated = await stockService.getConsolidatedStock(testBloodbankId)
		assert.strictEqual(consolidated.inventoryClassification, 'LEGACY_WITH_QUARANTINE_INTAKE')
		assert.strictEqual(consolidated.legacyUnverifiedStock.O_Positive, 3)
		assert.strictEqual(consolidated.traceableVerifiedStock.O_Positive, 0)
		assert.strictEqual(consolidated.O_Positive, 3, 'Top-level O_Positive reflects remaining legacy stock')
		assert.strictEqual(consolidated.traceableStatusBreakdown.Quarantined, 2)

		// 6. Idempotent Retry & Resumability on rs0
		const din3 = getNextDIN()
		const reentrantManifest = [
			dryRunManifest[0], // din1: already migrated
			dryRunManifest[1], // din2: already migrated
			{
				unitNumber: din3, // new unit
				bloodGroup: 'A_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				expiryDate: new Date(now.getTime() + 20 * 24 * 60 * 60 * 1000),
				deductFromLegacy: true,
			},
		]

		const retryRes = await withTransaction(async (session) => {
			return await reconciliationService.executeInventoryMigration({
				bloodbankId: testBloodbankId,
				mode: 'EXECUTE',
				migrationManifest: reentrantManifest,
				actorId: verifiedMOStaffId,
				actorModel: 'bloodbankstaff',
				session,
			})
		})

		assert.strictEqual(retryRes.migratedCount, 1, 'Only 1 new unit migrated')
		assert.strictEqual(retryRes.alreadyMigratedCount, 2, '2 units recognized as ALREADY_MIGRATED')

		// Legacy stock checks: O_Positive must NOT be re-decremented; A_Positive decremented 3 -> 2
		const stockAfterRetry = await Bloodstock.findOne({ bloodbankId: testBloodbankId })
		assert.strictEqual(stockAfterRetry.O_Positive, 3, 'O_Positive not decremented again')
		assert.strictEqual(stockAfterRetry.A_Positive, 2, 'A_Positive decremented 3 to 2')
		const totalUnitsAfterRetry = await BloodUnit.countDocuments({ bloodbankId: testBloodbankId })
		assert.strictEqual(totalUnitsAfterRetry, 3, 'Total units in DB is 3')

		// 7. Transaction Rollback on Conflict on rs0
		const conflictManifest = [
			{
				unitNumber: getNextDIN(),
				bloodGroup: 'B_Negative', // legacy stock has 0 units
				expiryDate: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000),
				deductFromLegacy: true,
			},
		]

		await assert.rejects(
			async () => {
				await withTransaction(async (session) => {
					await reconciliationService.executeInventoryMigration({
						bloodbankId: testBloodbankId,
						mode: 'EXECUTE',
						migrationManifest: conflictManifest,
						actorId: verifiedMOStaffId,
						session,
					})
				})
			},
			{
				name: 'Error',
				message: /Insufficient legacy stock for blood group B_Negative/i,
			}
		)

		// Verify complete rollback on rs0
		const countAfterConflict = await BloodUnit.countDocuments({ bloodbankId: testBloodbankId })
		assert.strictEqual(countAfterConflict, 3, 'No unit was created during failed transaction')
		const stockAfterConflict = await Bloodstock.findOne({ bloodbankId: testBloodbankId })
		assert.strictEqual(stockAfterConflict.A_Positive, 2)
		assert.strictEqual(stockAfterConflict.O_Positive, 3)
	})

	it('Scenario 16: Complete 10-Stage Clinical Lifecycle Pipeline on live rs0', async () => {
		const now = new Date()

		// 1. Donation intake creates unit in Quarantined state
		const din = getNextDIN()
		const unit = new BloodUnit({
			unitNumber: din,
			bloodbankId: testBloodbankId,
			bloodGroup: 'AB_Positive',
			componentType: 'Whole_Blood',
			volumeMl: 350,
			collectionDate: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000),
			expiryDate: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
			status: 'Quarantined',
		})
		await unit.save()
		assert.strictEqual(unit.status, 'Quarantined')
		assert.strictEqual(unit.isIssueEligible(), false)

		// 2. Record 5-panel TTI screening -> Tested_Passed
		unit.testing = {
			hiv: 'Non_Reactive',
			hbv: 'Non_Reactive',
			hcv: 'Non_Reactive',
			syphilis: 'Non_Reactive',
			malaria: 'Non_Reactive',
			testBatchId: 'BATCH-E2E-001',
			testedAt: now,
		}
		unit.status = 'Tested_Passed'
		await unit.save()
		assert.strictEqual(unit.status, 'Tested_Passed')
		assert.strictEqual(unit.isIssueEligible(), false, 'Screening alone never makes a unit issue-eligible')

		// 3. Medical Officer clearance -> Available
		unit.clearance = {
			isVerified: true,
			verifiedBy: testBloodbankId,
			verifiedByStaffId: verifiedMOStaffId,
			verifiedAt: now,
			notes: 'Clinical clearance approved by Medical Officer',
		}
		unit.status = 'Available'
		await unit.save()
		assert.strictEqual(unit.status, 'Available')
		assert.strictEqual(unit.isIssueEligible(), true)

		// 4. Create patient receive request
		const receiveReq = await seedReceiveRequest({
			bloodbankId: testBloodbankId,
			bloodType: 'AB_Positive',
			unitCount: 1,
			status: 'Accepted',
		})

		// 5. Atomic FEFO reservation on rs0
		const reservationRes = await withTransaction(async (session) => {
			return await reserveUnitsForRequest({
				requestId: receiveReq._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				session,
			})
		})
		assert.strictEqual(reservationRes.reservedUnits.length, 1)
		const reservedUnit = await BloodUnit.findById(unit._id)
		assert.strictEqual(reservedUnit.status, 'Reserved')

		// 6. Record Crossmatch Compatibility
		await withTransaction(async (session) => {
			return await recordCrossmatchForUnit({
				unitId: unit._id,
				receiveRequestId: receiveReq._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				crossmatchResult: 'Compatible',
				session,
			})
		})

		// 7. Atomic Issuance inside transaction on rs0
		const issueRes = await withTransaction(async (session) => {
			return await issueUnitsForRequest({
				requestId: receiveReq._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: verifiedMOStaffId,
				recipientPatientName: 'E2E Test Patient',
				hospitalName: 'Apollo City Hospital',
				session,
			})
		})
		assert.strictEqual(issueRes.issuedUnits.length, 1)
		const issuedUnit = await BloodUnit.findById(unit._id)
		assert.strictEqual(issuedUnit.status, 'Issued')

		// 8. Physical Dispatch
		const dispatchRes = await withTransaction(async (session) => {
			return await recordPhysicalDispatch({
				requestId: receiveReq._id,
				bloodbankId: testBloodbankId,
				actorId: verifiedMOStaffId,
				staffId: labTechStaffId,
				dispatchedToRecipient: 'Ambulance Courier #42',
				transportBoxId: 'BOX-COLD-99',
				dispatchNotes: 'Delivered in monitored cold box at 4C',
				session,
			})
		})
		assert.strictEqual(dispatchRes.dispatchedUnits.length, 1)
		const dispatchedUnit = await BloodUnit.findById(unit._id)
		assert.strictEqual(dispatchedUnit.status, 'Issued')
		assert.strictEqual(dispatchedUnit.issuance.dispatch.isDispatched, true)

		// 9. Guard: Discard on Dispatched unit must fail closed
		await assert.rejects(
			async () => {
				await discardBloodUnits({
					unitIds: [unit._id],
					bloodbankId: testBloodbankId,
					reason: 'Expired',
					actorId: verifiedMOStaffId,
				})
			},
			{
				name: 'Error',
				message: /Cannot discard unit.*already dispatched/i,
			}
		)

		// 10. Biohazard discard on an expired unit with reason 'Other' and mandatory notes
		const discardDIN = getNextDIN()
		const expiredUnit = new BloodUnit({
			unitNumber: discardDIN,
			bloodbankId: testBloodbankId,
			bloodGroup: 'AB_Positive',
			componentType: 'Whole_Blood',
			volumeMl: 350,
			collectionDate: new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000),
			expiryDate: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000),
			status: 'Expired',
		})
		await expiredUnit.save()

		// Discard reason 'Other' without notes must be rejected
		await assert.rejects(
			async () => {
				await discardBloodUnits({
					unitIds: [expiredUnit._id],
					bloodbankId: testBloodbankId,
					reason: 'Other',
					notes: '',
					actorId: verifiedMOStaffId,
				})
			},
			{
				name: 'Error',
				message: /requires explanatory notes/i,
			}
		)

		// Discard with notes succeeds
		const discardOutcome = await withTransaction(async (session) => {
			return await discardBloodUnits({
				unitIds: [expiredUnit._id],
				bloodbankId: testBloodbankId,
				reason: 'Other',
				notes: 'Bag seal damaged during quarterly inventory audit',
				actorId: verifiedMOStaffId,
				session,
			})
		})
		assert.strictEqual(discardOutcome.discardedCount, 1)
		const finalUnit = await BloodUnit.findById(expiredUnit._id)
		assert.strictEqual(finalUnit.status, 'Discarded')
		assert.strictEqual(finalUnit.discard.reason, 'Other')
	})
})
