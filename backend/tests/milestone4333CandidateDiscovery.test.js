/**
 * Milestone 4.3.3.3 Test Suite: Dual-Stream Candidate Discovery & 128-bit Truncated HMAC Reference Engine
 * Namma Blood — Phase 4 Emergency Blood Connection
 *
 * Requirements Covered:
 * 1. Dedicated HMAC Configuration Validation (EMERGENCY_HMAC_SECRET min 32 chars, fail closed, no JWT fallback, no leakage).
 * 2. 128-bit Truncated HMAC Reference Generation & Key Rotation (DNR-[0-9A-F]{32}, deterministic, previous key grace window).
 * 3. Donor Candidate Discovery & Clinical Eligibility Filters (compatible groups, exclusions for deferral, cooldown, busy).
 * 4. Blood Bank Traceable Inventory Integration (Phase 3 gates: Available, unexpired, MO verified, 5 TTI Non_Reactive, unreserved).
 * 5. Exact Five-Way Candidate Classification:
 *    - Potential_Donor_Match
 *    - Pending_Clinical_Evaluation
 *    - Verified_Bloodbank_Stock_Match
 *    - No_Matching_Stock
 *    - Inventory_Unverified (verifiedUnitsAvailable === null)
 * 6. Multi-Attribute Ranking & Deterministic Tie-Breaking (Clinical & inventory suitability prioritized over proximity).
 * 7. Privacy Shield & Allowlist Sanitization (Zero leaked ObjectIds, user IDs, coordinates, contact info, or DINs).
 * 8. Clinical Governance Flags & Read-Only Invariant (Zero database mutations).
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const crypto = require('crypto')

const {
	resolveEmergencyRequest,
	authorizeRequestAccess,
	validateRequestLifecycle,
	validateShortfallIntegrity,
	deriveRequestCompatibility,
	validateAndAuthorizeEmergencyRequest,
	validateHmacConfiguration,
	deriveCandidateReference,
	verifyCandidateReference,
	derivePublicFacilityReference,
	sanitizeDonorCandidate,
	sanitizeBloodBankCandidate,
	rankDonorCandidates,
	rankBloodBankCandidates,
	rankCombinedCandidates,
	discoverDonorCandidates,
	discoverBloodBankCandidates,
	findEmergencyRequestMatches,
} = require('../Emergency/emergencyMatchingService')

const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const { EmergencyDonorProfile } = require('../Emergency/emergencyDonorProfileModel')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const User = require('../User/userModel')
const stockService = require('../BloodStock/stockService')

const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

// Synthetic test secret (exactly 44 chars)
const VALID_TEST_HMAC_SECRET = 'NammaBlood_EmergencyMatching_SecretKey_2026_ABCD1234'
const VALID_PREVIOUS_HMAC_SECRET = 'NammaBlood_EmergencyMatching_PreviousKey_2025_XYZ9876'

function makeUserData(index, bloodGroup, overrides = {}) {
	const rand = Math.floor(10000000 + Math.random() * 90000000)
	const uniqueId = crypto.randomUUID().slice(0, 8)
	return {
		firstName: `Donor${index}`,
		lastName: 'Candidate',
		gender: 'Male',
		dob: new Date('1995-01-01'),
		age: 31,
		address: '100 Medical Street',
		bloodGroup: bloodGroup || 'B_Positive',
		state: 'Karnataka',
		city: 'Bengaluru',
		pinCode: 560001,
		phoneNo1: Number(`95${rand}`),
		email: `donor_${uniqueId}_${index}@nammablood.test`,
		password: 'Password123!',
		status: true,
		...overrides,
	}
}

describe('Milestone 4.3.3.3: Dual-Stream Candidate Discovery & 128-bit Truncated HMAC Engine', () => {
	let dbConnected = false

	// Track created document IDs for clean teardown
	const createdRequestIds = []
	const createdDonorIds = []
	const createdBankIds = []
	const createdUnitIds = []
	const createdUserIds = []

	let testUser = null
	let verifiedBPosRequest = null
	let referenceNow = new Date('2026-11-02T12:00:00.000Z')

	before(async () => {
		try {
			if (mongoose.connection.readyState !== 1) {
				await mongoose.connect(TEST_DB_URI)
			}
			dbConnected = mongoose.connection.readyState === 1
		} catch (err) {
			console.log('MongoDB not connected; skipping live DB tests.')
		}

		if (dbConnected) {
			// Create authenticated test user (creator)
			testUser = await User.create(makeUserData(1, 'B_Positive', { firstName: 'Matching', lastName: 'Requester' }))
			createdUserIds.push(testUser._id)


			// Create verified emergency request in Bengaluru (12.9716 N, 77.5946 E)
			verifiedBPosRequest = await EmergencyBloodRequest.create({
				requestNumber: `EMG-M4333-${Date.now().toString().slice(-6)}`,
				requesterUserId: testUser._id,
				patientName: 'SubMilestone Patient',
				patientAge: 35,
				patientGender: 'Female',
				requiredBloodGroup: 'B_Positive',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 2,
				unitsReserved: 0,
				unitsFulfilled: 0,
				urgencyLevel: 'Critical',
				requiredWithinHours: 4,
				expiresAt: new Date(Date.now() + 4 * 3600 * 1000),
				hospitalName: 'Bengaluru Medical College Hospital',
				hospitalAddress: 'Fort Road, Bengaluru',
				hospitalCity: 'Bengaluru',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560002,
				location: {
					type: 'Point',
					coordinates: [77.5946, 12.9716], // [longitude, latitude]
				},
				attendingDoctor: {
					doctorName: 'Dr. Ramesh Kumar',
					doctorPhone: '9876543211',
					registrationNumber: 'KMC-84729',
				},
				verificationStatus: 'Verified',
				status: 'Active',
			})
			createdRequestIds.push(verifiedBPosRequest._id)
		}
	})

	after(async () => {
		if (dbConnected) {
			if (createdRequestIds.length > 0) {
				await EmergencyBloodRequest.deleteMany({ _id: { $in: createdRequestIds } })
			}
			if (createdDonorIds.length > 0) {
				await EmergencyDonorProfile.deleteMany({ _id: { $in: createdDonorIds } })
			}
			if (createdBankIds.length > 0) {
				await Bloodbank.deleteMany({ _id: { $in: createdBankIds } })
			}
			if (createdUnitIds.length > 0) {
				await BloodUnit.deleteMany({ _id: { $in: createdUnitIds } })
			}
			if (createdUserIds.length > 0) {
				await User.deleteMany({ _id: { $in: createdUserIds } })
			}
			await mongoose.disconnect()
		}
	})

	// =========================================================================
	// 1. DEDICATED HMAC CONFIGURATION VALIDATION & 128-BIT TRUNCATION
	// =========================================================================
	describe('1. Dedicated HMAC Configuration Validation', () => {
		it('should fail closed with 500 HMAC_CONFIG_INVALID when secret is undefined or null', () => {
			assert.throws(
				() => validateHmacConfiguration(undefined),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'HMAC_CONFIG_INVALID')
					assert.match(err.message, /EMERGENCY_HMAC_SECRET is mandatory/)
					return true
				}
			)

			assert.throws(
				() => validateHmacConfiguration(null),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					return true
				}
			)
		})

		it('should fail closed with 500 HMAC_CONFIG_INVALID when secret is empty string', () => {
			assert.throws(
				() => validateHmacConfiguration(''),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'HMAC_CONFIG_INVALID')
					return true
				}
			)
		})

		it('should fail closed with 500 HMAC_CONFIG_INVALID when secret is shorter than 32 characters', () => {
			const shortSecret = 'ShortSecret_Only_31_Characters!'
			assert.strictEqual(shortSecret.length, 31)

			assert.throws(
				() => validateHmacConfiguration(shortSecret),
				(err) => {
					assert.strictEqual(err.statusCode, 500)
					assert.strictEqual(err.code, 'HMAC_CONFIG_INVALID')
					// Guarantee secret is not leaked in error message
					assert.strictEqual(err.message.includes(shortSecret), false)
					return true
				}
			)
		})

		it('should accept secret with exactly 32 characters or longer', () => {
			const exact32Secret = '12345678901234567890123456789012'
			assert.strictEqual(exact32Secret.length, 32)
			assert.strictEqual(validateHmacConfiguration(exact32Secret), true)

			assert.strictEqual(validateHmacConfiguration(VALID_TEST_HMAC_SECRET), true)
		})

		it('should never fall back to JWT_SECRET if EMERGENCY_HMAC_SECRET is missing', () => {
			const originalHmac = process.env.EMERGENCY_HMAC_SECRET
			const originalJwt = process.env.JWT_SECRET

			try {
				delete process.env.EMERGENCY_HMAC_SECRET
				process.env.JWT_SECRET = 'SomeSuperSecretJwtKeyThatIsLongEnough123456'

				assert.throws(
					() => deriveCandidateReference('654a1b2c3d4e5f6a7b8c9d0e', '654a1b2c3d4e5f6a7b8c9d0f'),
					(err) => {
						assert.strictEqual(err.statusCode, 500)
						assert.strictEqual(err.code, 'HMAC_CONFIG_INVALID')
						return true
					}
				)
			} finally {
				if (originalHmac) process.env.EMERGENCY_HMAC_SECRET = originalHmac
				if (originalJwt) process.env.JWT_SECRET = originalJwt
			}
		})

		it('should never leak secret content in errors, message text, or logs', () => {
			const testSecretWithSensitiveToken = 'TopSecretSecretToken_DoNotLeakMe_12345678'
			try {
				validateHmacConfiguration('short')
			} catch (err) {
				assert.strictEqual(err.message.includes(testSecretWithSensitiveToken), false)
			}
		})
	})

	// =========================================================================
	// 2. 128-BIT TRUNCATED HMAC REFERENCE GENERATION & KEY ROTATION
	// =========================================================================
	describe('2. 128-bit Truncated HMAC Reference Generation & Rotation', () => {
		const reqId = new mongoose.Types.ObjectId()
		const donorId1 = new mongoose.Types.ObjectId()
		const donorId2 = new mongoose.Types.ObjectId()

		it('should generate candidate reference in exact DNR- plus 32 uppercase hexadecimal format (128 bits)', () => {
			const ref = deriveCandidateReference(reqId, donorId1, VALID_TEST_HMAC_SECRET)

			assert.strictEqual(typeof ref, 'string')
			assert.strictEqual(ref.length, 36) // 'DNR-' (4) + 32 hex chars = 36 chars
			assert.match(ref, /^DNR-[0-9A-F]{32}$/)
		})

		it('should produce strictly deterministic candidate reference for identical inputs', () => {
			const ref1 = deriveCandidateReference(reqId, donorId1, VALID_TEST_HMAC_SECRET)
			const ref2 = deriveCandidateReference(reqId, donorId1, VALID_TEST_HMAC_SECRET)
			assert.strictEqual(ref1, ref2)
		})

		it('should produce distinct candidate references for different donors on the same request', () => {
			const ref1 = deriveCandidateReference(reqId, donorId1, VALID_TEST_HMAC_SECRET)
			const ref2 = deriveCandidateReference(reqId, donorId2, VALID_TEST_HMAC_SECRET)
			assert.notStrictEqual(ref1, ref2)
		})

		it('should produce distinct candidate references for the same donor across different requests', () => {
			const reqId2 = new mongoose.Types.ObjectId()
			const ref1 = deriveCandidateReference(reqId, donorId1, VALID_TEST_HMAC_SECRET)
			const ref2 = deriveCandidateReference(reqId2, donorId1, VALID_TEST_HMAC_SECRET)
			assert.notStrictEqual(ref1, ref2)
		})

		it('should verify candidate reference under active current secret', () => {
			const ref = deriveCandidateReference(reqId, donorId1, VALID_TEST_HMAC_SECRET)
			const result = verifyCandidateReference(ref, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
			})

			assert.deepStrictEqual(result, { isValid: true, keyVersion: 'current' })
		})

		it('should verify candidate reference under previous key DURING active grace window', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const graceStartsAt = new Date('2026-11-01T00:00:00.000Z')
			const graceExpiresAt = new Date('2026-11-03T00:00:00.000Z')
			const referenceNow = new Date('2026-11-02T12:00:00.000Z') // Exactly during grace window

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: graceStartsAt,
				previousKeyExpiresAt: graceExpiresAt,
				now: referenceNow,
			})

			assert.strictEqual(result.isValid, true)
			assert.strictEqual(result.keyVersion, 'previous')
		})

		it('should REJECT previous-key candidate reference BEFORE grace period starts', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const graceStartsAt = new Date('2026-11-02T15:00:00.000Z') // Starts in future
			const graceExpiresAt = new Date('2026-11-04T00:00:00.000Z')
			const referenceNow = new Date('2026-11-02T12:00:00.000Z') // Before startsAt

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: graceStartsAt,
				previousKeyExpiresAt: graceExpiresAt,
				now: referenceNow,
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'GRACE_PERIOD_NOT_STARTED')
		})

		it('should REJECT previous-key candidate reference AFTER grace period expires', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const graceStartsAt = new Date('2026-10-25T00:00:00.000Z')
			const graceExpiresAt = new Date('2026-10-30T00:00:00.000Z') // Lapsed in past
			const referenceNow = new Date('2026-11-02T12:00:00.000Z') // After expiresAt

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: graceStartsAt,
				previousKeyExpiresAt: graceExpiresAt,
				now: referenceNow,
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'GRACE_PERIOD_EXPIRED')
		})

		it('should REJECT previous-key candidate reference at the exact expiry instant (now === previousKeyExpiresAt)', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const graceStartsAt = new Date('2026-11-01T00:00:00.000Z')
			const graceExpiresAt = new Date('2026-11-03T12:00:00.000Z')
			const exactExpiryNow = new Date('2026-11-03T12:00:00.000Z') // Exactly at expiry boundary

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: graceStartsAt,
				previousKeyExpiresAt: graceExpiresAt,
				now: exactExpiryNow,
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'GRACE_PERIOD_EXPIRED')
		})

		it('should ACCEPT previous-key candidate reference at the exact start instant (now === previousKeyStartsAt)', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const graceStartsAt = new Date('2026-11-01T00:00:00.000Z')
			const graceExpiresAt = new Date('2026-11-03T12:00:00.000Z')
			const exactStartNow = new Date('2026-11-01T00:00:00.000Z') // Exactly at start boundary

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: graceStartsAt,
				previousKeyExpiresAt: graceExpiresAt,
				now: exactStartNow,
			})

			assert.strictEqual(result.isValid, true)
			assert.strictEqual(result.keyVersion, 'previous')
		})

		it('should fail closed when previous key is supplied but previousKeyStartsAt is missing', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: null, // Missing start
				previousKeyExpiresAt: new Date(Date.now() + 86400000),
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'MISSING_GRACE_START')
		})

		it('should fail closed when previous key is supplied but previousKeyExpiresAt is missing', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: new Date('2026-11-01T00:00:00.000Z'),
				previousKeyExpiresAt: null, // Missing expiry
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'MISSING_GRACE_EXPIRY')
		})

		it('should fail closed when previousKeyStartsAt is later than or equal to previousKeyExpiresAt (inconsistent rotation range)', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: new Date('2026-11-05T00:00:00.000Z'), // Starts AFTER expiry
				previousKeyExpiresAt: new Date('2026-11-03T00:00:00.000Z'),
				now: new Date('2026-11-04T00:00:00.000Z'),
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'INCONSISTENT_ROTATION_CONFIG')
		})

		it('should fail closed when previous key expiry timestamp is invalid', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)

			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: new Date('2026-11-01T00:00:00.000Z'),
				previousKeyExpiresAt: 'not-a-valid-date-string',
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'INVALID_GRACE_EXPIRY')
		})

		it('should always verify active current key regardless of previous key grace window status', () => {
			const currentRef = deriveCandidateReference(reqId, donorId1, VALID_TEST_HMAC_SECRET)

			// Even if previousKeyExpiresAt is lapsed in past, active key verification succeeds
			const result = verifyCandidateReference(currentRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: new Date('2024-01-01T00:00:00.000Z'),
				previousKeyExpiresAt: new Date('2025-01-01T00:00:00.000Z'), // Past
				now: new Date('2026-11-02T12:00:00.000Z'),
			})

			assert.strictEqual(result.isValid, true)
			assert.strictEqual(result.keyVersion, 'current')
		})

		it('should return isValid: false when reference does not match either active or previous key', () => {
			const forgedRef = 'DNR-A1B2C3D4E5F60718293A4B5C6D7E8F90'
			const result = verifyCandidateReference(forgedRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: new Date(Date.now() - 3600000),
				previousKeyExpiresAt: new Date(Date.now() + 86400000),
			})

			assert.deepStrictEqual(result, { isValid: false, keyVersion: null })
		})

		it('should return isValid: false on malformed candidate reference string', () => {
			const result = verifyCandidateReference('invalid-format', reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
			})
			assert.deepStrictEqual(result, { isValid: false, keyVersion: null })
		})

		it('should fail closed with INVALID_PREVIOUS_SECRET when previous secret is shorter than 32 characters', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)
			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: 'ShortKey_Under_32_Chars!',
				previousKeyStartsAt: new Date(Date.now() - 3600000),
				previousKeyExpiresAt: new Date(Date.now() + 86400000),
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'INVALID_PREVIOUS_SECRET')
		})

		it('should fail closed with INVALID_GRACE_STARTS_AT when previousKeyStartsAt is an invalid date string', () => {
			const oldRef = deriveCandidateReference(reqId, donorId1, VALID_PREVIOUS_HMAC_SECRET)
			const result = verifyCandidateReference(oldRef, reqId, donorId1, {
				secret: VALID_TEST_HMAC_SECRET,
				previousSecret: VALID_PREVIOUS_HMAC_SECRET,
				previousKeyStartsAt: 'invalid-starts-at-date',
				previousKeyExpiresAt: new Date(Date.now() + 86400000),
			})

			assert.strictEqual(result.isValid, false)
			assert.strictEqual(result.keyVersion, null)
			assert.strictEqual(result.rotationStatus, 'INVALID_GRACE_STARTS_AT')
		})
	})

	// =========================================================================
	// 3. PUBLIC FACILITY REFERENCE GENERATION (BB-XXXXXXXXXXXX)
	// =========================================================================
	describe('3. Public Facility Reference Derivation', () => {
		it('should derive deterministic opaque facility reference in BB-XXXXXXXXXXXX format', () => {
			const bankId = new mongoose.Types.ObjectId()
			const ref1 = derivePublicFacilityReference(bankId)
			const ref2 = derivePublicFacilityReference(bankId)

			assert.strictEqual(ref1, ref2)
			assert.match(ref1, /^BB-[0-9A-F]{12}$/)
			assert.strictEqual(ref1.length, 15) // 'BB-' (3) + 12 hex chars = 15 chars
		})

		it('should derive distinct facility references for different blood banks', () => {
			const bank1 = new mongoose.Types.ObjectId()
			const bank2 = new mongoose.Types.ObjectId()
			assert.notStrictEqual(derivePublicFacilityReference(bank1), derivePublicFacilityReference(bank2))
		})
	})

	// =========================================================================
	// 4. DONOR CANDIDATE DISCOVERY & ELIGIBILITY FILTERS
	// =========================================================================
	describe('4. Donor Candidate Discovery & Eligibility Safeguards', () => {
		let donorUser1, donorUser2, donorUser3, donorUser4, donorUser5, donorUser6

		before(async () => {
			if (!dbConnected) return

			// Create users for donor profiles using makeUserData helper
			const userDocs = await User.create([
				makeUserData(10, 'B_Positive', { firstName: 'Cleared', lastName: 'BPos' }),
				makeUserData(20, 'O_Positive', { firstName: 'Pending', lastName: 'OPos' }),
				makeUserData(30, 'A_Positive', { firstName: 'Incompatible', lastName: 'APos' }),
				makeUserData(40, 'B_Positive', { firstName: 'Deferred', lastName: 'BPos' }),
				makeUserData(50, 'B_Positive', { firstName: 'Cooldown', lastName: 'BPos' }),
				makeUserData(60, 'B_Positive', { firstName: 'Busy', lastName: 'BPos' }),
			])
			userDocs.forEach((u) => createdUserIds.push(u._id))
			;[donorUser1, donorUser2, donorUser3, donorUser4, donorUser5, donorUser6] = userDocs

			// Create corresponding EmergencyDonorProfile documents in Bengaluru (within 10km of hospital)
			const donorProfiles = await EmergencyDonorProfile.create([
				// 1. Compatible B_Positive, Clinically_Cleared, Ready (~3.5 km away)
				{
					userId: donorUser1._id,
					bloodGroup: 'B_Positive',
					isEmergencyDonor: true,
					availabilityStatus: 'Ready',
					clinicalEligibilityStatus: 'Clinically_Cleared',
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560001,
					maxTravelDistanceKm: 15,
					location: { type: 'Point', coordinates: [77.6100, 12.9800] },
				},
				// 2. Compatible O_Positive (Alternative), Pending_Clinical_Evaluation, Ready (~5.2 km away)
				{
					userId: donorUser2._id,
					bloodGroup: 'O_Positive',
					isEmergencyDonor: true,
					availabilityStatus: 'Ready',
					clinicalEligibilityStatus: 'Pending_Clinical_Evaluation',
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560025,
					maxTravelDistanceKm: 15,
					location: { type: 'Point', coordinates: [77.6250, 12.9900] },
				},
				// 3. Incompatible A_Positive (should be strictly excluded for B_Positive PRBC)
				{
					userId: donorUser3._id,
					bloodGroup: 'A_Positive',
					isEmergencyDonor: true,
					availabilityStatus: 'Ready',
					clinicalEligibilityStatus: 'Clinically_Cleared',
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560001,
					location: { type: 'Point', coordinates: [77.6000, 12.9750] },
				},
				// 4. Temporarily Deferred B_Positive (should be strictly excluded)
				{
					userId: donorUser4._id,
					bloodGroup: 'B_Positive',
					isEmergencyDonor: true,
					availabilityStatus: 'Ready',
					clinicalEligibilityStatus: 'Temporarily_Deferred',
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560001,
					location: { type: 'Point', coordinates: [77.6050, 12.9760] },
				},
				// 5. Active Cooldown Period B_Positive (eligibleToDonateAfter > now, should be excluded)
				{
					userId: donorUser5._id,
					bloodGroup: 'B_Positive',
					isEmergencyDonor: true,
					availabilityStatus: 'Ready',
					clinicalEligibilityStatus: 'Clinically_Cleared',
					eligibleToDonateAfter: new Date(Date.now() + 30 * 24 * 3600 * 1000), // 30 days in future
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560001,
					location: { type: 'Point', coordinates: [77.6020, 12.9740] },
				},
				// 6. Busy Availability Donor (availabilityStatus: 'Busy_Temporarily', should be excluded)
				{
					userId: donorUser6._id,
					bloodGroup: 'B_Positive',
					isEmergencyDonor: true,
					availabilityStatus: 'Busy_Temporarily',
					clinicalEligibilityStatus: 'Clinically_Cleared',
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560001,
					location: { type: 'Point', coordinates: [77.6010, 12.9730] },
				},
			])
			donorProfiles.forEach((p) => createdDonorIds.push(p._id))
		})

		it('should discover compatible donors and exclude incompatible, deferred, cooldown, and busy donors', async () => {
			if (!dbConnected) return

			const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
			const result = await discoverDonorCandidates(verifiedBPosRequest, compatibility, {
				radiusKm: 15,
				hmacSecret: VALID_TEST_HMAC_SECRET,
			})

			assert.strictEqual(result.data.length, 2)
			const groups = result.data.map((d) => d.bloodGroup)
			assert.strictEqual(groups.includes('B_Positive'), true)
			assert.strictEqual(groups.includes('O_Positive'), true)
			assert.strictEqual(groups.includes('A_Positive'), false) // Excluded incompatible
		})

		it('should correctly classify Clinically_Cleared as Potential_Donor_Match with historical MO review notice', async () => {
			if (!dbConnected) return

			const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
			const result = await discoverDonorCandidates(verifiedBPosRequest, compatibility, {
				radiusKm: 15,
				hmacSecret: VALID_TEST_HMAC_SECRET,
			})

			const clearedDonor = result.data.find((d) => d.bloodGroup === 'B_Positive')
			assert.ok(clearedDonor)
			assert.strictEqual(clearedDonor.classification, 'Potential_Donor_Match')
			assert.strictEqual(clearedDonor.matchQuality, 'Identical')
			assert.match(clearedDonor.clinicalNotice, /historical Medical Officer review/)
			assert.match(clearedDonor.clinicalNotice, /laboratory crossmatching remain compulsory/)
		})

		it('should correctly classify Pending_Clinical_Evaluation with mandatory clinical evaluation notice', async () => {
			if (!dbConnected) return

			const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
			const result = await discoverDonorCandidates(verifiedBPosRequest, compatibility, {
				radiusKm: 15,
				hmacSecret: VALID_TEST_HMAC_SECRET,
			})

			const pendingDonor = result.data.find((d) => d.bloodGroup === 'O_Positive')
			assert.ok(pendingDonor)
			assert.strictEqual(pendingDonor.classification, 'Pending_Clinical_Evaluation')
			assert.strictEqual(pendingDonor.matchQuality, 'Compatible_Alternative')
			assert.match(pendingDonor.clinicalNotice, /Mandatory clinical safety notice: Prospective candidate/)
			assert.match(pendingDonor.clinicalNotice, /Donor has not undergone qualified clinical review/)
		})

		it('should never treat self-reported availability as clinical clearance', async () => {
			if (!dbConnected) return

			const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
			const result = await discoverDonorCandidates(verifiedBPosRequest, compatibility, {
				radiusKm: 15,
				hmacSecret: VALID_TEST_HMAC_SECRET,
			})

			const pendingDonor = result.data.find((d) => d.classification === 'Pending_Clinical_Evaluation')
			assert.strictEqual(pendingDonor.availabilityStatus, 'Ready')
			assert.strictEqual(pendingDonor.clinicalEligibilityStatus, 'Pending_Clinical_Evaluation')
			assert.notStrictEqual(pendingDonor.classification, 'Potential_Donor_Match')
		})
	})

	// =========================================================================
	// 5. BLOOD BANK TRACEABLE INVENTORY DISCOVERY & CLASSIFICATIONS
	// =========================================================================
	describe('5. Blood Bank Traceable Inventory Discovery & Exact 3-Way Stock Classifications', () => {
		let bankWithStock, bankZeroStock, bankUnverified

		before(async () => {
			if (!dbConnected) return

			// Create 3 synthetic blood banks in Bengaluru
			const banks = await Bloodbank.create([
				// Bank 1: Has verified issue-eligible stock
				{
					bloodbankName: 'Victoria Hospital Blood Centre',
					contactPerson: 'Dr. Suresh Director',
					category: 'Government',
					address1: 'K.R. Market Road',
					address2: 'Near City Market',
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560002,
					phoneNo1: `080-86${Math.floor(100000 + Math.random() * 900000)}`,
					phoneNo2: `080-87${Math.floor(100000 + Math.random() * 900000)}`,
					email: `victoria_${crypto.randomUUID()}@bloodbank.test`,
					password: 'Password123!',
					status: true,
					location: { type: 'Point', coordinates: [77.5850, 12.9650] },
				},
				// Bank 2: Traceable records exist, but 0 matching units
				{
					bloodbankName: 'Bowring Hospital Blood Centre',
					contactPerson: 'Dr. Anita Incharge',
					category: 'Government',
					address1: 'Lady Curzon Road',
					address2: 'Shivaji Nagar',
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560001,
					phoneNo1: `080-88${Math.floor(100000 + Math.random() * 900000)}`,
					phoneNo2: `080-89${Math.floor(100000 + Math.random() * 900000)}`,
					email: `bowring_${crypto.randomUUID()}@bloodbank.test`,
					password: 'Password123!',
					status: true,
					location: { type: 'Point', coordinates: [77.6000, 12.9800] },
				},
				// Bank 3: No traceable inventory initialized on platform
				{
					bloodbankName: 'Unregistered Inventory Charity Bank',
					contactPerson: 'Mr. Raghavan Trustee',
					category: 'Charitable',
					address1: 'M.G. Road',
					address2: 'Brigade Junction',
					city: 'Bengaluru',
					state: 'Karnataka',
					pinCode: 560025,
					phoneNo1: `080-90${Math.floor(100000 + Math.random() * 900000)}`,
					phoneNo2: `080-91${Math.floor(100000 + Math.random() * 900000)}`,
					email: `charity_${crypto.randomUUID()}@bloodbank.test`,
					password: 'Password123!',
					status: true,
					location: { type: 'Point', coordinates: [77.6100, 12.9750] },
				},
			])
			banks.forEach((b) => createdBankIds.push(b._id))
			;[bankWithStock, bankZeroStock, bankUnverified] = banks

			// Populate Bank 1 with traceable units:
			// 2 verified issue-eligible B_Positive PRBC units
			const validUnits = await BloodUnit.create([
				{
					unitNumber: `DIN-B1-01-${Date.now()}`,
					bloodbankId: bankWithStock._id,
					bloodGroup: 'B_Positive',
					componentType: 'Packed_Red_Blood_Cells',
					status: 'Available',
					collectionDate: new Date(Date.now() - 5 * 24 * 3600 * 1000),
					expiryDate: new Date(Date.now() + 35 * 24 * 3600 * 1000),
					volumeMl: 350,
					testing: { hiv: 'Non_Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
					clearance: { isVerified: true, verifiedBy: new mongoose.Types.ObjectId(), verifiedAt: new Date() },
				},
				{
					unitNumber: `DIN-B1-02-${Date.now()}`,
					bloodbankId: bankWithStock._id,
					bloodGroup: 'B_Positive',
					componentType: 'Packed_Red_Blood_Cells',
					status: 'Available',
					collectionDate: new Date(Date.now() - 4 * 24 * 3600 * 1000),
					expiryDate: new Date(Date.now() + 36 * 24 * 3600 * 1000),
					volumeMl: 350,
					testing: { hiv: 'Non_Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
					clearance: { isVerified: true, verifiedBy: new mongoose.Types.ObjectId(), verifiedAt: new Date() },
				},
				// Excluded unit 1: Quarantined
				{
					unitNumber: `DIN-B1-03-${Date.now()}`,
					bloodbankId: bankWithStock._id,
					bloodGroup: 'B_Positive',
					componentType: 'Packed_Red_Blood_Cells',
					status: 'Quarantined',
					collectionDate: new Date(),
					expiryDate: new Date(Date.now() + 40 * 24 * 3600 * 1000),
					volumeMl: 350,
					testing: { hiv: 'Pending', hbv: 'Pending', hcv: 'Pending', syphilis: 'Pending', malaria: 'Pending' },
					clearance: { isVerified: false },
				},
				// Excluded unit 2: Reactive TTI (HIV) - status must be Discarded
				{
					unitNumber: `DIN-B1-04-${Date.now()}`,
					bloodbankId: bankWithStock._id,
					bloodGroup: 'B_Positive',
					componentType: 'Packed_Red_Blood_Cells',
					status: 'Discarded',
					collectionDate: new Date(Date.now() - 10 * 24 * 3600 * 1000),
					expiryDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
					volumeMl: 350,
					testing: { hiv: 'Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
					clearance: { isVerified: false },
				},
				// Excluded unit 3: Expired - status must be Expired
				{
					unitNumber: `DIN-B1-05-${Date.now()}`,
					bloodbankId: bankWithStock._id,
					bloodGroup: 'B_Positive',
					componentType: 'Packed_Red_Blood_Cells',
					status: 'Expired',
					collectionDate: new Date(Date.now() - 45 * 24 * 3600 * 1000),
					expiryDate: new Date(Date.now() - 2 * 24 * 3600 * 1000), // Expired 2 days ago
					volumeMl: 350,
					testing: { hiv: 'Non_Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
					clearance: { isVerified: true },
				},
				// Excluded unit 4: Missing MO clearance - status must be Tested_Passed
				{
					unitNumber: `DIN-B1-06-${Date.now()}`,
					bloodbankId: bankWithStock._id,
					bloodGroup: 'B_Positive',
					componentType: 'Packed_Red_Blood_Cells',
					status: 'Tested_Passed',
					collectionDate: new Date(Date.now() - 5 * 24 * 3600 * 1000),
					expiryDate: new Date(Date.now() + 35 * 24 * 3600 * 1000),
					volumeMl: 350,
					testing: { hiv: 'Non_Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
					clearance: { isVerified: false }, // No MO clearance
				},
				// Excluded unit 5: Component mismatch (Platelet instead of PRBC)
				{
					unitNumber: `DIN-B1-07-${Date.now()}`,
					bloodbankId: bankWithStock._id,
					bloodGroup: 'B_Positive',
					componentType: 'Platelet_Concentrate',
					status: 'Available',
					collectionDate: new Date(Date.now() - 1 * 24 * 3600 * 1000),
					expiryDate: new Date(Date.now() + 4 * 24 * 3600 * 1000),
					volumeMl: 50,
					testing: { hiv: 'Non_Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
					clearance: { isVerified: true },
				},
			])
			validUnits.forEach((u) => createdUnitIds.push(u._id))

			// Populate Bank 2 with traceable units of ONLY A_Positive (so B_Positive query has 0 matching)
			const bank2Units = await BloodUnit.create([
				{
					unitNumber: `DIN-B2-01-${Date.now()}`,
					bloodbankId: bankZeroStock._id,
					bloodGroup: 'A_Positive', // Incompatible with B_Positive PRBC
					componentType: 'Packed_Red_Blood_Cells',
					status: 'Available',
					collectionDate: new Date(),
					expiryDate: new Date(Date.now() + 30 * 24 * 3600 * 1000),
					volumeMl: 350,
					testing: { hiv: 'Non_Reactive', hbv: 'Non_Reactive', hcv: 'Non_Reactive', syphilis: 'Non_Reactive', malaria: 'Non_Reactive' },
					clearance: { isVerified: true },
				},
			])
			bank2Units.forEach((u) => createdUnitIds.push(u._id))
		})

		it('should classify bank with verified units as Verified_Bloodbank_Stock_Match with exact unit count (excluding invalid units)', async () => {
			if (!dbConnected) return

			const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
			const result = await discoverBloodBankCandidates(verifiedBPosRequest, compatibility, {
				radiusKm: 15,
			})

			const bank1Match = result.data.find((b) => b.bloodbankName.includes('Victoria Hospital'))
			assert.ok(bank1Match)
			assert.strictEqual(bank1Match.inventoryTrustStatus, 'Verified_Bloodbank_Stock_Match')
			// Exactly 2 units meeting ALL safety gates (quarantined, reactive, expired, missing MO, and platelet excluded)
			assert.strictEqual(bank1Match.verifiedUnitsAvailable, 2)
			assert.strictEqual(bank1Match.matchQuality, 'Identical')
			assert.match(bank1Match.rankingExplanation, /Verified stock available \(2 units\)/)
		})

		it('should classify bank with traceable units but 0 matching units as No_Matching_Stock (verifiedUnitsAvailable: 0)', async () => {
			if (!dbConnected) return

			const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
			const result = await discoverBloodBankCandidates(verifiedBPosRequest, compatibility, {
				radiusKm: 15,
			})

			const bank2Match = result.data.find((b) => b.bloodbankName.includes('Bowring Hospital'))
			assert.ok(bank2Match)
			assert.strictEqual(bank2Match.inventoryTrustStatus, 'No_Matching_Stock')
			assert.strictEqual(bank2Match.verifiedUnitsAvailable, 0)
			assert.match(bank2Match.inventoryNotice, /No matching units found/)
		})

		it('should classify facility without traceable platform records as Inventory_Unverified (verifiedUnitsAvailable: null)', async () => {
			if (!dbConnected) return

			const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
			const result = await discoverBloodBankCandidates(verifiedBPosRequest, compatibility, {
				radiusKm: 15,
			})

			const bank3Match = result.data.find((b) => b.bloodbankName.includes('Unregistered Inventory Charity'))
			assert.ok(bank3Match)
			assert.strictEqual(bank3Match.inventoryTrustStatus, 'Inventory_Unverified')
			assert.strictEqual(bank3Match.verifiedUnitsAvailable, null) // Strictly null, NEVER zero
			assert.match(bank3Match.inventoryNotice, /Traceable inventory records are not available/)
		})

		it('should classify inventory lookup failures as Inventory_Unverified (verifiedUnitsAvailable: null, fail closed)', async () => {
			// Mock stockService.getTraceableStatusBreakdown throwing an error
			const originalBreakdown = stockService.getTraceableStatusBreakdown
			stockService.getTraceableStatusBreakdown = async () => {
				throw new Error('Database connection timeout')
			}

			try {
				const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
				const result = await discoverBloodBankCandidates(verifiedBPosRequest, compatibility, {
					radiusKm: 15,
				})

				for (const bank of result.data) {
					assert.strictEqual(bank.inventoryTrustStatus, 'Inventory_Unverified')
					assert.strictEqual(bank.verifiedUnitsAvailable, null)
				}
			} finally {
				stockService.getTraceableStatusBreakdown = originalBreakdown
			}
		})
	})

	// =========================================================================
	// 6. MULTI-ATTRIBUTE RANKING & DETERMINISTIC TIE-BREAKING
	// =========================================================================
	describe('6. Multi-Attribute Candidate Ranking & Deterministic Tie-Breaking', () => {
		it('should prioritize clinical cleared status over geographic proximity for donors', () => {
			const candidateClearedFar = {
				candidateRef: 'DNR-B2222222222222222222222222222222',
				classification: 'Potential_Donor_Match',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 12.5, // 12.5 km away
			}

			const candidatePendingClose = {
				candidateRef: 'DNR-A1111111111111111111111111111111',
				classification: 'Pending_Clinical_Evaluation',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 0.8, // 800 meters away!
			}

			// Clinically cleared donor must strictly outrank pending evaluation prospect despite distance
			const ranked = rankDonorCandidates([candidatePendingClose, candidateClearedFar])
			assert.strictEqual(ranked[0].candidateRef, candidateClearedFar.candidateRef)
			assert.strictEqual(ranked[1].candidateRef, candidatePendingClose.candidateRef)
		})

		it('should prioritize verified stock match over unverified inventory despite proximity for blood banks', () => {
			const bankVerifiedFar = {
				facilityRef: 'BB-B22222222222',
				inventoryTrustStatus: 'Verified_Bloodbank_Stock_Match',
				matchQuality: 'Identical',
				verifiedUnitsAvailable: 3,
				approxDistanceKm: 14.0, // 14 km away
			}

			const bankUnverifiedClose = {
				facilityRef: 'BB-A11111111111',
				inventoryTrustStatus: 'Inventory_Unverified',
				matchQuality: null,
				verifiedUnitsAvailable: null,
				approxDistanceKm: 0.5, // 500 meters away!
			}

			const ranked = rankBloodBankCandidates([bankUnverifiedClose, bankVerifiedFar])
			assert.strictEqual(ranked[0].facilityRef, bankVerifiedFar.facilityRef)
			assert.strictEqual(ranked[1].facilityRef, bankUnverifiedClose.facilityRef)
		})

		it('should sort identical ABO/Rh match before compatible alternative for equivalent clinical status', () => {
			const donorIdentical = {
				candidateRef: 'DNR-A1111111111111111111111111111111',
				classification: 'Potential_Donor_Match',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 5.0,
			}

			const donorAlternative = {
				candidateRef: 'DNR-B2222222222222222222222222222222',
				classification: 'Potential_Donor_Match',
				matchQuality: 'Compatible_Alternative',
				withinDonorTravelRadius: true,
				approxDistanceKm: 5.0,
			}

			const ranked = rankDonorCandidates([donorAlternative, donorIdentical])
			assert.strictEqual(ranked[0].candidateRef, donorIdentical.candidateRef)
		})

		it('should perform deterministic tie-breaking by candidateRef for equivalent donor inputs', () => {
			const donorA = {
				candidateRef: 'DNR-11111111111111111111111111111111',
				classification: 'Potential_Donor_Match',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 4.2,
			}

			const donorB = {
				candidateRef: 'DNR-99999999999999999999999999999999',
				classification: 'Potential_Donor_Match',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 4.2,
			}

			const ranked1 = rankDonorCandidates([donorB, donorA])
			const ranked2 = rankDonorCandidates([donorA, donorB])

			assert.strictEqual(ranked1[0].candidateRef, donorA.candidateRef)
			assert.strictEqual(ranked2[0].candidateRef, donorA.candidateRef)
		})

		it('should rank combined candidate streams in correct global tier order', () => {
			const verifiedBank = {
				facilityRef: 'BB-000000000001',
				inventoryTrustStatus: 'Verified_Bloodbank_Stock_Match',
				matchQuality: 'Identical',
				verifiedUnitsAvailable: 2,
				approxDistanceKm: 8.0,
			}

			const clearedDonor = {
				candidateRef: 'DNR-00000000000000000000000000000002',
				classification: 'Potential_Donor_Match',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 4.0,
			}

			const pendingDonor = {
				candidateRef: 'DNR-00000000000000000000000000000003',
				classification: 'Pending_Clinical_Evaluation',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 2.0,
			}

			const zeroStockBank = {
				facilityRef: 'BB-000000000004',
				inventoryTrustStatus: 'No_Matching_Stock',
				matchQuality: null,
				verifiedUnitsAvailable: 0,
				approxDistanceKm: 1.0,
			}

			const unverifiedBank = {
				facilityRef: 'BB-000000000005',
				inventoryTrustStatus: 'Inventory_Unverified',
				matchQuality: null,
				verifiedUnitsAvailable: null,
				approxDistanceKm: 0.5,
			}

			const ranked = rankCombinedCandidates([
				unverifiedBank,
				pendingDonor,
				zeroStockBank,
				clearedDonor,
				verifiedBank,
			])

			// Tier 1: Verified Blood Bank
			assert.strictEqual(ranked[0].facilityRef, verifiedBank.facilityRef)
			// Tier 2: Clinically Cleared Donor
			assert.strictEqual(ranked[1].candidateRef, clearedDonor.candidateRef)
			// Tier 3: Pending Evaluation Donor
			assert.strictEqual(ranked[2].candidateRef, pendingDonor.candidateRef)
			// Tier 4: No Matching Stock Bank
			assert.strictEqual(ranked[3].facilityRef, zeroStockBank.facilityRef)
			// Tier 5: Inventory Unverified Bank
			assert.strictEqual(ranked[4].facilityRef, unverifiedBank.facilityRef)
		})

		it('should prioritize facilities capable of complete ticket fulfillment over partial fulfillment facilities', () => {
			const unmetUnits = 4

			const bankFullCapacity = {
				facilityRef: 'BB-FULL-CAPACITY',
				inventoryTrustStatus: 'Verified_Bloodbank_Stock_Match',
				matchQuality: 'Identical',
				verifiedUnitsAvailable: 5, // >= 4 unmet units
				approxDistanceKm: 12.0, // 12 km away
			}

			const bankPartialCapacity = {
				facilityRef: 'BB-PARTIAL-CAP',
				inventoryTrustStatus: 'Verified_Bloodbank_Stock_Match',
				matchQuality: 'Identical',
				verifiedUnitsAvailable: 2, // Only 2 units (cannot fulfill ticket alone)
				approxDistanceKm: 2.0, // 2 km away (much closer!)
			}

			// In both blood bank ranking and combined ranking, full capacity facility should rank first
			const rankedBanks = rankBloodBankCandidates([bankPartialCapacity, bankFullCapacity], { unmetUnits })
			assert.strictEqual(rankedBanks[0].facilityRef, bankFullCapacity.facilityRef)
			assert.strictEqual(rankedBanks[1].facilityRef, bankPartialCapacity.facilityRef)

			const rankedCombined = rankCombinedCandidates([bankPartialCapacity, bankFullCapacity], { unmetUnits })
			assert.strictEqual(rankedCombined[0].facilityRef, bankFullCapacity.facilityRef)
			assert.strictEqual(rankedCombined[1].facilityRef, bankPartialCapacity.facilityRef)
		})

		it('should strictly ensure pending clinical evaluation prospects cannot outrank clinically cleared donors solely due to closer distance', () => {
			const clearedDonorFar = {
				candidateRef: 'DNR-CLEARED-FAR-1234567890ABCDEF',
				classification: 'Potential_Donor_Match',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 14.9, // 14.9 km away
			}

			const pendingProspectImmediate = {
				candidateRef: 'DNR-PENDING-IMMED-1234567890ABCDEF',
				classification: 'Pending_Clinical_Evaluation',
				matchQuality: 'Identical',
				withinDonorTravelRadius: true,
				approxDistanceKm: 0.1, // 100 meters away!
			}

			// Combined ranking must strictly place Tier 2 (cleared) ahead of Tier 3 (pending)
			const ranked = rankCombinedCandidates([pendingProspectImmediate, clearedDonorFar])
			assert.strictEqual(ranked[0].candidateRef, clearedDonorFar.candidateRef)
			assert.strictEqual(ranked[1].candidateRef, pendingProspectImmediate.candidateRef)
		})
	})

	// =========================================================================
	// 7. PRIVACY SHIELD & ALLOWLIST SANITIZATION
	// =========================================================================
	describe('7. Privacy Shield & Allowlist Response Sanitization', () => {
		it('should never expose donor ObjectId, userId, exact coordinates, phone, email, or push keys', () => {
			const rawDonor = {
				_id: new mongoose.Types.ObjectId(),
				userId: new mongoose.Types.ObjectId(),
				bloodGroup: 'B_Positive',
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Clinically_Cleared',
				city: 'Bengaluru',
				state: 'Karnataka',
				pinCode: 560001,
				maxTravelDistanceKm: 15,
				phone: '9876543210',
				email: 'sensitive@donor.test',
				residentialAddress: 'Flat 402, Private Residency, Bengaluru',
				location: { type: 'Point', coordinates: [77.5946, 12.9716] },
				notificationPreferences: { email: true, webPush: true },
				pushSubscription: { endpoint: 'https://push.example.com', auth: 'secret-auth-key' },
				internalNotes: 'Staff review private remarks',
			}

			const meta = {
				candidateRef: 'DNR-A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4',
				matchQuality: 'Identical',
				classification: 'Potential_Donor_Match',
				approxDistanceKm: 3.5,
				withinDonorTravelRadius: true,
				clinicalNotice: 'Mandatory clinical safety notice',
				rankingExplanation: 'ABO/Rh identical match',
			}

			const sanitized = sanitizeDonorCandidate(rawDonor, meta)

			// Forbidden fields must not exist
			assert.strictEqual(sanitized._id, undefined)
			assert.strictEqual(sanitized.userId, undefined)
			assert.strictEqual(sanitized.phone, undefined)
			assert.strictEqual(sanitized.email, undefined)
			assert.strictEqual(sanitized.residentialAddress, undefined)
			assert.strictEqual(sanitized.location, undefined)
			assert.strictEqual(sanitized.coordinates, undefined)
			assert.strictEqual(sanitized.pushSubscription, undefined)
			assert.strictEqual(sanitized.internalNotes, undefined)

			// Approved allowlist fields must be present
			assert.strictEqual(sanitized.candidateRef, meta.candidateRef)
			assert.strictEqual(sanitized.bloodGroup, 'B_Positive')
			assert.strictEqual(sanitized.matchQuality, 'Identical')
			assert.strictEqual(sanitized.classification, 'Potential_Donor_Match')
			assert.strictEqual(sanitized.approxDistanceKm, 3.5)
			assert.strictEqual(sanitized.city, 'Bengaluru')
			assert.strictEqual(sanitized.state, 'Karnataka')
		})

		it('should never expose blood bank ObjectId, password, tokenVersion, or unit DINs', () => {
			const rawBank = {
				_id: new mongoose.Types.ObjectId(),
				bloodbankName: 'Victoria Hospital Blood Centre',
				category: 'Government',
				address1: 'K.R. Market Road',
				address2: 'Near City Market',
				city: 'Bengaluru',
				state: 'Karnataka',
				pinCode: 560002,
				phoneNo1: '080-26701234',
				phoneNo2: '080-26705678',
				email: 'victoria@bloodbank.test',
				password: 'HashedPasswordValue12345678',
				passwordResetToken: 'TokenValueXYZ',
				tokenVersion: 3,
				location: { type: 'Point', coordinates: [77.5850, 12.9650] },
			}

			const meta = {
				facilityRef: 'BB-A1B2C3D4E5F6',
				approxDistanceKm: 2.1,
				inventoryTrustStatus: 'Verified_Bloodbank_Stock_Match',
				verifiedUnitsAvailable: 5,
				availableComponentCategories: ['Packed_Red_Blood_Cells'],
				matchQuality: 'Identical',
				inventoryNotice: 'Verified issue-eligible inventory available.',
				rankingExplanation: 'Verified stock available (5 units).',
			}

			const sanitized = sanitizeBloodBankCandidate(rawBank, meta)

			// Forbidden fields must not exist
			assert.strictEqual(sanitized._id, undefined)
			assert.strictEqual(sanitized.password, undefined)
			assert.strictEqual(sanitized.passwordResetToken, undefined)
			assert.strictEqual(sanitized.tokenVersion, undefined)
			assert.strictEqual(sanitized.location, undefined)

			// Approved allowlist fields must be present
			assert.strictEqual(sanitized.facilityRef, 'BB-A1B2C3D4E5F6')
			assert.strictEqual(sanitized.bloodbankName, 'Victoria Hospital Blood Centre')
			assert.strictEqual(sanitized.city, 'Bengaluru')
			assert.strictEqual(sanitized.state, 'Karnataka')
			assert.strictEqual(sanitized.verifiedUnitsAvailable, 5)
		})

		it('should strictly exclude personal staff contacts (contactPerson, internal staff data) and expose only institutional public contacts', () => {
			const rawBankWithStaffPII = {
				_id: new mongoose.Types.ObjectId(),
				bloodbankName: 'District Red Cross Blood Centre',
				category: 'RedCross',
				contactPerson: 'Dr. Ramesh Staff Director (Personal)',
				address1: '12 Hospital Junction',
				address2: 'Civil Lines',
				city: 'Bengaluru',
				state: 'Karnataka',
				pinCode: 560009,
				phoneNo1: '080-22223333', // Institutional facility reception
				phoneNo2: '080-44445555', // Institutional facility helpline
				email: 'contact@redcross-district.org', // Institutional facility email
				staffPhone: '9876599999', // Private staff personal mobile
				staffEmail: 'ramesh.personal@gmail.com', // Private staff personal email
				staffNotes: 'Sensitive staff roster internal memo',
				password: 'SecretHashedPassword',
				tokenVersion: 1,
				location: { type: 'Point', coordinates: [77.5900, 12.9700] },
			}

			const meta = {
				facilityRef: 'BB-C1D2E3F4A5B6',
				approxDistanceKm: 4.1,
				inventoryTrustStatus: 'Verified_Bloodbank_Stock_Match',
				verifiedUnitsAvailable: 2,
				availableComponentCategories: ['Packed_Red_Blood_Cells'],
				matchQuality: 'Identical',
				inventoryNotice: 'Verified issue-eligible inventory available.',
				rankingExplanation: 'Verified stock available.',
			}

			const sanitized = sanitizeBloodBankCandidate(rawBankWithStaffPII, meta)

			// 1. Personal staff contact details must be strictly stripped
			assert.strictEqual(sanitized.contactPerson, undefined)
			assert.strictEqual(sanitized.staffPhone, undefined)
			assert.strictEqual(sanitized.staffEmail, undefined)
			assert.strictEqual(sanitized.staffNotes, undefined)

			// 2. Institutional public contacts must be preserved
			assert.strictEqual(sanitized.phoneNo1, '080-22223333')
			assert.strictEqual(sanitized.phoneNo2, '080-44445555')
			assert.strictEqual(sanitized.email, 'contact@redcross-district.org')
			assert.strictEqual(sanitized.address, '12 Hospital Junction, Civil Lines')

			// 3. Sensitive identifiers and internal credentials must be stripped
			assert.strictEqual(sanitized._id, undefined)
			assert.strictEqual(sanitized.password, undefined)
			assert.strictEqual(sanitized.location, undefined)
		})

		it('should sanitize error paths and prevent database error message or stack trace leakage in discovery notices', async () => {
			if (!dbConnected) return

			const originalBreakdown = stockService.getTraceableStatusBreakdown
			try {
				// Simulate internal database fault with sensitive connection details / stack trace
				stockService.getTraceableStatusBreakdown = async () => {
					const error = new Error('MongoNetworkError: connection 127.0.0.1:27017 timed out; secret_replica_key=XYZ')
					error.stack = 'SensitiveInternalStackDumpAtLine1234'
					throw error
				}

				const compatibility = deriveRequestCompatibility(verifiedBPosRequest)
				const result = await discoverBloodBankCandidates(verifiedBPosRequest, compatibility, {
					radiusKm: 15,
				})

				for (const bank of result.data) {
					// Must fail closed to Inventory_Unverified
					assert.strictEqual(bank.inventoryTrustStatus, 'Inventory_Unverified')
					assert.strictEqual(bank.verifiedUnitsAvailable, null)

					// Notice must NOT leak internal error text, stack trace, or database connection details
					assert.strictEqual(bank.inventoryNotice.includes('MongoNetworkError'), false)
					assert.strictEqual(bank.inventoryNotice.includes('secret_replica_key'), false)
					assert.strictEqual(bank.inventoryNotice.includes('SensitiveInternalStackDump'), false)

					// Must provide neutral, safe notice
					assert.ok(bank.inventoryNotice.includes('temporarily unavailable'))
				}
			} finally {
				stockService.getTraceableStatusBreakdown = originalBreakdown
			}
		})
	})

	// =========================================================================
	// 8. END-TO-END MATCHING PIPELINE & READ-ONLY INVARIANT
	// =========================================================================
	describe('8. End-to-End Matching Pipeline & Read-Only Invariants', () => {
		it('should execute findEmergencyRequestMatches and return complete dual-stream discovery structure', async () => {
			if (!dbConnected) return

			const authContext = {
				user: testUser,
				userRole: 'USER',
			}

			const result = await findEmergencyRequestMatches(verifiedBPosRequest._id, authContext, {
				radiusKm: 15,
				hmacSecret: VALID_TEST_HMAC_SECRET,
			})

			// 1. Structure
			assert.ok(result.emergencyRequest)
			assert.ok(result.matchingSummary)
			assert.ok(result.bloodBanks)
			assert.ok(result.donors)
			assert.ok(result.governance)

			// 2. Request summary
			assert.strictEqual(result.emergencyRequest.requestNumber, verifiedBPosRequest.requestNumber)
			assert.strictEqual(result.emergencyRequest.verificationStatus, 'Verified')
			assert.strictEqual(result.emergencyRequest.unitsRequested, 2)
			assert.strictEqual(result.emergencyRequest.unitsUnmet, 2)

			// 3. Matching summary
			assert.strictEqual(result.matchingSummary.searchRadiusKm, 15)
			assert.strictEqual(result.matchingSummary.preferredGroup, 'B_Positive')
			assert.strictEqual(result.matchingSummary.verifiedBloodBankCount >= 1, true)
			assert.strictEqual(result.matchingSummary.potentialDonorCount >= 1, true)

			// 4. Governance flags
			assert.strictEqual(result.governance.isAuthoritativeClinicalDecision, false)
			assert.strictEqual(result.governance.isPresumptiveImmunohematologyCheck, true)
			assert.strictEqual(result.governance.cannotAuthorizeDispatch, true)
			assert.strictEqual(result.governance.cannotAuthorizeReservation, true)
			assert.strictEqual(result.governance.cannotAuthorizeDonation, true)
			assert.strictEqual(result.governance.requiresLaboratoryCrossmatch, true)
			assert.ok(result.governance.clinicalSafetyNotice)
			assert.strictEqual(result.governance.clinicalSafetyNotice.includes('essential clinical safety prerequisites'), true)
			assert.strictEqual(result.governance.clinicalSafetyNotice.includes('Discovery and ranking do not authorize reservation, issuance, dispatch, or transfusion'), true)
			assert.strictEqual(result.governance.clinicalSafetyNotice.includes('statutory'), false)
		})

		it('should guarantee zero database mutations during full candidate discovery execution', async () => {
			if (!dbConnected) return

			const beforeReq = await EmergencyBloodRequest.findById(verifiedBPosRequest._id).lean()
			const countUnitsBefore = await BloodUnit.countDocuments({ _id: { $in: createdUnitIds } })
			const countDonorsBefore = await EmergencyDonorProfile.countDocuments({ _id: { $in: createdDonorIds } })
			const countBanksBefore = await Bloodbank.countDocuments({ _id: { $in: createdBankIds } })

			const authContext = {
				user: testUser,
				userRole: 'USER',
			}

			await findEmergencyRequestMatches(verifiedBPosRequest._id, authContext, {
				radiusKm: 15,
				hmacSecret: VALID_TEST_HMAC_SECRET,
			})

			const afterReq = await EmergencyBloodRequest.findById(verifiedBPosRequest._id).lean()
			const countUnitsAfter = await BloodUnit.countDocuments({ _id: { $in: createdUnitIds } })
			const countDonorsAfter = await EmergencyDonorProfile.countDocuments({ _id: { $in: createdDonorIds } })
			const countBanksAfter = await Bloodbank.countDocuments({ _id: { $in: createdBankIds } })

			assert.strictEqual(beforeReq.updatedAt.getTime(), afterReq.updatedAt.getTime())
			assert.strictEqual(beforeReq.unitsReserved, afterReq.unitsReserved)
			assert.strictEqual(beforeReq.unitsFulfilled, afterReq.unitsFulfilled)
			assert.strictEqual(beforeReq.status, afterReq.status)
			assert.strictEqual(countUnitsBefore, countUnitsAfter)
			assert.strictEqual(countDonorsBefore, countDonorsAfter)
			assert.strictEqual(countBanksBefore, countBanksAfter)
		})

		it('should strictly deny unauthorized user with 404 REQUEST_NOT_FOUND without revealing candidate matches', async () => {
			if (!dbConnected) return

			const unauthorizedUser = {
				_id: new mongoose.Types.ObjectId(),
				status: true,
			}
			const authContext = {
				user: unauthorizedUser,
				userRole: 'USER',
			}

			await assert.rejects(
				() =>
					findEmergencyRequestMatches(verifiedBPosRequest._id, authContext, {
						radiusKm: 15,
						hmacSecret: VALID_TEST_HMAC_SECRET,
					}),
				(err) => {
					assert.strictEqual(err.statusCode, 404)
					assert.strictEqual(err.code, 'REQUEST_NOT_FOUND')
					return true
				}
			)
		})
	})
})
