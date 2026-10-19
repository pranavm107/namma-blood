const mongoose = require('mongoose')
const { BloodUnit } = require('./bloodUnitModel')
const { recordAuditLog } = require('./bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')

const VALID_DISCARD_REASONS = [
	'TTI_Reactive',
	'Expired',
	'Hemolysis',
	'Bag_Leakage',
	'Clotted',
	'Temperature_Excursion',
	'Other',
]

const ALLOWED_PRE_DISCARD_STATUSES = [
	'Quarantined',
	'Tested_Passed',
	'Available',
	'Reserved',
	'Expired',
]

/**
 * Executes an authorized biohazard or clinical discard of traceable blood units.
 *
 * Strict Concurrency & Clinical Invariants:
 * 1. RBAC & Actor Tracking: Records authenticated actor (staff or blood bank) and staff ID.
 * 2. Tenant Isolation: Units must belong strictly to the authenticated bloodbankId (BOLA guard).
 * 3. Required Clinical Reason: Must be one of VALID_DISCARD_REASONS.
 * 4. State Machine Guards: Only units in Quarantined, Tested_Passed, Available, Reserved, or Expired can be discarded.
 *    - Units already in 'Discarded' are rejected (duplicate discard prevention).
 *    - Units in 'Issued' or physically dispatched are rejected.
 * 5. Reservation Decoupling: If a Reserved unit is discarded, its reference is atomically pulled from
 *    ReceiveRequests.reservedUnitIds, and unit.reservation metadata is cleared.
 * 6. Concurrency Protection: Uses conditional locking inside multi-document transactions where supported.
 *    Concurrent issuance, dispatch, or duplicate discard causes transaction conflict and safe rollback.
 * 7. Immutable Audit Trail: Appends 'UNIT_DISCARDED' audit record within the transaction.
 * 8. Legacy Stock Isolation: Legacy aggregate Bloodstock is NEVER touched or decremented.
 *
 * @param {Object} options
 * @param {string|mongoose.Types.ObjectId|Array} options.unitIds - One or more unit ObjectIds or DIN strings
 * @param {string|mongoose.Types.ObjectId} options.bloodbankId - Owning blood bank ID
 * @param {string} options.reason - Clinical discard reason
 * @param {string} [options.wasteManifestNumber=''] - Regulated biohazard waste manifest tracking number
 * @param {string} [options.notes=''] - Additional clinical disposal notes
 * @param {string|mongoose.Types.ObjectId} options.actorId - Authorizing actor ID
 * @param {string} [options.actorModel='bloodbank'] - Authorizing actor model ('bloodbank')
 * @param {string|mongoose.Types.ObjectId} [options.staffId=null] - Individual staff member ID
 * @param {string} [options.ipAddress=null] - Client IP address
 * @param {mongoose.ClientSession} [options.session=null] - Database transaction session
 * @returns {Promise<Object>} Discard outcome and updated units
 */
async function discardBloodUnits({
	unitIds,
	bloodbankId,
	reason,
	wasteManifestNumber = '',
	notes = '',
	actorId,
	actorModel = 'bloodbank',
	staffId = null,
	ipAddress = null,
	session = null,
}) {
	const opts = session ? { session } : {}
	const now = new Date()

	if (!bloodbankId || !mongoose.Types.ObjectId.isValid(bloodbankId)) {
		const err = new Error('Valid bloodbankId is required for unit discard.')
		err.statusCode = 400
		throw err
	}
	const bbObjectId = new mongoose.Types.ObjectId(bloodbankId)

	// Validate Discard Reason
	if (!reason || typeof reason !== 'string' || !VALID_DISCARD_REASONS.includes(reason.trim())) {
		const err = new Error(
			`Discard reason is required and must be one of: ${VALID_DISCARD_REASONS.join(', ')}.`
		)
		err.statusCode = 400
		throw err
	}
	const validatedReason = reason.trim()

	// Normalize target unit IDs
	let targetIdentifiers = []
	if (Array.isArray(unitIds)) {
		targetIdentifiers = unitIds.filter((id) => Boolean(id))
	} else if (unitIds) {
		targetIdentifiers = [unitIds]
	}

	if (targetIdentifiers.length === 0) {
		const err = new Error('At least one blood unit identifier (ObjectId or DIN) is required for discard.')
		err.statusCode = 400
		throw err
	}

	// Resolve target units matching bloodbankId
	const objectIds = targetIdentifiers.filter((id) => mongoose.Types.ObjectId.isValid(id))
	const stringIdentifiers = targetIdentifiers.map((id) => String(id).trim().toUpperCase())

	const candidateUnits = await BloodUnit.find(
		{
			bloodbankId: bbObjectId,
			$or: [
				{ _id: { $in: objectIds } },
				{ unitNumber: { $in: stringIdentifiers } },
			],
		},
		null,
		opts
	)

	if (candidateUnits.length === 0) {
		const err = new Error('No matching blood units found belonging to your blood bank.')
		err.statusCode = 404
		throw err
	}

	if (candidateUnits.length !== targetIdentifiers.length) {
		const err = new Error(
			'One or more blood units could not be found or do not belong to your blood bank.'
		)
		err.statusCode = 404
		throw err
	}

	// Lifecycle State & Guard Checks
	for (const unit of candidateUnits) {
		// Duplicate discard guard
		if (unit.status === 'Discarded') {
			const err = new Error(
				`Cannot discard unit '${unit.unitNumber || unit._id}': Unit has already been discarded at ${unit.discard?.discardedAt?.toISOString() || 'earlier date'}. Duplicate discard is rejected.`
			)
			err.statusCode = 400
			throw err
		}

		// Issued / Dispatched guard
		if (unit.status === 'Issued' || unit.issuance?.dispatch?.isDispatched) {
			const err = new Error(
				`Cannot discard unit '${unit.unitNumber || unit._id}': Unit is in status '${unit.status}' (or already dispatched) and cannot be discarded from active inventory.`
			)
			err.statusCode = 400
			throw err
		}

		// Invalid status guard
		if (!ALLOWED_PRE_DISCARD_STATUSES.includes(unit.status)) {
			const err = new Error(
				`Invalid lifecycle transition: Cannot discard unit '${unit.unitNumber || unit._id}' in status '${unit.status}'. Allowed statuses: ${ALLOWED_PRE_DISCARD_STATUSES.join(', ')}.`
			)
			err.statusCode = 400
			throw err
		}
	}

	const sanitizedManifest = typeof wasteManifestNumber === 'string' ? wasteManifestNumber.trim().slice(0, 100) : ''
	const sanitizedNotes = typeof notes === 'string' ? notes.trim().slice(0, 500) : ''
	const staffObjectId = staffId && mongoose.Types.ObjectId.isValid(staffId) ? new mongoose.Types.ObjectId(staffId) : null

	const discardedUnits = []

	// Perform atomic conditional updates
	for (const candidate of candidateUnits) {
		const prevStatus = candidate.status

		// Atomic conditional match inside session
		const lockedUnit = await BloodUnit.findOne(
			{
				_id: candidate._id,
				bloodbankId: bbObjectId,
				status: { $in: ALLOWED_PRE_DISCARD_STATUSES },
			},
			null,
			opts
		)

		if (!lockedUnit) {
			const err = new Error(
				`Concurrent modification conflict: Unit '${candidate.unitNumber || candidate._id}' was concurrently modified, issued, or discarded by another transaction. Discard aborted.`
			)
			err.statusCode = 409
			throw err
		}

		// If unit was Reserved, decouple from associated receive request
		const associatedRequestId = lockedUnit.reservation?.receiveRequestId
		if (prevStatus === 'Reserved' && associatedRequestId) {
			await ReceiveRequests.findOneAndUpdate(
				{
					_id: associatedRequestId,
					bloodbankId: bbObjectId,
				},
				{
					$pull: { reservedUnitIds: lockedUnit._id },
				},
				opts
			)
		}

		// Mutate document fields
		lockedUnit.status = 'Discarded'
		lockedUnit.discard = {
			reason: validatedReason,
			discardedAt: now,
			discardedBy: bbObjectId,
			discardedByStaffId: staffObjectId,
			wasteManifestNumber: sanitizedManifest,
			discardNotes: sanitizedNotes,
		}

		if (prevStatus === 'Reserved') {
			lockedUnit.reservation = {
				receiveRequestId: null,
				reservedAt: null,
				reservedExpiresAt: null,
			}
		}

		await lockedUnit.save(opts)

		// Append non-repudiable audit event
		await recordAuditLog({
			unitId: lockedUnit._id,
			unitNumber: lockedUnit.unitNumber,
			bloodbankId: lockedUnit.bloodbankId,
			action: 'UNIT_DISCARDED',
			previousStatus: prevStatus,
			newStatus: 'Discarded',
			actorId: staffObjectId || bbObjectId,
			actorModel: staffObjectId ? 'bloodbank' : actorModel,
			ipAddress,
			reason: `Unit discarded: ${validatedReason}${sanitizedNotes ? ` - ${sanitizedNotes}` : ''}`,
			metadata: {
				discardReason: validatedReason,
				wasteManifestNumber: sanitizedManifest || null,
				discardNotes: sanitizedNotes || null,
				previousStatus: prevStatus,
				discardedByStaffId: staffObjectId ? String(staffObjectId) : null,
				associatedRequestId: associatedRequestId ? String(associatedRequestId) : null,
				discardedAt: now.toISOString(),
			},
			session: opts.session,
		})

		discardedUnits.push(lockedUnit)
	}

	return {
		success: true,
		discardedCount: discardedUnits.length,
		discardedAt: now,
		discardedUnits,
	}
}

/**
 * Scans available, tested passed, and quarantined shelf inventory for units that have exceeded
 * their clinical shelf-life expiry date, and transitions them to 'Expired'.
 *
 * @param {Object} options
 * @param {number} [options.batchSize=100] - Batch size limit (bounded 1–500)
 * @param {Date} [options.now=new Date()] - Time baseline
 * @param {string|mongoose.Types.ObjectId} [options.bloodbankId=null] - Optional tenant filter
 * @param {Object} [options.logger=console] - Logger interface
 * @param {mongoose.ClientSession} [options.session=null] - Optional transaction session
 * @returns {Promise<Object>} Execution summary
 */
async function processClinicallyExpiredInventory({
	batchSize = 100,
	now = new Date(),
	bloodbankId = null,
	logger = console,
	session = null,
} = {}) {
	const startTime = Date.now()
	const effectiveNow = now instanceof Date ? now : new Date(now)
	const boundedLimit = Math.max(1, Math.min(Number(batchSize) || 100, 500))
	const opts = session ? { session } : {}

	const query = {
		status: { $in: ['Available', 'Tested_Passed', 'Quarantined'] },
		expiryDate: { $lte: effectiveNow },
	}

	if (bloodbankId) {
		query.bloodbankId = mongoose.Types.ObjectId.isValid(bloodbankId)
			? new mongoose.Types.ObjectId(bloodbankId)
			: bloodbankId
	}

	const candidates = await BloodUnit.find(query, null, opts)
		.sort({ expiryDate: 1, _id: 1 })
		.limit(boundedLimit)

	let processedCount = 0
	let skippedCount = 0
	let failedCount = 0
	const errors = []
	const expiredUnits = []

	for (const candidate of candidates) {
		try {
			const prevStatus = candidate.status
			const locked = await BloodUnit.findOne(
				{
					_id: candidate._id,
					bloodbankId: candidate.bloodbankId,
					status: { $in: ['Available', 'Tested_Passed', 'Quarantined'] },
					expiryDate: { $lte: effectiveNow },
				},
				null,
				opts
			)

			if (!locked) {
				skippedCount++
				continue
			}

			locked.status = 'Expired'
			await locked.save(opts)

			await recordAuditLog({
				unitId: locked._id,
				unitNumber: locked.unitNumber,
				bloodbankId: locked.bloodbankId,
				action: 'UNIT_EXPIRED',
				previousStatus: prevStatus,
				newStatus: 'Expired',
				actorId: locked.bloodbankId,
				actorModel: 'bloodbank',
				reason: `Unit exceeded clinical shelf-life (${locked.expiryDate.toISOString()}). Automatically transitioned to Expired.`,
				metadata: {
					previousStatus: prevStatus,
					expiryDate: locked.expiryDate.toISOString(),
					expiredAt: effectiveNow.toISOString(),
					executedByWorker: true,
				},
				session: opts.session,
			})

			expiredUnits.push(locked)
			processedCount++
		} catch (err) {
			failedCount++
			errors.push({ unitId: candidate._id, error: err.message })
			if (logger && typeof logger.error === 'function') {
				logger.error(
					`[ExpiryService] Failed to expire unit '${candidate.unitNumber || candidate._id}': ${err.message}`
				)
			}
		}
	}

	return {
		success: failedCount === 0,
		candidatesFound: candidates.length,
		processedCount,
		skippedCount,
		failedCount,
		errors,
		expiredUnits,
		durationMs: Date.now() - startTime,
	}
}

module.exports = {
	VALID_DISCARD_REASONS,
	ALLOWED_PRE_DISCARD_STATUSES,
	discardBloodUnits,
	processClinicallyExpiredInventory,
}
