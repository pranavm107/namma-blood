const express = require('express')
const { loginMiddleware, login } = require('../Login_And_Authentication/login')
const { selectAdminModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const {
	resetPassword,
	forgotPassword,
} = require('../Login_And_Authentication/forgotPassword')
const { verifyStaffLicense } = require('./adminController')

const router = express.Router()

router.use(selectAdminModel)

router.route('/login').post(loginMiddleware, login)

router.route('/forgotpassword').post(forgotPassword)

router.route('/resetpassword/:token').patch(resetPassword)

// Global Administrator Medical Officer License Verification
router.route('/staff/:staffId/verify-license').patch(protect, verifyStaffLicense)

module.exports = router
