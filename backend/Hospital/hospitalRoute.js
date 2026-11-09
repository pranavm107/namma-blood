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
const hospitalAssociationApprovalController = require('./hospitalAssociationApprovalController')

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
// Stage B3.4.4: Hospital Representative Medical Officer Association Endpoints
// (Protected strictly by protectHospitalAdminAuth for tenant isolation)
const hospitalAssocPaths = [
	'/medical-officers/associations',
	'/medical-officer/associations',
]
const hospitalAssocDetailPaths = [
	'/medical-officers/:doctorId/associations/:associationId',
	'/medical-officer/:doctorId/associations/:associationId',
]
const hospitalAssocSuspendPaths = [
	'/medical-officers/:doctorId/associations/:associationId/suspend',
	'/medical-officer/:doctorId/associations/:associationId/suspend',
]
const hospitalAssocRevokePaths = [
	'/medical-officers/:doctorId/associations/:associationId/revoke',
	'/medical-officer/:doctorId/associations/:associationId/revoke',
]

// Hospital Representative queries (read-only list & detail)
router.get(
	hospitalAssocPaths,
	protectHospitalAdminAuth,
	hospitalAssociationApprovalController.getHospitalAssociations
)
router.get(
	hospitalAssocDetailPaths,
	protectHospitalAdminAuth,
	hospitalAssociationApprovalController.getHospitalAssociationDetails
)

// Hospital Representative actions (suspend & revoke)
router.patch(
	hospitalAssocSuspendPaths,
	protectHospitalAdminAuth,
	hospitalAssociationApprovalController.suspendHospitalAssociationByHospital
)
router.patch(
	hospitalAssocRevokePaths,
	protectHospitalAdminAuth,
	hospitalAssociationApprovalController.revokeHospitalAssociationByHospital
)

// Explicit Denials for Hospital Representatives (Stage B3.4.4 Security Invariants)
const hospitalAssocApprovePaths = [
	'/medical-officers/:doctorId/associations/:associationId/approve',
	'/medical-officer/:doctorId/associations/:associationId/approve',
]
const hospitalAssocReactivatePaths = [
	'/medical-officers/:doctorId/associations/:associationId/reactivate',
	'/medical-officer/:doctorId/associations/:associationId/reactivate',
]
const hospitalAssocPermissionPaths = [
	'/medical-officers/:doctorId/associations/:associationId/permissions',
	'/medical-officer/:doctorId/associations/:associationId/permissions',
]

router.patch(hospitalAssocApprovePaths, protectHospitalAdminAuth, (req, res) => {
	return res.status(403).json({
		status: 'fail',
		message: 'Access denied: Hospital Representatives cannot approve associations. Platform Administrator approval is required.',
	})
})

router.patch(hospitalAssocReactivatePaths, protectHospitalAdminAuth, (req, res) => {
	return res.status(403).json({
		status: 'fail',
		message: 'Access denied: Hospital Representatives cannot reactivate suspended associations. Platform Administrator approval is required.',
	})
})

router.patch(hospitalAssocPermissionPaths, protectHospitalAdminAuth, (req, res) => {
	return res.status(403).json({
		status: 'fail',
		message: 'Access denied: Hospital Representatives cannot modify association clinical permissions. Platform Administrator authorization is required.',
	})
})

// Legacy Admin route fallback for backward compatibility
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
