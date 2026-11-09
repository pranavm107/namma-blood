/**
 * Hospital Medical Officer Routes
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

const express = require('express')
const router = express.Router()

const { protectMedicalOfficerAuth } = require('./medicalOfficerMiddleware')
const { protectMedicalOfficerOnboarding } = require('./medicalOfficerOnboardingMiddleware')
const medicalOfficerController = require('./medicalOfficerController')
const medicalOfficerCredentialController = require('./medicalOfficerCredentialController')

// Public Independent Medical Officer Self-Registration (Stage B3.3)
// POST /api/medical-officers/register & POST /api/medical-officer/register
router.post('/register', medicalOfficerController.registerMedicalOfficer)

// =========================================================================
// Credential Onboarding & Management Endpoints (Stage B3.4.2)
// Accessible by Active Medical Officers in Onboarding scope
// =========================================================================
router.post(
	'/credentials/submit',
	protectMedicalOfficerOnboarding,
	medicalOfficerCredentialController.submitCredentials
)
router.get(
	'/credentials/status',
	protectMedicalOfficerOnboarding,
	medicalOfficerCredentialController.getCredentialStatus
)
router.patch(
	'/credentials/resubmit',
	protectMedicalOfficerOnboarding,
	medicalOfficerCredentialController.resubmitCredentials
)

// =========================================================================
// Clinical Operations Endpoints (Protected by Three-Gate Authorization)
// =========================================================================
// Enforce Medical Officer authentication, three-gate validation, and multi-tenancy across all routes
router.use(protectMedicalOfficerAuth('VIEW_EMERGENCY_REQUESTS'))

router.get('/dashboard', medicalOfficerController.getMedicalOfficerDashboard)
router.get('/requests', medicalOfficerController.getAssignedRequests)
router.get('/queue', medicalOfficerController.getAssignedRequests)
router.get('/requests/:id', medicalOfficerController.getRequestDetails)
router.get('/requests/:id/verification-history', medicalOfficerController.getVerificationHistory)

// Hospital-Specific Medical Officer Availability Endpoints
router.patch('/hospitals/:hospitalId/availability', medicalOfficerController.updateAvailability)
router.get('/hospitals/:hospitalId/availability', medicalOfficerController.getAvailability)

// State Machine Decision Endpoints (Requires VERIFY_EMERGENCY_REQUESTS)
router.patch('/requests/:id/verify', protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.approveEmergencyRequest)
router.patch('/requests/:id/approve', protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.approveEmergencyRequest)
router.patch('/requests/:id/reject', protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.rejectEmergencyRequest)
router.patch('/requests/:id/request-information', protectMedicalOfficerAuth('VERIFY_EMERGENCY_REQUESTS'), medicalOfficerController.requestAdditionalInformation)

module.exports = router

