const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const Bloodstock = require('../BloodStock/bloodStockModel')
const {
	BloodUnit,
	VALID_BLOOD_GROUPS,
	VALID_COMPONENT_TYPES,
	MANDATORY_TTI_TESTS,
} = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')
const { InventoryReconciliationRecord } = require('../BloodStock/reconciliationModel')
const stockService = require('../BloodStock/stockService')
const reconciliationService = require('../BloodStock/reconciliationService')
const bloodStockController = require('../BloodStock/bloodStockController')

describe('Phase 3.7 — Legacy Blood Inventory Reconciliation & Migration Safeguards', () => {
	const bankAId = new mongoose.Types.ObjectId()
	const bankBId = new mongoose.Types.ObjectId()
	const staffAdminId = new mongoose.Types.ObjectId()
	const medicalOfficerId = new mongoose.Types.ObjectId()

	// -------------------------------------------------------------
	// 1. Dry-Run Performs Zero Writes
	// -------------------------------------------------------------
	describe('1. Dry-Run Invariant (Zero Mutations)', () => {
		it('generateReconciliationReport should perform zero writes to Bloodstock and BloodUnit', async () => {
			const originalSaveBloodUnit = BloodUnit.prototype.save
			const originalSaveBloodStock = Bloodstock.prototype.save
			const originalUpdateOne = BloodUnit.updateOne
			const originalUpdateMany = BloodUnit.updateMany

			let writeAttempted = false
			BloodUnit.prototype.save = async function () {
				writeAttempted = true
				throw new Error('Mutation forbidden in dry-run')
			}
			Bloodstock.prototype.save = async function () {
				writeAttempted = true
				throw new Error('Mutation forbidden in dry-run')
			}

			try {
				// Mock legacy stock and traceable units
				const origFindOne = Bloodstock.findOne
				const origFind = BloodUnit.find
				const origAgg = BloodUnit.aggregate

				Bloodstock.findOne = async () => ({
					_id: new mongoose.Types.ObjectId(),
					bloodbankId: bankAId,
					A_Positive: 10,
					O_Negative: 5,
				})

				BloodUnit.find = () => ({
					session() { return this },
					select() { return this },
					lean: async () => [
						{
							_id: new mongoose.Types.ObjectId(),
							unitNumber: 'W00012600001',
							bloodbankId: bankAId,
							bloodGroup: 'A_Positive',
							componentType: 'Whole_Blood',
							status: 'Available',
							expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
							clearance: { isVerified: true },
							testing: {
								hiv: 'Non_Reactive',
								hbv: 'Non_Reactive',
								hcv: 'Non_Reactive',
								syphilis: 'Non_Reactive',
								malaria: 'Non_Reactive',
							},
						},
					],
				})


				BloodUnit.aggregate = () => ({
					session() { return this },
					then(resolve) { return Promise.resolve([]).then(resolve) },
				})

				const report = await reconciliationService.generateReconciliationReport({
					bloodbankId: bankAId,
					recordAudit: false,
				})

				assert.strictEqual(writeAttempted, false, 'No writes should be attempted during reconciliation audit')
				assert.strictEqual(report.bloodbankId, bankAId)
				assert.strictEqual(report.runType, 'AUDIT_REPORT')
				assert.strictEqual(report.summary.legacyTotal, 15)
				assert.strictEqual(report.summary.traceableTotal, 1)
				assert.strictEqual(report.summary.traceableVerifiedTotal, 1)

				Bloodstock.findOne = origFindOne
				BloodUnit.find = origFind
				BloodUnit.aggregate = origAgg
			} finally {
				BloodUnit.prototype.save = originalSaveBloodUnit
				Bloodstock.prototype.save = originalSaveBloodStock
				BloodUnit.updateOne = originalUpdateOne
				BloodUnit.updateMany = originalUpdateMany
			}
		})

		it('executeInventoryMigration in DRY_RUN mode should simulate outcome and perform zero database writes', async () => {
			let writeAttempted = false
			const origSave = BloodUnit.prototype.save
			const origFindOneAndUpdate = Bloodstock.findOneAndUpdate
			BloodUnit.prototype.save = async function () {
				writeAttempted = true
				throw new Error('Write forbidden in dry run')
			}
			Bloodstock.findOneAndUpdate = async function () {
				writeAttempted = true
				throw new Error('Write forbidden in dry run')
			}

			const origFindStock = Bloodstock.findOne
			const origFindUnit = BloodUnit.find

			Bloodstock.findOne = async () => ({
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: bankAId,
				O_Positive: 5,
			})
			BloodUnit.find = () => ({
				lean: async () => [],
			})

			try {
				const manifest = [
					{
						unitNumber: 'W00012699901',
						bloodGroup: 'O_Positive',
						componentType: 'Whole_Blood',
						volumeMl: 350,
						expiryDate: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
						deductFromLegacy: true,
					},
				]

				const dryRunResult = await reconciliationService.executeInventoryMigration({
					bloodbankId: bankAId,
					mode: 'DRY_RUN',
					migrationManifest: manifest,
				})

				assert.strictEqual(writeAttempted, false, 'DRY_RUN must perform zero writes to BloodUnit or Bloodstock')
				assert.strictEqual(dryRunResult.mode, 'DRY_RUN')
				assert.strictEqual(dryRunResult.status, 'COMPLETED')
				assert.strictEqual(dryRunResult.isExecutable, true)
				assert.strictEqual(dryRunResult.summary.validToMigrate, 1)
				assert.strictEqual(dryRunResult.legacyStockBefore.O_Positive, 5)
				assert.strictEqual(dryRunResult.simulatedLegacyStockAfter.O_Positive, 4)
			} finally {
				BloodUnit.prototype.save = origSave
				Bloodstock.findOneAndUpdate = origFindOneAndUpdate
				Bloodstock.findOne = origFindStock
				BloodUnit.find = origFindUnit
			}
		})
	})

	// -------------------------------------------------------------
	// 2. Tenant Isolation & BOLA Enforcement
	// -------------------------------------------------------------
	describe('2. Multi-Tenant Scoping & BOLA Enforcement', () => {
		it('should reject reconciliation if bloodbankId is invalid or missing', async () => {
			await assert.rejects(
				async () => {
					await reconciliationService.generateReconciliationReport({
						bloodbankId: 'invalid-id',
					})
				},
				/Valid bloodbankId is required/
			)
		})

		it('should detect cross-tenant DIN collisions and mark units non-reconcilable', async () => {
			const origFindStock = Bloodstock.findOne
			const origFindUnit = BloodUnit.find
			const origAgg = BloodUnit.aggregate

			Bloodstock.findOne = async () => ({
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: bankAId,
			})

			// Bank A has unit with DIN W00012677777
			BloodUnit.find = (query) => {
				if (query.bloodbankId && String(query.bloodbankId) === String(bankAId)) {
					return {
						session() { return this },
						lean: async () => [
							{
								_id: new mongoose.Types.ObjectId(),
								unitNumber: 'W00012677777',
								bloodbankId: bankAId,
								bloodGroup: 'B_Positive',
								componentType: 'Whole_Blood',
								status: 'Quarantined',
								expiryDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
							},
						],
					}
				}
				// Cross query finds that another bank also owns DIN W00012677777
				if (query.unitNumber && query.bloodbankId?.$ne) {
					return {
						session() { return this },
						select: () => ({
							session() { return this },
							lean: async () => [
								{ unitNumber: 'W00012677777', bloodbankId: bankBId },
							],
						}),
					}
				}
				return { session() { return this }, lean: async () => [] }
			}

			BloodUnit.aggregate = () => ({
				session() { return this },
				then(resolve) { return Promise.resolve([]).then(resolve) },
			})

			try {
				const report = await reconciliationService.generateReconciliationReport({
					bloodbankId: bankAId,
				})

				assert.strictEqual(report.status, 'CONFLICT_DETECTED')
				assert.strictEqual(report.isClean, false)
				const collision = report.discrepancies.find((d) => d.type === 'CROSS_TENANT_DUPLICATE_DIN')
				assert.ok(collision, 'Cross-tenant DIN collision must be reported')
				assert.strictEqual(collision.unitNumber, 'W00012677777')
			} finally {
				Bloodstock.findOne = origFindStock
				BloodUnit.find = origFindUnit
				BloodUnit.aggregate = origAgg
			}
		})
	})

	// -------------------------------------------------------------
	// 3. Duplicate and Missing Identifiers
	// -------------------------------------------------------------
	describe('3. Duplicate & Missing Identifier Detection', () => {
		it('should reject manifest containing duplicate DINs within the manifest itself', async () => {
			const manifest = [
				{
					unitNumber: 'W00012611111',
					bloodGroup: 'O_Positive',
					expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
				},
				{
					unitNumber: 'W00012611111', // Duplicate DIN
					bloodGroup: 'O_Positive',
					expiryDate: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
				},
			]

			const origFindStock = Bloodstock.findOne
			const origFindUnit = BloodUnit.find
			Bloodstock.findOne = async () => ({ bloodbankId: bankAId, O_Positive: 10 })
			BloodUnit.find = () => ({ lean: async () => [] })

			try {
				const res = await reconciliationService.executeInventoryMigration({
					bloodbankId: bankAId,
					mode: 'DRY_RUN',
					migrationManifest: manifest,
				})

				assert.strictEqual(res.isExecutable, false)
				assert.strictEqual(res.status, 'CONFLICT_DETECTED')
				const duplicateError = res.validationErrors.find((e) => e.includes('Duplicate DIN'))
				assert.ok(duplicateError, 'Duplicate DIN in manifest must be caught')
			} finally {
				Bloodstock.findOne = origFindStock
				BloodUnit.find = origFindUnit
			}
		})

		it('should reject manifest item missing a DIN or with invalid blood group', () => {
			const invalidItem1 = {
				unitNumber: '',
				bloodGroup: 'O_Positive',
				expiryDate: new Date(Date.now() + 100000),
			}
			const res1 = reconciliationService.validateManifestItem(invalidItem1, 0)
			assert.strictEqual(res1.isValid, false)
			assert.match(res1.errors[0], /DIN \/ Barcode/i)


			const invalidItem2 = {
				unitNumber: 'W00012622222',
				bloodGroup: 'INVALID_GROUP',
				expiryDate: new Date(Date.now() + 100000),
			}
			const res2 = reconciliationService.validateManifestItem(invalidItem2, 1)
			assert.strictEqual(res2.isValid, false)
			assert.match(res2.errors[0], /Invalid blood group/)
		})

		it('should reject manifest items that are clinically expired', () => {
			const expiredItem = {
				unitNumber: 'W00012633333',
				bloodGroup: 'AB_Positive',
				expiryDate: new Date(Date.now() - 24 * 60 * 60 * 1000), // In the past!
			}
			const res = reconciliationService.validateManifestItem(expiredItem, 0)
			assert.strictEqual(res.isValid, false)
			assert.match(res.errors[0], /Clinical safety violation: Expiry date .* must be in the future/)
		})
	})

	// -------------------------------------------------------------
	// 4. Clinical Safety Gate: Unverified Inventory Never Becomes Issuable
	// -------------------------------------------------------------
	describe('4. Clinical Safety Gate (Never Auto-Available)', () => {
		it('migrated units must strictly be created in Quarantined status and cannot be issue-eligible', async () => {
			const origSave = BloodUnit.prototype.save
			const origFindOneAndUpdate = Bloodstock.findOneAndUpdate
			const origFindStock = Bloodstock.findOne
			const origFindUnit = BloodUnit.find
			const origRecordAudit = BloodUnitAuditLog.prototype.save
			const origReconciliationSave = InventoryReconciliationRecord.prototype.save

			let createdUnit = null
			BloodUnit.prototype.save = async function () {
				createdUnit = this
				return this
			}
			Bloodstock.findOne = async () => ({
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: bankAId,
				A_Positive: 5,
			})
			Bloodstock.findOneAndUpdate = async () => ({
				A_Positive: 4,
			})
			BloodUnit.find = () => ({
				lean: async () => [],
			})
			BloodUnitAuditLog.prototype.save = async function () {
				return this
			}
			InventoryReconciliationRecord.prototype.save = async function () {
				return this
			}

			const mockSession = {
				async startTransaction() {},
				async commitTransaction() {},
				async abortTransaction() {},
				async endSession() {},
			}

			try {
				const manifest = [
					{
						unitNumber: 'W00012644444',
						bloodGroup: 'A_Positive',
						componentType: 'Whole_Blood',
						volumeMl: 450,
						expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
						deductFromLegacy: true,
					},
				]

				const result = await reconciliationService.executeInventoryMigration({
					bloodbankId: bankAId,
					mode: 'EXECUTE',
					migrationManifest: manifest,
					actorId: staffAdminId,
					session: mockSession,
				})

				assert.strictEqual(result.status, 'COMPLETED')
				assert.strictEqual(result.migratedCount, 1)
				assert.ok(createdUnit, 'Unit must have been instantiated')
				assert.strictEqual(createdUnit.status, 'Quarantined', 'Migrated unit MUST strictly be Quarantined')
				assert.strictEqual(createdUnit.isLegacyMigrated, true, 'isLegacyMigrated flag must be true')
				assert.strictEqual(createdUnit.clearance.isVerified, false, 'Clearance must NOT be verified')
				assert.strictEqual(createdUnit.testing.hiv, 'Pending', 'TTI panel must be Pending')
				assert.strictEqual(createdUnit.isIssueEligible(), false, 'Migrated unit must NEVER be issue-eligible')
			} finally {
				BloodUnit.prototype.save = origSave
				Bloodstock.findOneAndUpdate = origFindOneAndUpdate
				Bloodstock.findOne = origFindStock
				BloodUnit.find = origFindUnit
				BloodUnitAuditLog.prototype.save = origRecordAudit
				InventoryReconciliationRecord.prototype.save = origReconciliationSave
			}
		})
	})

	// -------------------------------------------------------------
	// 5. Idempotent Retries & Resumability
	// -------------------------------------------------------------
	describe('5. Idempotency & Resumable Migration', () => {
		it('re-running migration with already migrated units should skip deduction and not duplicate records', async () => {
			const existingMigratedUnit = {
				_id: new mongoose.Types.ObjectId(),
				unitNumber: 'W00012655555',
				bloodbankId: bankAId,
				bloodGroup: 'O_Positive',
				isLegacyMigrated: true,
				status: 'Quarantined',
			}

			const origFindStock = Bloodstock.findOne
			const origFindUnit = BloodUnit.find
			const origFindOneAndUpdate = Bloodstock.findOneAndUpdate
			const origReconSave = InventoryReconciliationRecord.prototype.save
			let stockDecremented = false

			InventoryReconciliationRecord.prototype.save = async function () {
				return this
			}
			Bloodstock.findOne = async () => ({
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: bankAId,
				O_Positive: 5,
			})
			Bloodstock.findOneAndUpdate = async () => {
				stockDecremented = true
				return {}
			}
			BloodUnit.find = () => ({
				lean: async () => [existingMigratedUnit],
			})

			const mockSession = {
				async startTransaction() {},
				async commitTransaction() {},
				async abortTransaction() {},
				async endSession() {},
			}

			try {
				const manifest = [

					{
						unitNumber: 'W00012655555', // Already migrated
						bloodGroup: 'O_Positive',
						expiryDate: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
						deductFromLegacy: true,
					},
				]

				const res = await reconciliationService.executeInventoryMigration({
					bloodbankId: bankAId,
					mode: 'EXECUTE',
					migrationManifest: manifest,
					actorId: staffAdminId,
					session: mockSession,
				})

				assert.strictEqual(res.status, 'COMPLETED')
				assert.strictEqual(res.migratedCount, 0, 'No new units should be migrated')
				assert.strictEqual(res.alreadyMigratedCount, 1, 'Unit must be recognized as ALREADY_MIGRATED')
				assert.strictEqual(stockDecremented, false, 'Legacy stock must NOT be decremented again')
				assert.strictEqual(res.manifestResults[0].status, 'ALREADY_MIGRATED')
			} finally {
				Bloodstock.findOne = origFindStock
				BloodUnit.find = origFindUnit
				Bloodstock.findOneAndUpdate = origFindOneAndUpdate
				InventoryReconciliationRecord.prototype.save = origReconSave
			}

		})
	})

	// -------------------------------------------------------------
	// 6. Safe Failure & Rollback on Stock Deficits
	// -------------------------------------------------------------
	describe('6. Conflict Detection & Safe Failure', () => {
		it('should abort migration and throw error if legacy stock is insufficient for requested deduction', async () => {
			const origFindStock = Bloodstock.findOne
			const origFindUnit = BloodUnit.find

			// Bank has only 1 unit of B_Negative in legacy stock
			Bloodstock.findOne = async () => ({
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: bankAId,
				B_Negative: 1,
			})
			BloodUnit.find = () => ({ lean: async () => [] })

			try {
				const manifest = [
					{
						unitNumber: 'W00012666661',
						bloodGroup: 'B_Negative',
						expiryDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
						deductFromLegacy: true,
					},
					{
						unitNumber: 'W00012666662',
						bloodGroup: 'B_Negative',
						expiryDate: new Date(Date.now() + 15 * 24 * 60 * 60 * 1000),
						deductFromLegacy: true, // Needs 2 total, only 1 available!
					},
				]

				await assert.rejects(
					async () => {
						await reconciliationService.executeInventoryMigration({
							bloodbankId: bankAId,
							mode: 'EXECUTE',
							migrationManifest: manifest,
							actorId: staffAdminId,
						})
					},
					/Insufficient legacy stock for blood group B_Negative/
				)
			} finally {
				Bloodstock.findOne = origFindStock
				BloodUnit.find = origFindUnit
			}
		})
	})

	// -------------------------------------------------------------
	// 7. No Double-Counting Across Legacy & Traceable Inventory
	// -------------------------------------------------------------
	describe('7. Double-Counting Prevention', () => {
		it('stockService.getConsolidatedStock should isolate legacy stock and never sum it with traceable units', async () => {
			const origFindStock = Bloodstock.findOne
			const origAggregate = BloodUnit.aggregate

			// Legacy stock: 10 units of O_Positive
			Bloodstock.findOne = async () => ({
				_id: new mongoose.Types.ObjectId(),
				bloodbankId: bankAId,
				O_Positive: 10,
				A_Positive: 0,
				B_Positive: 0,
				AB_Positive: 0,
				O_Negative: 0,
				A_Negative: 0,
				B_Negative: 0,
				AB_Negative: 0,
			})

			// Traceable units: 2 verified Available O_Positive units, 3 Quarantined
			BloodUnit.aggregate = (pipeline) => {
				const match = pipeline[0]?.$match
				// Breakdown query
				if (match && !match.status) {
					return Promise.resolve([
						{ _id: 'Available', count: 2 },
						{ _id: 'Quarantined', count: 3 },
					])
				}
				// Available stock query
				if (match && match.status === 'Available') {
					return Promise.resolve([
						{ _id: 'O_Positive', count: 2 },
					])
				}
				return Promise.resolve([])
			}

			try {
				const consolidated = await stockService.getConsolidatedStock(bankAId)

				// In HYBRID_TRANSITIONAL, top-level O_Positive MUST reflect issue-eligible units (2), NOT 2 + 10 = 12!
				assert.strictEqual(consolidated.inventoryClassification, 'HYBRID_TRANSITIONAL')
				assert.strictEqual(consolidated.O_Positive, 2, 'Top-level count must be verified units only (2), not summed (12)')
				assert.strictEqual(consolidated.traceableVerifiedStock.O_Positive, 2)
				assert.strictEqual(consolidated.legacyUnverifiedStock.O_Positive, 10, 'Legacy counts must remain isolated')
				assert.strictEqual(consolidated.traceableStatusBreakdown.Quarantined, 3)
				assert.ok(consolidated.legacyNotice.includes('isolated in legacyUnverifiedStock'))
			} finally {
				Bloodstock.findOne = origFindStock
				BloodUnit.aggregate = origAggregate
			}
		})
	})

	// -------------------------------------------------------------
	// 8. Legacy Workflow Compatibility & Deprecation Headers
	// -------------------------------------------------------------
	describe('8. Legacy Workflow Compatibility & Deprecation Warning', () => {
		it('bloodStockController.updatStock should set X-API-Deprecation-Warning header', async () => {
			let headerSet = null
			let saved = false

			const mockRes = {
				status(code) {
					this.statusCode = code
					return this
				},
				json(data) {
					this.data = data
					return this
				},
				setHeader(name, val) {
					if (name === 'X-API-Deprecation-Warning') {
						headerSet = val
					}
				},
			}

			const mockReq = {
				user: { _id: bankAId },
				body: { A_Positive: 2 },
			}

			const origFind = Bloodstock.findOne
			Bloodstock.findOne = async () => ({
				bloodbankId: bankAId,
				A_Positive: 5,
				save: async () => {
					saved = true
				},
			})

			try {
				await bloodStockController.updatStock(mockReq, mockRes)

				assert.ok(headerSet, 'Deprecation warning header must be set')
				assert.match(headerSet, /deprecated/i)
				assert.strictEqual(saved, true, 'Legacy save must succeed for backward compatibility')
				assert.strictEqual(mockRes.statusCode, 200)
			} finally {
				Bloodstock.findOne = origFind
			}
		})
	})
})
