const mongoose = require('mongoose')
const bloodStockController = require('../BloodStock/bloodStockController')
const catchAsync = require('../Utils/catchAsync')
const ReceiveRequests = require('./bloodReceiveModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const AppError = require('../Utils/appError')

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

	const request = await ReceiveRequests.findOne({
		_id: id,
		bloodbankId: req.user._id,
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

	const request = await ReceiveRequests.findOne({
		_id: id,
		bloodbankId: req.user._id,
	})

	if (!request) {
		return res.status(404).json({
			message: 'Request not found.',
		})
	}

	if (request.status === 'Fulfilled') {
		return res.status(400).json({
			message: 'Cannot reject an already fulfilled request.',
		})
	}

	if (request.status === 'Rejected') {
		return res.status(400).json({
			message: 'Request is already rejected.',
		})
	}

	request.status = 'Rejected'
	request.message = message || 'Rejected by Bloodbank.'
	await request.save()

	return res.status(200).json({
		message: 'Request Rejected.',
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

	const request = await ReceiveRequests.findOne({
		_id: id,
		userId: req.user._id,
	})

	if (!request) {
		return res.status(404).json({
			message: 'Request not found.',
		})
	}

	if (request.status === 'Fulfilled') {
		return res.status(400).json({
			message: 'Cannot cancel an already fulfilled request.',
		})
	}

	if (request.status === 'Rejected') {
		return res.status(400).json({
			message: 'Request is already cancelled.',
		})
	}

	request.status = 'Rejected'
	request.message = message || 'Cancelled by User.'
	await request.save()

	return res.status(200).json({
		message: 'Request Rejected.',
	})
})

const { withTransaction } = require('../Utils/transactionHelper')

const fulfilledRequest = catchAsync(async (req, res, next) => {
	const { id, bloodType, unit, whenDoYouWant } = req.body

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
				bloodbankId: req.user._id,
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

		// Verify availability first
		const isAvailable = await bloodStockController.checkAvailability(
			req.user._id,
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

		// 1. Atomically decrement stock
		const stockUpdated = await bloodStockController.decreaseStock(
			req.user._id,
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

		// 2. Atomically transition request to Fulfilled
		const updated = await ReceiveRequests.findOneAndUpdate(
			{
				_id: id,
				bloodbankId: req.user._id,
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

		// If request transition failed (e.g. concurrent fulfillment), restore decremented stock!
		if (!updated) {
			if (!session) {
				await bloodStockController.increaseStock(
					req.user._id,
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
	const receiveRequests = await ReceiveRequests.find({
		bloodbankId: req.user._id,
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
	const userStates = await ReceiveRequests.aggregate([
		{
			$match: {
				bloodbankId: req.user._id,
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

	const filter = { bloodbankId: req.user._id }

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
