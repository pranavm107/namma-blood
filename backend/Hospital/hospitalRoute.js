/**
 * Hospital Routes
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

const express = require('express')
const router = express.Router()

const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const { protectHospitalAdminAuth } = require('./hospitalAdminMiddleware')
const hospitalController = require('./hospitalController')
const { nominateDoctorInvitation } = require('./hospitalInvitationController')

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

// Public / Authenticated dropdown endpoint
router.get('/verified', hospitalController.getVerifiedHospitals)

// Admin-only Medical Officer Onboarding & Lifecycle Management
// (Must be declared before /:id to prevent route shadowing)
router.get(
	'/medical-officers/directory',
	protectEmergencyAuth,
	requireAdmin,
	hospitalController.getMedicalOfficersDirectory
)
router.post(
	'/medical-officers/onboard',
	protectEmergencyAuth,
	requireAdmin,
	hospitalController.onboardMedicalOfficer
)
router.patch(
	'/medical-officers/:id/verify',
	protectEmergencyAuth,
	requireAdmin,
	hospitalController.verifyMedicalOfficerAccount
)
router.post(
	'/medical-officers/nominate',
	protectEmergencyAuth,
	hospitalController.nominateMedicalOfficer
)

// Doctor Nomination by Hospital Representative (Stage B3.2)
// POST /api/hospital/doctors/nominate & POST /api/hospitals/doctors/nominate
router.post(
	'/doctors/nominate',
	protectHospitalAdminAuth,
	nominateDoctorInvitation
)

// Admin-only Medical Officer Discovery for Association Selector
router.get(
	'/medical-officers',
	protectEmergencyAuth,
	requireAdmin,
	hospitalController.getMedicalOfficers
)

// Admin-only Medical Officer Hospital Association
router.post(
	'/medical-officers/assign',
	protectEmergencyAuth,
	requireAdmin,
	hospitalController.assignMedicalOfficer
)
router.get(
	'/medical-officers/associations',
	protectEmergencyAuth,
	requireAdmin,
	hospitalController.getAssociations
)
router.patch(
	'/medical-officers/association/:id/status',
	protectEmergencyAuth,
	requireAdmin,
	hospitalController.updateAssociationStatus
)

// Hospital Facility CRUD (Admin & Authenticated)
router
	.route('/')
	.post(protectEmergencyAuth, requireAdmin, hospitalController.registerHospital)
	.get(protectEmergencyAuth, requireAdmin, hospitalController.getAllHospitals)

router.get('/:id', protectEmergencyAuth, hospitalController.getHospitalById)
router.patch('/:id/verify', protectEmergencyAuth, requireAdmin, hospitalController.verifyHospital)

module.exports = router
