const express = require('express')
const router = express.Router()
const {
	addState,
	getStates,
	updateState,
	deleteState,
} = require('./stateController')
const { stateMiddleware } = require('./stateMiddleware')
const { selectAdminModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')

// Public read endpoint
router.route('/').get(getStates)

// Admin-only write endpoints
router
	.route('/')
	.post(selectAdminModel, protect, stateMiddleware, addState)

router
	.route('/:id')
	.patch(selectAdminModel, protect, updateState)
	.delete(selectAdminModel, protect, deleteState)

module.exports = router
