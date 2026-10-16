const catchAsync = require('../Utils/catchAsync')
const Bloodstock = require('./bloodStockModel')

const addStock = catchAsync(async (id) => {
	await Bloodstock.create({ bloodbankId: id })
})

const getStock = catchAsync(async (req, res) => {
	const bloodStock = await Bloodstock.findOne({ bloodbankId: req.user._id })

	return res.status(200).json(bloodStock)
})

const checkAvailability = async (bloodbankId, bloodType, unit = 1) => {
	const validUnits = Math.max(1, Number(unit) || 1)
	const bloodstock = await Bloodstock.findOne({ bloodbankId })
	if (!bloodstock) return false
	return (bloodstock[bloodType] || 0) >= validUnits
}

const updatStock = catchAsync(async (req, res) => {
	const currentStock = await Bloodstock.findOne({
		bloodbankId: req.user._id,
	})

	if (!currentStock) {
		return res.status(404).json({
			message: 'Stock not found for this bloodbank.',
		})
	}

	const body = req.body
	const allowedKeys = [
		'A_Positive',
		'A_Negative',
		'B_Positive',
		'B_Negative',
		'AB_Positive',
		'AB_Negative',
		'O_Positive',
		'O_Negative',
	]

	for (const key of allowedKeys) {
		if (body[key] !== undefined) {
			const delta = Number(body[key])
			if (isNaN(delta)) continue
			if (currentStock[key] + delta >= 0) {
				currentStock[key] = currentStock[key] + delta
			} else {
				return res.status(400).json({
					message: `Cannot decrease stock for ${key} below zero.`,
				})
			}
		}
	}

	await currentStock.save()

	return res.status(200).json({
		message: 'Stock Updated.',
	})
})

const increaseStock = async (bloodbankId, bloodType, unit = 1) => {
	const validUnits = Math.max(1, Number(unit) || 1)
	const updated = await Bloodstock.findOneAndUpdate(
		{ bloodbankId },
		{ $inc: { [bloodType]: validUnits } },
		{ upsert: true, new: true }
	)
	return updated
}

const decreaseStock = async (bloodbankId, bloodType, unit = 1) => {
	const validUnits = Math.max(1, Number(unit) || 1)
	const updated = await Bloodstock.findOneAndUpdate(
		{ bloodbankId, [bloodType]: { $gte: validUnits } },
		{ $inc: { [bloodType]: -validUnits } },
		{ new: true }
	)
	return updated
}

module.exports = {
	addStock,
	getStock,
	updatStock,
	checkAvailability,
	increaseStock,
	decreaseStock,
}
