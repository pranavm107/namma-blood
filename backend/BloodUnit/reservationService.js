const mongoose = require('mongoose')
const { BloodUnit, MANDATORY_TTI_TESTS } = require('./bloodUnitModel')
const { recordAuditLog } = require('./bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')

/**
 * Finds issue-eligible available blood units sorted by First Expiry First Out (FEFO).
 *
 * Deterministic Sorting:
 * 1. expiryDate: ASC (earliest expiry first - FEFO)
 * 2. collectionDate: ASC (older collections prioritized for equal expiry dates)
 * 3. _id: ASC (deterministic tie-breaker)
 *
 * Clinical Eligibility Criteria:
 * - status === 'Available'
 * - clearance.isVerified === true
 * - expiryDate > now
 * - All 5 mandatory TTI tests === 'Non_Reactive'
 * - Matching bloodGroup
 * - Matching componentType (if specified)
 */
async function findEligibleUnitsFEFO({
	bloodbankId,
	bloodGroup,
	componentType = null,
	requiredCount = 1,
	now = new Date(),
	options = {},
}) {
	const bbObjectId = mongoose.Types.ObjectId.isValid(bloodbankId)
		? new mongoose.Types.ObjectId(bloodbankId)
		: bloodbankId

	const query = {
		bloodbankId: bbObjectId,
		bloodGroup,
		status: 'Available',
		'clearance.isVerified': true,
		expiryDate: { $gt: now },
	}

	for (const test of MANDATORY_TTI_TESTS) {
		query[`testing.${test}`] = 'Non_Reactive'
	}

	if (componentType) {
		query.componentType = componentType
	}

	const cursor = BloodUnit.find(query, null, options)
		.sort({ expiryDate: 1, collectionDate: 1, _id: 1 })
		.limit(requiredCount)

	return await cursor
}

/**
 * Atomically reserves traceable, issue-eligible blood units for a specific patient receive request.
 *
 * Strict Concurrency & Lifecycle Invariants:
 * 1. Multi-Tenant Scoping: Request must exist and belong to bloodbankId. Cross-bank attempts are rejected.
 * 2. Request State Guard: Request must not be 'Fulfilled' or 'Rejected'.
 * 3. Idempotency / Duplicate Guard: Rejects if request already has reserved units assigned.
 * 4. All-or-Nothing Sufficiency: If available eligible units < required units, fails closed without partial reservation.
 * 5. Deterministic FEFO Selection: Units with earliest expiry dates are selected first.
 * 6. Conditional Atomic Update: Each unit is conditionally updated where status is strictly 'Available'.
 *    If a concurrent transaction claims the unit, the conditional update returns null and triggers conflict abort.
 * 7. Immutable Audit Trail: Every reserved unit appends a 'UNIT_RESERVED' audit event within the transaction.
 * 8. Legacy Stock Isolation: Legacy aggregate counters are never mutated or treated as traceable inventory.
 */
async function reserveUnitsForRequest({
	requestId,
	bloodbankId,
	actorId,
	actorModel = 'bloodbank',
	ipAddress = null,
	componentType = null,
	holdHours = 24,
	session = null,
}) {
	const opts = session ? { session } : {}
	const now = new Date()

	if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
		const err = new Error('Valid requestId is required for reservation.')
		err.statusCode = 400
		throw err
	}

	const bbObjectId = mongoose.Types.ObjectId.isValid(bloodbankId)
		? new mongoose.Types.ObjectId(bloodbankId)
		: bloodbankId

	// 1. Re-read receive request inside session to prevent race conditions
	const request = await ReceiveRequests.findOne(
		{
			_id: requestId,
			bloodbankId: bbObjectId,
		},
		null,
		opts
	)

	if (!request) {
		const err = new Error('Receive request not found or not owned by your blood bank.')
		err.statusCode = 404
		throw err
	}

	if (request.status === 'Fulfilled') {
		const err = new Error('Cannot reserve units for an already fulfilled request.')
		err.statusCode = 400
		throw err
	}

	if (request.status === 'Rejected') {
		const err = new Error('Cannot reserve units for a rejected request.')
		err.statusCode = 400
		throw err
	}

	if (!['Pending', 'Accepted'].includes(request.status)) {
		const err = new Error(
			`Cannot reserve units for a request with status '${request.status}'. Allowed statuses: Pending, Accepted.`
		)
		err.statusCode = 400
		throw err
	}

	// Check existing reserved units for this request
	const existingUnits = await BloodUnit.find(
		{
			'reservation.receiveRequestId': request._id,
			bloodbankId: bbObjectId,
			status: 'Reserved',
		},
		null,
		opts
	)

	if (existingUnits.length > 0) {
		const hasActiveHold = existingUnits.some(
			(u) =>
				!u.reservation?.reservedExpiresAt ||
				new Date(u.reservation.reservedExpiresAt) > now
		)
		if (hasActiveHold) {
			const err = new Error(
				'Request already has units reserved under an active hold. Duplicate reservation is rejected.'
			)
			err.statusCode = 400
			throw err
		}

		// All existing holds are expired! Clean them up atomically inside this same transaction before allocating new units
		await releaseReservationForRequest({
			requestId: request._id,
			bloodbankId: bbObjectId,
			actorId,
			actorModel,
			ipAddress,
			reason: 'Previous reservation hold expired; cleaned up atomically before re-allocation.',
			session: opts.session,
		})
	} else if (request.reservedUnitIds && request.reservedUnitIds.length > 0) {
		// Clean up dangling references if units are no longer reserved
		request.reservedUnitIds = []
		await request.save(opts)
	}

	const requiredCount = Math.floor(Number(request.unit))
	if (!requiredCount || requiredCount < 1 || isNaN(requiredCount)) {
		const err = new Error('Invalid request unit count: must be a positive integer.')
		err.statusCode = 400
		throw err
	}

	// 2. Locate candidate eligible units via FEFO
	const candidates = await findEligibleUnitsFEFO({
		bloodbankId: bbObjectId,
		bloodGroup: request.bloodType,
		componentType,
		requiredCount,
		now,
		options: opts,
	})

	if (candidates.length < requiredCount) {
		const err = new Error(
			`Cannot reserve units: Insufficient verified, issue-eligible units available for blood group '${request.bloodType}'. Required: ${requiredCount}, eligible available: ${candidates.length}.`
		)
		err.statusCode = 400
		throw err
	}

	// 3. Calculate reservation hold expiration
	const boundedHoldHours =
		Number(holdHours) && holdHours >= 1 && holdHours <= 72 ? Number(holdHours) : 24
	const defaultHoldExpires = new Date(now.getTime() + boundedHoldHours * 60 * 60 * 1000)

	// 4. Atomically reserve each candidate unit
	const reservedUnits = []
	const reservedUnitIds = []

	for (const candidate of candidates) {
		// Clinical safety: Hold expiry cannot exceed the unit's clinical expiry date
		const effectiveHoldExpires =
			candidate.expiryDate < defaultHoldExpires ? candidate.expiryDate : defaultHoldExpires

		const locked = await BloodUnit.findOneAndUpdate(
			{
				_id: candidate._id,
				bloodbankId: bbObjectId,
				status: 'Available',
				'clearance.isVerified': true,
				expiryDate: { $gt: now },
				'testing.hiv': 'Non_Reactive',
				'testing.hbv': 'Non_Reactive',
				'testing.hcv': 'Non_Reactive',
				'testing.syphilis': 'Non_Reactive',
				'testing.malaria': 'Non_Reactive',
			},
			{
				$set: {
					status: 'Reserved',
					'reservation.receiveRequestId': request._id,
					'reservation.reservedAt': now,
					'reservation.reservedExpiresAt': effectiveHoldExpires,
				},
			},
			{ new: true, ...opts }
		)

		if (!locked) {
			const err = new Error(
				`Concurrent reservation conflict: Unit '${candidate.unitNumber || candidate._id}' was modified or claimed by another transaction. Reservation aborted.`
			)
			err.statusCode = 409
			throw err
		}

		reservedUnits.push(locked)
		reservedUnitIds.push(locked._id)

		// Record immutable audit entry
		await recordAuditLog({
			unitId: locked._id,
			unitNumber: locked.unitNumber,
			bloodbankId: bbObjectId,
			action: 'UNIT_RESERVED',
			previousStatus: 'Available',
			newStatus: 'Reserved',
			actorId,
			actorModel,
			ipAddress,
			reason: 'Unit reserved for patient receive request',
			metadata: {
				receiveRequestId: request._id,
				requestedBloodType: request.bloodType,
				componentType: locked.componentType,
				unitExpiryDate: locked.expiryDate,
				reservedAt: now,
				reservedExpiresAt: effectiveHoldExpires,
			},
			session: opts.session,
		})
	}

	// 5. Update ReceiveRequest with reserved unit references and transition from Pending to Accepted
	request.reservedUnitIds = reservedUnitIds
	if (request.status === 'Pending') {
		request.status = 'Accepted'
	}
	await request.save(opts)

	return {
		request,
		reservedUnits,
		reservedUnitIds,
	}
}

/**
 * Releases reserved units back to Available inventory (or Expired if shelf-life has elapsed).
 * Triggered upon receive request cancellation, rejection, or explicit reservation release.
 */
async function releaseReservationForRequest({
	requestId,
	bloodbankId,
	actorId,
	actorModel = 'bloodbank',
	ipAddress = null,
	reason = '',
	session = null,
}) {
	const opts = session ? { session } : {}
	const now = new Date()

	const bbObjectId = mongoose.Types.ObjectId.isValid(bloodbankId)
		? new mongoose.Types.ObjectId(bloodbankId)
		: bloodbankId

	const request = await ReceiveRequests.findOne(
		{
			_id: requestId,
			bloodbankId: bbObjectId,
		},
		null,
		opts
	)

	if (!request) {
		const err = new Error('Receive request not found or not owned by your blood bank.')
		err.statusCode = 404
		throw err
	}

	if (request.status === 'Fulfilled') {
		const err = new Error('Cannot release reservation for an already fulfilled request.')
		err.statusCode = 400
		throw err
	}

	// Locate all units currently reserved for this request and tenant
	const reservedUnits = await BloodUnit.find(
		{
			'reservation.receiveRequestId': request._id,
			bloodbankId: bbObjectId,
			status: 'Reserved',
		},
		null,
		opts
	)

	const releasedUnits = []

	for (const unit of reservedUnits) {
		const isExpired = unit.expiryDate && new Date(unit.expiryDate) <= now

		if (isExpired) {
			unit.status = 'Expired'
			unit.reservation = {
				receiveRequestId: null,
				reservedAt: null,
				reservedExpiresAt: null,
			}
			await unit.save(opts)

			await recordAuditLog({
				unitId: unit._id,
				unitNumber: unit.unitNumber,
				bloodbankId: unit.bloodbankId,
				action: 'UNIT_EXPIRED',
				previousStatus: 'Reserved',
				newStatus: 'Expired',
				actorId,
				actorModel,
				ipAddress,
				reason: reason || 'Reservation hold elapsed on expired unit.',
				metadata: {
					receiveRequestId: request._id,
					expiredAt: unit.expiryDate,
				},
				session: opts.session,
			})
		} else {
			unit.status = 'Available'
			unit.reservation = {
				receiveRequestId: null,
				reservedAt: null,
				reservedExpiresAt: null,
			}
			await unit.save(opts)

			await recordAuditLog({
				unitId: unit._id,
				unitNumber: unit.unitNumber,
				bloodbankId: unit.bloodbankId,
				action: 'RESERVATION_RELEASED',
				previousStatus: 'Reserved',
				newStatus: 'Available',
				actorId,
				actorModel,
				ipAddress,
				reason: reason || 'Reservation released; unit returned to available inventory.',
				metadata: {
					receiveRequestId: request._id,
					releasedAt: now,
				},
				session: opts.session,
			})
		}

		releasedUnits.push(unit)
	}

	// Clear reserved references on request
	request.reservedUnitIds = []
	await request.save(opts)

	return {
		request,
		releasedUnits,
		releasedCount: releasedUnits.length,
	}
}

const {
	processExpiredReservations,
	parseWorkerConfig,
	startReservationExpiryWorker,
	stopReservationExpiryWorker,
	getWorkerStatus,
} = require('./reservationExpiryWorker')

module.exports = {
	findEligibleUnitsFEFO,
	reserveUnitsForRequest,
	releaseReservationForRequest,
	processExpiredReservations,
	parseWorkerConfig,
	startReservationExpiryWorker,
	stopReservationExpiryWorker,
	getWorkerStatus,
}
