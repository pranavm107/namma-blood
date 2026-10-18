const express = require('express')
const router = express.Router()
const { selectAdminModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const {
	downloadTemplate,
	downloadSample,
	getSchemaDocumentation,
	previewBulkImport,
	confirmBulkImport,
} = require('./bulkImportController')

// Enforce Admin Model for authentication context
router.use(selectAdminModel)

// Downloadable templates & samples (Admin protected)
router.route('/template/:entity').get(protect, downloadTemplate)
router.route('/sample/:entity').get(protect, downloadSample)
router.route('/schema/:entity').get(protect, getSchemaDocumentation)

// Preview workflow (strictly zero mutations, Admin protected)
router.route('/preview/:entity').post(protect, previewBulkImport)

// Confirmed import workflow (server-revalidated, transactional, Admin protected)
router.route('/confirm/:entity').post(protect, confirmBulkImport)

module.exports = router
