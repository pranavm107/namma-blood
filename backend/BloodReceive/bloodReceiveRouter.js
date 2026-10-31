const express = require('express')
const router = express.Router()
const {
	addRequest,
	acceptRequest,
	rejectRequest,
	editReceiveRequest,
	rejectRequestByUser,
	fulfilledRequest,
	getUserStates,
	getBloodbankStates,
	getUserData,
	getBloodbankData,
	getBloodbankDataQuery,
} = require('./bloodReceiveController')
const {
	selectUserModel,
	selectBloodbankModel,
} = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const {
	protectBloodbankOrStaff,
} = require('../BloodBank/bloodbankStaffMiddleware')

router.route('/addrequest').post(selectUserModel, protect, addRequest)

router
	.route('/acceptrequest')
	.patch(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		acceptRequest
	)

router
	.route('/rejectrequest')
	.patch(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		rejectRequest
	)

router
	.route('/editreceiverequest')
	.patch(selectUserModel, protect, editReceiveRequest)

router
	.route('/rejectrequestbyuser')
	.patch(selectUserModel, protect, rejectRequestByUser)

router
	.route('/fulfilledrequest')
	.patch(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		fulfilledRequest
	)

router.route('/getuserstates').get(selectUserModel, protect, getUserStates)

router
	.route('/getbloodbankstates')
	.get(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		getBloodbankStates
	)

router.route('/getuserdata').get(selectUserModel, protect, getUserData)

router
	.route('/getbloodbankdata')
	.get(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		getBloodbankData
	)

router
	.route('/getbloodbankdataquery')
	.get(
		protectBloodbankOrStaff('Medical_Officer', 'Lab_Technician', 'Staff_Admin'),
		getBloodbankDataQuery
	)

module.exports = router
