const express = require('express')
const { loginMiddleware, login } = require('../Login_And_Authentication/login')
const { selectAdminModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const {
	resetPassword,
	forgotPassword,
} = require('../Login_And_Authentication/forgotPassword')
const { verifyStaffLicense } = require('./adminController')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const {
	issueHospitalRepresentativeInvitation,
} = require('../Hospital/hospitalInvitationController')

const router = express.Router()

// Admin authorization guard
const requireAdmin = (req, res, next) => {
	if (req.userRole !== 'ADMIN') {
		return res.status(403).json({
			status: 'fail',
			message: 'Access denied: Platform Administrator privileges required.',
		})
	}
	next()
}

router.use(selectAdminModel)

router.route('/login').post(loginMiddleware, login)

router.route('/forgotpassword').post(forgotPassword)

router.route('/resetpassword/:token').patch(resetPassword)

// Global Administrator Medical Officer License Verification
router.route('/staff/:staffId/verify-license').patch(protect, verifyStaffLicense)

// Platform Administrator Hospital Representative Invitation Issuance
router
	.route('/hospital-invitations')
	.post(protectEmergencyAuth, requireAdmin, issueHospitalRepresentativeInvitation)

module.exports = router
