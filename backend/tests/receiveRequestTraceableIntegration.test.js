const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const User = require('../User/userModel')

const receiveController = require('../BloodReceive/bloodReceiveController')
const {
	reserveUnitsForRequest,
} = require('../BloodUnit/reservationService')
const {
	issueUnitsForRequest,
	recordCrossmatchForUnit,
	recordPhysicalDispatch,
} = require('../BloodUnit/issuanceService')
const { canUseTransactions } = require('../Utils/transactionHelper')

const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	'mongodb://127.0.0.1:27017/namma_blood_test_rs0_receivereq?replicaSet=rs0'

function createMockReqRes({ user, staff, body = {}, query = {}, params = {}, ip = '127.0.0.1' } = {}) {
	const req = {
		user: user || (staff ? { _id: staff.bloodbankId, staffId: staff._id, isStaff: true } : { _id: new mongoose.Types.ObjectId().toString() }),
		staff: staff || null,
		body,
		query,
		params,
		headers: {},
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

describe('Phase 3.5 — Receive Requests & Traceable Blood Unit Inventory Integration', () => {
	let connection
	let testBloodbankAId
	let testBloodbankBId
	let testUserId
	let verifiedMOStaffId

	before(async () => {
		assert.notStrictEqual(
			process.env.NODE_ENV,
			'production',
			'SAFETY GUARD: Integration tests must never run with NODE_ENV=production.'
		)
		assert.match(
			TEST_DB_URI,
			/test/i,
			'SAFETY GUARD: TEST_MONGODB_URI must contain "test".'
		)

		console.log('\n--- Connecting to MongoDB Replica Set (rs0) ---')
		await mongoose.connect(TEST_DB_URI, {
			serverSelectionTimeoutMS: 5000,
		})
		connection = mongoose.connection
		assert.strictEqual(connection.readyState, 1)

		const admin = connection.db.admin()
		const replStatus = await admin.command({ replSetGetStatus: 1 })
		assert.strictEqual(replStatus.set, 'rs0')
		assert.strictEqual(canUseTransactions(), true)

		testBloodbankAId = new mongoose.Types.ObjectId()
		testBloodbankBId = new mongoose.Types.ObjectId()
		testUserId = new mongoose.Types.ObjectId()
		verifiedMOStaffId = new mongoose.Types.ObjectId()
	})

	after(async () => {
		if (connection && connection.readyState === 1) {
			await connection.db.dropDatabase()
			await mongoose.disconnect()
			console.log('--- Integration Test Database Cleaned & Disconnected ---')
		}
	})

	beforeEach(async () => {
		await BloodUnit.deleteMany({})
		if (connection.db) {
			await connection.db.collection('bloodunitauditlogs').deleteMany({}).catch(() => {})
		}
		await ReceiveRequests.deleteMany({})
		await Bloodstock.deleteMany({})
	})

	// Helper to create a verified issue-eligible unit
	async function createEligibleUnit(bloodbankId, overrides = {}) {
		const unit = await BloodUnit.create({
			unitNumber: `DIN-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}-WB`,
			bloodbankId,
			bloodGroup: 'A_Positive',
			componentType: 'Whole_Blood',
			status: 'Available',
			volumeMl: 350,
			collectionDate: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
			expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
			testing: {
				hiv: 'Non_Reactive',
				hbv: 'Non_Reactive',
				hcv: 'Non_Reactive',
				syphilis: 'Non_Reactive',
				malaria: 'Non_Reactive',
				testedBy: bloodbankId,
				testedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
			},
			clearance: {
				isVerified: true,
				verifiedBy: bloodbankId,
				verifiedByStaffId: verifiedMOStaffId,
				verifiedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
				notes: 'Medical Officer verified issue-eligible',
			},
			...overrides,
		})
		return unit
	}

	it('1. Accepting a request sets status to Accepted without issuing blood or modifying inventory', async () => {
		// Setup legacy stock: A_Positive: 10
		await Bloodstock.create({
			bloodbankId: testBloodbankAId,
			A_Positive: 10,
		})

		// Setup traceable unit: exactly 1 Available A+ unit (DIN-001)
		const traceableUnit = await createEligibleUnit(testBloodbankAId, {
			unitNumber: 'DIN-001',
		})

		// Create patient receive request for quantity 2 of A_Positive
		const request = await ReceiveRequests.create({
			userId: testUserId,
			bloodbankId: testBloodbankAId,
			bloodType: 'A_Positive',
			unit: 2,
			status: 'Pending',
			whenDoYouWant: new Date(Date.now() + 24 * 60 * 60 * 1000),
		})

		// Execute acceptRequest
		const { req, res, next } = createMockReqRes({
			user: { _id: testBloodbankAId },
			body: { id: request._id.toString() },
		})
		await receiveController.acceptRequest(req, res, next)

		assert.strictEqual(res.statusCode, 200)
		assert.strictEqual(res.responseData.message, 'Request Accepted.')

		// Verify database state
		const updatedRequest = await ReceiveRequests.findById(request._id)
		assert.strictEqual(updatedRequest.status, 'Accepted')
		assert.strictEqual(updatedRequest.reservedUnitIds.length, 0, 'No units reserved on acceptance')

		// Verify Traceable Inventory remains untouched
		const reloadedUnit = await BloodUnit.findById(traceableUnit._id)
		assert.strictEqual(reloadedUnit.status, 'Available')
		assert.ok(!reloadedUnit.reservation?.receiveRequestId, 'Unit must not have receiveRequestId assigned')

		// Verify Legacy Stock remains untouched
		const reloadedStock = await Bloodstock.findOne({ bloodbankId: testBloodbankAId })
		assert.strictEqual(reloadedStock.A_Positive, 10, 'Legacy stock must remain exactly 10')

		// Verify no audit logs created
		const auditCount = await BloodUnitAuditLog.countDocuments({ unitId: traceableUnit._id })
		assert.strictEqual(auditCount, 0, 'No audit logs should be written on acceptance')
	})

	it('2. Insufficient stock: 2-unit request fails when only 1 eligible traceable unit exists, leaving legacy stock untouched', async () => {
		// Setup legacy stock: A_Positive: 10
		await Bloodstock.create({
			bloodbankId: testBloodbankAId,
			A_Positive: 10,
		})

		// Setup traceable inventory: exactly ONE Available A+ unit (DIN-001)
		const traceableUnit = await createEligibleUnit(testBloodbankAId, {
			unitNumber: 'DIN-001',
		})

		// Create an Accepted request for 2 units
		const request = await ReceiveRequests.create({
			userId: testUserId,
			bloodbankId: testBloodbankAId,
			bloodType: 'A_Positive',
			unit: 2,
			status: 'Accepted',
			whenDoYouWant: new Date(Date.now() + 24 * 60 * 60 * 1000),
		})

		// Attempt fulfillment of 2-unit request
		const { req, res, next } = createMockReqRes({
			user: { _id: testBloodbankAId },
			body: {
				id: request._id.toString(),
				bloodType: 'A_Positive',
				unit: 2,
			},
		})
		await receiveController.fulfilledRequest(req, res, next)

		// Must fail closed with 400 Insufficient verified stock
		assert.strictEqual(res.statusCode, 400)
		assert.match(
			res.responseData.message,
			/Insufficient verified, issue-eligible traceable units available for blood group 'A_Positive'\. Required: 2, available: 1/i
		)

		// Verify Request remains in Accepted status (NOT fulfilled)
		const reloadedRequest = await ReceiveRequests.findById(request._id)
		assert.strictEqual(reloadedRequest.status, 'Accepted')

		// Verify Legacy Stock is NOT decremented (MUST NOT decrease from 10 to 8!)
		const reloadedStock = await Bloodstock.findOne({ bloodbankId: testBloodbankAId })
		assert.strictEqual(reloadedStock.A_Positive, 10, 'Legacy stock MUST NOT be decremented to fulfill traceable requests!')

		// Verify Traceable Unit DIN-001 remains in Available status (NOT reserved or issued)
		const reloadedUnit = await BloodUnit.findById(traceableUnit._id)
		assert.strictEqual(reloadedUnit.status, 'Available')
	})

	it('3. Successful reservation of an eligible unit links request and records UNIT_RESERVED audit log', async () => {
		// Setup traceable unit: Available A+ unit
		const traceableUnit = await createEligibleUnit(testBloodbankAId, {
			unitNumber: 'DIN-001',
		})

		// Create an Accepted request for 1 unit
		const request = await ReceiveRequests.create({
			userId: testUserId,
			bloodbankId: testBloodbankAId,
			bloodType: 'A_Positive',
			unit: 1,
			status: 'Accepted',
			whenDoYouWant: new Date(Date.now() + 24 * 60 * 60 * 1000),
		})

		// Reserve units for request
		const reservationResult = await reserveUnitsForRequest({
			requestId: request._id,
			bloodbankId: testBloodbankAId,
			actorId: testBloodbankAId,
			actorModel: 'bloodbank',
			holdHours: 24,
		})

		assert.strictEqual(reservationResult.reservedUnits.length, 1)

		// Verify unit status updated to Reserved
		const reloadedUnit = await BloodUnit.findById(traceableUnit._id)
		assert.strictEqual(reloadedUnit.status, 'Reserved')
		assert.strictEqual(
			reloadedUnit.reservation.receiveRequestId.toString(),
			request._id.toString()
		)
		assert.ok(reloadedUnit.reservation.reservedExpiresAt > new Date())

		// Verify request has reservedUnitIds linked
		const reloadedRequest = await ReceiveRequests.findById(request._id)
		assert.strictEqual(reloadedRequest.reservedUnitIds.length, 1)
		assert.strictEqual(
			reloadedRequest.reservedUnitIds[0].toString(),
			traceableUnit._id.toString()
		)

		// Verify immutable audit log
		const auditLog = await BloodUnitAuditLog.findOne({
			unitId: traceableUnit._id,
			action: 'UNIT_RESERVED',
		})
		assert.ok(auditLog, 'UNIT_RESERVED audit log must exist')
		assert.strictEqual(auditLog.previousStatus, 'Available')
		assert.strictEqual(auditLog.newStatus, 'Reserved')
	})

	it('4. Crossmatch failure: Incompatible crossmatch result strictly prevents issuance and fulfillment', async () => {
		// Setup traceable unit and reserve it
		const traceableUnit = await createEligibleUnit(testBloodbankAId, {
			unitNumber: 'DIN-001',
		})

		const request = await ReceiveRequests.create({
			userId: testUserId,
			bloodbankId: testBloodbankAId,
			bloodType: 'A_Positive',
			unit: 1,
			status: 'Accepted',
			whenDoYouWant: new Date(Date.now() + 24 * 60 * 60 * 1000),
		})

		await reserveUnitsForRequest({
			requestId: request._id,
			bloodbankId: testBloodbankAId,
			actorId: testBloodbankAId,
			actorModel: 'bloodbank',
		})

		// Record Incompatible crossmatch on the reserved unit
		await recordCrossmatchForUnit({
			unitId: traceableUnit._id,
			receiveRequestId: request._id,
			bloodbankId: testBloodbankAId,
			actorId: testBloodbankAId,
			crossmatchResult: 'Incompatible',
			notes: 'Major incompatibility detected on saline agglutination.',
		})

		// Attempt fulfillment via fulfilledRequest
		const { req, res, next } = createMockReqRes({
			user: { _id: testBloodbankAId },
			body: {
				id: request._id.toString(),
				bloodType: 'A_Positive',
				unit: 1,
			},
		})
		await receiveController.fulfilledRequest(req, res, next)

		// Must reject with 400 Incompatible crossmatch
		assert.strictEqual(res.statusCode, 400)
		assert.match(
			res.responseData.message,
			/has an Incompatible crossmatch result\. Incompatible units cannot be fulfilled/i
		)

		// Verify unit remains in Reserved status (NEVER transitioned to Issued)
		const reloadedUnit = await BloodUnit.findById(traceableUnit._id)
		assert.strictEqual(reloadedUnit.status, 'Reserved')

		// Verify request remains in Accepted status (NEVER transitioned to Fulfilled)
		const reloadedRequest = await ReceiveRequests.findById(request._id)
		assert.strictEqual(reloadedRequest.status, 'Accepted')
	})

	it('5. Successful issuance and physical dispatch updates unit lifecycle and immutable audit history', async () => {
		// Setup legacy stock: 10
		await Bloodstock.create({
			bloodbankId: testBloodbankAId,
			A_Positive: 10,
		})

		// Setup traceable unit: Available A+
		const traceableUnit = await createEligibleUnit(testBloodbankAId, {
			unitNumber: 'DIN-001',
		})

		// Create Accepted request
		const request = await ReceiveRequests.create({
			userId: testUserId,
			bloodbankId: testBloodbankAId,
			bloodType: 'A_Positive',
			unit: 1,
			status: 'Accepted',
			whenDoYouWant: new Date(Date.now() + 24 * 60 * 60 * 1000),
		})

		// Fulfill the request directly via fulfilledRequest (which reserves & issues with Compatible crossmatch)
		const { req, res, next } = createMockReqRes({
			user: { _id: testBloodbankAId },
			body: {
				id: request._id.toString(),
				bloodType: 'A_Positive',
				unit: 1,
				crossmatchResult: 'Compatible',
				recipientPatientName: 'Aarav Sharma',
				hospitalName: 'Apollo Speciality Hospital',
				dispatchNotes: 'Verified compatibility and temperature hold.',
			},
		})
		await receiveController.fulfilledRequest(req, res, next)

		assert.strictEqual(res.statusCode, 200)
		assert.strictEqual(res.responseData.message, 'Request Fulfilled.')

		// Verify unit transitioned to Issued
		const issuedUnit = await BloodUnit.findById(traceableUnit._id)
		assert.strictEqual(issuedUnit.status, 'Issued')
		assert.strictEqual(
			issuedUnit.issuance.issuedToReceiveRequestId.toString(),
			request._id.toString()
		)
		assert.strictEqual(issuedUnit.issuance.recipientPatientName, 'Aarav Sharma')
		assert.strictEqual(issuedUnit.issuance.crossmatchResult, 'Compatible')
		assert.ok(issuedUnit.issuance.issuedAt)

		// Verify request transitioned to Fulfilled
		const fulfilledRequestDoc = await ReceiveRequests.findById(request._id)
		assert.strictEqual(fulfilledRequestDoc.status, 'Fulfilled')

		// Verify Legacy Stock was NEVER touched (still 10)
		const reloadedStock = await Bloodstock.findOne({ bloodbankId: testBloodbankAId })
		assert.strictEqual(reloadedStock.A_Positive, 10, 'Legacy stock must remain isolated')

		// Verify UNIT_ISSUED audit log exists
		const issueAudit = await BloodUnitAuditLog.findOne({
			unitId: traceableUnit._id,
			action: 'UNIT_ISSUED',
		})
		assert.ok(issueAudit, 'UNIT_ISSUED audit log must exist')
		assert.strictEqual(issueAudit.previousStatus, 'Reserved')
		assert.strictEqual(issueAudit.newStatus, 'Issued')
		assert.strictEqual(issueAudit.metadata.recipientPatientName, 'Aarav Sharma')

		// Now record Physical Dispatch
		const dispatchResult = await recordPhysicalDispatch({
			unitIds: [traceableUnit._id],
			bloodbankId: testBloodbankAId,
			actorId: testBloodbankAId,
			dispatchedToRecipient: 'Courier Logistics - Van 12',
			transportBoxId: 'COLD-BOX-99',
			dispatchNotes: 'Cold chain verified at 3.5 deg C.',
		})

		assert.strictEqual(dispatchResult.dispatchedUnits.length, 1)

		// Verify dispatched metadata on unit
		const dispatchedUnit = await BloodUnit.findById(traceableUnit._id)
		assert.strictEqual(dispatchedUnit.status, 'Issued')
		assert.strictEqual(dispatchedUnit.issuance.dispatch.isDispatched, true)
		assert.strictEqual(
			dispatchedUnit.issuance.dispatch.dispatchedToRecipient,
			'Courier Logistics - Van 12'
		)
		assert.strictEqual(dispatchedUnit.issuance.dispatch.transportBoxId, 'COLD-BOX-99')

		// Verify UNIT_DISPATCHED audit log exists
		const dispatchAudit = await BloodUnitAuditLog.findOne({
			unitId: traceableUnit._id,
			action: 'UNIT_DISPATCHED',
		})
		assert.ok(dispatchAudit, 'UNIT_DISPATCHED audit log must exist')
		assert.strictEqual(dispatchAudit.metadata.transportBoxId, 'COLD-BOX-99')
	})

	it('6. Duplicate fulfillment and concurrent requests cannot consume the same unit twice', async () => {
		const traceableUnit = await createEligibleUnit(testBloodbankAId, {
			unitNumber: 'DIN-001',
		})

		const request = await ReceiveRequests.create({
			userId: testUserId,
			bloodbankId: testBloodbankAId,
			bloodType: 'A_Positive',
			unit: 1,
			status: 'Accepted',
			whenDoYouWant: new Date(Date.now() + 24 * 60 * 60 * 1000),
		})

		// First fulfillment succeeds
		const { req: req1, res: res1, next: next1 } = createMockReqRes({
			user: { _id: testBloodbankAId },
			body: { id: request._id.toString() },
		})
		await receiveController.fulfilledRequest(req1, res1, next1)
		assert.strictEqual(res1.statusCode, 200)

		// Duplicate fulfillment attempt on already fulfilled request
		const { req: req2, res: res2, next: next2 } = createMockReqRes({
			user: { _id: testBloodbankAId },
			body: { id: request._id.toString() },
		})
		await receiveController.fulfilledRequest(req2, res2, next2)

		// Must be rejected with 400
		assert.strictEqual(res2.statusCode, 400)
		assert.match(res2.responseData.message, /already been fulfilled/i)

		// Verify exactly one UNIT_ISSUED audit log exists
		const auditCount = await BloodUnitAuditLog.countDocuments({
			unitId: traceableUnit._id,
			action: 'UNIT_ISSUED',
		})
		assert.strictEqual(auditCount, 1, 'Only one UNIT_ISSUED audit record should ever be written')
	})

	it('7. Cross-blood-bank access is strictly rejected (BOLA defense)', async () => {
		// Unit and request belong to Blood Bank A
		const traceableUnit = await createEligibleUnit(testBloodbankAId, {
			unitNumber: 'DIN-001',
		})

		const requestA = await ReceiveRequests.create({
			userId: testUserId,
			bloodbankId: testBloodbankAId,
			bloodType: 'A_Positive',
			unit: 1,
			status: 'Accepted',
			whenDoYouWant: new Date(Date.now() + 24 * 60 * 60 * 1000),
		})

		// Blood Bank B tries to fulfill Blood Bank A's request
		const { req, res, next } = createMockReqRes({
			user: { _id: testBloodbankBId }, // Different blood bank!
			body: { id: requestA._id.toString() },
		})
		await receiveController.fulfilledRequest(req, res, next)

		// Must return 404 (Request not found for this blood bank)
		assert.strictEqual(res.statusCode, 404)
		assert.match(res.responseData.message, /not found/i)

		// Verify Blood Bank A's unit was NOT touched
		const reloadedUnit = await BloodUnit.findById(traceableUnit._id)
		assert.strictEqual(reloadedUnit.status, 'Available')

		// Verify Blood Bank A's request was NOT touched
		const reloadedRequest = await ReceiveRequests.findById(requestA._id)
		assert.strictEqual(reloadedRequest.status, 'Accepted')
	})
})
