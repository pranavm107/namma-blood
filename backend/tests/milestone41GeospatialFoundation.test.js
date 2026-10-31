const { describe, it, before, after } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const {
	isValidCoordinate,
	normalizeCoordinates,
	fuzzLocation,
	calculateHaversineDistanceKm,
	sanitizeDonorForDiscovery,
} = require('../Emergency/geoValidation')
const {
	EmergencyBloodRequest,
	VALID_URGENCY_LEVELS,
	VALID_VERIFICATION_STATUSES,
	VALID_EMERGENCY_STATUSES,
} = require('../Emergency/emergencyBloodRequestModel')
const {
	EmergencyDonorProfile,
	VALID_DONOR_AVAILABILITY,
	VALID_CLINICAL_ELIGIBILITY_STATUSES,
	VALID_DONATION_COMPONENTS,
} = require('../Emergency/emergencyDonorProfileModel')
const Bloodbank = require('../BloodBank/bloodbankModel')

describe('Milestone 4.1: Geospatial Foundation & Emergency Data Schemas', () => {
	let dbConnected = false
	const testRequesterId = new mongoose.Types.ObjectId()
	const testDonorUserId = new mongoose.Types.ObjectId()

	before(async () => {
		try {
			if (mongoose.connection.readyState !== 1) {
				await mongoose.connect(
					process.env.database_url || 'mongodb://127.0.0.1:27017/namma_blood_dev?replicaSet=rs0'
				)
			}
			dbConnected = mongoose.connection.readyState === 1
		} catch (err) {
			console.log('MongoDB not connected; skipping live geospatial query tests.')
		}
	})

	describe('1. Geospatial Validation & Privacy Shield Utilities', () => {
		it('isValidCoordinate: validates legitimate [longitude, latitude] pairs', () => {
			assert.strictEqual(isValidCoordinate([77.5946, 12.9716]), true) // Bangalore
			assert.strictEqual(isValidCoordinate([80.2707, 13.0827]), true) // Chennai
			assert.strictEqual(isValidCoordinate([0, 0]), true)
			assert.strictEqual(isValidCoordinate([-180, -90]), true)
			assert.strictEqual(isValidCoordinate([180, 90]), true)
		})

		it('isValidCoordinate: rejects out-of-range coordinates', () => {
			assert.strictEqual(isValidCoordinate([180.0001, 12.0]), false) // Longitude > 180
			assert.strictEqual(isValidCoordinate([-180.0001, 12.0]), false) // Longitude < -180
			assert.strictEqual(isValidCoordinate([77.0, 90.0001]), false) // Latitude > 90
			assert.strictEqual(isValidCoordinate([77.0, -90.0001]), false) // Latitude < -90
		})

		it('isValidCoordinate: rejects non-array, wrong length, strings, or NaN inputs', () => {
			assert.strictEqual(isValidCoordinate(null), false)
			assert.strictEqual(isValidCoordinate(undefined), false)
			assert.strictEqual(isValidCoordinate([77.0]), false)
			assert.strictEqual(isValidCoordinate([77.0, 12.0, 100.0]), false)
			assert.strictEqual(isValidCoordinate(['77.59', '12.97']), false)
			assert.strictEqual(isValidCoordinate([NaN, 12.97]), false)
			assert.strictEqual(isValidCoordinate([77.59, NaN]), false)
		})

		it('normalizeCoordinates: normalizes diverse valid input shapes to [lng, lat]', () => {
			assert.deepStrictEqual(normalizeCoordinates([77.59, 12.97]), [77.59, 12.97])
			assert.deepStrictEqual(
				normalizeCoordinates({ longitude: 77.59, latitude: 12.97 }),
				[77.59, 12.97]
			)
			assert.deepStrictEqual(
				normalizeCoordinates({ lng: 77.59, lat: 12.97 }),
				[77.59, 12.97]
			)
			assert.deepStrictEqual(
				normalizeCoordinates({ lon: 77.59, lat: 12.97 }),
				[77.59, 12.97]
			)
			assert.deepStrictEqual(
				normalizeCoordinates(['77.5946', '12.9716']),
				[77.5946, 12.9716]
			)
			assert.strictEqual(normalizeCoordinates({ invalid: 123 }), null)
			assert.strictEqual(normalizeCoordinates(null), null)
		})

		it('fuzzLocation: adds bounded jitter for privacy protection without breaching bounds', () => {
			const original = [77.5946, 12.9716]
			const fuzzed = fuzzLocation(original, 750)

			assert.strictEqual(isValidCoordinate(fuzzed), true)
			// Must not be identical to original (privacy protection)
			assert.notDeepStrictEqual(fuzzed, original)

			// Distance between original and fuzzed must be <= 1.5 km
			const distanceKm = calculateHaversineDistanceKm(original, fuzzed)
			assert.ok(distanceKm <= 1.5, `Distance was ${distanceKm} km, expected <= 1.5 km`)
		})

		it('fuzzLocation: rejects invalid coordinates', () => {
			assert.throws(() => fuzzLocation([999, 999]), /Cannot fuzz invalid coordinates/i)
		})

		it('calculateHaversineDistanceKm: accurately calculates great-circle distance', () => {
			const bangalore = [77.5946, 12.9716]
			const chennai = [80.2707, 13.0827]
			const distance = calculateHaversineDistanceKm(bangalore, chennai)

			// Actual straight-line distance is ~290 km
			assert.ok(distance >= 280 && distance <= 305, `Distance was ${distance} km, expected ~290 km`)
		})

		it('sanitizeDonorForDiscovery: completely strips coordinates, push keys, and PII', () => {
			const rawDonor = {
				_id: new mongoose.Types.ObjectId(),
				userId: new mongoose.Types.ObjectId(),
				bloodGroup: 'O_Negative',
				state: 'Karnataka',
				city: 'Bangalore',
				pinCode: 560001,
				maxTravelDistanceKm: 10,
				isEmergencyDonor: true,
				availabilityStatus: 'Ready',
				clinicalEligibilityStatus: 'Pending_Clinical_Evaluation',
				location: {
					type: 'Point',
					coordinates: [77.5946, 12.9716],
				},
				pushSubscription: {
					endpoint: 'https://push.example.com/sub/12345',
					keys: { p256dh: 'secret_key', auth: 'auth_key' },
				},
			}

			const sanitized = sanitizeDonorForDiscovery(rawDonor)

			// Must not contain location coordinates
			assert.strictEqual(sanitized.location, undefined)
			// Must not contain pushSubscription secrets
			assert.strictEqual(sanitized.pushSubscription, undefined)
			// Must have boolean flag indicating location exists without revealing it
			assert.strictEqual(sanitized.hasLocation, true)
			assert.strictEqual(sanitized.bloodGroup, 'O_Negative')
			assert.strictEqual(sanitized.city, 'Bangalore')
		})
	})

	describe('2. EmergencyBloodRequest Schema & Invariants', () => {
		it('should validate a complete, valid emergency blood request with coordinates', async () => {
			const request = new EmergencyBloodRequest({
				requesterUserId: testRequesterId,
				patientName: 'Kavitha Ramesh',
				patientAge: 42,
				patientGender: 'Female',
				requiredBloodGroup: 'O_Negative',
				requiredComponent: 'Packed_Red_Blood_Cells',
				unitsRequested: 3,
				urgencyLevel: 'Critical',
				requiredWithinHours: 2,
				hospitalName: 'Bowring and Lady Curzon Hospital',
				hospitalAddress: 'Shivajinagar, Tasker Town',
				hospitalCity: 'Bangalore',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.6033, 12.9833],
				},
				attendingDoctor: {
					doctorName: 'Dr. S. K. Rao',
					doctorPhone: '9845098450',
					registrationNumber: 'KMC-12345',
				},
				clinicalJustification: 'Emergency intraoperative hemorrhage in trauma OT',
			})

			await request.validate()

			// Safety Requirement: Never automatically mark emergency requests as verified
			assert.strictEqual(request.verificationStatus, 'Pending_Verification')
			assert.strictEqual(request.status, 'Active')
			assert.ok(request.requestNumber.startsWith('EMG-'))
			assert.ok(request.expiresAt instanceof Date)
			assert.ok(request.expiresAt.getTime() > Date.now())
		})

		it('should validate an emergency request WITHOUT coordinates (City/State fallback)', async () => {
			const request = new EmergencyBloodRequest({
				requesterUserId: testRequesterId,
				patientName: 'Emergency Patient',
				patientAge: 55,
				patientGender: 'Male',
				requiredBloodGroup: 'A_Positive',
				requiredComponent: 'Whole_Blood',
				unitsRequested: 2,
				urgencyLevel: 'Urgent',
				hospitalName: 'General Hospital',
				hospitalAddress: 'MG Road',
				hospitalCity: 'Bangalore',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560001,
				attendingDoctor: {
					doctorName: 'Dr. Murthy',
					doctorPhone: '9876543210',
				},
			})

			await request.validate()

			assert.strictEqual(request.location, undefined)
			assert.strictEqual(request.hospitalCity, 'Bangalore')
			assert.strictEqual(request.verificationStatus, 'Pending_Verification')
		})

		it('should clean up empty coordinates array in emergency request to undefined', async () => {
			const request = new EmergencyBloodRequest({
				requesterUserId: testRequesterId,
				patientName: 'Emergency Patient',
				patientAge: 55,
				patientGender: 'Male',
				requiredBloodGroup: 'A_Positive',
				unitsRequested: 1,
				hospitalName: 'General Hospital',
				hospitalAddress: 'MG Road',
				hospitalCity: 'Bangalore',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [], // Empty coordinates array
				},
				attendingDoctor: {
					doctorName: 'Dr. Murthy',
					doctorPhone: '9876543210',
				},
			})

			await request.validate()
			assert.strictEqual(request.location, undefined)
		})

		it('should reject request with out-of-range coordinates', async () => {
			const request = new EmergencyBloodRequest({
				requesterUserId: testRequesterId,
				patientName: 'Test Patient',
				patientAge: 30,
				patientGender: 'Male',
				requiredBloodGroup: 'A_Positive',
				hospitalName: 'Test Hospital',
				hospitalAddress: 'Test Address',
				hospitalCity: 'Bangalore',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [195.0, 12.0], // Longitude > 180 invalid
				},
				attendingDoctor: {
					doctorName: 'Dr. Test',
					doctorPhone: '9876543210',
				},
			})

			await assert.rejects(
				async () => {
					await request.validate()
				},
				(err) => {
					assert.match(err.message, /Coordinates must be valid/i)
					return true
				}
			)
		})

		it('should reject request missing mandatory attending doctor details', async () => {
			const request = new EmergencyBloodRequest({
				requesterUserId: testRequesterId,
				patientName: 'Test Patient',
				patientAge: 30,
				patientGender: 'Male',
				requiredBloodGroup: 'A_Positive',
				hospitalName: 'Test Hospital',
				hospitalAddress: 'Test Address',
				hospitalCity: 'Bangalore',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.59, 12.97],
				},
				// Missing attendingDoctor
			})

			await assert.rejects(
				async () => {
					await request.validate()
				},
				(err) => {
					assert.match(err.message, /attending doctor/i)
					return true
				}
			)
		})

		it('should reject request with invalid urgency level', async () => {
			const request = new EmergencyBloodRequest({
				requesterUserId: testRequesterId,
				patientName: 'Test Patient',
				patientAge: 30,
				patientGender: 'Male',
				requiredBloodGroup: 'A_Positive',
				urgencyLevel: 'Super_Immediate_Unrealistic', // Invalid enum
				hospitalName: 'Test Hospital',
				hospitalAddress: 'Test Address',
				hospitalCity: 'Bangalore',
				hospitalState: 'Karnataka',
				hospitalPinCode: 560001,
				location: {
					type: 'Point',
					coordinates: [77.59, 12.97],
				},
				attendingDoctor: {
					doctorName: 'Dr. Test',
					doctorPhone: '9876543210',
				},
			})

			await assert.rejects(
				async () => {
					await request.validate()
				},
				(err) => {
					assert.match(err.message, /not a valid urgency level/i)
					return true
				}
			)
		})
	})

	describe('3. EmergencyDonorProfile Clinical Governance & Privacy Shield', () => {
		it('should validate an emergency donor profile with safe clinical defaults', async () => {
			const profile = new EmergencyDonorProfile({
				userId: testDonorUserId,
				bloodGroup: 'B_Positive',
				state: 'Karnataka',
				city: 'Bangalore',
				pinCode: 560034,
			})

			await profile.validate()

			assert.strictEqual(profile.isEmergencyDonor, false)
			assert.strictEqual(profile.availabilityStatus, 'Ready')
			// Clinical Governance Invariant: Defaults strictly to Pending_Clinical_Evaluation
			assert.strictEqual(profile.clinicalEligibilityStatus, 'Pending_Clinical_Evaluation')
			assert.strictEqual(profile.eligibleToDonateAfter, null)
			assert.strictEqual(profile.maxTravelDistanceKm, 15)
		})

		it('should NOT automatically compute unapproved cooldown intervals upon donation recording', async () => {
			const donationDate = new Date('2026-10-15T10:00:00.000Z')

			const profile = new EmergencyDonorProfile({
				userId: testDonorUserId,
				bloodGroup: 'O_Positive',
				lastDonationDate: donationDate,
				lastDonationComponent: 'Whole_Blood',
				state: 'Karnataka',
				city: 'Bangalore',
				pinCode: 560034,
			})

			await profile.validate()

			// Safety Invariant: Does NOT automatically add 90 days or assume eligibility
			assert.strictEqual(profile.lastDonationDate.toISOString(), donationDate.toISOString())
			assert.strictEqual(profile.lastDonationComponent, 'Whole_Blood')
			assert.strictEqual(profile.eligibleToDonateAfter, null)
			assert.strictEqual(profile.clinicalEligibilityStatus, 'Pending_Clinical_Evaluation')
			// Does NOT automatically force Cooling_Down without clinical evaluation
			assert.strictEqual(profile.availabilityStatus, 'Ready')
		})

		it('toDiscoverySafeObject: strips coordinates and PII from public responses', async () => {
			const profile = new EmergencyDonorProfile({
				userId: testDonorUserId,
				bloodGroup: 'A_Negative',
				state: 'Karnataka',
				city: 'Bangalore',
				pinCode: 560034,
				location: {
					type: 'Point',
					coordinates: [77.5946, 12.9716],
				},
				pushSubscription: {
					endpoint: 'https://push.example.com/token',
					keys: { p256dh: 'p256', auth: 'auth' },
				},
			})

			await profile.validate()

			const safeObj = profile.toDiscoverySafeObject()

			assert.strictEqual(safeObj.location, undefined)
			assert.strictEqual(safeObj.pushSubscription, undefined)
			assert.strictEqual(safeObj.hasLocation, true)
			assert.strictEqual(safeObj.bloodGroup, 'A_Negative')
			assert.strictEqual(safeObj.clinicalEligibilityStatus, 'Pending_Clinical_Evaluation')
		})

		it('should clean up empty coordinates array to undefined', async () => {
			const profile = new EmergencyDonorProfile({
				userId: testDonorUserId,
				bloodGroup: 'B_Positive',
				state: 'Karnataka',
				city: 'Bangalore',
				pinCode: 560034,
				location: {
					type: 'Point',
					coordinates: [], // Empty coordinates should be pruned
				},
			})

			await profile.validate()

			assert.strictEqual(profile.location, undefined)
		})
	})

	describe('4. Blood Bank Model Backward Compatibility & Optional Coordinates', () => {
		it('should validate a legacy blood bank record with NO coordinates successfully', async () => {
			const legacyBank = new Bloodbank({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: 'Victoria Hospital Blood Bank',
				category: 'Government',
				contactPerson: 'Dr. Nagaraj',
				address1: 'Fort Road',
				address2: 'Near City Market',
				pinCode: 560002,
				phoneNo1: '08026701111',
				phoneNo2: '08026702222',
				email: `victoria_${Date.now()}@karnataka.gov.in`,
				password: 'securePassword123',
			})

			await legacyBank.validate()

			// Pre-validate hook keeps location undefined
			assert.strictEqual(legacyBank.location, undefined)
			assert.strictEqual(legacyBank.bloodbankName, 'Victoria Hospital Blood Bank')
			assert.strictEqual(legacyBank.tokenVersion, 0)
		})

		it('should validate a modern blood bank record WITH GeoJSON coordinates successfully', async () => {
			const geoBank = new Bloodbank({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: 'Bowring Hospital Blood Center',
				category: 'Government',
				contactPerson: 'Dr. Anupama',
				address1: 'Shivajinagar',
				address2: 'Lady Curzon Road',
				pinCode: 560001,
				phoneNo1: '08025591111',
				phoneNo2: '08025592222',
				email: `bowring_${Date.now()}@karnataka.gov.in`,
				password: 'securePassword123',
				location: {
					type: 'Point',
					coordinates: [77.6033, 12.9833],
				},
			})

			await geoBank.validate()

			assert.strictEqual(geoBank.location.type, 'Point')
			assert.deepStrictEqual(geoBank.location.coordinates, [77.6033, 12.9833])
		})

		it('should clean up blood bank with empty coordinates array to undefined', async () => {
			const bank = new Bloodbank({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: 'Test Bank',
				category: 'Private',
				contactPerson: 'Contact Person',
				address1: 'Address 1',
				address2: 'Address 2',
				pinCode: 560001,
				phoneNo1: '9845111111',
				phoneNo2: '9845222222',
				email: `bank_${Date.now()}@test.com`,
				password: 'password123',
				location: {
					type: 'Point',
					coordinates: [], // Empty array
				},
			})

			await bank.validate()
			assert.strictEqual(bank.location, undefined)
		})

		it('should reject blood bank with invalid latitude (> 90)', async () => {
			const bank = new Bloodbank({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: 'Test Bank',
				category: 'Private',
				contactPerson: 'Contact Person',
				address1: 'Address 1',
				address2: 'Address 2',
				pinCode: 560001,
				phoneNo1: '9845111111',
				phoneNo2: '9845222222',
				email: `bank_${Date.now()}@test.com`,
				password: 'password123',
				location: {
					type: 'Point',
					coordinates: [77.59, 105.0], // Latitude > 90 invalid
				},
			})

			await assert.rejects(
				async () => {
					await bank.validate()
				},
				(err) => {
					assert.match(err.message, /Coordinates must be valid/i)
					return true
				}
			)
		})
	})

	describe('5. Live MongoDB Geospatial 2dsphere Index Verification', () => {
		let createdBankIds = []
		let createdRequestId = null

		after(async () => {
			if (dbConnected) {
				try {
					if (createdBankIds.length > 0) {
						await Bloodbank.deleteMany({ _id: { $in: createdBankIds } })
					}
					if (createdRequestId) {
						await EmergencyBloodRequest.deleteOne({ _id: createdRequestId })
					}
					await mongoose.disconnect()
				} catch (err) {
					console.error('Test cleanup error:', err.message)
				}
			}
		})

		it('should verify 2dsphere index and perform $nearSphere radius query correctly', async () => {
			if (!dbConnected) {
				console.log('Skipping live 2dsphere query test: MongoDB offline.')
				return
			}

			// Ensure indexes are built
			await Bloodbank.syncIndexes()
			await EmergencyBloodRequest.syncIndexes()

			const uniqueStamp = Date.now()

			// 1. Bank A: Victoria Hospital in Bangalore central (~1.5 km from request)
			const nearbyBank = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: `Nearby Test Bank ${uniqueStamp}`,
				category: 'Government',
				contactPerson: 'Dr. Test',
				address1: 'Fort Road',
				address2: 'City Market',
				pinCode: 560002,
				phoneNo1: `9845${uniqueStamp.toString().slice(-6)}1`,
				phoneNo2: `9845${uniqueStamp.toString().slice(-6)}2`,
				email: `nearby_${uniqueStamp}@test.gov.in`,
				password: 'password123',
				location: {
					type: 'Point',
					coordinates: [77.5736, 12.9628], // Victoria Hospital area
				},
			})
			createdBankIds.push(nearbyBank._id)

			// 2. Bank B: Mysore Blood Bank (~130 km away from request)
			const farBank = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Mysore',
				bloodbankName: `Far Test Bank ${uniqueStamp}`,
				category: 'Government',
				contactPerson: 'Dr. Far',
				address1: 'Irwin Road',
				address2: 'Mysore Central',
				pinCode: 570001,
				phoneNo1: `9846${uniqueStamp.toString().slice(-6)}1`,
				phoneNo2: `9846${uniqueStamp.toString().slice(-6)}2`,
				email: `far_${uniqueStamp}@test.gov.in`,
				password: 'password123',
				location: {
					type: 'Point',
					coordinates: [76.6548, 12.3118], // Mysore
				},
			})
			createdBankIds.push(farBank._id)

			// 3. Bank C: Legacy Bank with NO coordinates
			const legacyBank = await Bloodbank.create({
				state: 'Karnataka',
				city: 'Bangalore',
				bloodbankName: `Legacy No-Geo Bank ${uniqueStamp}`,
				category: 'Private',
				contactPerson: 'Dr. Legacy',
				address1: 'MG Road',
				address2: 'Brigade Junction',
				pinCode: 560001,
				phoneNo1: `9847${uniqueStamp.toString().slice(-6)}1`,
				phoneNo2: `9847${uniqueStamp.toString().slice(-6)}2`,
				email: `legacy_${uniqueStamp}@test.com`,
				password: 'password123',
			})
			createdBankIds.push(legacyBank._id)

			// Search location: City Market Junction, Bangalore [77.5750, 12.9640]
			const searchPoint = [77.575, 12.964]

			// Query nearby blood banks within 10 km (10,000 meters)
			const nearbyResults = await Bloodbank.find({
				location: {
					$nearSphere: {
						$geometry: {
							type: 'Point',
							coordinates: searchPoint,
						},
						$maxDistance: 10000, // 10 km
					},
				},
			})

			const nearbyResultIds = nearbyResults.map((b) => b._id.toString())

			// Bank A (Nearby) MUST be present
			assert.ok(
				nearbyResultIds.includes(nearbyBank._id.toString()),
				'Nearby blood bank was not returned by $nearSphere query'
			)

			// Bank B (Far - Mysore) MUST NOT be present
			assert.ok(
				!nearbyResultIds.includes(farBank._id.toString()),
				'Far blood bank was erroneously returned by 10km $nearSphere query'
			)

			// Bank C (Legacy - No coordinates) MUST NOT crash the query and must be safely excluded from spatial results
			assert.ok(!nearbyResultIds.includes(legacyBank._id.toString()))

			// But Bank C CAN still be found in standard string-based queries!
			const cityResults = await Bloodbank.find({ city: 'Bangalore', _id: legacyBank._id })
			assert.strictEqual(cityResults.length, 1)
			assert.strictEqual(cityResults[0]._id.toString(), legacyBank._id.toString())
		})
	})
})
