const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const City = require('./cityModel')
const State = require('../State/stateModel')

function escapeRegex(text) {
	return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

const addCity = catchAsync(async (req, res) => {
	const stateName = (req.body.stateName || '').trim()
	const cityName = (req.body.cityName || '').trim()

	if (!stateName || !cityName) {
		return res.status(400).json({
			message: 'Both stateName and cityName are required.',
		})
	}

	const stateExists = await State.findOne({
		stateName: { $regex: new RegExp(`^${escapeRegex(stateName)}$`, 'i') },
	})

	if (!stateExists) {
		return res.status(404).json({
			message: `Referenced state '${stateName}' does not exist.`,
		})
	}

	const existingCity = await City.findOne({
		cityName: { $regex: new RegExp(`^${escapeRegex(cityName)}$`, 'i') },
	})

	if (existingCity) {
		return res.status(400).json({
			message: `City '${cityName}' already exists.`,
		})
	}

	const newCity = await City.create({
		stateName: stateExists.stateName,
		cityName,
	})

	return res.status(201).json({
		message: 'City added successfully.',
		data: newCity,
	})
})

const getCities = catchAsync(async (req, res) => {
	const stateName = (req.params.stateName || '').trim()

	if (!stateName) {
		return res.status(400).json({
			message: 'State name is required.',
		})
	}

	const cities = await City.find({
		stateName: { $regex: new RegExp(`^${escapeRegex(stateName)}$`, 'i') },
	}).sort({ cityName: 1 })

	return res.status(200).json(cities)
})

const updateCity = catchAsync(async (req, res) => {
	const { id } = req.params
	const stateName = req.body.stateName ? req.body.stateName.trim() : undefined
	const cityName = req.body.cityName ? req.body.cityName.trim() : undefined

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid City ID is required.',
		})
	}

	if (!stateName && !cityName) {
		return res.status(400).json({
			message: 'At least one field (stateName or cityName) is required for update.',
		})
	}

	const city = await City.findById(id)
	if (!city) {
		return res.status(404).json({
			message: 'City not found.',
		})
	}

	if (stateName) {
		const stateExists = await State.findOne({
			stateName: { $regex: new RegExp(`^${escapeRegex(stateName)}$`, 'i') },
		})
		if (!stateExists) {
			return res.status(404).json({
				message: `Referenced state '${stateName}' does not exist.`,
			})
		}
		city.stateName = stateExists.stateName
	}

	if (cityName) {
		const duplicate = await City.findOne({
			_id: { $ne: id },
			cityName: { $regex: new RegExp(`^${escapeRegex(cityName)}$`, 'i') },
		})
		if (duplicate) {
			return res.status(400).json({
				message: `City name '${cityName}' is already in use.`,
			})
		}
		city.cityName = cityName
	}

	await city.save()

	return res.status(200).json({
		message: 'City updated successfully.',
		data: city,
	})
})

const deleteCity = catchAsync(async (req, res) => {
	const { id } = req.params

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid City ID is required.',
		})
	}

	const city = await City.findById(id)
	if (!city) {
		return res.status(404).json({
			message: 'City not found.',
		})
	}

	await City.findByIdAndDelete(id)

	return res.status(200).json({
		message: 'City deleted successfully.',
	})
})

module.exports = {
	addCity,
	getCities,
	updateCity,
	deleteCity,
}
