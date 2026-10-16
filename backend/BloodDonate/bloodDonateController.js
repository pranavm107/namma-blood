const mongoose = require('mongoose')
const bloodStockController = require('../BloodStock/bloodStockController')
const AppError = require('../Utils/appError')
const catchAsync = require('../Utils/catchAsync')
const DonateRequests = require('./bloodDonateModel')
const Bloodbank = require('../BloodBank/bloodbankModel')

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

const checkifDonateOrNot = async (id) => {
	const data = await DonateRequests.find({ userId: id, status: 'Fulfilled' })
		.sort({ whenToGive: -1 })
		.limit(1)

	if (data.length === 0) {
		return true
	}

	const date = data[0]?.whenToGive
	if (!date) return true

	const curDate = new Date()
	const diffTime = Math.abs(curDate - date)
	const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24))

	if (diffDays < 90) {
		return false
	}

	return true
}

const addRequest = catchAsync(async (req, res, next) => {
	const { bloodbankId, bloodType, whenToGive, message } = req.body

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

	if (bloodType && !VALID_BLOOD_TYPES.includes(bloodType)) {
		return res.status(400).json({
			message: `Invalid blood type. Allowed types: ${VALID_BLOOD_TYPES.join(', ')}`,
		})
	}

	const isEligible = await checkifDonateOrNot(req.user._id)
	if (!isEligible) {
		return res.status(400).json({
			message:
				'You are not eligible to donate blood. You can donate after 90 days of your last blood donation.',
		})
	}

	const existingPending = await DonateRequests.findOne({
		userId: req.user._id,
		bloodbankId,
		status: { $in: ['Pending', 'Accepted'] },
	})

	if (existingPending) {
		return res.status(400).json({
			message: 'You already have an active request with this blood bank. Please await their response.',
		})
	}

	await DonateRequests.create({
		userId: req.user._id,
		bloodbankId,
		bloodType: bloodType || '',
		whenToGive: whenToGive ? new Date(whenToGive) : undefined,
		message: message || '',
		status: 'Pending',
	})

	return res.status(201).json({
		message: 'Request sent.',
	})
})

const acceptRequest = catchAsync(async (req, res, next) => {
	const { id, whenToGive } = req.body

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid request ID is required.',
		})
	}

	const request = await DonateRequests.findOne({
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
	if (whenToGive) request.whenToGive = new Date(whenToGive)
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

	const request = await DonateRequests.findOne({
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
			message: 'Cannot reject an already fulfilled donation request.',
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

const editDonateRequest = catchAsync(async (req, res, next) => {
	const { id, whenToGive, bloodType } = req.body

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid request ID is required.',
		})
	}

	const request = await DonateRequests.findOne({
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

	if (whenToGive) request.whenToGive = new Date(whenToGive)
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

	const request = await DonateRequests.findOne({
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
			message: 'Cannot cancel an already fulfilled donation.',
		})
	}

	if (request.status === 'Rejected') {
		return res.status(400).json({
			message: 'Request is already cancelled.',
		})
	}

	request.status = 'Rejected'
	request.message = message || 'Rejected by User.'
	await request.save()

	return res.status(200).json({
		message: 'Request Rejected.',
	})
})

const fulfilledRequest = catchAsync(async (req, res, next) => {
	const { id, bloodType, whenToGive } = req.body

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid request ID is required.',
		})
	}

	const request = await DonateRequests.findOne({
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
			message: 'Request has already been fulfilled. Stock cannot be incremented repeatedly.',
		})
	}

	if (request.status === 'Rejected') {
		return res.status(400).json({
			message: 'Cannot fulfill a rejected request.',
		})
	}

	const effectiveBloodType = bloodType || request.bloodType
	if (!effectiveBloodType || !VALID_BLOOD_TYPES.includes(effectiveBloodType)) {
		return res.status(400).json({
			message: `Valid Blood Type is required. Allowed types: ${VALID_BLOOD_TYPES.join(', ')}`,
		})
	}

	const updated = await DonateRequests.findOneAndUpdate(
		{
			_id: id,
			bloodbankId: req.user._id,
			status: { $ne: 'Fulfilled' },
		},
		{
			status: 'Fulfilled',
			bloodType: effectiveBloodType,
			whenToGive: whenToGive ? new Date(whenToGive) : request.whenToGive || new Date(),
		},
		{ new: true }
	)

	if (!updated) {
		return res.status(400).json({
			message: 'Request fulfillment conflict. Please refresh and retry.',
		})
	}

	try {
		await bloodStockController.increaseStock(req.user._id, effectiveBloodType, 1)
	} catch (stockErr) {
		await DonateRequests.findByIdAndUpdate(id, { status: request.status })
		return res.status(500).json({
			message: 'Failed to update blood stock. Transaction rolled back.',
		})
	}

	return res.status(200).json({
		message: 'Request Fulfilled.',
	})
})

const getUserData = catchAsync(async (req, res) => {
	const query = req.query

	const donateRequests = await DonateRequests.find({ userId: req.user._id })
		.find(query)
		.populate({ path: 'bloodbankId' })

	const data = donateRequests.map((element, index) => {
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
			whenToGive: element.whenToGive,
			status: element.status,
			message: element.message,
		}
	})

	return res.status(200).json(data)
})

const getBloodbankData = catchAsync(async (req, res) => {
	const donateRequests = await DonateRequests.find({
		bloodbankId: req.user._id,
	}).populate({ path: 'userId' })

	const data = donateRequests.map((element, index) => {
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
			whenToGive: element.whenToGive,
			status: element.status,
			message: element.message,
		}
	})

	return res.status(200).json(data)
})

const getUserStates = catchAsync(async (req, res) => {
	const userStates = await DonateRequests.aggregate([
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

const getBloodbankStates = catchAsync(async (req, res) => {
	const userStates = await DonateRequests.aggregate([
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

const getBloodbankDataQuery = catchAsync(async (req, res) => {
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

	const data = await DonateRequests.find(filter)
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
	editDonateRequest,
	rejectRequestByUser,
	fulfilledRequest,
	getUserData,
	getBloodbankData,
	getUserStates,
	getBloodbankStates,
	getBloodbankDataQuery,
}
