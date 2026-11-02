/**
 * Emergency Blood Connection Route Definitions
 * Namma Blood — Emergency Blood Connection (Milestone 4.3)
 */

const express = require('express')
const router = express.Router()

const { protectEmergencyAuth } = require('./emergencyAuthMiddleware')
const { discoveryRateLimiter } = require('./discoveryRateLimiter')
const { getNearbyDonors, getNearbyBloodbanks } = require('./emergencyDiscoveryController')

// Sub-Milestone 4.3.1: Authenticated nearby donor discovery with rate limiting
router.route('/discover/donors').get(protectEmergencyAuth, discoveryRateLimiter, getNearbyDonors)

// Sub-Milestone 4.3.2: Authenticated nearby blood bank discovery with verified inventory
router.route('/discover/bloodbanks').get(protectEmergencyAuth, discoveryRateLimiter, getNearbyBloodbanks)

module.exports = router
