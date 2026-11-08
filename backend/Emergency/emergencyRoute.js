/**
 * Emergency Blood Connection Route Definitions
 * Namma Blood — Emergency Blood Connection (Milestone 4.3)
 */

const express = require('express')
const router = express.Router()

const { protectEmergencyAuth } = require('./emergencyAuthMiddleware')
const { discoveryRateLimiter } = require('./discoveryRateLimiter')
const { requestCreationRateLimiter } = require('./emergencyRequestRateLimiter')
const {
	getNearbyDonors,
	getNearbyBloodbanks,
	getRequestMatches,
} = require('./emergencyDiscoveryController')
const {
	createEmergencyRequest,
	provideAdditionalInformation,
} = require('./emergencyRequestController')

// Sub-Milestone 4.3.0: Authenticated emergency blood request initiation with rate limiting
router.route('/requests').post(protectEmergencyAuth, requestCreationRateLimiter, createEmergencyRequest)

// Phase 4.3.5: Requester additional clinical information resubmission
router.route('/requests/:id/provide-information').patch(protectEmergencyAuth, provideAdditionalInformation)
router.route('/requests/:id/resubmit').patch(protectEmergencyAuth, provideAdditionalInformation)

// Sub-Milestone 4.3.1: Authenticated nearby donor discovery with rate limiting
router.route('/discover/donors').get(protectEmergencyAuth, discoveryRateLimiter, getNearbyDonors)

// Sub-Milestone 4.3.2: Authenticated nearby blood bank discovery with verified inventory
router.route('/discover/bloodbanks').get(protectEmergencyAuth, discoveryRateLimiter, getNearbyBloodbanks)

// Sub-Milestone 4.3.3.4: Authenticated emergency request matching engine with rate limiting
router.route('/requests/:id/matches').get(protectEmergencyAuth, discoveryRateLimiter, getRequestMatches)

module.exports = router
