const express = require('express')
const {
	recordScreeningResults,
	getBloodUnitById,
	getBloodUnits,
	verifyBloodUnitClearance,
	reserveBloodUnits,
	releaseBloodUnitReservation,
	issueBloodUnits,
	recordCrossmatchResult,
	dispatchBloodUnits,
	discardBloodUnit,
} = require('./bloodUnitController')
const {
	protectStaff,
	restrictToStaffRole,
	protectBloodbankOrStaff,
} = require('../BloodBank/bloodbankStaffMiddleware')

const router = express.Router()

// List and filter blood units for authenticated blood bank / staff
router
	.route('/')
	.get(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		getBloodUnits
	)

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

// Authorized blood unit biohazard / clinical discard
router
	.route('/discard')
	.post(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		discardBloodUnit
	)

router
	.route('/:id/discard')
	.post(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		discardBloodUnit
	)

// Record TTI laboratory screening results for a unit
router
	.route('/:id/tests')
	.post(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		recordScreeningResults
	)
	.patch(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		recordScreeningResults
	)

// Medical Officer quality verification & availability clearance
router
	.route('/:id/verify')
	.post(protectStaff, restrictToStaffRole('Medical_Officer'), verifyBloodUnitClearance)

// Inspect unit details & testing status
router
	.route('/:id')
	.get(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		getBloodUnitById
	)

module.exports = router
