const express = require('express')
const router = express.Router()
const {
	registerUser,
	getUserById,
	updateUser,
	getUserProfile,
} = require('./userController')
const { registerMiddleware } = require('./userMiddleware')
const { login, loginMiddleware } = require('../Login_And_Authentication/login')
const { selectUserModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const {
	forgotPassword,
	resetPassword,
} = require('../Login_And_Authentication/forgotPassword')
const {
	updatePassword,
	updatePasswordMiddleware,
} = require('../Login_And_Authentication/updatePassword')

router.use(selectUserModel)

// Public endpoints
router.route('/register').post(registerMiddleware, registerUser)
router.route('/login').post(loginMiddleware, login)
router.route('/forgotpassword').post(forgotPassword)
router.route('/resetpassword/:token').patch(resetPassword)

// Protected user endpoints
router.use(protect)

router.route('/getuserprofile').get(getUserProfile)
router.route('/getuserbyid/:id').get(getUserById)
router.route('/updatepassword').patch(updatePasswordMiddleware, updatePassword)
router.route('/updateuser').patch(updateUser)

module.exports = router
