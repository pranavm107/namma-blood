const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const { registerUserEmail } = require('../Utils/emailContant')

const SAFE_USER_FIELDS =
	'_id firstName lastName gender dob age phoneNo1 phoneNo2 email state city address pinCode status createdAt updatedAt'

const ALLOWED_UPDATE_FIELDS = [
	'firstName',
	'lastName',
	'gender',
	'dob',
	'age',
	'phoneNo1',
	'phoneNo2',
	'state',
	'city',
	'address',
	'pinCode',
]

const registerUser = catchAsync(async (req, res) => {
	const user = await req.model.create(req.body)

	await registerUserEmail(user.firstName, user.lastName, user.email)

	return res.status(201).json({
		message: 'User Register Successfully.',
	})
})

const getUserById = catchAsync(async (req, res) => {
	const { id } = req.params

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid user ID is required.',
		})
	}

	// Authorization check: users can only fetch their own profile data
	if (!req.user || req.user._id.toString() !== id) {
		return res.status(404).json({
			message: 'User not found.',
		})
	}

	const user = await req.model.findById(id).select(SAFE_USER_FIELDS)

	if (!user) {
		return res.status(404).json({
			message: 'User not found.',
		})
	}

	return res.status(200).json({
		message: 'User successfully retrieved.',
		user,
	})
})

const updateUser = catchAsync(async (req, res) => {
	const filteredBody = {}

	for (const key of ALLOWED_UPDATE_FIELDS) {
		if (req.body[key] !== undefined) {
			filteredBody[key] = req.body[key]
		}
	}

	if (Object.keys(filteredBody).length === 0) {
		return res.status(400).json({
			message: 'No valid update fields provided.',
		})
	}

	const user = await req.model
		.findByIdAndUpdate(req.user._id, filteredBody, {
			new: true,
			runValidators: true,
		})
		.select(SAFE_USER_FIELDS)

	if (!user) {
		return res.status(404).json({
			message: 'User not found.',
		})
	}

	return res.status(200).json({
		message: 'User successfully updated.',
		user,
	})
})

const getUserProfile = catchAsync(async (req, res) => {
	const user = await req.model.findById(req.user._id).select(SAFE_USER_FIELDS)

	if (!user) {
		return res.status(404).json({
			message: 'User not found.',
		})
	}

	return res.status(200).json(user)
})

module.exports = {
	registerUser,
	getUserById,
	getUserProfile,
	updateUser,
}
