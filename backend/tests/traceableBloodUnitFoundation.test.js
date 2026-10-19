const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const {
	BloodUnit,
	VALID_BLOOD_GROUPS,
	VALID_COMPONENT_TYPES,
	VALID_STATUSES,
	MANDATORY_TTI_TESTS,
} = require('../BloodUnit/bloodUnitModel')
const {
	BloodUnitAuditLog,
	recordAuditLog,
} = require('../BloodUnit/bloodUnitAuditModel')
const {
	buildCandidateDIN,
	generateUniqueDIN,
	getJulianDay,
	saveWithDINRetry,
} = require('../BloodUnit/dinGenerator')
const stockService = require('../BloodStock/stockService')
const Bloodstock = require('../BloodStock/bloodStockModel')

describe('Phase 3.1 — Traceable Blood Inventory Foundation & Compatibility', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId()
	const mockUserId = new mongoose.Types.ObjectId()
	const mockRequestId = new mongoose.Types.ObjectId()

	// -------------------------------------------------------------
	// 1. BloodUnit Model Validation & Enums
	// -------------------------------------------------------------
	describe('1. BloodUnit Model Schema & Validation', () => {
		it('should default status to Quarantined and clearance.isVerified to false', () => {
			const unit = new BloodUnit({
				unitNumber: 'DIN-2026292-A1B2C3-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
			})

			assert.strictEqual(unit.status, 'Quarantined')
			assert.strictEqual(unit.clearance.isVerified, false)
			assert.strictEqual(unit.testing.hiv, 'Pending')
			assert.strictEqual(unit.testing.hbv, 'Pending')
			assert.strictEqual(unit.testing.hcv, 'Pending')
			assert.strictEqual(unit.testing.syphilis, 'Pending')
			assert.strictEqual(unit.testing.malaria, 'Pending')
			assert.strictEqual(unit.componentType, 'Whole_Blood')
			assert.strictEqual(unit.volumeMl, 350)
			assert.strictEqual(unit.isIssueEligible(), false)
		})

		it('should fail validation when required fields are missing', async () => {
			const unit = new BloodUnit({})
			let validationError = null

			try {
				await unit.validate()
			} catch (err) {
				validationError = err
			}

			assert.ok(validationError, 'Validation must fail for empty document')
			assert.ok(validationError.errors.unitNumber, 'unitNumber is required')
			assert.ok(validationError.errors.bloodbankId, 'bloodbankId is required')
			assert.ok(validationError.errors.bloodGroup, 'bloodGroup is required')
			assert.ok(validationError.errors.expiryDate, 'expiryDate is required')
		})

		it('should reject invalid blood groups and component types', async () => {
			const unit = new BloodUnit({
				unitNumber: 'DIN-2026292-INVALID-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'Z_Unknown',
				componentType: 'Artificial_Plasma',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
			})

			let validationError = null
			try {
				await unit.validate()
			} catch (err) {
				validationError = err
			}

			assert.ok(validationError)
			assert.ok(validationError.errors.bloodGroup)
			assert.ok(validationError.errors.componentType)
		})

		it('should reject volumes below 50 mL or above 600 mL', async () => {
			const tooSmall = new BloodUnit({
				unitNumber: 'DIN-2026292-SMALL-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'A_Positive',
				volumeMl: 30,
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
			})

			let smallErr = null
			try {
				await tooSmall.validate()
			} catch (err) {
				smallErr = err
			}
			assert.ok(smallErr?.errors?.volumeMl)

			const tooLarge = new BloodUnit({
				unitNumber: 'DIN-2026292-LARGE-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'A_Positive',
				volumeMl: 750,
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
			})

			let largeErr = null
			try {
				await tooLarge.validate()
			} catch (err) {
				largeErr = err
			}
			assert.ok(largeErr?.errors?.volumeMl)
		})
	})

	// -------------------------------------------------------------
	// 2. Clinical Safety Gates & Pre-Save Validation
	// -------------------------------------------------------------
	describe('2. Clinical Safety Gates & Issue-Eligibility Rules', () => {
		it('should forbid setting status to Available without Medical Officer clearance', async () => {
			const unit = new BloodUnit({
				unitNumber: 'DIN-2026292-NOCLR-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'B_Positive',
				status: 'Available',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				clearance: { isVerified: false },
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})

			await assert.rejects(
				() => unit.save(),
				/Medical Officer clearance verification/
			)
		})

		it('should forbid setting status to Available if any mandatory TTI test is Pending or missing', async () => {
			const unit = new BloodUnit({
				unitNumber: 'DIN-2026292-PENDING-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'B_Positive',
				status: 'Available',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				clearance: { isVerified: true, verifiedBy: mockBloodbankId },
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Pending', // HIV passed, HBV still pending!
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})

			await assert.rejects(
				() => unit.save(),
				/mandatory screening test 'hbv' is 'Pending'/
			)
		})

		it('should forbid setting status to Available if expiryDate is in the past', async () => {
			const unit = new BloodUnit({
				unitNumber: 'DIN-2026292-EXPIRED-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Negative',
				status: 'Available',
				expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // Expired yesterday
				clearance: { isVerified: true },
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})

			await assert.rejects(
				() => unit.save(),
				/Expired BloodUnit cannot be marked Available/
			)
		})

		it('should forbid status Tested_Passed or Available if any TTI screening test is Reactive', async () => {
			const reactiveUnit = new BloodUnit({
				unitNumber: 'DIN-2026292-REACTIVE-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'A_Positive',
				status: 'Tested_Passed',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: {
					hiv: 'Reactive', // HIV positive/reactive!
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})

			await assert.rejects(
				() => reactiveUnit.save(),
				/reactive screening results cannot be Tested_Passed or Available/
			)
		})

		it('should verify isIssueEligible returns true only when all clearance conditions are satisfied', () => {
			const validUnit = new BloodUnit({
				unitNumber: 'DIN-2026292-VALID-WB',
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				status: 'Available',
				expiryDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
				clearance: { isVerified: true },
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})

			assert.strictEqual(validUnit.isIssueEligible(), true)

			// Quarantined unit is NOT issue-eligible
			validUnit.status = 'Quarantined'
			assert.strictEqual(validUnit.isIssueEligible(), false)

			// Reserved unit is NOT issue-eligible for general issuance
			validUnit.status = 'Reserved'
			assert.strictEqual(validUnit.isIssueEligible(), false)

			// Expired unit is NOT issue-eligible
			validUnit.status = 'Available'
			validUnit.expiryDate = new Date(Date.now() - 1000)
			assert.strictEqual(validUnit.isIssueEligible(), false)
		})

		it('should block unsafe query-based status promotions to Available or Tested_Passed across all update operations', async () => {
			// Direct field update
			await assert.rejects(
				() => BloodUnit.updateOne({}, { status: 'Available' }).exec(),
				/Query-based transition to status 'Available' is strictly forbidden/
			)

			// In $set operator
			await assert.rejects(
				() => BloodUnit.updateOne({}, { $set: { status: 'Available' } }).exec(),
				/Query-based transition to status 'Available' is strictly forbidden/
			)

			// In updateMany
			await assert.rejects(
				() => BloodUnit.updateMany({}, { $set: { status: 'Tested_Passed' } }).exec(),
				/Query-based transition to status 'Tested_Passed' is strictly forbidden/
			)

			// In findOneAndUpdate
			await assert.rejects(
				() => BloodUnit.findOneAndUpdate({}, { $set: { status: 'Available' } }).exec(),
				/Query-based transition to status 'Available' is strictly forbidden/
			)

			// In replaceOne
			await assert.rejects(
				() => BloodUnit.replaceOne({}, { status: 'Available' }).exec(),
				/Query-based transition to status 'Available' is strictly forbidden/
			)

			// In findOneAndReplace
			await assert.rejects(
				() => BloodUnit.findOneAndReplace({}, { status: 'Available' }).exec(),
				/Query-based transition to status 'Available' is strictly forbidden/
			)
		})
	})

	// -------------------------------------------------------------
	// 3. Collision-Safe DIN Generator
	// -------------------------------------------------------------
	describe('3. Donation Identification Number (DIN) Generator', () => {
		it('should generate candidate DIN matching standard format with Julian day and component suffix', () => {
			const testDate = new Date(Date.UTC(2026, 9, 19)) // Oct 19, 2026
			const julian = getJulianDay(testDate)
			assert.strictEqual(julian, '292')

			const prbcDin = buildCandidateDIN('Packed_Red_Blood_Cells', testDate)
			assert.match(prbcDin, /^DIN-2026292-[0-9A-F]{6}-PRBC$/)

			const pltDin = buildCandidateDIN('Platelet_Concentrate', testDate)
			assert.match(pltDin, /^DIN-2026292-[0-9A-F]{6}-PLT$/)
		})

		it('should detect simulated collisions and retry until finding a unique DIN', async () => {
			let queryCount = 0
			const mockModel = {
				async findOne({ unitNumber }) {
					queryCount++
					// Simulate collision on first 2 attempts, success on 3rd attempt
					if (queryCount < 3) {
						return { _id: new mongoose.Types.ObjectId(), unitNumber }
					}
					return null // Available
				},
			}

			const din = await generateUniqueDIN(mockBloodbankId, 'O_Positive', 'Whole_Blood', {
				model: mockModel,
				maxRetries: 5,
			})

			assert.ok(din.startsWith('DIN-'))
			assert.strictEqual(queryCount, 3, 'Should have queried 3 times due to 2 collisions')
		})

		it('should throw an error when collision retries are exhausted', async () => {
			const mockCollidingModel = {
				async findOne() {
					return { _id: 'collision' } // Always colliding
				},
			}

			await assert.rejects(
				() =>
					generateUniqueDIN(mockBloodbankId, 'A_Positive', 'Whole_Blood', {
						model: mockCollidingModel,
						maxRetries: 3,
					}),
				/Unable to generate a unique DIN after 3 collision retries/
			)
		})

		it('should recover from save-time E11000 duplicate-key collisions via saveWithDINRetry', async () => {
			let attempts = 0
			const generatedDINs = []

			// Simulate save callback failing with E11000 duplicate key error on 1st attempt, succeeding on 2nd
			const mockSaveCallback = async (din) => {
				attempts++
				generatedDINs.push(din)
				if (attempts === 1) {
					const dupErr = new Error(
						'E11000 duplicate key error collection: test.bloodunits index: unitNumber_1 dup key: { unitNumber: "' +
							din +
							'" }'
					)
					dupErr.code = 11000
					throw dupErr
				}
				return { _id: new mongoose.Types.ObjectId(), unitNumber: din, status: 'Quarantined' }
			}

			const mockModel = {
				async findOne() {
					return null // Passes pre-check findOne
				},
			}

			const result = await saveWithDINRetry(mockSaveCallback, {
				bloodbankId: mockBloodbankId,
				bloodGroup: 'B_Positive',
				componentType: 'Packed_Red_Blood_Cells',
				model: mockModel,
				maxRetries: 3,
			})

			assert.strictEqual(attempts, 2, 'Should have retried after E11000 collision')
			assert.strictEqual(generatedDINs.length, 2)
			assert.notStrictEqual(generatedDINs[0], generatedDINs[1], 'New DIN must be generated on retry')
			assert.strictEqual(result.unitNumber, generatedDINs[1])
		})
	})

	// -------------------------------------------------------------
	// 4. Stock Service & Issue-Eligible Availability
	// -------------------------------------------------------------
	describe('4. Stock Service Derived Availability & Legacy Isolation', () => {
		it('should derive zero verified available stock when units are in non-eligible statuses', async () => {
			const originalAggregate = BloodUnit.aggregate
			try {
				// Mock aggregation returning empty results (no Available units)
				BloodUnit.aggregate = () => []

				const verifiedStock = await stockService.getTraceableAvailableStock(
					mockBloodbankId
				)

				for (const bg of VALID_BLOOD_GROUPS) {
					assert.strictEqual(
						verifiedStock[bg],
						0,
						`${bg} must be 0 when no eligible units exist`
					)
				}
			} finally {
				BloodUnit.aggregate = originalAggregate
			}
		})

		it('should derive verified stock counts strictly from qualifying available units', async () => {
			const originalAggregate = BloodUnit.aggregate
			try {
				// Mock aggregation simulating database returning only Available, non-reactive units
				BloodUnit.aggregate = () => [
					{ _id: 'O_Positive', count: 4 },
					{ _id: 'A_Negative', count: 2 },
				]

				const verifiedStock = await stockService.getTraceableAvailableStock(
					mockBloodbankId
				)

				assert.strictEqual(verifiedStock.O_Positive, 4)
				assert.strictEqual(verifiedStock.A_Negative, 2)
				assert.strictEqual(verifiedStock.B_Positive, 0)
			} finally {
				BloodUnit.aggregate = originalAggregate
			}
		})

		it('should maintain strict separation between verified stock and legacy aggregate stock in getConsolidatedStock', async () => {
			const originalAggregate = BloodUnit.aggregate
			const originalFindOne = Bloodstock.findOne

			try {
				// Case A: Blood bank with ONLY legacy stock (0 traceable units)
				BloodUnit.aggregate = () => []

				Bloodstock.findOne = async () => ({
					_id: new mongoose.Types.ObjectId(),
					bloodbankId: mockBloodbankId,
					A_Positive: 15,
					O_Negative: 5,
				})

				const legacyResult = await stockService.getConsolidatedStock(mockBloodbankId)

				assert.strictEqual(legacyResult.isTraceableActive, false)
				assert.strictEqual(legacyResult.isVerifiedStock, false)
				assert.strictEqual(legacyResult.inventoryClassification, 'LEGACY_UNVERIFIED')
				assert.strictEqual(legacyResult.A_Positive, 15)
				assert.strictEqual(legacyResult.legacyUnverifiedStock.A_Positive, 15)
				assert.strictEqual(legacyResult.traceableVerifiedStock.A_Positive, 0)
				assert.match(legacyResult.legacyNotice, /unverified legacy aggregate quantities/)

				// Case B: Blood bank with legacy stock (15 A+) and their first traceable unit is Quarantined (0 Available)
				let callIndexB = 0
				BloodUnit.aggregate = () => {
					callIndexB++
					if (callIndexB === 1) {
						// getTraceableAvailableStock: 0 verified available
						return []
					}
					// getTraceableStatusBreakdown: 1 Quarantined unit
					return [{ _id: 'Quarantined', count: 1 }]
				}

				const quarantinedIntakeResult = await stockService.getConsolidatedStock(mockBloodbankId)

				assert.strictEqual(quarantinedIntakeResult.isTraceableActive, true)
				assert.strictEqual(quarantinedIntakeResult.isVerifiedStock, false)
				assert.strictEqual(
					quarantinedIntakeResult.inventoryClassification,
					'LEGACY_WITH_QUARANTINE_INTAKE'
				)
				// Top-level preserves legacy operational visibility without zeroing out to 0
				assert.strictEqual(quarantinedIntakeResult.A_Positive, 15)
				assert.strictEqual(quarantinedIntakeResult.legacyUnverifiedStock.A_Positive, 15)
				// Verified available stock strictly remains 0 (quarantined unit is NOT counted)
				assert.strictEqual(quarantinedIntakeResult.traceableVerifiedStock.A_Positive, 0)
				assert.strictEqual(quarantinedIntakeResult.traceableStatusBreakdown.Quarantined, 1)
				assert.match(
					quarantinedIntakeResult.legacyNotice,
					/1 unit\(s\) are currently Quarantined awaiting infectious screening/
				)

				// Case C: Blood bank with legacy stock (15 A+) AND active verified traceable units (3 Available)
				let callIndexC = 0
				BloodUnit.aggregate = () => {
					callIndexC++
					if (callIndexC === 1) {
						// getTraceableAvailableStock
						return [{ _id: 'A_Positive', count: 3 }]
					}
					// getTraceableStatusBreakdown
					return [
						{ _id: 'Available', count: 3 },
						{ _id: 'Quarantined', count: 2 },
					]
				}

				const hybridResult = await stockService.getConsolidatedStock(mockBloodbankId)

				assert.strictEqual(hybridResult.isTraceableActive, true)
				assert.strictEqual(hybridResult.isVerifiedStock, true)
				assert.strictEqual(hybridResult.inventoryClassification, 'HYBRID_TRANSITIONAL')
				// Top-level strictly reflects issue-eligible verified units
				assert.strictEqual(hybridResult.A_Positive, 3)
				assert.strictEqual(hybridResult.traceableVerifiedStock.A_Positive, 3)
				assert.strictEqual(hybridResult.legacyUnverifiedStock.A_Positive, 15)
				assert.strictEqual(hybridResult.traceableStatusBreakdown.Available, 3)
				assert.strictEqual(hybridResult.traceableStatusBreakdown.Quarantined, 2)
				assert.match(hybridResult.legacyNotice, /reflect issue-eligible verified units only/)
			} finally {
				BloodUnit.aggregate = originalAggregate
				Bloodstock.findOne = originalFindOne
			}
		})

		it('should check availability strictly against issue-eligible units, rejecting unverified legacy quantities', async () => {
			const originalAggregate = BloodUnit.aggregate
			try {
				BloodUnit.aggregate = () => [{ _id: 'O_Positive', count: 1 }]

				// Available: 1 unit of O_Positive
				const canFulfillOne = await stockService.checkIssueEligibleAvailability(
					mockBloodbankId,
					'O_Positive',
					1
				)
				assert.strictEqual(canFulfillOne, true)

				// Requires 2 units of O_Positive (only 1 available)
				const canFulfillTwo = await stockService.checkIssueEligibleAvailability(
					mockBloodbankId,
					'O_Positive',
					2
				)
				assert.strictEqual(canFulfillTwo, false)

				// No units of B_Positive
				const canFulfillB = await stockService.checkIssueEligibleAvailability(
					mockBloodbankId,
					'B_Positive',
					1
				)
				assert.strictEqual(canFulfillB, false)
			} finally {
				BloodUnit.aggregate = originalAggregate
			}
		})
	})

	// -------------------------------------------------------------
	// 5. Append-Only Audit Log Immutability
	// -------------------------------------------------------------
	describe('5. BloodUnitAuditLog Append-Only Immutability', () => {
		it('should create an audit log record with valid actions', () => {
			const log = new BloodUnitAuditLog({
				unitId: new mongoose.Types.ObjectId(),
				unitNumber: 'DIN-2026292-AUDIT-WB',
				bloodbankId: mockBloodbankId,
				action: 'UNIT_INTAKE_COLLECTED',
				previousStatus: 'None',
				newStatus: 'Quarantined',
				actor: {
					actorId: mockBloodbankId,
					actorModel: 'bloodbank',
				},
				reason: 'Voluntary blood donation intake',
			})

			assert.strictEqual(log.action, 'UNIT_INTAKE_COLLECTED')
			assert.strictEqual(log.newStatus, 'Quarantined')
		})

		it('should reject invalid audit actions', async () => {
			const log = new BloodUnitAuditLog({
				unitId: new mongoose.Types.ObjectId(),
				unitNumber: 'DIN-2026292-AUDIT-WB',
				bloodbankId: mockBloodbankId,
				action: 'UNAUTHORIZED_ACTION',
				previousStatus: 'None',
				newStatus: 'Quarantined',
				actor: {
					actorId: mockBloodbankId,
					actorModel: 'bloodbank',
				},
			})

			let validationError = null
			try {
				await log.validate()
			} catch (err) {
				validationError = err
			}

			assert.ok(validationError?.errors?.action)
		})

		it('should block update, replacement, and delete operations on audit log records via schema guards', async () => {
			await assert.rejects(
				() => BloodUnitAuditLog.updateOne({}, { reason: 'Tampered' }).exec(),
				/records are append-only and cannot be modified or deleted/
			)

			await assert.rejects(
				() => BloodUnitAuditLog.updateMany({}, { reason: 'Tampered' }).exec(),
				/records are append-only and cannot be modified or deleted/
			)

			await assert.rejects(
				() => BloodUnitAuditLog.findOneAndUpdate({}, { reason: 'Tampered' }).exec(),
				/records are append-only and cannot be modified or deleted/
			)

			await assert.rejects(
				() => BloodUnitAuditLog.replaceOne({}, { reason: 'Tampered' }).exec(),
				/records are append-only and cannot be modified or deleted/
			)

			await assert.rejects(
				() => BloodUnitAuditLog.findOneAndReplace({}, { reason: 'Tampered' }).exec(),
				/records are append-only and cannot be modified or deleted/
			)

			await assert.rejects(
				() => BloodUnitAuditLog.deleteOne({}).exec(),
				/records are append-only and cannot be modified or deleted/
			)

			await assert.rejects(
				() => BloodUnitAuditLog.deleteMany({}).exec(),
				/records are append-only and cannot be modified or deleted/
			)

			await assert.rejects(
				() => BloodUnitAuditLog.findOneAndDelete({}).exec(),
				/records are append-only and cannot be modified or deleted/
			)
		})
	})
})
