const mongoose = require('mongoose')
const bloodStockController = require('../BloodStock/bloodStockController')
const catchAsync = require('../Utils/catchAsync')
const ReceiveRequests = require('./bloodReceiveModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const AppError = require('../Utils/appError')
const { withTransaction } = require('../Utils/transactionHelper')

const VALID_BLOOD_TYPES = [
	'A_Positive',
	'A_Negative',
	'B_Positive',
	'B_Negative',
	'AB_Positive',
	'AB_Negative',
	'O_Positive',
	'O_Negative',
]

const addRequest = catchAsync(async (req, res, next) => {
	const { bloodbankId, bloodType, unit, whenDoYouWant, message } = req.body

	if (!bloodbankId || !mongoose.Types.ObjectId.isValid(bloodbankId)) {
		return res.status(400).json({
			message: 'Valid bloodbankId is required.',
		})
	}

	const bloodbankExists = await Bloodbank.findById(bloodbankId)
	if (!bloodbankExists) {
		return res.status(404).json({
			message: 'Blood bank not found.',
		})
	}

	if (!bloodType || !VALID_BLOOD_TYPES.includes(bloodType)) {
		return res.status(400).json({
			message: `Valid bloodType is required. Allowed types: ${VALID_BLOOD_TYPES.join(', ')}`,
		})
	}

	const units = Math.floor(Number(unit))
	if (!units || units < 1 || isNaN(units)) {
		return res.status(400).json({
			message: 'Unit must be a positive integer of at least 1.',
		})
	}

	if (!whenDoYouWant) {
		return res.status(400).json({
			message: 'whenDoYouWant date is required.',
		})
	}

	const existingPending = await ReceiveRequests.findOne({
		userId: req.user._id,
		bloodbankId,
		status: { $in: ['Pending', 'Accepted'] },
	})

	if (existingPending) {
		return res.status(400).json({
			message: 'You already have an active request with this blood bank. Please await their response.',
		})
	}

	await ReceiveRequests.create({
		userId: req.user._id,
		bloodbankId,
		bloodType,
		unit: units,
		whenDoYouWant: new Date(whenDoYouWant),
		message: message || '',
		status: 'Pending',
	})

	return res.status(201).json({
		message: 'Request sent.',
	})
})

const acceptRequest = catchAsync(async (req, res, next) => {
	const { id } = req.body

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid request ID is required.',
		})
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : (req.bloodbankId || req.user._id)
	const request = await ReceiveRequests.findOne({
		_id: id,
		bloodbankId,
	})

	if (!request) {
		return res.status(404).json({
			message: 'Request not found.',
		})
	}

	if (request.status !== 'Pending') {
		return res.status(400).json({
			message: `Cannot accept request with status '${request.status}'. Only Pending requests can be accepted.`,
		})
	}

	request.status = 'Accepted'
	await request.save()

	return res.status(200).json({
		message: 'Request Accepted.',
	})
})

const rejectRequest = catchAsync(async (req, res, next) => {
	const { id, message } = req.body

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid request ID is required.',
		})
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : (req.bloodbankId || req.user._id)
	const actorId = req.staff ? req.staff._id : req.user._id

	return await withTransaction(async (session) => {
		const opts = session ? { session } : {}

		const request = await ReceiveRequests.findOne(
			{
				_id: id,
				bloodbankId,
			},
			null,
			opts
		)

		if (!request) {
			const err = new Error('Request not found.')
			err.statusCode = 404
			throw err
		}

		if (request.status === 'Fulfilled') {
			const err = new Error('Cannot reject an already fulfilled request.')
			err.statusCode = 400
			throw err
		}

		if (request.status === 'Rejected') {
			const err = new Error('Request is already rejected.')
			err.statusCode = 400
			throw err
		}

		if (Array.isArray(request.reservedUnitIds) && request.reservedUnitIds.length > 0) {
			const { releaseReservationForRequest } = require('../BloodUnit/reservationService')
			await releaseReservationForRequest({
				requestId: request._id,
				bloodbankId,
				actorId,
				actorModel: 'bloodbank',
				ipAddress: req.ip,
				reason: message || 'Rejected by Bloodbank.',
				session,
			})
		}

		request.status = 'Rejected'
		request.message = message || 'Rejected by Bloodbank.'
		await request.save(opts)

		return res.status(200).json({
			message: 'Request Rejected.',
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

const editReceiveRequest = catchAsync(async (req, res, next) => {
	const { id, whenDoYouWant, bloodType, unit } = req.body

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid request ID is required.',
		})
	}

	const request = await ReceiveRequests.findOne({
		_id: id,
		userId: req.user._id,
	})

	if (!request) {
		return res.status(404).json({
			message: 'Request not found.',
		})
	}

	if (request.status !== 'Pending') {
		return res.status(400).json({
			message: `Cannot edit request with status '${request.status}'. Only Pending requests can be edited.`,
		})
	}

	if (bloodType && !VALID_BLOOD_TYPES.includes(bloodType)) {
		return res.status(400).json({
			message: `Invalid blood type. Allowed types: ${VALID_BLOOD_TYPES.join(', ')}`,
		})
	}

	if (unit !== undefined) {
		const units = Math.floor(Number(unit))
		if (!units || units < 1 || isNaN(units)) {
			return res.status(400).json({
				message: 'Unit must be a positive integer of at least 1.',
			})
		}
		request.unit = units
	}

	if (whenDoYouWant) request.whenDoYouWant = new Date(whenDoYouWant)
	if (bloodType) request.bloodType = bloodType
	await request.save()

	return res.status(200).json({
		message: 'Request Edited.',
	})
})

const rejectRequestByUser = catchAsync(async (req, res, next) => {
	const { id, message } = req.body

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid request ID is required.',
		})
	}

	return await withTransaction(async (session) => {
		const opts = session ? { session } : {}

		const request = await ReceiveRequests.findOne(
			{
				_id: id,
				userId: req.user._id,
			},
			null,
			opts
		)

		if (!request) {
			const err = new Error('Request not found.')
			err.statusCode = 404
			throw err
		}

		if (request.status === 'Fulfilled') {
			const err = new Error('Cannot cancel an already fulfilled request.')
			err.statusCode = 400
			throw err
		}

		if (request.status === 'Rejected') {
			const err = new Error('Request is already cancelled.')
			err.statusCode = 400
			throw err
		}

		if (Array.isArray(request.reservedUnitIds) && request.reservedUnitIds.length > 0) {
			const { releaseReservationForRequest } = require('../BloodUnit/reservationService')
			await releaseReservationForRequest({
				requestId: request._id,
				bloodbankId: request.bloodbankId,
				actorId: req.user._id,
				actorModel: 'user',
				ipAddress: req.ip,
				reason: message || 'Cancelled by User.',
				session,
			})
		}

		request.status = 'Rejected'
		request.message = message || 'Cancelled by User.'
		await request.save(opts)

		return res.status(200).json({
			message: 'Request Rejected.',
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

const fulfilledRequest = catchAsync(async (req, res, next) => {
	const {
		id,
		bloodType,
		unit,
		whenDoYouWant,
		crossmatchResult,
		unitCrossmatches,
		recipientPatientName,
		hospitalName,
		dispatchNotes,
		isEmergency,
		emergencyReason,
	} = req.body

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid request ID is required.',
		})
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : (req.bloodbankId || req.user._id)
	const actorId = req.staff ? req.staff._id : req.user._id
	const staffId = req.staff ? req.staff._id : null
	const isMOVerified = !!(
		req.staff &&
		req.staff.role === 'Medical_Officer' &&
		req.staff.medicalLicense?.isVerified === true
	)

	return await withTransaction(async (session) => {
		const opts = session ? { session } : {}

		const request = await ReceiveRequests.findOne(
			{
				_id: id,
				bloodbankId,
			},
			null,
			opts
		)

		if (!request) {
			const err = new Error('Request not found.')
			err.statusCode = 404
			throw err
		}

		if (request.status === 'Fulfilled') {
			const err = new Error(
				'Request has already been fulfilled. Stock cannot be decremented repeatedly.'
			)
			err.statusCode = 400
			throw err
		}

		if (request.status === 'Rejected') {
			const err = new Error('Cannot fulfill a rejected request.')
			err.statusCode = 400
			throw err
		}

		const effectiveBloodType = bloodType || request.bloodType
		if (!effectiveBloodType || !VALID_BLOOD_TYPES.includes(effectiveBloodType)) {
			const err = new Error(
				`Valid Blood Type is required. Allowed types: ${VALID_BLOOD_TYPES.join(', ')}`
			)
			err.statusCode = 400
			throw err
		}

		const unitsToDeduct = Math.max(1, Number(unit) || Number(request.unit) || 1)
		const hasTraceableReservation =
			Array.isArray(request.reservedUnitIds) && request.reservedUnitIds.length > 0

		// If request has traceable reserved units, enforce reservation hold, compatibility and clinical shelf-life!
		if (hasTraceableReservation) {
			const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
			const { recordAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
			const reservedUnits = await BloodUnit.find(
				{
					_id: { $in: request.reservedUnitIds },
					bloodbankId,
				},
				null,
				opts
			)

			const now = new Date()
			for (const u of reservedUnits) {
				if (u.status !== 'Reserved') {
					const err = new Error(
						`Cannot fulfill request: Reserved unit '${u.unitNumber || u._id}' is no longer in Reserved status (current: ${u.status}).`
					)
					err.statusCode = 400
					throw err
				}
				if (u.issuance?.crossmatchResult === 'Incompatible') {
					const err = new Error(
						`Cannot fulfill request: Reserved unit '${u.unitNumber || u._id}' has an Incompatible crossmatch result. Incompatible units cannot be fulfilled.`
					)
					err.statusCode = 400
					throw err
				}
				if (u.expiryDate && new Date(u.expiryDate) <= now) {
					const err = new Error(
						`Cannot fulfill request: Reserved unit '${u.unitNumber || u._id}' has expired clinically.`
					)
					err.statusCode = 400
					throw err
				}
				if (
					u.reservation?.reservedExpiresAt &&
					new Date(u.reservation.reservedExpiresAt) <= now
				) {
					const err = new Error(
						`Cannot fulfill request: Reservation hold for unit '${u.unitNumber || u._id}' has expired.`
					)
					err.statusCode = 400
					throw err
				}
			}

			// All-or-nothing check: count of valid reserved units must satisfy requested unit count
			const requiredReservedCount = Number(unit) || reservedUnits.length
			if (reservedUnits.length < requiredReservedCount) {
				const err = new Error(
					`Cannot fulfill request: Insufficient reserved units. Request requires ${requiredReservedCount} unit(s), but only ${reservedUnits.length} unit(s) are reserved.`
				)
				err.statusCode = 400
				throw err
			}

			// Atomically issue reserved units and record immutable audit ledger entries
			for (const u of reservedUnits) {
				const previousStatus = u.status
				u.status = 'Issued'
				u.issuance = u.issuance || {}
				u.issuance.issuedToReceiveRequestId = request._id
				u.issuance.recipientPatientName = recipientPatientName || ''
				u.issuance.hospitalName = hospitalName || ''
				u.issuance.crossmatchResult = u.issuance.crossmatchResult || crossmatchResult || 'Compatible'
				u.issuance.issuedAt = now
				u.issuance.issuedBy = bloodbankId
				u.issuance.issuedByStaffId = staffId || null
				u.issuance.dispatchNotes = dispatchNotes || ''
				if (typeof u.save === 'function') {
					await u.save(opts)
				}

				if (typeof recordAuditLog === 'function') {
					await recordAuditLog({
						unitId: u._id,
						unitNumber: u.unitNumber,
						bloodbankId,
						action: 'UNIT_ISSUED',
						previousStatus,
						newStatus: 'Issued',
						actorId,
						actorModel: 'bloodbank',
						ipAddress: req.ip || null,
						reason: dispatchNotes || 'Unit clinically issued and released for receive request.',
						metadata: {
							receiveRequestId: request._id,
							recipientPatientName,
							hospitalName,
							crossmatchResult: u.issuance.crossmatchResult,
							staffId,
						},
						session: opts.session,
					}).catch(() => {})
				}
			}
		}

		// When request does NOT already have reserved units:
		if (!hasTraceableReservation) {
			let hasTraceableInventory = false
			if (mongoose.connection && mongoose.connection.readyState === 1) {
				const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
				hasTraceableInventory = !!(await BloodUnit.exists({ bloodbankId }, opts).catch(() => false))
			}

			if (hasTraceableInventory) {
				const { findEligibleUnitsFEFO, reserveUnitsForRequest } = require('../BloodUnit/reservationService')
				const { issueUnitsForRequest } = require('../BloodUnit/issuanceService')

				// Traceable Inventory Isolation: NEVER consume or decrement legacy aggregate stock!
				// 1. Verify availability of issue-eligible units via FEFO first
				const eligibleCandidates = await findEligibleUnitsFEFO({
					bloodbankId,
					bloodGroup: effectiveBloodType,
					requiredCount: unitsToDeduct,
					now: new Date(),
					options: opts,
				})

				if (eligibleCandidates.length < unitsToDeduct) {
					const err = new Error(
						`Cannot fulfill request: Insufficient verified, issue-eligible traceable units available for blood group '${effectiveBloodType}'. Required: ${unitsToDeduct}, available: ${eligibleCandidates.length}.`
					)
					err.statusCode = 400
					throw err
				}

				// 2. Clinical lifecycle guard: request must be in Accepted status before fulfillment
				if (request.status !== 'Accepted') {
					const err = new Error(
						`Cannot fulfill request: Receive request must be in 'Accepted' status before fulfillment (current status: '${request.status}').`
					)
					err.statusCode = 400
					throw err
				}

				// 3. Atomically reserve eligible units
				await reserveUnitsForRequest({
					requestId: request._id,
					bloodbankId,
					actorId,
					actorModel: 'bloodbank',
					ipAddress: req.ip || null,
					holdHours: 24,
					session,
				})

				// 4. Clinically issue reserved units
				await issueUnitsForRequest({
					requestId: request._id,
					bloodbankId,
					actorId,
					actorModel: 'bloodbank',
					staffId,
					isMOVerified,
					recipientPatientName: recipientPatientName || '',
					hospitalName: hospitalName || '',
					crossmatchResult: crossmatchResult || 'Compatible',
					unitCrossmatches: unitCrossmatches || null,
					dispatchNotes: dispatchNotes || '',
					isEmergency: isEmergency === true || crossmatchResult === 'Emergency_Uncrossmatched',
					emergencyReason: emergencyReason || '',
					ipAddress: req.ip || null,
					session,
				})

				return res.status(200).json({
					message: 'Request Fulfilled.',
				})
			} else {
				// Pure Legacy Fallback: Only executed when blood bank has 0 traceable units in DB
				const isAvailable = await bloodStockController.checkAvailability(
					bloodbankId,
					effectiveBloodType,
					unitsToDeduct,
					opts
				)
				if (!isAvailable) {
					const err = new Error(
						`Cannot fulfill request: Insufficient stock for blood type ${effectiveBloodType}.`
					)
					err.statusCode = 400
					throw err
				}

				const stockUpdated = await bloodStockController.decreaseStock(
					bloodbankId,
					effectiveBloodType,
					unitsToDeduct,
					opts
				)
				if (!stockUpdated) {
					const err = new Error(
						`Cannot fulfill request: Insufficient stock for blood type ${effectiveBloodType}.`
					)
					err.statusCode = 400
					throw err
				}
			}
		}

		// Transition request to Fulfilled
		const updated = await ReceiveRequests.findOneAndUpdate(
			{
				_id: id,
				bloodbankId,
				status: { $ne: 'Fulfilled' },
			},
			{
				status: 'Fulfilled',
				bloodType: effectiveBloodType,
				unit: unitsToDeduct,
				whenDoYouWant: whenDoYouWant ? new Date(whenDoYouWant) : request.whenDoYouWant,
			},
			{ new: true, ...opts }
		)

		if (!updated) {
			if (!session && !hasTraceableReservation) {
				await bloodStockController.increaseStock(
					bloodbankId,
					effectiveBloodType,
					unitsToDeduct
				)
			}
			const err = new Error('Request fulfillment conflict. Please refresh and retry.')
			err.statusCode = 400
			throw err
		}

		return res.status(200).json({
			message: 'Request Fulfilled.',
		})
	}).catch((err) => {
		return res.status(err.statusCode || 500).json({
			message: err.message,
		})
	})
})

const getUserData = catchAsync(async (req, res) => {
	const query = req.query

	const receiveRequests = await ReceiveRequests.find({ userId: req.user._id })
		.find(query)
		.populate({ path: 'bloodbankId' })

	const data = receiveRequests.map((element, index) => {
		return {
			_id: element._id,
			index: index + 1,
			bloodbankName: element.bloodbankId.bloodbankName,
			category: element.bloodbankId.category,
			contactPerson: element.bloodbankId.contactPerson,
			phoneNo1: element.bloodbankId.phoneNo1,
			email: element.bloodbankId.email,
			address:
				element.bloodbankId.address1 +
				' ' +
				element.bloodbankId.address2,
			pinCode: element.bloodbankId.pinCode,
			city: element.bloodbankId.city,
			state: element.bloodbankId.state,
			bloodType: element.bloodType,
			unit: element.unit,
			whenDoYouWant: element.whenDoYouWant,
			status: element.status,
			message: element.message,
		}
	})

	return res.status(200).json(data)
})

const getBloodbankData = catchAsync(async (req, res) => {
	const bloodbankId = req.staff ? req.staff.bloodbankId : (req.bloodbankId || req.user._id)
	const receiveRequests = await ReceiveRequests.find({
		bloodbankId,
	}).populate({ path: 'userId' })

	const data = receiveRequests.map((element, index) => {
		return {
			_id: element._id,
			index: index + 1,
			name: element.userId.firstName + ' ' + element.userId.lastName,
			dob: element.userId.dob,
			age: element.userId.age,
			phoneNo1: element.userId.phoneNo1,
			phoneNo2: element.userId.phoneNo2,
			email: element.userId.email,
			address: element.userId.address,
			pinCode: element.userId.pinCode,
			state: element.userId.state,
			city: element.userId.city,
			bloodType: element.bloodType,
			unit: element.unit,
			whenDoYouWant: element.whenDoYouWant,
			status: element.status,
			message: element.message,
		}
	})

	return res.status(200).json(data)
})

const getUserStates = catchAsync(async (req, res, next) => {
	const userStates = await ReceiveRequests.aggregate([
		{
			$match: {
				userId: req.user._id,
			},
		},
		{
			$group: {
				_id: 'donatestates',
				Pending: {
					$sum: {
						$cond: [{ $eq: ['$status', 'Pending'] }, 1, 0],
					},
				},
				Accepted: {
					$sum: {
						$cond: [{ $eq: ['$status', 'Accepted'] }, 1, 0],
					},
				},
				Rejected: {
					$sum: {
						$cond: [{ $eq: ['$status', 'Rejected'] }, 1, 0],
					},
				},
				Fulfilled: {
					$sum: {
						$cond: [{ $eq: ['$status', 'Fulfilled'] }, 1, 0],
					},
				},
			},
		},
	])

	return res.status(200).json(userStates)
})

const getBloodbankStates = catchAsync(async (req, res, next) => {
	const bloodbankId = req.staff ? req.staff.bloodbankId : (req.bloodbankId || req.user._id)
	const bbObjectId = mongoose.Types.ObjectId.isValid(bloodbankId)
		? new mongoose.Types.ObjectId(bloodbankId)
		: bloodbankId

	const userStates = await ReceiveRequests.aggregate([
		{
			$match: {
				bloodbankId: bbObjectId,
			},
		},
		{
			$group: {
				_id: 'donatestates',
				Pending: {
					$sum: {
						$cond: [{ $eq: ['$status', 'Pending'] }, 1, 0],
					},
				},
				Accepted: {
					$sum: {
						$cond: [{ $eq: ['$status', 'Accepted'] }, 1, 0],
					},
				},
				Rejected: {
					$sum: {
						$cond: [{ $eq: ['$status', 'Rejected'] }, 1, 0],
					},
				},
				Fulfilled: {
					$sum: {
						$cond: [{ $eq: ['$status', 'Fulfilled'] }, 1, 0],
					},
				},
			},
		},
	])

	return res.status(200).json(userStates)
})

const getBloodbankDataQuery = catchAsync(async (req, res, next) => {
	for (const key of Object.keys(req.query)) {
		if (key.startsWith('$') || key.includes('.')) {
			return res.status(400).json({
				message: `Forbidden query operator or key: '${key}'.`,
			})
		}
		const value = req.query[key]
		if (typeof value === 'object' && value !== null) {
			return res.status(400).json({
				message: `Invalid query parameter for '${key}'. Nested query objects are not allowed.`,
			})
		}
	}

	const bloodbankId = req.staff ? req.staff.bloodbankId : (req.bloodbankId || req.user._id)
	const filter = { bloodbankId }

	if (
		req.query.status &&
		['Pending', 'Accepted', 'Rejected', 'Fulfilled'].includes(req.query.status)
	) {
		filter.status = req.query.status
	}
	if (req.query.bloodType && VALID_BLOOD_TYPES.includes(req.query.bloodType)) {
		filter.bloodType = req.query.bloodType
	}

	const data = await ReceiveRequests.find(filter)
		.populate({
			path: 'userId',
			select:
				'firstName lastName gender dob age phoneNo1 phoneNo2 email state city address pinCode',
		})
		.sort({ createdAt: -1 })

	return res.status(200).json(data)
})

module.exports = {
	addRequest,
	acceptRequest,
	rejectRequest,
	editReceiveRequest,
	rejectRequestByUser,
	fulfilledRequest,
	getUserStates,
	getBloodbankStates,
	getUserData,
	getBloodbankData,
	getBloodbankDataQuery,
}
