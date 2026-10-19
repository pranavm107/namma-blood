const express = require('express')
const {
	recordScreeningResults,
	getBloodUnitById,
	verifyBloodUnitClearance,
	reserveBloodUnits,
	releaseBloodUnitReservation,
	issueBloodUnits,
	recordCrossmatchResult,
	dispatchBloodUnits,
} = require('./bloodUnitController')
const { selectBloodbankModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const {
	protectStaff,
	restrictToStaffRole,
	protectBloodbankOrStaff,
} = require('../BloodBank/bloodbankStaffMiddleware')

const router = express.Router()

// Final clinical unit issuance
router
	.route('/issue')
	.post(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		issueBloodUnits
	)

// Physical dispatch handoff
router
	.route('/dispatch')
	.post(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		dispatchBloodUnits
	)

// Patient request unit reservation & FEFO allocation
router
	.route('/reserve')
	.post(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		reserveBloodUnits
	)

// Explicit reservation release
router
	.route('/release-reservation')
	.post(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		releaseBloodUnitReservation
	)

// Record pre-issuance crossmatch compatibility result
router
	.route('/:id/crossmatch')
	.post(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		recordCrossmatchResult
	)

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
