const mongoose = require('mongoose')
const { addStock } = require('../BloodStock/bloodStockController')
const catchAsync = require('../Utils/catchAsync')
const { registerBloodbankEmail } = require('../Utils/emailContant')
const Bloodbank = require('./bloodbankModel')

const SENSITIVE_FIELDS = '-password -passwordResetToken -passwordResetExpires -passwordChangedAt -__v'

function escapeRegex(text) {
	return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

const registerBloodbank = catchAsync(async (req, res) => {
	const {
		state,
		city,
		bloodbankName,
		category,
		contactPerson,
		address1,
		address2,
		pinCode,
		phoneNo1,
		phoneNo2,
		email,
		password,
		openingDate,
	} = req.body

	const bloodbank = await Bloodbank.create({
		state,
		city,
		bloodbankName,
		category,
		contactPerson,
		address1,
		address2,
		pinCode,
		phoneNo1,
		phoneNo2,
		email,
		password,
		openingDate: openingDate || Date.now(),
	})

	addStock(bloodbank._id)

	await registerBloodbankEmail(
		bloodbank.bloodbankName,
		bloodbank.email
	)

	return res.status(201).json({
		message: 'Bloodbank Registered Successfully.',
	})
})

const getBloodbanks = catchAsync(async (req, res) => {
	const bloodbanks = await Bloodbank.find()
		.select(SENSITIVE_FIELDS)
		.sort({ bloodbankName: 1 })

	return res.status(200).json(bloodbanks)
})

const getBloodbankById = catchAsync(async (req, res) => {
	const { id } = req.params

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid blood bank ID is required.',
		})
	}

	const bloodbank = await Bloodbank.findById(id).select(SENSITIVE_FIELDS)

	if (!bloodbank) {
		return res.status(404).json({
			message: 'Blood bank not found.',
		})
	}

	return res.status(200).json(bloodbank)
})

const getBloodbanksByQuery = catchAsync(async (req, res) => {
	// Guard against NoSQL injection: disallow operator keys or nested query objects
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

	// Build explicit allowlist filter
	const filter = {}

	if (typeof req.query.state === 'string' && req.query.state.trim()) {
		filter.state = {
			$regex: new RegExp(`^${escapeRegex(req.query.state.trim())}$`, 'i'),
		}
	}

	if (typeof req.query.city === 'string' && req.query.city.trim()) {
		filter.city = {
			$regex: new RegExp(`^${escapeRegex(req.query.city.trim())}$`, 'i'),
		}
	}

	if (
		typeof req.query.category === 'string' &&
		['Government', 'RedCross', 'Private'].includes(req.query.category.trim())
	) {
		filter.category = req.query.category.trim()
	}

	if (req.query.pinCode !== undefined) {
		const pin = Number(req.query.pinCode)
		if (!isNaN(pin) && pin > 0) {
			filter.pinCode = pin
		}
	}

	const searchName = req.query.bloodbankName || req.query.name
	if (typeof searchName === 'string' && searchName.trim()) {
		filter.bloodbankName = {
			$regex: new RegExp(escapeRegex(searchName.trim()), 'i'),
		}
	}

	if (req.query.status !== undefined) {
		if (req.query.status === 'true' || req.query.status === true) {
			filter.status = true
		} else if (req.query.status === 'false' || req.query.status === false) {
			filter.status = false
		}
	}

	const bloodbanks = await Bloodbank.find(filter)
		.select(SENSITIVE_FIELDS)
		.sort({ bloodbankName: 1 })

	return res.status(200).json(bloodbanks)
})

const getBloodbankProfile = catchAsync(async (req, res) => {
	const user = await Bloodbank.findById(req.user._id).select(SENSITIVE_FIELDS)

	if (!user) {
		return res.status(404).json({
			message: 'Blood bank profile not found.',
		})
	}

	return res.status(200).json(user)
})

module.exports = {
	registerBloodbank,
	getBloodbanks,
	getBloodbankById,
	getBloodbanksByQuery,
	getBloodbankProfile,
}
