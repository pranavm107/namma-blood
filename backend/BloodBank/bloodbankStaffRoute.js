const express = require('express')
const {
	provisionStaff,
	loginStaff,
	setupStaffPassword,
	changeStaffPassword,
	getStaffList,
	updateStaffStatus,
	getStaffProfile,
} = require('./bloodbankStaffController')
const {
	selectBloodbankModel,
} = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const { protectStaff } = require('./bloodbankStaffMiddleware')

const router = express.Router()

// Public Staff Login (signed, role-bearing token)
router.route('/login').post(loginStaff)

// Initial Setup Credential Password Setup
router.route('/setup-password').post(setupStaffPassword)

// Authenticated Staff Password Change
router.route('/change-password').patch(protectStaff, changeStaffPassword)

// Staff Member Self-Profile
router.route('/me').get(protectStaff, getStaffProfile)

// Blood Bank Institutional Management of Staff (Provisioning, Listing, Status Control)
router
	.route('/')
	.get(selectBloodbankModel, protect, getStaffList)
	.post(selectBloodbankModel, protect, provisionStaff)

router
	.route('/provision')
	.post(selectBloodbankModel, protect, provisionStaff)

router
	.route('/:staffId/status')
	.patch(selectBloodbankModel, protect, updateStaffStatus)

module.exports = router
