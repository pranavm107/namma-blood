const catchAsync = require('../Utils/catchAsync')
const Bloodstock = require('./bloodStockModel')
const stockService = require('./stockService')
const reconciliationService = require('./reconciliationService')

const addStock = catchAsync(async (id) => {
	await Bloodstock.create({ bloodbankId: id })
})

/**
 * Returns consolidated blood stock for the authenticated blood bank.
 * Preserves top-level A_Positive .. O_Negative integers for 100% backward compatibility with
 * existing frontend Redux consumers, while providing explicit demarcation between verified
 * issue-eligible traceable units and unverified legacy aggregate numbers.
 */
const getStock = catchAsync(async (req, res) => {
	const bloodbankId = req.bloodbankId || req.user._id
	const stockData = await stockService.getConsolidatedStock(bloodbankId)
	return res.status(200).json(stockData)
})

const checkAvailability = async (bloodbankId, bloodType, unit = 1, options = {}) => {
	const validUnits = Math.max(1, Number(unit) || 1)
	const bloodstock = await Bloodstock.findOne({ bloodbankId }, null, options)
	if (!bloodstock) return false
	return (bloodstock[bloodType] || 0) >= validUnits
}

/**
 * LEGACY AGGREGATE MODIFIER (PRESERVED FOR BACKWARD COMPATIBILITY)
 *
 * SAFETY INVARIANT:
 * This endpoint mutates ONLY the legacy Bloodstock aggregate counter document.
 * It NEVER mutates BloodUnit records and CANNOT falsely create verified or issue-eligible units.
 * Direct scalar delta modification bypasses infectious disease testing, component tracking,
 * and bag verification. It is scheduled for deprecation once all centers complete physical unit migration.
 */
const updatStock = catchAsync(async (req, res) => {
	res.setHeader(
		'X-API-Deprecation-Warning',
		'Direct legacy stock scalar modification is deprecated. Use traceable unit intake and reconciliation.'
	)

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

const increaseStock = async (bloodbankId, bloodType, unit = 1, options = {}) => {
	const validUnits = Math.max(1, Number(unit) || 1)
	const updated = await Bloodstock.findOneAndUpdate(
		{ bloodbankId },
		{ $inc: { [bloodType]: validUnits } },
		{ upsert: true, new: true, ...options }
	)
	return updated
}

const decreaseStock = async (bloodbankId, bloodType, unit = 1, options = {}) => {
	const validUnits = Math.max(1, Number(unit) || 1)
	const updated = await Bloodstock.findOneAndUpdate(
		{ bloodbankId, [bloodType]: { $gte: validUnits } },
		{ $inc: { [bloodType]: -validUnits } },
		{ new: true, ...options }
	)
	return updated
}

/**
 * Generates an auditable, dry-run reconciliation report comparing legacy aggregate counts
 * with traceable unit records for the authenticated blood bank.
 */
const getReconciliationReport = catchAsync(async (req, res) => {
	const bloodbankId = req.bloodbankId || req.user._id
	const actorId = req.staff?._id || req.user?._id
	const actorModel = req.staff ? 'bloodbankstaff' : 'bloodbank'
	const staffId = req.staff?._id || null
	const ipAddress = req.ip || req.connection?.remoteAddress || null
	const recordAudit = req.query.recordAudit === 'true'

	const report = await reconciliationService.generateReconciliationReport({
		bloodbankId,
		actorId,
		actorModel,
		staffId,
		ipAddress,
		recordAudit,
	})

	return res.status(200).json(report)
})

/**
 * Runs legacy inventory reconciliation and safe migration.
 * Requires an explicit execution mode: defaults strictly to 'DRY_RUN'.
 * 'EXECUTE' mode performs atomic deductions and registers quarantined traceable units.
 */
const runInventoryMigration = catchAsync(async (req, res) => {
	const bloodbankId = req.bloodbankId || req.user._id
	const actorId = req.staff?._id || req.user?._id
	const actorModel = req.staff ? 'bloodbankstaff' : 'bloodbank'
	const staffId = req.staff?._id || null
	const ipAddress = req.ip || req.connection?.remoteAddress || null

	const { mode = 'DRY_RUN', migrationManifest = [], batchId, notes = '' } = req.body

	const result = await reconciliationService.executeInventoryMigration({
		bloodbankId,
		mode,
		migrationManifest,
		batchId,
		actorId,
		actorModel,
		staffId,
		ipAddress,
		notes,
	})

	const statusCode = result.status === 'CONFLICT_DETECTED' ? 409 : 200
	return res.status(statusCode).json(result)
})

/**
 * Retrieves audit history of reconciliation and migration runs for the authenticated blood bank.
 */
const getReconciliationHistory = catchAsync(async (req, res) => {
	const bloodbankId = req.bloodbankId || req.user._id
	const { limit, skip } = req.query

	const history = await reconciliationService.getReconciliationHistory({
		bloodbankId,
		limit,
		skip,
	})

	return res.status(200).json(history)
})

module.exports = {
	addStock,
	getStock,
	updatStock,
	checkAvailability,
	increaseStock,
	decreaseStock,
	getReconciliationReport,
	runInventoryMigration,
	getReconciliationHistory,
	stockService,
	reconciliationService,
}
