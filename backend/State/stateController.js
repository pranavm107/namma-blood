const mongoose = require('mongoose')
const catchAsync = require('../Utils/catchAsync')
const State = require('./stateModel')
const City = require('../City/cityModel')

function escapeRegex(text) {
	return text.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

const addState = catchAsync(async (req, res) => {
	const stateName = (req.body.stateName || '').trim()

	if (!stateName) {
		return res.status(400).json({
			message: 'State name is required.',
		})
	}

	const existing = await State.findOne({
		stateName: { $regex: new RegExp(`^${escapeRegex(stateName)}$`, 'i') },
	})

	if (existing) {
		return res.status(400).json({
			message: `State '${stateName}' already exists.`,
		})
	}

	const newState = await State.create({ stateName })

	return res.status(201).json({
		message: 'State added successfully.',
		data: newState,
	})
})

const getStates = catchAsync(async (req, res) => {
	const states = await State.find().sort({ stateName: 1 })

	return res.status(200).json(states)
})

const updateState = catchAsync(async (req, res) => {
	const { id } = req.params
	const stateName = (req.body.stateName || '').trim()

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid State ID is required.',
		})
	}

	if (!stateName) {
		return res.status(400).json({
			message: 'State name is required.',
		})
	}

	const state = await State.findById(id)
	if (!state) {
		return res.status(404).json({
			message: 'State not found.',
		})
	}

	const duplicate = await State.findOne({
		_id: { $ne: id },
		stateName: { $regex: new RegExp(`^${escapeRegex(stateName)}$`, 'i') },
	})

	if (duplicate) {
		return res.status(400).json({
			message: `State name '${stateName}' is already in use.`,
		})
	}

	const oldName = state.stateName
	state.stateName = stateName
	await state.save()

	if (oldName !== stateName) {
		await City.updateMany({ stateName: oldName }, { stateName })
	}

	return res.status(200).json({
		message: 'State updated successfully.',
		data: state,
	})
})

const deleteState = catchAsync(async (req, res) => {
	const { id } = req.params

	if (!id || !mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({
			message: 'Valid State ID is required.',
		})
	}

	const state = await State.findById(id)
	if (!state) {
		return res.status(404).json({
			message: 'State not found.',
		})
	}

	const cityCount = await City.countDocuments({ stateName: state.stateName })
	if (cityCount > 0) {
		return res.status(400).json({
			message: `Cannot delete state because it has ${cityCount} associated city/cities. Please delete or reassign associated cities first.`,
		})
	}

	await State.findByIdAndDelete(id)

	return res.status(200).json({
		message: 'State deleted successfully.',
	})
})

module.exports = {
	addState,
	getStates,
	updateState,
	deleteState,
}
