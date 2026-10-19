const express = require('express')
const {
	recordScreeningResults,
	getBloodUnitById,
	verifyBloodUnitClearance,
} = require('./bloodUnitController')
const { selectBloodbankModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const {
	protectStaff,
	restrictToStaffRole,
} = require('../BloodBank/bloodbankStaffMiddleware')

const router = express.Router()

// Record TTI laboratory screening results for a unit
router
	.route('/:id/tests')
	.post(selectBloodbankModel, protect, recordScreeningResults)
	.patch(selectBloodbankModel, protect, recordScreeningResults)

// Medical Officer quality verification & availability clearance
router
	.route('/:id/verify')
	.post(protectStaff, restrictToStaffRole('Medical_Officer'), verifyBloodUnitClearance)

// Inspect unit details & testing status
router.route('/:id').get(selectBloodbankModel, protect, getBloodUnitById)

module.exports = router
