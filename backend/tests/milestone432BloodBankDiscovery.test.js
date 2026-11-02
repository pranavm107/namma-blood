/**
 * Milestone 4.3.2: Blood Bank Discovery Backend Service & APIs Test Suite
 * Namma Blood — Emergency Blood Connection (Milestone 4.3)
 *
 * Verifies:
 * 1. Geospatial discovery, proximity ordering, radius filtering, out-of-bounds rejection
 * 2. Administrative city/state fallback when GPS coordinates are unavailable
 * 3. Verified traceable inventory integration using stockService safeguards
 * 4. Inventory trust statuses: Verified_Available, No_Matching_Stock, Inventory_Unverified
 * 5. Strict privacy shield and response sanitization:
 *    - Opaque scoped public facilityRef (BB-XXXXXXXXXXXX) instead of internal MongoDB ObjectIds
 *    - Strict exclusion of internal _id, bloodbankId, contactPerson, passwords, tokens, DINs, and donor PII
 *    - Approved public-facing institutional contact info (address, phone numbers, email, pinCode)
 * 6. Inventory filter consistency:
 *    - availableComponentCategories strictly reflects requested filters
 *    - verifiedUnitsAvailable strictly reflects exact group/component combination
 * 7. Role-based authentication, account lifecycle validation, and rate limiting
 * 8. Clinical governance and safe fail-closed behavior
 */

const { describe, it, before, after, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')

const {
	discoverNearbyBloodbanks,
	sanitizeBloodBankForDiscovery,
	derivePublicFacilityReference,
	escapeRegex,
} = require('../Emergency/emergencyDiscoveryService')
const { getNearbyBloodbanks } = require('../Emergency/emergencyDiscoveryController')
const {
	discoveryRateLimiter,
	resetDiscoveryRateLimiter,
	MAX_REQUESTS_PER_WINDOW,
} = require('../Emergency/discoveryRateLimiter')
const { protectEmergencyAuth } = require('../Emergency/emergencyAuthMiddleware')
const stockService = require('../BloodStock/stockService')
const Bloodbank = require('../BloodBank/bloodbankModel')
const { BloodUnit } = require('../BloodUnit/bloodUnitModel')
const User = require('../User/userModel')
const { BloodbankStaff } = require('../BloodBank/bloodbankStaffModel')
const Admin = require('../Admin/adminModel')

const TEST_DB_URI =
	process.env.TEST_MONGODB_URI ||
	process.env.database_url ||
	'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'

function createMockReqRes({
	user = null,
	query = {},
	headers = {},
	ip = '127.0.0.1',
} = {}) {
	const req = {
		user,
		query,
		headers,
		ip,
		socket: { remoteAddress: ip },
		connection: { remoteAddress: ip },
	}
	const res = {
		statusCode: 200,
		responseData: null,
		headersSent: {},
		status(code) {
			this.statusCode = code
			return this
		},
		json(data) {
			this.responseData = data
			return this
		},
		setHeader(key, val) {
			this.headersSent[key] = val
		},
	}
	let nextCalled = false
	const next = (err) => {
		nextCalled = true
		if (err) {
			res.statusCode = err.statusCode || 500
			res.responseData = { status: 'error', message: err.message }
		}
	}
	return { req, res, next, isNextCalled: () => nextCalled }
}

describe('Milestone 4.3.2: Blood Bank Discovery Backend Service & APIs', () => {
	let dbConnected = false
	const createdBankIds = []
	const createdUnitIds = []
	const createdUserIds = []
	const createdStaffIds = []
	const createdAdminIds = []

	// Auth test fixtures
	let validUserToken = ''
	let deactivatedUserToken = ''
	let validStaffToken = ''
	let inactiveStaffToken = ''
	let validBankToken = ''
	let deactivatedBankToken = ''
	let validAdminToken = ''

	// Test Blood Banks
	let nearActiveBankWithStock = null
	let nearActiveBankNoMatch = null
	let nearActiveBankNoTraceableUnits = null
	let farMysoreBank = null
	let deactivatedNearBank = null
	let fallbackMangaloreBank = null

	before(async () => {
		try {
			if (mongoose.connection.readyState !== 1) {
				await mongoose.connect(TEST_DB_URI)
			}
			dbConnected = mongoose.connection.readyState === 1
		} catch (err) {
			console.log('MongoDB not connected; skipping live geospatial tests.')
		}

		if (dbConnected) {
			// Ensure indexes are built
			await Bloodbank.syncIndexes()
			await BloodUnit.syncIndexes()

			const stamp = Date.now()

			// 1. Seed Accounts for Role-Based Auth Tests
			// Active User
			const activeUser = await User.create({
				firstName: 'Active',
				lastName: 'User',
				gender: 'Male',
				dob: new Date('1990-01-01'),
				age: 34,
				phoneNo1: Number(`91${stamp.toString().slice(-8)}`),
				email: `active_user_bb_${stamp}@test.com`,
				state: 'Karnataka',
				city: 'Bangalore',
				address: '123 Test Street',
				pinCode: 560001,
				password: 'Password123!',
				status: true,
			})
			createdUserIds.push(activeUser._id)
			validUserToken = jwt.sign(
				{ id: activeUser._id.toString(), tokenVersion: activeUser.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Deactivated User
			const deactUser = await User.create({
				firstName: 'Deact',
				lastName: 'User',
				gender: 'Female',
				dob: new Date('1992-05-10'),
				age: 32,
				phoneNo1: Number(`92${stamp.toString().slice(-8)}`),
				email: `deact_user_bb_${stamp}@test.com`,
				state: 'Karnataka',
				city: 'Bangalore',
				address: '456 Deact Street',
				pinCode: 560001,
				password: 'Password123!',
				status: false,
			})
			createdUserIds.push(deactUser._id)
			deactivatedUserToken = jwt.sign(
				{ id: deactUser._id.toString(), tokenVersion: deactUser.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Active Blood Bank 1: Near ~2.1 km with Verified Stock
			nearActiveBankWithStock = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: `Victoria Hospital Blood Centre ${stamp}`,
				category: 'Government',
				contactPerson: 'Dr. Victoria',
				address1: 'Fort Road',
				address2: 'City Market',
				pinCode: 560002,
				phoneNo1: `9845${stamp.toString().slice(-6)}1`,
				phoneNo2: `9845${stamp.toString().slice(-6)}2`,
				email: `victoria_bb_${stamp}@gov.in`,
				password: 'Password123!',
				status: true,
				location: {
					type: 'Point',
					coordinates: [77.575, 12.964], // ~2.1 km from [77.5946, 12.9716]
				},
			})
			createdBankIds.push(nearActiveBankWithStock._id)
			validBankToken = jwt.sign(
				{ id: nearActiveBankWithStock._id.toString(), tokenVersion: nearActiveBankWithStock.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Active Blood Bank 2: Near ~6.1 km with Other Component Stock
			nearActiveBankNoMatch = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: `Bowring Hospital Blood Centre ${stamp}`,
				category: 'Government',
				contactPerson: 'Dr. Bowring',
				address1: 'Lady Curzon Road',
				address2: 'Shivajinagar',
				pinCode: 560001,
				phoneNo1: `9846${stamp.toString().slice(-6)}1`,
				phoneNo2: `9846${stamp.toString().slice(-6)}2`,
				email: `bowring_bb_${stamp}@gov.in`,
				password: 'Password123!',
				status: true,
				location: {
					type: 'Point',
					coordinates: [77.65, 12.98], // ~6.1 km from [77.5946, 12.9716]
				},
			})
			createdBankIds.push(nearActiveBankNoMatch._id)

			// Active Blood Bank 3: Near ~1.2 km with NO Traceable BloodUnit Records
			nearActiveBankNoTraceableUnits = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: `City Life Blood Bank ${stamp}`,
				category: 'Private',
				contactPerson: 'Dr. CityLife',
				address1: 'Residency Road',
				address2: 'Shanthala Nagar',
				pinCode: 560025,
				phoneNo1: `9847${stamp.toString().slice(-6)}1`,
				phoneNo2: `9847${stamp.toString().slice(-6)}2`,
				email: `citylife_bb_${stamp}@test.com`,
				password: 'Password123!',
				status: true,
				location: {
					type: 'Point',
					coordinates: [77.59, 12.975], // ~1.2 km from [77.5946, 12.9716]
				},
			})
			createdBankIds.push(nearActiveBankNoTraceableUnits._id)

			// Active Blood Bank 4: Far away ~130 km in Mysore
			farMysoreBank = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Mysore',
				bloodbankName: `Mysore District Blood Centre ${stamp}`,
				category: 'Government',
				contactPerson: 'Dr. Mysore',
				address1: 'Irwin Road',
				address2: 'Lashkar Mohalla',
				pinCode: 570001,
				phoneNo1: `9848${stamp.toString().slice(-6)}1`,
				phoneNo2: `9848${stamp.toString().slice(-6)}2`,
				email: `mysore_bb_${stamp}@gov.in`,
				password: 'Password123!',
				status: true,
				location: {
					type: 'Point',
					coordinates: [76.6413, 12.3052], // Mysore ~130 km away
				},
			})
			createdBankIds.push(farMysoreBank._id)

			// Deactivated Blood Bank 5: Near ~2.0 km, but status: false
			deactivatedNearBank = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: `Suspended Red Cross Centre ${stamp}`,
				category: 'RedCross',
				contactPerson: 'Dr. Suspended',
				address1: 'Cubbon Road',
				address2: 'Sampangi Rama Nagara',
				pinCode: 560001,
				phoneNo1: `9849${stamp.toString().slice(-6)}1`,
				phoneNo2: `9849${stamp.toString().slice(-6)}2`,
				email: `suspended_bb_${stamp}@test.com`,
				password: 'Password123!',
				status: false, // Deactivated
				location: {
					type: 'Point',
					coordinates: [77.58, 12.97],
				},
			})
			createdBankIds.push(deactivatedNearBank._id)
			deactivatedBankToken = jwt.sign(
				{ id: deactivatedNearBank._id.toString(), tokenVersion: deactivatedNearBank.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Fallback Blood Bank 6: In Mangalore, Karnataka without GPS coordinates
			fallbackMangaloreBank = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Mangalore',
				bloodbankName: `Mangalore City Blood Bank ${stamp}`,
				category: 'Charitable',
				contactPerson: 'Dr. Mangalore',
				address1: 'K.S. Rao Road',
				address2: 'Hampankatta',
				pinCode: 575001,
				phoneNo1: `9850${stamp.toString().slice(-6)}1`,
				phoneNo2: `9850${stamp.toString().slice(-6)}2`,
				email: `mangalore_bb_${stamp}@test.com`,
				password: 'Password123!',
				status: true,
			})
			createdBankIds.push(fallbackMangaloreBank._id)

			// Active Staff
			const activeStaff = await BloodbankStaff.create({
				fullName: 'Active Staff Tech',
				phoneNo: `9851${stamp.toString().slice(-6)}0`,
				email: `active_staff_bb_${stamp}@test.com`,
				password: 'Password123!',
				role: 'Lab_Technician',
				status: 'Active',
				bloodbankId: nearActiveBankWithStock._id,
				createdBy: nearActiveBankWithStock._id,
			})
			createdStaffIds.push(activeStaff._id)
			validStaffToken = jwt.sign(
				{
					id: activeStaff._id.toString(),
					userType: 'staff',
					bloodbankId: nearActiveBankWithStock._id.toString(),
					tokenVersion: activeStaff.tokenVersion || 0,
				},
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Inactive Staff
			const inactiveStaff = await BloodbankStaff.create({
				fullName: 'Inactive Staff Tech',
				phoneNo: `9852${stamp.toString().slice(-6)}0`,
				email: `inactive_staff_bb_${stamp}@test.com`,
				password: 'Password123!',
				role: 'Lab_Technician',
				status: 'Suspended',
				bloodbankId: nearActiveBankWithStock._id,
				createdBy: nearActiveBankWithStock._id,
			})
			createdStaffIds.push(inactiveStaff._id)
			inactiveStaffToken = jwt.sign(
				{
					id: inactiveStaff._id.toString(),
					userType: 'staff',
					bloodbankId: nearActiveBankWithStock._id.toString(),
					tokenVersion: inactiveStaff.tokenVersion || 0,
				},
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// Active Admin
			const activeAdmin = await Admin.create({
				email: `admin_bb_${stamp}@test.com`,
				phoneNo: String(stamp).slice(-10).padStart(10, '9'),
				password: 'Password123!',
			})
			createdAdminIds.push(activeAdmin._id)
			validAdminToken = jwt.sign(
				{ id: activeAdmin._id.toString(), tokenVersion: activeAdmin.tokenVersion || 0 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '1h' }
			)

			// 2. Seed BloodUnit records for nearActiveBankWithStock
			const futureDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // +30 days
			const pastDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) // -5 days (expired)

			// Unit 1: Eligible O_Positive Packed_Red_Blood_Cells
			const unit1 = await BloodUnit.create({
				unitNumber: `DIN-O-POS-1-${stamp}`,
				bloodbankId: nearActiveBankWithStock._id,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				volumeMl: 350,
				status: 'Available',
				expiryDate: futureDate,
				clearance: {
					isVerified: true,
					verifiedAt: new Date(),
					verifiedBy: activeStaff._id,
				},
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			createdUnitIds.push(unit1._id)

			// Unit 2: Eligible O_Positive Packed_Red_Blood_Cells
			const unit2 = await BloodUnit.create({
				unitNumber: `DIN-O-POS-2-${stamp}`,
				bloodbankId: nearActiveBankWithStock._id,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				volumeMl: 350,
				status: 'Available',
				expiryDate: futureDate,
				clearance: {
					isVerified: true,
					verifiedAt: new Date(),
					verifiedBy: activeStaff._id,
				},
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			createdUnitIds.push(unit2._id)

			// Unit 3: Eligible A_Positive Whole_Blood
			const unit3 = await BloodUnit.create({
				unitNumber: `DIN-A-POS-1-${stamp}`,
				bloodbankId: nearActiveBankWithStock._id,
				bloodGroup: 'A_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 350,
				status: 'Available',
				expiryDate: futureDate,
				clearance: {
					isVerified: true,
					verifiedAt: new Date(),
					verifiedBy: activeStaff._id,
				},
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			createdUnitIds.push(unit3._id)

			// Unit 4: EXPIRED unit (status: Expired)
			const unit4 = await BloodUnit.create({
				unitNumber: `DIN-EXP-1-${stamp}`,
				bloodbankId: nearActiveBankWithStock._id,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				volumeMl: 350,
				status: 'Expired',
				expiryDate: pastDate,
				clearance: {
					isVerified: true,
					verifiedAt: new Date(),
					verifiedBy: activeStaff._id,
				},
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			createdUnitIds.push(unit4._id)

			// Unit 5: RESERVED unit (status: Reserved)
			const unit5 = await BloodUnit.create({
				unitNumber: `DIN-RES-1-${stamp}`,
				bloodbankId: nearActiveBankWithStock._id,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				volumeMl: 350,
				status: 'Reserved',
				expiryDate: futureDate,
				clearance: {
					isVerified: true,
					verifiedAt: new Date(),
					verifiedBy: activeStaff._id,
				},
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			createdUnitIds.push(unit5._id)

			// Unit 6: Unverified MO clearance (clearance.isVerified: false)
			const unit6 = await BloodUnit.create({
				unitNumber: `DIN-UNV-1-${stamp}`,
				bloodbankId: nearActiveBankWithStock._id,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				volumeMl: 350,
				status: 'Tested_Passed',
				expiryDate: futureDate,
				clearance: {
					isVerified: false,
				},
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			createdUnitIds.push(unit6._id)

			// Unit 7: Reactive TTI screening (testing.hiv: 'Reactive')
			const unit7 = await BloodUnit.create({
				unitNumber: `DIN-REA-1-${stamp}`,
				bloodbankId: nearActiveBankWithStock._id,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				volumeMl: 350,
				status: 'Quarantined',
				expiryDate: futureDate,
				testing: {
					hiv: 'Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			createdUnitIds.push(unit7._id)

			// 3. Seed BloodUnit for nearActiveBankNoMatch (only B_Positive Fresh_Frozen_Plasma)
			const unit8 = await BloodUnit.create({
				unitNumber: `DIN-B-FFP-1-${stamp}`,
				bloodbankId: nearActiveBankNoMatch._id,
				bloodGroup: 'B_Positive',
				componentType: 'Fresh_Frozen_Plasma',
				volumeMl: 250,
				status: 'Available',
				expiryDate: futureDate,
				clearance: {
					isVerified: true,
					verifiedAt: new Date(),
					verifiedBy: activeStaff._id,
				},
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})
			createdUnitIds.push(unit8._id)
		}
	})

	beforeEach(() => {
		resetDiscoveryRateLimiter()
	})

	after(async () => {
		if (dbConnected) {
			try {
				if (createdUnitIds.length > 0) {
					await BloodUnit.deleteMany({ _id: { $in: createdUnitIds } })
				}
				if (createdBankIds.length > 0) {
					await Bloodbank.deleteMany({ _id: { $in: createdBankIds } })
				}
				if (createdUserIds.length > 0) {
					await User.deleteMany({ _id: { $in: createdUserIds } })
				}
				if (createdStaffIds.length > 0) {
					await BloodbankStaff.deleteMany({ _id: { $in: createdStaffIds } })
				}
				if (createdAdminIds.length > 0) {
					await Admin.deleteMany({ _id: { $in: createdAdminIds } })
				}
				await mongoose.disconnect()
			} catch (err) {
				console.error('Cleanup error:', err.message)
			}
		}
	})

	describe('1. Geospatial Discovery & Proximity Queries', () => {
		it('should discover nearby active blood banks within 15 km radius using public facilityRef', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
			})

			assert.strictEqual(result.searchCriteria.isGeospatial, true)
			assert.strictEqual(result.searchCriteria.radiusKm, 15)
			assert.ok(result.data.length >= 3, 'Should discover at least 3 nearby active banks')

			const bankRefs = result.data.map((b) => b.facilityRef)
			assert.ok(bankRefs.includes(derivePublicFacilityReference(nearActiveBankWithStock._id)))
			assert.ok(bankRefs.includes(derivePublicFacilityReference(nearActiveBankNoMatch._id)))
			assert.ok(bankRefs.includes(derivePublicFacilityReference(nearActiveBankNoTraceableUnits._id)))

			// Far Mysore bank must NOT be included
			assert.strictEqual(bankRefs.includes(derivePublicFacilityReference(farMysoreBank._id)), false)
			// Deactivated bank must NOT be included
			assert.strictEqual(bankRefs.includes(derivePublicFacilityReference(deactivatedNearBank._id)), false)

			// Internal identifiers must NOT be exposed
			for (const bank of result.data) {
				assert.strictEqual(bank._id, undefined, 'Must not expose _id')
				assert.strictEqual(bank.bloodbankId, undefined, 'Must not expose internal bloodbankId')
			}
		})

		it('should order results by proximity ascending (nearest first)', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
			})

			assert.ok(result.data.length >= 2)
			for (let i = 0; i < result.data.length - 1; i++) {
				const currentDist = result.data[i].approxDistanceKm
				const nextDist = result.data[i + 1].approxDistanceKm
				if (currentDist !== null && nextDist !== null) {
					assert.ok(
						currentDist <= nextDist + 0.001,
						`Expected current dist ${currentDist} <= next dist ${nextDist}`
					)
				}
			}
		})

		it('should strictly exclude blood banks outside the requested radius', async () => {
			if (!dbConnected) return

			// Search radius 3 km: nearActiveBankNoMatch is ~6.1 km away, farMysoreBank is ~130 km away
			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 3,
			})

			const bankRefs = result.data.map((b) => b.facilityRef)
			assert.ok(bankRefs.includes(derivePublicFacilityReference(nearActiveBankNoTraceableUnits._id))) // ~1.2 km
			assert.strictEqual(bankRefs.includes(derivePublicFacilityReference(nearActiveBankNoMatch._id)), false) // ~6.1 km
			assert.strictEqual(bankRefs.includes(derivePublicFacilityReference(farMysoreBank._id)), false) // ~130 km
		})

		it('should include far bank when radius is expanded to cover it', async () => {
			if (!dbConnected) return

			// Search from Mysore coordinates: Mysore bank should be discovered
			const result = await discoverNearbyBloodbanks({
				latitude: 12.3052,
				longitude: 76.6413,
				radiusKm: 10,
			})

			const bankRefs = result.data.map((b) => b.facilityRef)
			assert.ok(bankRefs.includes(derivePublicFacilityReference(farMysoreBank._id)))
			assert.strictEqual(bankRefs.includes(derivePublicFacilityReference(nearActiveBankWithStock._id)), false)
		})

		it('should reject incomplete coordinates (latitude provided without longitude)', async () => {
			await assert.rejects(
				async () => {
					await discoverNearbyBloodbanks({ latitude: 12.9716 })
				},
				{ code: 'INCOMPLETE_COORDINATES', statusCode: 400 }
			)
		})

		it('should reject out-of-bounds latitude (< -90 or > 90)', async () => {
			await assert.rejects(
				async () => {
					await discoverNearbyBloodbanks({ latitude: 95.0, longitude: 77.5946 })
				},
				{ code: 'LATITUDE_OUT_OF_BOUNDS', statusCode: 400 }
			)
		})

		it('should reject out-of-bounds longitude (< -180 or > 180)', async () => {
			await assert.rejects(
				async () => {
					await discoverNearbyBloodbanks({ latitude: 12.9716, longitude: 185.0 })
				},
				{ code: 'LONGITUDE_OUT_OF_BOUNDS', statusCode: 400 }
			)
		})

		it('should reject non-numeric coordinates', async () => {
			await assert.rejects(
				async () => {
					await discoverNearbyBloodbanks({ latitude: 'not-a-number', longitude: 77.5946 })
				},
				{ code: 'INVALID_COORDINATES', statusCode: 400 }
			)
		})

		it('should reject invalid radius (< 1 or > 50)', async () => {
			await assert.rejects(
				async () => {
					await discoverNearbyBloodbanks({ latitude: 12.9716, longitude: 77.5946, radiusKm: 0 })
				},
				{ code: 'INVALID_RADIUS', statusCode: 400 }
			)

			await assert.rejects(
				async () => {
					await discoverNearbyBloodbanks({ latitude: 12.9716, longitude: 77.5946, radiusKm: 75 })
				},
				{ code: 'INVALID_RADIUS', statusCode: 400 }
			)
		})
	})

	describe('2. Administrative Fallback (City / State)', () => {
		it('should discover blood banks by city when coordinates are omitted', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyBloodbanks({
				city: 'Mangalore',
			})

			assert.strictEqual(result.searchCriteria.isGeospatial, false)
			assert.strictEqual(result.searchCriteria.radiusKm, null)
			assert.strictEqual(result.searchCriteria.city, 'Mangalore')

			const bankRefs = result.data.map((b) => b.facilityRef)
			assert.ok(bankRefs.includes(derivePublicFacilityReference(fallbackMangaloreBank._id)))

			// In fallback mode, approxDistanceKm must be null
			const mangaloreResult = result.data.find(
				(b) => b.facilityRef === derivePublicFacilityReference(fallbackMangaloreBank._id)
			)
			assert.strictEqual(mangaloreResult.approxDistanceKm, null)
			assert.strictEqual(mangaloreResult.distanceKm, null)
			assert.strictEqual(mangaloreResult.isDistanceApproximate, false)
		})

		it('should perform case-insensitive city matching', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyBloodbanks({
				city: 'mAnGaLoRe',
			})

			const bankRefs = result.data.map((b) => b.facilityRef)
			assert.ok(bankRefs.includes(derivePublicFacilityReference(fallbackMangaloreBank._id)))
		})

		it('should discover blood banks by state when city is omitted', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyBloodbanks({
				state: 'Karnataka',
				limit: 20,
			})

			assert.strictEqual(result.searchCriteria.isGeospatial, false)
			assert.strictEqual(result.searchCriteria.state, 'Karnataka')
			assert.ok(result.data.length >= 4)
		})

		it('should reject search when neither coordinates nor city/state are provided', async () => {
			await assert.rejects(
				async () => {
					await discoverNearbyBloodbanks({})
				},
				{ code: 'MISSING_SEARCH_LOCATION', statusCode: 400 }
			)
		})

		it('should reject city or state strings exceeding 100 characters', async () => {
			const longString = 'A'.repeat(101)
			await assert.rejects(
				async () => {
					await discoverNearbyBloodbanks({ city: longString })
				},
				{ code: 'LOCATION_STRING_TOO_LONG', statusCode: 400 }
			)
		})
	})

	describe('3. Verified Traceable Inventory Integration & Filtering Consistency', () => {
		it('should classify bank as Verified_Available when matching stock exists and count correctly', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			const victoriaRef = derivePublicFacilityReference(nearActiveBankWithStock._id)
			const victoria = result.data.find((b) => b.facilityRef === victoriaRef)
			assert.ok(victoria, 'Victoria blood bank must be returned')
			assert.strictEqual(victoria.inventoryTrustStatus, 'Verified_Available')
			// Exactly 2 eligible O_Positive PRBC units were seeded (unit1 and unit2)
			assert.strictEqual(victoria.verifiedUnitsAvailable, 2)

			// Issue 3 verification: availableComponentCategories MUST ONLY contain components matching the requested filter
			assert.deepStrictEqual(victoria.availableComponentCategories, ['Packed_Red_Blood_Cells'])
			assert.strictEqual(
				victoria.availableComponentCategories.includes('Whole_Blood'),
				false,
				'Must NOT include Whole_Blood when filtering for Packed_Red_Blood_Cells'
			)
			assert.deepStrictEqual(victoria.verifiedStockByGroup, { O_Positive: 2 })
			assert.match(victoria.inventoryNotice, /Verified issue-eligible inventory/i)
		})

		it('should list all available component categories at facility when no filters are specified', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
			})

			const victoriaRef = derivePublicFacilityReference(nearActiveBankWithStock._id)
			const victoria = result.data.find((b) => b.facilityRef === victoriaRef)
			assert.ok(victoria)
			assert.strictEqual(victoria.inventoryTrustStatus, 'Verified_Available')
			assert.strictEqual(victoria.verifiedUnitsAvailable, 3) // 2 PRBC + 1 WB
			assert.ok(victoria.availableComponentCategories.includes('Packed_Red_Blood_Cells'))
			assert.ok(victoria.availableComponentCategories.includes('Whole_Blood'))
		})

		it('should strictly exclude expired units from verified stock', async () => {
			if (!dbConnected) return

			// Unit 4 is expired (expiryDate in past). Confirm verified count is 2, NOT 3.
			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			const victoriaRef = derivePublicFacilityReference(nearActiveBankWithStock._id)
			const victoria = result.data.find((b) => b.facilityRef === victoriaRef)
			assert.strictEqual(victoria.verifiedUnitsAvailable, 2)
		})

		it('should strictly exclude reserved units from verified stock', async () => {
			if (!dbConnected) return

			// Unit 5 is Reserved. Confirm count is 2.
			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			const victoriaRef = derivePublicFacilityReference(nearActiveBankWithStock._id)
			const victoria = result.data.find((b) => b.facilityRef === victoriaRef)
			assert.strictEqual(victoria.verifiedUnitsAvailable, 2)
		})

		it('should strictly exclude units without Medical Officer clearance from verified stock', async () => {
			if (!dbConnected) return

			// Unit 6 is Tested_Passed without clearance. Confirm count is 2.
			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			const victoriaRef = derivePublicFacilityReference(nearActiveBankWithStock._id)
			const victoria = result.data.find((b) => b.facilityRef === victoriaRef)
			assert.strictEqual(victoria.verifiedUnitsAvailable, 2)
		})

		it('should strictly exclude units with reactive TTI results from verified stock', async () => {
			if (!dbConnected) return

			// Unit 7 has HIV Reactive. Confirm count is 2.
			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			const victoriaRef = derivePublicFacilityReference(nearActiveBankWithStock._id)
			const victoria = result.data.find((b) => b.facilityRef === victoriaRef)
			assert.strictEqual(victoria.verifiedUnitsAvailable, 2)
		})

		it('should filter by component type and exclude non-matching components', async () => {
			if (!dbConnected) return

			// Victoria has 1 Whole_Blood unit (A_Positive) and 2 PRBC units (O_Positive)
			const prbcResult = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
				bloodGroup: 'A_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})
			const victoriaRef = derivePublicFacilityReference(nearActiveBankWithStock._id)
			const victoriaPrbc = prbcResult.data.find((b) => b.facilityRef === victoriaRef)
			assert.strictEqual(victoriaPrbc.inventoryTrustStatus, 'No_Matching_Stock')
			assert.strictEqual(victoriaPrbc.verifiedUnitsAvailable, 0)
			assert.deepStrictEqual(victoriaPrbc.availableComponentCategories, [])

			const wbResult = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
				bloodGroup: 'A_Positive',
				componentType: 'Whole_Blood',
			})
			const victoriaWb = wbResult.data.find((b) => b.facilityRef === victoriaRef)
			assert.strictEqual(victoriaWb.inventoryTrustStatus, 'Verified_Available')
			assert.strictEqual(victoriaWb.verifiedUnitsAvailable, 1)
			assert.deepStrictEqual(victoriaWb.availableComponentCategories, ['Whole_Blood'])
		})

		it('should classify bank as No_Matching_Stock when traceable inventory exists but 0 units match filter', async () => {
			if (!dbConnected) return

			// Bowring bank has only B_Positive Fresh_Frozen_Plasma
			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
				bloodGroup: 'O_Positive',
				componentType: 'Packed_Red_Blood_Cells',
			})

			const bowringRef = derivePublicFacilityReference(nearActiveBankNoMatch._id)
			const bowring = result.data.find((b) => b.facilityRef === bowringRef)
			assert.ok(bowring)
			assert.strictEqual(bowring.inventoryTrustStatus, 'No_Matching_Stock')
			assert.strictEqual(bowring.verifiedUnitsAvailable, 0)
			assert.deepStrictEqual(bowring.availableComponentCategories, [])
			assert.deepStrictEqual(bowring.verifiedStockByGroup, { O_Positive: 0 })
			assert.match(bowring.inventoryNotice, /No matching units found/i)
		})

		it('should classify bank with NO traceable records as Inventory_Unverified and report null count', async () => {
			if (!dbConnected) return

			// City Life blood bank has 0 units in BloodUnit collection
			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
			})

			const cityLifeRef = derivePublicFacilityReference(nearActiveBankNoTraceableUnits._id)
			const cityLife = result.data.find((b) => b.facilityRef === cityLifeRef)
			assert.ok(cityLife)
			assert.strictEqual(cityLife.inventoryTrustStatus, 'Inventory_Unverified')
			assert.strictEqual(cityLife.verifiedUnitsAvailable, null, 'Must strictly report count as null, never 0')
			assert.strictEqual(cityLife.verifiedStockByGroup, null)
			assert.match(cityLife.inventoryNotice, /records are not available or have not been initialized/i)
		})

		it('should fail closed as Inventory_Unverified with null count if inventory query fails', async () => {
			// Test dedicated sanitizer behavior when inventory check encounters an unexpected error
			const mockBank = {
				_id: new mongoose.Types.ObjectId(),
				bloodbankName: 'Error Mock Bank',
				category: 'Private',
				city: 'Bangalore',
				state: 'Karnataka',
				status: true,
			}

			const sanitized = sanitizeBloodBankForDiscovery(mockBank, {
				approxDistanceKm: 5.2,
				inventoryTrustStatus: 'Inventory_Unverified',
				verifiedUnitsAvailable: null,
				availableComponentCategories: [],
				inventoryNotice: 'Inventory verification service is temporarily unavailable for this facility.',
			})

			assert.strictEqual(sanitized.inventoryTrustStatus, 'Inventory_Unverified')
			assert.strictEqual(sanitized.verifiedUnitsAvailable, null, 'Must strictly be null')
			assert.strictEqual(sanitized.isDistanceApproximate, true)
			assert.strictEqual(sanitized.approxDistanceKm, 5.2)
		})
	})

	describe('4. Privacy Shield & Response Sanitization', () => {
		it('should sanitize public response: use scoped facilityRef and exclude internal MongoDB ObjectIds', async () => {
			if (!dbConnected) return

			const result = await discoverNearbyBloodbanks({
				latitude: 12.9716,
				longitude: 77.5946,
				radiusKm: 15,
			})

			assert.ok(result.data.length > 0)
			for (const bank of result.data) {
				// Scoped public identifier
				assert.ok(bank.facilityRef, 'Must have facilityRef')
				assert.match(bank.facilityRef, /^BB-[A-F0-9]{12}$/, 'Must have valid BB-XXXXXXXXXXXX format')

				// Prohibited internal database identifiers
				assert.strictEqual(bank._id, undefined, 'Must NEVER expose internal MongoDB _id')
				assert.strictEqual(bank.bloodbankId, undefined, 'Must NEVER expose raw bloodbankId ObjectId')

				// Required public institutional fields
				assert.ok(bank.bloodbankName, 'Must have bloodbankName')
				assert.ok(bank.category, 'Must have category')
				assert.ok(bank.city, 'Must have city')
				assert.ok(bank.state, 'Must have state')
				assert.ok(bank.address, 'Must have address')
				assert.ok(bank.pinCode, 'Must have pinCode')
				assert.ok(bank.phoneNo1, 'Must have phoneNo1')
				assert.ok(bank.email, 'Must have email')
				assert.strictEqual(typeof bank.operatingStatus, 'string')
				assert.ok(['Verified_Available', 'No_Matching_Stock', 'Inventory_Unverified'].includes(bank.inventoryTrustStatus))

				// Prohibited sensitive account & staff credentials
				assert.strictEqual(bank.password, undefined, 'Must NEVER expose password')
				assert.strictEqual(bank.passwordResetToken, undefined, 'Must NEVER expose passwordResetToken')
				assert.strictEqual(bank.passwordResetExpires, undefined, 'Must NEVER expose passwordResetExpires')
				assert.strictEqual(bank.tokenVersion, undefined, 'Must NEVER expose tokenVersion')
				assert.strictEqual(bank.passwordChangedAt, undefined, 'Must NEVER expose passwordChangedAt')
				assert.strictEqual(bank.__v, undefined, 'Must NEVER expose __v')
				assert.strictEqual(bank.contactPerson, undefined, 'Must strictly exclude personal staff contactPerson')
				assert.strictEqual(bank.location, undefined, 'Must not expose raw location GeoJSON object')

				// Prohibited inventory internals & donor PII
				assert.strictEqual(bank.unitNumber, undefined, 'Must NEVER expose DIN')
				assert.strictEqual(bank.DIN, undefined, 'Must NEVER expose DIN')
				assert.strictEqual(bank.donorUserId, undefined, 'Must NEVER expose donorUserId')
				assert.strictEqual(bank.donationRequestId, undefined, 'Must NEVER expose donationRequestId')
			}
		})

		it('should derive deterministic, collision-resistant public facility references', () => {
			const id1 = new mongoose.Types.ObjectId()
			const id2 = new mongoose.Types.ObjectId()

			const ref1A = derivePublicFacilityReference(id1)
			const ref1B = derivePublicFacilityReference(id1)
			const ref2 = derivePublicFacilityReference(id2)

			// Deterministic
			assert.strictEqual(ref1A, ref1B)
			// Distinct per blood bank
			assert.notStrictEqual(ref1A, ref2)
			// Format
			assert.match(ref1A, /^BB-[A-F0-9]{12}$/)
			assert.match(ref2, /^BB-[A-F0-9]{12}$/)
			// Opaque (does not equal raw 24-character ObjectId)
			assert.notStrictEqual(ref1A, id1.toString())
		})
	})

	describe('5. Security, Input Validation & Rate Limiting via Controller', () => {
		it('should reject unauthenticated request with 401 Unauthorized', async () => {
			const { req, res, next, isNextCalled } = createMockReqRes({
				query: { latitude: '12.9716', longitude: '77.5946' },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /Authentication required/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should reject expired JWT token with 401 Unauthorized', async () => {
			const expiredToken = jwt.sign(
				{ id: nearActiveBankWithStock._id.toString(), tokenVersion: 0, iat: Math.floor(Date.now() / 1000) - 7200 },
				process.env.JWT_SECRET || 'test_jwt_secret_key_12345',
				{ expiresIn: '-10m' }
			)

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${expiredToken}` },
				query: { latitude: '12.9716', longitude: '77.5946' },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /expired/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should allow valid User token', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${validUserToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'USER')
		})

		it('should allow valid Blood Bank token', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${validBankToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'BLOODBANK')
		})

		it('should allow valid Staff token', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${validStaffToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'STAFF')
		})

		it('should allow valid Admin token', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${validAdminToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(isNextCalled(), true)
			assert.strictEqual(req.userRole, 'ADMIN')
		})

		it('should strictly reject deactivated User account with 401 Unauthorized', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${deactivatedUserToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /deactivated or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should strictly reject deactivated Blood Bank account with 401 Unauthorized', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${deactivatedBankToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /deactivated or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should strictly reject suspended Staff account with 401 Unauthorized', async () => {
			if (!dbConnected) return

			const { req, res, next, isNextCalled } = createMockReqRes({
				headers: { authorization: `Bearer ${inactiveStaffToken}` },
			})

			await protectEmergencyAuth(req, res, next)

			assert.strictEqual(res.statusCode, 401)
			assert.match(res.responseData.message, /inactive or suspended/i)
			assert.strictEqual(isNextCalled(), false)
		})

		it('should prevent NoSQL injection via query keys with $ or .', async () => {
			const { req, res } = createMockReqRes({
				query: {
					'$where': 'sleep(1000)',
					latitude: '12.9716',
					longitude: '77.5946',
				},
			})

			await getNearbyBloodbanks(req, res, () => {})

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Forbidden query operator or key/i)
		})

		it('should prevent NoSQL injection via nested query objects', async () => {
			const { req, res } = createMockReqRes({
				query: {
					latitude: { $gt: 0 },
					longitude: '77.5946',
				},
			})

			await getNearbyBloodbanks(req, res, () => {})

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Nested query objects are not allowed/i)
		})

		it('should validate and reject invalid blood group parameter', async () => {
			const { req, res } = createMockReqRes({
				query: {
					latitude: '12.9716',
					longitude: '77.5946',
					bloodGroup: 'INVALID_GROUP',
				},
			})

			await getNearbyBloodbanks(req, res, () => {})

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Invalid blood group/i)
		})

		it('should validate and reject invalid component type parameter', async () => {
			const { req, res } = createMockReqRes({
				query: {
					latitude: '12.9716',
					longitude: '77.5946',
					componentType: 'UNSUPPORTED_COMPONENT',
				},
			})

			await getNearbyBloodbanks(req, res, () => {})

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unsupported component type/i)
		})

		it('should enforce rate limiting on consecutive discovery requests', async () => {
			const mockUser = { _id: new mongoose.Types.ObjectId() }

			// Execute MAX_REQUESTS_PER_WINDOW requests
			for (let i = 0; i < MAX_REQUESTS_PER_WINDOW; i++) {
				const { req, res, next, isNextCalled } = createMockReqRes({ user: mockUser })
				discoveryRateLimiter(req, res, next)
				assert.strictEqual(isNextCalled(), true)
			}

			// (MAX_REQUESTS_PER_WINDOW + 1)-th request must be rejected with 429
			const { req, res, next, isNextCalled } = createMockReqRes({ user: mockUser })
			discoveryRateLimiter(req, res, next)

			assert.strictEqual(res.statusCode, 429)
			assert.strictEqual(isNextCalled(), false)
			assert.match(res.responseData.message, /Too many discovery requests/i)
			assert.ok(res.responseData.retryAfter > 0)
			assert.strictEqual(res.headersSent['Retry-After'], res.responseData.retryAfter)
		})

		it('should validate pagination parameters and return proper metadata', async () => {
			if (!dbConnected) return

			const { req, res } = createMockReqRes({
				query: {
					latitude: '12.9716',
					longitude: '77.5946',
					radiusKm: '15',
					page: '1',
					limit: '2',
				},
			})

			await getNearbyBloodbanks(req, res, () => {})

			assert.strictEqual(res.statusCode, 200)
			assert.strictEqual(res.responseData.pagination.page, 1)
			assert.strictEqual(res.responseData.pagination.limit, 2)
			assert.ok(res.responseData.data.length <= 2)
			assert.ok(res.responseData.pagination.totalCount >= 3)
			assert.strictEqual(res.responseData.pagination.hasNextPage, true)
		})

		it('should reject invalid page parameter (< 1)', async () => {
			const { req, res } = createMockReqRes({
				query: {
					latitude: '12.9716',
					longitude: '77.5946',
					page: '0',
				},
			})

			await getNearbyBloodbanks(req, res, () => {})

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Page number must be a positive integer/i)
		})

		it('should reject invalid limit parameter (> 50)', async () => {
			const { req, res } = createMockReqRes({
				query: {
					latitude: '12.9716',
					longitude: '77.5946',
					limit: '100',
				},
			})

			await getNearbyBloodbanks(req, res, () => {})

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Page limit must be an integer between 1 and 50/i)
		})

		it('should attach clinical governance notice to discovery response', async () => {
			if (!dbConnected) return

			const { req, res } = createMockReqRes({
				query: {
					latitude: '12.9716',
					longitude: '77.5946',
					radiusKm: '15',
				},
			})

			await getNearbyBloodbanks(req, res, () => {})

			assert.strictEqual(res.statusCode, 200)
			const governance = res.responseData.governance
			assert.ok(governance)
			assert.strictEqual(governance.isDiscoveryOnly, true)
			assert.strictEqual(governance.cannotAuthorizeCollection, true)
			assert.strictEqual(governance.cannotAuthorizeReservation, true)
			assert.strictEqual(governance.cannotAuthorizeIssuance, true)
			assert.strictEqual(governance.cannotAuthorizeDispatch, true)
			assert.strictEqual(governance.requiresLaboratoryCrossmatch, true)
			assert.strictEqual(governance.preservesPhase3Safeguards, true)
			assert.match(governance.disclaimer, /does NOT constitute blood unit reservation/i)
		})
	})
})
