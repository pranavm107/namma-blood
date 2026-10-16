const express = require('express')
const router = express.Router()
const {
	addCity,
	getCities,
	updateCity,
	deleteCity,
} = require('./cityController')
const { cityMiddleware } = require('./cityMiddleware')
const { selectAdminModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')

// Public read endpoint (used by frontend state dropdowns)
router.route('/getcitybystatename/:stateName').get(getCities)

// Admin-only write endpoints
router
	.route('/addcity')
	.post(selectAdminModel, protect, cityMiddleware, addCity)

router
	.route('/')
	.post(selectAdminModel, protect, cityMiddleware, addCity)

router
	.route('/updatecity/:id')
	.patch(selectAdminModel, protect, updateCity)

router
	.route('/deletecity/:id')
	.delete(selectAdminModel, protect, deleteCity)

router
	.route('/:id')
	.patch(selectAdminModel, protect, updateCity)
	.delete(selectAdminModel, protect, deleteCity)

module.exports = router
