const express = require('express')
const {
	getStock,
	updatStock,
	getReconciliationReport,
	runInventoryMigration,
	getReconciliationHistory,
} = require('./bloodStockController')
const { selectBloodbankModel } = require('../Common/Middlewares/selectModels')
const { protect } = require('../Login_And_Authentication/authMiddleware')
const { protectBloodbankOrStaff } = require('../BloodBank/bloodbankStaffMiddleware')

const router = express.Router()

// Legacy Stock Endpoints (Preserved for backward compatibility)
router
	.route('/getstock')
	.get(
		protectBloodbankOrStaff('Staff_Admin', 'Medical_Officer', 'Lab_Technician'),
		getStock
	)
router.route('/updatestock').patch(selectBloodbankModel, protect, updatStock)

// Phase 3.7: Inventory Reconciliation & Safe Migration Endpoints
router
	.route('/reconciliation')
	.get(
		protectBloodbankOrStaff('Staff_Admin', 'Medical_Officer', 'Lab_Technician'),
		getReconciliationReport
	)

router
	.route('/reconcile')
	.post(
		protectBloodbankOrStaff('Staff_Admin', 'Medical_Officer'),
		runInventoryMigration
	)

router
	.route('/reconciliation/history')
	.get(
		protectBloodbankOrStaff('Staff_Admin', 'Medical_Officer'),
		getReconciliationHistory
	)

module.exports = router
