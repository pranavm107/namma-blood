const mongoose = require('mongoose')
const { BloodUnit, MANDATORY_TTI_TESTS } = require('./bloodUnitModel')
const { recordAuditLog } = require('./bloodUnitAuditModel')
const ReceiveRequests = require('../BloodReceive/bloodReceiveModel')

const VALID_CROSSMATCH_RESULTS = [
	'Compatible',
	'Incompatible',
	'Emergency_Uncrossmatched',
]

/**
 * Validates crossmatch compatibility status for issuance.
 *
 * Hardened Clinical Safety & Governance Rules:
 * 1. 'Compatible': Clinically confirmed compatible. Issue-eligible.
 * 2. 'Emergency_Uncrossmatched': Permitted strictly under genuine emergency protocol.
 *    - REQUIRES verified Medical Officer authorization (isMOVerified === true).
 *    - REQUIRES explicit clinical justification (emergencyReason min 10 characters).
 *    - Fails closed if authorization or justification cannot be established.
 * 3. 'Incompatible': Strictly FORBIDDEN under all circumstances. Transfusion of incompatible
 *    blood causes fatal acute hemolytic transfusion reactions (AHTR).
 * 4. 'Pending' / Missing: Strictly FORBIDDEN. Blood cannot be issued without confirmed compatibility.
 */
function validateCrossmatchResult(
	result,
	{ isEmergency = false, emergencyReason = '', isMOVerified = false } = {}
) {
	if (!result || typeof result !== 'string' || !result.trim()) {
		const err = new Error(
			'Crossmatch validation failure: Recorded, valid crossmatch result is required before issuance. Crossmatch cannot be empty or missing.'
		)
		err.statusCode = 400
		throw err
	}

	const normalized = result.trim()

	if (normalized === 'Pending') {
		const err = new Error(
			"Crossmatch validation failure: Crossmatch result is 'Pending'. Blood units cannot be issued until compatibility testing is concluded."
		)
		err.statusCode = 400
		throw err
	}

	if (normalized === 'Incompatible') {
		const err = new Error(
			"Clinical safety violation: Crossmatch result is 'Incompatible'. Incompatible blood units can NEVER be issued or dispatched under any circumstances."
		)
		err.statusCode = 400
		throw err
	}

	if (normalized === 'Emergency_Uncrossmatched') {
		if (!isEmergency) {
			const err = new Error(
				"Clinical safety violation: Unit marked 'Emergency_Uncrossmatched' requires explicit emergency protocol authorization (isEmergency: true) for dispatch."
			)
			err.statusCode = 400
			throw err
		}

		if (!isMOVerified) {
			const err = new Error(
				'Access forbidden: Emergency uncrossmatched blood issuance strictly requires authorization by a verified Medical Officer.'
			)
			err.statusCode = 403
			throw err
		}

		if (
			!emergencyReason ||
			typeof emergencyReason !== 'string' ||
			emergencyReason.trim().length < 10
		) {
			const err = new Error(
				'Clinical safety violation: Emergency uncrossmatched blood issuance requires clinical justification (emergencyReason of at least 10 characters).'
			)
			err.statusCode = 400
			throw err
		}

		return 'Emergency_Uncrossmatched'
	}

	if (normalized === 'Compatible') {
		return 'Compatible'
	}

	const err = new Error(
		`Invalid crossmatch result '${result}'. Valid values are: ${VALID_CROSSMATCH_RESULTS.join(', ')}.`
	)
	err.statusCode = 400
	throw err
}

/**
 * Records or updates laboratory crossmatch results on a specific blood unit.
 *
 * Integrity Invariants:
 * 1. BOLA defense: Unit must belong to bloodbankId.
 * 2. Status guard: Unit must be in 'Reserved' or 'Available' status.
 * 3. Overwrite Protection: A confirmed 'Incompatible' crossmatch result can NEVER be
 *    overwritten to 'Compatible' to bypass a failed compatibility test.
 * 4. Request Binding: If unit is reserved, crossmatch is bound strictly to that request.
 * 5. Immutable Ledger: Appends an append-only audit event inside the database transaction.
 */
async function recordCrossmatchForUnit({
	unitId,
	receiveRequestId = null,
	bloodbankId,
	actorId,
	actorModel = 'bloodbank',
	staffId = null,
	ipAddress = null,
	crossmatchResult,
	notes = '',
	session = null,
}) {
	const opts = session ? { session } : {}
	const bbObjectId = mongoose.Types.ObjectId.isValid(bloodbankId)
		? new mongoose.Types.ObjectId(bloodbankId)
		: bloodbankId

	if (!unitId || !mongoose.Types.ObjectId.isValid(unitId)) {
		const err = new Error('Valid unitId is required.')
		err.statusCode = 400
		throw err
	}

	const unit = await BloodUnit.findOne(
		{
			_id: unitId,
			bloodbankId: bbObjectId,
		},
		null,
		opts
	)

	if (!unit) {
		const err = new Error('Blood unit not found or not owned by your blood bank.')
		err.statusCode = 404
		throw err
	}

	if (['Issued', 'Discarded', 'Expired'].includes(unit.status)) {
		const err = new Error(
			`Cannot record crossmatch on a unit in status '${unit.status}'.`
		)
		err.statusCode = 400
		throw err
	}

	if (unit.expiryDate && new Date(unit.expiryDate) <= new Date()) {
		const err = new Error('Cannot record crossmatch on an expired blood unit.')
		err.statusCode = 400
		throw err
	}

	// Verify request binding if provided
	if (receiveRequestId && mongoose.Types.ObjectId.isValid(receiveRequestId)) {
		if (
			unit.reservation?.receiveRequestId &&
			unit.reservation.receiveRequestId.toString() !== receiveRequestId.toString()
		) {
			const err = new Error(
				'Wrong request/unit association: Unit is reserved for a different receive request.'
			)
			err.statusCode = 400
			throw err
		}
	}

	// Overwrite Protection: Failed Incompatible result can NEVER be downgraded/bypassed
	if (
		unit.issuance?.crossmatchResult === 'Incompatible' &&
		crossmatchResult !== 'Incompatible'
	) {
		const err = new Error(
			"Clinical safety violation: Unit has a confirmed 'Incompatible' crossmatch result for this recipient. Failed crossmatch results cannot be overwritten to bypass compatibility gates."
		)
		err.statusCode = 400
		throw err
	}

	const normalizedResult = crossmatchResult ? crossmatchResult.trim() : ''
	if (!VALID_CROSSMATCH_RESULTS.includes(normalizedResult) && normalizedResult !== 'Pending') {
		const err = new Error(
			`Invalid crossmatch result '${crossmatchResult}'. Allowed values: ${VALID_CROSSMATCH_RESULTS.join(', ')}.`
		)
		err.statusCode = 400
		throw err
	}

	unit.issuance = unit.issuance || {}
	unit.issuance.crossmatchResult = normalizedResult
	if (notes) {
		unit.issuance.dispatchNotes = notes.trim().substring(0, 500)
	}

	await unit.save(opts)

	// Record immutable audit entry
	await recordAuditLog({
		unitId: unit._id,
		unitNumber: unit.unitNumber,
		bloodbankId: bbObjectId,
		action: 'CROSSMATCH_RECORDED',
		previousStatus: unit.status,
		newStatus: unit.status,
		actorId: actorId || bbObjectId,
		actorModel: actorModel || 'bloodbank',
		ipAddress: ipAddress || null,
		reason: notes || `Crossmatch recorded as '${normalizedResult}'.`,
		metadata: {
			receiveRequestId: unit.reservation?.receiveRequestId || receiveRequestId,
			crossmatchResult: normalizedResult,
			staffId: staffId || null,
		},
		session: opts.session,
	})

	return unit
}

/**
 * Safely, atomically issues reserved blood units.
 *
 * Strict Concurrency & Clinical Invariants:
 * 1. Multi-Tenant Scoping: Request must exist and belong to bloodbankId (BOLA defense).
 * 2. Request Lifecycle Guard: Request must be in 'Accepted' status. An ineligible 'Pending' request
 *    can NEVER be transitioned directly to 'Fulfilled'.
 * 3. All-or-Nothing Sufficiency: All units requested (request.unit) must be reserved and valid.
 * 4. Reserved Unit Validation: Every unit in request.reservedUnitIds must:
 *    - Exist and belong to bloodbankId.
 *    - Be in 'Reserved' status.
 *    - Be assigned strictly to this receiveRequestId (wrong-request association guard).
 *    - Be clinically unexpired (expiryDate > now).
 *    - Have an active reservation hold (reservedExpiresAt > now).
 *    - Have verified Medical Officer clearance (clearance.isVerified === true).
 *    - Have all 5 mandatory TTI tests confirmed Non_Reactive.
 * 5. Crossmatch Verification: Every unit must have a recorded or submitted valid crossmatch
 *    ('Compatible' or authorized 'Emergency_Uncrossmatched'). Incompatible or Pending blood is blocked.
 * 6. Emergency Issuance Governance: 'Emergency_Uncrossmatched' strictly requires verified MO authorization
 *    and non-empty clinical justification (emergencyReason).
 * 7. Atomic Conditional Update: Each unit transitions from 'Reserved' -> 'Issued' via conditional
 *    database update checking status, shelf-life, and active hold ($or hold expiry > now).
 * 8. Non-Repudiable Audit: An immutable 'UNIT_ISSUED' log entry is appended inside the database transaction.
 * 9. Legacy Stock Isolation: Legacy aggregate counters are NEVER decremented or mutated.
 * 10. Operational Decoupling: Clinical issuance (status: 'Issued') does not prematurely record physical
 *     dispatch handoff.
 */
async function issueUnitsForRequest({
	requestId,
	bloodbankId,
	actorId,
	actorModel = 'bloodbank',
	staffId = null,
	isMOVerified = false,
	recipientPatientName = '',
	hospitalName = '',
	crossmatchResult = null,
	unitCrossmatches = null,
	dispatchNotes = '',
	isEmergency = false,
	emergencyReason = '',
	ipAddress = null,
	session = null,
}) {
	const opts = session ? { session } : {}
	const now = new Date()

	if (!requestId || !mongoose.Types.ObjectId.isValid(requestId)) {
		const err = new Error('Valid requestId is required for issuance.')
		err.statusCode = 400
		throw err
	}

	const bbObjectId = mongoose.Types.ObjectId.isValid(bloodbankId)
		? new mongoose.Types.ObjectId(bloodbankId)
		: bloodbankId

	// 1. Locate and lock receive request inside session
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
		const err = new Error(
			'Cannot issue units: Request has already been fulfilled. Duplicate issuance is rejected.'
		)
		err.statusCode = 400
		throw err
	}

	if (request.status === 'Rejected') {
		const err = new Error('Cannot issue units for a rejected request.')
		err.statusCode = 400
		throw err
	}

	// Request Lifecycle State Guard: Ineligible 'Pending' requests cannot be directly fulfilled
	if (request.status !== 'Accepted') {
		const err = new Error(
			`Cannot issue units: Receive request must be in 'Accepted' status before issuance (current status: '${request.status}').`
		)
		err.statusCode = 400
		throw err
	}

	// 2. Validate reserved traceable units & full sufficiency
	const requiredCount = Math.floor(Number(request.unit)) || 1
	if (!Array.isArray(request.reservedUnitIds) || request.reservedUnitIds.length < requiredCount) {
		const err = new Error(
			`Cannot issue units: Insufficient reserved units. Request requires ${requiredCount} unit(s), but only ${request.reservedUnitIds?.length || 0} unit(s) are reserved.`
		)
		err.statusCode = 400
		throw err
	}

	const reservedUnits = await BloodUnit.find(
		{
			_id: { $in: request.reservedUnitIds },
			bloodbankId: bbObjectId,
		},
		null,
		opts
	)

	if (reservedUnits.length !== request.reservedUnitIds.length) {
		const err = new Error(
			'Cannot issue units: One or more reserved units could not be found or do not belong to your blood bank.'
		)
		err.statusCode = 400
		throw err
	}

	// Build crossmatch lookup map if per-unit crossmatches provided
	const crossmatchMap = new Map()
	if (Array.isArray(unitCrossmatches)) {
		for (const item of unitCrossmatches) {
			if (item && item.unitId) {
				crossmatchMap.set(item.unitId.toString(), item.crossmatchResult)
			}
		}
	} else if (unitCrossmatches && typeof unitCrossmatches === 'object') {
		for (const [key, val] of Object.entries(unitCrossmatches)) {
			crossmatchMap.set(key.toString(), val)
		}
	}

	// Pre-validate all units before starting mutations
	const unitsToIssue = []
	for (const unit of reservedUnits) {
		// Status check
		if (unit.status !== 'Reserved') {
			const err = new Error(
				`Cannot issue unit '${unit.unitNumber || unit._id}': unit status is '${unit.status}', must be 'Reserved'.`
			)
			err.statusCode = 400
			throw err
		}

		// Wrong request association check
		const assignedRequestId = unit.reservation?.receiveRequestId?.toString()
		if (assignedRequestId !== request._id.toString()) {
			const err = new Error(
				`Wrong request/unit association: Unit '${unit.unitNumber || unit._id}' is reserved for a different receive request (${assignedRequestId}).`
			)
			err.statusCode = 400
			throw err
		}

		// Clinical shelf-life check
		if (unit.expiryDate && new Date(unit.expiryDate) <= now) {
			const err = new Error(
				`Clinical safety violation: Unit '${unit.unitNumber || unit._id}' has expired clinically (${unit.expiryDate.toISOString()}). Expired blood cannot be issued.`
			)
			err.statusCode = 400
			throw err
		}

		// Reservation hold check
		if (
			unit.reservation?.reservedExpiresAt &&
			new Date(unit.reservation.reservedExpiresAt) <= now
		) {
			const err = new Error(
				`Reservation hold expired: Hold for unit '${unit.unitNumber || unit._id}' elapsed at ${new Date(unit.reservation.reservedExpiresAt).toISOString()}. Re-allocation is required.`
			)
			err.statusCode = 400
			throw err
		}

		// Clearance check
		if (!unit.clearance?.isVerified) {
			const err = new Error(
				`Safety violation: Unit '${unit.unitNumber || unit._id}' has not received verified Medical Officer clearance.`
			)
			err.statusCode = 400
			throw err
		}

		// Mandatory TTI Screening Panel check
		if (!unit.testing) {
			const err = new Error(
				`Safety violation: Unit '${unit.unitNumber || unit._id}' is missing TTI screening results.`
			)
			err.statusCode = 400
			throw err
		}
		for (const test of MANDATORY_TTI_TESTS) {
			if (unit.testing[test] !== 'Non_Reactive') {
				const err = new Error(
					`Safety violation: Unit '${unit.unitNumber || unit._id}' has non-cleared screening test '${test}' ('${unit.testing[test]}'). Must be 'Non_Reactive'.`
				)
				err.statusCode = 400
				throw err
			}
		}

		// Crossmatch validation & Overwrite protection
		if (unit.issuance?.crossmatchResult === 'Incompatible') {
			const err = new Error(
				`Clinical safety violation: Unit '${unit.unitNumber || unit._id}' has a recorded 'Incompatible' crossmatch result for this recipient. Incompatible blood units can NEVER be issued or dispatched under any circumstances.`
			)
			err.statusCode = 400
			throw err
		}

		const unitSpecificResult =
			crossmatchMap.get(unit._id.toString()) ||
			crossmatchMap.get(unit.unitNumber) ||
			crossmatchResult ||
			unit.issuance?.crossmatchResult

		const validatedCrossmatch = validateCrossmatchResult(unitSpecificResult, {
			isEmergency,
			emergencyReason,
			isMOVerified,
		})

		unitsToIssue.push({
			unit,
			crossmatchResult: validatedCrossmatch,
		})
	}

	// Sanitize recipient and dispatch metadata
	const sanitizedRecipient =
		typeof recipientPatientName === 'string'
			? recipientPatientName.trim().substring(0, 100)
			: ''
	const sanitizedHospital =
		typeof hospitalName === 'string'
			? hospitalName.trim().substring(0, 200)
			: ''
	const sanitizedNotes =
		typeof dispatchNotes === 'string'
			? dispatchNotes.trim().substring(0, 500)
			: ''
	const sanitizedEmergencyReason =
		typeof emergencyReason === 'string'
			? emergencyReason.trim().substring(0, 500)
			: ''

	// 3. Atomically update each unit and record audit logs
	const issuedUnits = []
	const modifiedUnitIds = []

	try {
		for (const { unit, crossmatchResult: unitCrossmatch } of unitsToIssue) {
			const filter = {
				_id: unit._id,
				bloodbankId: bbObjectId,
				status: 'Reserved',
				'reservation.receiveRequestId': request._id,
				'issuance.crossmatchResult': { $ne: 'Incompatible' },
				expiryDate: { $gt: now },
				'clearance.isVerified': true,
				'testing.hiv': 'Non_Reactive',
				'testing.hbv': 'Non_Reactive',
				'testing.hcv': 'Non_Reactive',
				'testing.syphilis': 'Non_Reactive',
				'testing.malaria': 'Non_Reactive',
				$or: [
					{ 'reservation.reservedExpiresAt': null },
					{ 'reservation.reservedExpiresAt': { $gt: now } },
				],
			}

			const update = {
				$set: {
					status: 'Issued',
					'issuance.issuedToReceiveRequestId': request._id,
					'issuance.recipientPatientName': sanitizedRecipient,
					'issuance.hospitalName': sanitizedHospital,
					'issuance.crossmatchResult': unitCrossmatch,
					'issuance.issuedAt': now,
					'issuance.issuedBy': bbObjectId,
					'issuance.issuedByStaffId': staffId || null,
					'issuance.emergency.isEmergency': isEmergency === true,
					'issuance.emergency.emergencyReason': isEmergency ? sanitizedEmergencyReason : '',
					'issuance.emergency.authorizedByStaffId': isEmergency ? (staffId || null) : null,
					'issuance.emergency.authorizedAt': isEmergency ? now : null,
					'issuance.dispatch.isDispatched': false,
					'issuance.dispatch.dispatchedAt': null,
					'issuance.dispatch.dispatchedByStaffId': null,
					'issuance.dispatch.dispatchedToRecipient': '',
					'issuance.dispatch.transportBoxId': '',
					'issuance.dispatch.dispatchNotes': sanitizedNotes,
					'issuance.dispatchedByStaffId': null,
					'issuance.dispatchNotes': sanitizedNotes,
				},
			}

			const locked = await BloodUnit.findOneAndUpdate(filter, update, {
				new: true,
				...opts,
			})

			if (!locked) {
				const err = new Error(
					`Concurrent issuance conflict: Unit '${unit.unitNumber || unit._id}' was modified, hold expired, or already issued by another transaction. Issuance aborted.`
				)
				err.statusCode = 409
				throw err
			}

			modifiedUnitIds.push(unit._id)
			issuedUnits.push(locked)

			// Record append-only immutable audit entry for clinical issuance
			await recordAuditLog({
				unitId: locked._id,
				unitNumber: locked.unitNumber,
				bloodbankId: bbObjectId,
				action: 'UNIT_ISSUED',
				previousStatus: 'Reserved',
				newStatus: 'Issued',
				actorId: actorId || bbObjectId,
				actorModel: actorModel || 'bloodbank',
				ipAddress: ipAddress || null,
				reason: sanitizedNotes || 'Unit clinically issued and released for receive request.',
				metadata: {
					receiveRequestId: request._id,
					recipientPatientName: sanitizedRecipient,
					hospitalName: sanitizedHospital,
					crossmatchResult: unitCrossmatch,
					isEmergency,
					emergencyReason: isEmergency ? sanitizedEmergencyReason : undefined,
					issuedAt: now,
					staffId: staffId || null,
				},
				session: opts.session,
			})
		}

		// 4. Atomically transition ReceiveRequest to Fulfilled
		const updatedRequest = await ReceiveRequests.findOneAndUpdate(
			{
				_id: request._id,
				bloodbankId: bbObjectId,
				status: 'Accepted',
			},
			{
				$set: {
					status: 'Fulfilled',
				},
			},
			{ new: true, ...opts }
		)

		if (!updatedRequest) {
			const err = new Error(
				'Request fulfillment conflict: Receive request was modified or fulfilled concurrently.'
			)
			err.statusCode = 409
			throw err
		}

		return {
			request: updatedRequest,
			issuedUnits,
			issuedCount: issuedUnits.length,
			recipientPatientName: sanitizedRecipient,
			hospitalName: sanitizedHospital,
			isEmergency,
			emergencyReason: sanitizedEmergencyReason,
			issuedAt: now,
		}
	} catch (err) {
		// Non-production standalone compensating rollback
		if (!session && modifiedUnitIds.length > 0) {
			for (const id of modifiedUnitIds) {
				await BloodUnit.updateOne(
					{ _id: id, bloodbankId: bbObjectId },
					{
						$set: {
							status: 'Reserved',
							'issuance.issuedToReceiveRequestId': null,
							'issuance.issuedAt': null,
							'issuance.emergency.isEmergency': false,
						},
					}
				).catch(() => {})
			}
		}
		throw err
	}
}

/**
 * Records physical dispatch of issued blood units to courier / transport / hospital.
 *
 * Operational Governance Invariants:
 * 1. Status Guard: Unit MUST already be in 'Issued' status.
 * 2. Dispatch Guard: Unit cannot be dispatched repeatedly (dispatch.isDispatched !== true).
 * 3. Actual Dispatcher Tracking: Records actual dispatcher staff ID (staffId), NOT the authorizer's ID.
 * 4. Chain-of-Custody Metadata: Captures recipient/courier name, cold-chain transport box ID, notes.
 * 5. Immutable Ledger: Appends 'UNIT_DISPATCHED' audit log.
 */
async function recordPhysicalDispatch({
	requestId = null,
	unitIds = null,
	bloodbankId,
	actorId,
	actorModel = 'bloodbank',
	staffId = null,
	dispatchedToRecipient = '',
	transportBoxId = '',
	dispatchNotes = '',
	ipAddress = null,
	session = null,
}) {
	const opts = session ? { session } : {}
	const now = new Date()

	const bbObjectId = mongoose.Types.ObjectId.isValid(bloodbankId)
		? new mongoose.Types.ObjectId(bloodbankId)
		: bloodbankId

	let targetUnitIds = []
	if (Array.isArray(unitIds) && unitIds.length > 0) {
		targetUnitIds = unitIds.map((id) =>
			mongoose.Types.ObjectId.isValid(id) ? new mongoose.Types.ObjectId(id) : id
		)
	} else if (requestId && mongoose.Types.ObjectId.isValid(requestId)) {
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
		targetUnitIds = request.reservedUnitIds || []
	} else {
		const err = new Error('Valid requestId or array of unitIds is required for physical dispatch.')
		err.statusCode = 400
		throw err
	}

	if (targetUnitIds.length === 0) {
		const err = new Error('No blood units found to physically dispatch.')
		err.statusCode = 400
		throw err
	}

	const sanitizedRecipient =
		typeof dispatchedToRecipient === 'string'
			? dispatchedToRecipient.trim().substring(0, 150)
			: ''
	const sanitizedTransportBox =
		typeof transportBoxId === 'string'
			? transportBoxId.trim().substring(0, 100)
			: ''
	const sanitizedNotes =
		typeof dispatchNotes === 'string'
			? dispatchNotes.trim().substring(0, 500)
			: ''

	// Verify all target units
	const units = await BloodUnit.find(
		{
			_id: { $in: targetUnitIds },
			bloodbankId: bbObjectId,
		},
		null,
		opts
	)

	if (units.length !== targetUnitIds.length) {
		const err = new Error(
			'One or more units could not be found or do not belong to your blood bank.'
		)
		err.statusCode = 400
		throw err
	}

	for (const unit of units) {
		if (unit.status !== 'Issued') {
			const err = new Error(
				`Cannot dispatch unit '${unit.unitNumber || unit._id}': Unit must be in 'Issued' status before physical dispatch (current status: '${unit.status}').`
			)
			err.statusCode = 400
			throw err
		}

		if (unit.issuance?.dispatch?.isDispatched) {
			const err = new Error(
				`Unit '${unit.unitNumber || unit._id}' has already been physically dispatched at ${unit.issuance.dispatch.dispatchedAt?.toISOString()}. Duplicate dispatch is rejected.`
			)
			err.statusCode = 400
			throw err
		}
	}

	const dispatchedUnits = []
	for (const unit of units) {
		const locked = await BloodUnit.findOneAndUpdate(
			{
				_id: unit._id,
				bloodbankId: bbObjectId,
				status: 'Issued',
				'issuance.dispatch.isDispatched': { $ne: true },
			},
			{
				$set: {
					'issuance.dispatch.isDispatched': true,
					'issuance.dispatch.dispatchedAt': now,
					'issuance.dispatch.dispatchedBy': bbObjectId,
					'issuance.dispatch.dispatchedByStaffId': staffId || null,
					'issuance.dispatch.dispatchedToRecipient': sanitizedRecipient,
					'issuance.dispatch.transportBoxId': sanitizedTransportBox,
					'issuance.dispatch.dispatchNotes': sanitizedNotes,
					'issuance.dispatchedByStaffId': staffId || null,
					'issuance.dispatchNotes': sanitizedNotes,
				},
			},
			{ new: true, ...opts }
		)

		if (!locked) {
			const err = new Error(
				`Concurrent dispatch conflict: Unit '${unit.unitNumber || unit._id}' was already dispatched or modified concurrently.`
			)
			err.statusCode = 409
			throw err
		}

		dispatchedUnits.push(locked)

		// Record append-only immutable audit entry for physical dispatch
		await recordAuditLog({
			unitId: locked._id,
			unitNumber: locked.unitNumber,
			bloodbankId: bbObjectId,
			action: 'UNIT_DISPATCHED',
			previousStatus: 'Issued',
			newStatus: 'Issued',
			actorId: actorId || bbObjectId,
			actorModel: actorModel || 'bloodbank',
			ipAddress: ipAddress || null,
			reason: sanitizedNotes || 'Blood unit physically handed off for transport/dispatch.',
			metadata: {
				receiveRequestId: locked.issuance?.issuedToReceiveRequestId,
				dispatchedToRecipient: sanitizedRecipient,
				transportBoxId: sanitizedTransportBox,
				dispatchedByStaffId: staffId || null,
				dispatchedAt: now,
			},
			session: opts.session,
		})
	}

	return {
		dispatchedUnits,
		dispatchedCount: dispatchedUnits.length,
		dispatchedAt: now,
		dispatchedToRecipient: sanitizedRecipient,
		transportBoxId: sanitizedTransportBox,
	}
}

module.exports = {
	VALID_CROSSMATCH_RESULTS,
	validateCrossmatchResult,
	recordCrossmatchForUnit,
	issueUnitsForRequest,
	recordPhysicalDispatch,
}
