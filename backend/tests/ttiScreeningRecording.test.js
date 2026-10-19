const { describe, it } = require('node:test')
const assert = require('node:assert')
const mongoose = require('mongoose')

const bloodUnitController = require('../BloodUnit/bloodUnitController')
const { BloodUnit, MANDATORY_TTI_TESTS } = require('../BloodUnit/bloodUnitModel')
const { BloodUnitAuditLog } = require('../BloodUnit/bloodUnitAuditModel')

// Mock Request & Response Helper
function createMockReqRes({ user, body = {}, query = {}, params = {}, ip = '127.0.0.1' } = {}) {
	const req = {
		user: user || { _id: new mongoose.Types.ObjectId().toString() },
		body,
		query,
		params,
		ip,
	}
	const res = {
		statusCode: 200,
		responseData: null,
		status(code) {
			this.statusCode = code
			return this
		},
		json(data) {
			this.responseData = data
			return this
		},
	}
	const next = (err) => {
		if (err) {
			res.statusCode = err.statusCode || 500
			res.responseData = { message: err.message }
		}
	}
	return { req, res, next }
}

// Mock ClientSession Helper
function createMockSession() {
	const session = {
		id: new mongoose.Types.ObjectId().toString(),
		isCommitted: false,
		isAborted: false,
		isEnded: false,
		async startTransaction() {},
		async commitTransaction() {
			this.isCommitted = true
		},
		async abortTransaction() {
			this.isAborted = true
		},
		async endSession() {
			this.isEnded = true
		},
		async withTransaction(fn) {
			try {
				await fn()
				this.isCommitted = true
			} catch (err) {
				this.isAborted = true
				throw err
			}
		},
	}
	return session
}

describe('Phase 3.3A — TTI Screening Recording Foundation & Validation', () => {
	const mockBloodbankId = new mongoose.Types.ObjectId().toString()
	const otherBloodbankId = new mongoose.Types.ObjectId().toString()
	const mockUnitId = new mongoose.Types.ObjectId().toString()
	const mockDIN = 'DIN-2026292-ABC123-WB'

	const bloodbankUser = {
		_id: mockBloodbankId,
		bloodbankName: 'City Central Blood Bank',
		email: 'contact@citycentral.org',
	}

	const otherBloodbankUser = {
		_id: otherBloodbankId,
		bloodbankName: 'Metro Red Cross',
		email: 'contact@metroredcross.org',
	}

	// -------------------------------------------------------------
	// 1. Successful Authorized Recording
	// -------------------------------------------------------------
	describe('1. Successful Authorized Screening Recording', () => {
		it('should record complete non-reactive panel and transition unit from Quarantined to Tested_Passed', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let savedUnit = null
			let savedAudit = null
			let sessionPassedToUnit = null
			let sessionPassedToAudit = null

			// Unit starts in Quarantined
			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				status: 'Quarantined',
				collectionDate: new Date('2026-10-18T10:00:00Z'),
				expiryDate: new Date('2026-11-22T10:00:00Z'),
				testing: {
					hiv: 'Pending',
					hbv: 'Pending',
					hcv: 'Pending',
					syphilis: 'Pending',
					malaria: 'Pending',
				},
				clearance: { isVerified: false },
			})

			BloodUnit.findOne = async () => mockUnitDoc

			BloodUnit.prototype.save = async function (opts) {
				sessionPassedToUnit = opts?.session
				savedUnit = this
				return this
			}

			BloodUnitAuditLog.prototype.save = async function (opts) {
				sessionPassedToAudit = opts?.session
				savedAudit = this
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: {
						tests: {
							hiv: 'Non_Reactive',
							hbv: 'Non_Reactive',
							hcv: 'Non_Reactive',
							syphilis: 'Non_Reactive',
							malaria: 'Non_Reactive',
						},
						testBatchId: 'BATCH-20261019-ALL-01',
						testedAt: '2026-10-19T08:00:00Z',
						notes: 'Complete mandatory serology panel non-reactive',
					},
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.message, 'Screening results recorded successfully.')

				// Invariant: Unit transitions to Tested_Passed
				assert.strictEqual(savedUnit.status, 'Tested_Passed')
				assert.strictEqual(savedUnit.testing.hiv, 'Non_Reactive')
				assert.strictEqual(savedUnit.testing.hbv, 'Non_Reactive')
				assert.strictEqual(savedUnit.testing.hcv, 'Non_Reactive')
				assert.strictEqual(savedUnit.testing.syphilis, 'Non_Reactive')
				assert.strictEqual(savedUnit.testing.malaria, 'Non_Reactive')
				assert.strictEqual(savedUnit.testing.testBatchId, 'BATCH-20261019-ALL-01')
				assert.strictEqual(savedUnit.testing.testedBy.toString(), mockBloodbankId)
				assert.strictEqual(new Date(savedUnit.testing.testedAt).toISOString(), '2026-10-19T08:00:00.000Z')

				// Clinical safety: clearance.isVerified remains FALSE and unit is NOT Available
				assert.strictEqual(savedUnit.clearance.isVerified, false)
				assert.notStrictEqual(savedUnit.status, 'Available')

				// Audit logging invariant
				assert.ok(savedAudit, 'Audit log created')
				assert.strictEqual(savedAudit.action, 'TTI_TESTING_RECORDED')
				assert.strictEqual(savedAudit.previousStatus, 'Quarantined')
				assert.strictEqual(savedAudit.newStatus, 'Tested_Passed')
				assert.strictEqual(savedAudit.unitNumber, mockDIN)
				assert.strictEqual(savedAudit.metadata.testBatchId, 'BATCH-20261019-ALL-01')
				assert.strictEqual(savedAudit.metadata.isAllNonReactive, true)
				assert.strictEqual(savedAudit.metadata.isAnyReactive, false)
				assert.strictEqual(savedAudit.metadata.previousTesting.hiv, 'Pending')

				// Session integrity
				assert.strictEqual(sessionPassedToUnit, mockSession)
				assert.strictEqual(sessionPassedToAudit, mockSession)
				assert.strictEqual(mockSession.isCommitted, true)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should record partial panel results while keeping unit in Quarantined status', async () => {
			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let savedUnit = null

			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'A_Positive',
				status: 'Quarantined',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: {
					hiv: 'Pending',
					hbv: 'Pending',
					hcv: 'Pending',
					syphilis: 'Pending',
					malaria: 'Pending',
				},
			})

			BloodUnit.findOne = async () => mockUnitDoc
			BloodUnit.prototype.save = async function () {
				savedUnit = this
				return this
			}
			BloodUnitAuditLog.prototype.save = async function () {
				return this
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: {
						hiv: 'Non_Reactive',
						hbv: 'Non_Reactive',
						testBatchId: 'BATCH-PARTIAL-01',
					},
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				// Unit must REMAIN Quarantined because panel is incomplete
				assert.strictEqual(savedUnit.status, 'Quarantined')
				assert.strictEqual(savedUnit.testing.hiv, 'Non_Reactive')
				assert.strictEqual(savedUnit.testing.hbv, 'Non_Reactive')
				assert.strictEqual(savedUnit.testing.hcv, 'Pending')
				assert.strictEqual(savedUnit.testing.syphilis, 'Pending')
				assert.strictEqual(savedUnit.testing.malaria, 'Pending')
			} finally {
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should allow lookups by unit DIN/barcode string as well as ObjectId', async () => {
			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let lookupQuery = null

			BloodUnit.findOne = async (query) => {
				lookupQuery = query
				return new BloodUnit({
					_id: mockUnitId,
					unitNumber: mockDIN,
					bloodbankId: mockBloodbankId,
					bloodGroup: 'B_Positive',
					status: 'Quarantined',
					expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
					testing: { hiv: 'Pending', hbv: 'Pending', hcv: 'Pending', syphilis: 'Pending', malaria: 'Pending' },
				})
			}
			BloodUnit.prototype.save = async function () { return this }
			BloodUnitAuditLog.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockDIN },
					body: { hiv: 'Non_Reactive' },
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(lookupQuery.unitNumber, mockDIN)
				assert.strictEqual(lookupQuery.bloodbankId, mockBloodbankId)
			} finally {
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should allow idempotent resubmission of identical test results', async () => {
			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				status: 'Tested_Passed',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
					testBatchId: 'BATCH-INITIAL',
				},
			})

			BloodUnit.findOne = async () => mockUnitDoc
			BloodUnit.prototype.save = async function () { return this }
			BloodUnitAuditLog.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: {
						hiv: 'Non_Reactive', // Exact same result re-submitted
					},
				})

				await bloodUnitController.recordScreeningResults(req, res, next)
				assert.strictEqual(res.statusCode, 200)
			} finally {
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})
	})

	// -------------------------------------------------------------
	// 2. Overwrite Protection & Reactive Result Enforcement
	// -------------------------------------------------------------
	describe('2. Overwrite Protection & Reactive Result Locks', () => {
		it('should strictly reject attempting to overwrite a previously Reactive test to Non_Reactive', async () => {
			const originalFindOne = BloodUnit.findOne

			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				status: 'Quarantined',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: {
					hiv: 'Reactive', // Confirmed infection marker
					hbv: 'Pending',
					hcv: 'Pending',
					syphilis: 'Pending',
					malaria: 'Pending',
				},
			})

			BloodUnit.findOne = async () => mockUnitDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: {
						hiv: 'Non_Reactive', // Attempting to silently downgrade reactive test
					},
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot overwrite previously Reactive test 'hiv' to 'Non_Reactive'/i)
				assert.match(res.responseData.message, /locked against ordinary downgrade/i)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject attempting to revert an already concluded Non_Reactive test back to Pending', async () => {
			const originalFindOne = BloodUnit.findOne

			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				status: 'Quarantined',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Pending',
					hcv: 'Pending',
					syphilis: 'Pending',
					malaria: 'Pending',
				},
			})

			BloodUnit.findOne = async () => mockUnitDoc

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: {
						hiv: 'Pending', // Attempting to revert concluded result to Pending
					},
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Cannot revert concluded test 'hiv' from 'Non_Reactive' back to 'Pending'/i)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should keep unit strictly in Quarantined hold when a reactive screening test is recorded', async () => {
			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let savedUnit = null

			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				status: 'Quarantined',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: {
					hiv: 'Pending',
					hbv: 'Pending',
					hcv: 'Pending',
					syphilis: 'Pending',
					malaria: 'Pending',
				},
			})

			BloodUnit.findOne = async () => mockUnitDoc
			BloodUnit.prototype.save = async function () {
				savedUnit = this
				return this
			}
			BloodUnitAuditLog.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: {
						hiv: 'Reactive',
						hbv: 'Non_Reactive',
						hcv: 'Non_Reactive',
						syphilis: 'Non_Reactive',
						malaria: 'Non_Reactive',
					},
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				// Invariant: MUST NOT be Tested_Passed or Available
				assert.strictEqual(savedUnit.status, 'Quarantined')
				assert.notStrictEqual(savedUnit.status, 'Tested_Passed')
				assert.notStrictEqual(savedUnit.status, 'Available')
				assert.strictEqual(savedUnit.testing.hiv, 'Reactive')
				assert.strictEqual(savedUnit.clearance.isVerified, false)
			} finally {
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should drop unit back to Quarantined if a previously Tested_Passed unit receives a Reactive test', async () => {
			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let savedUnit = null

			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'AB_Positive',
				status: 'Tested_Passed',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
				},
			})

			BloodUnit.findOne = async () => mockUnitDoc
			BloodUnit.prototype.save = async function () {
				savedUnit = this
				return this
			}
			BloodUnitAuditLog.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: { hcv: 'Reactive' },
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(savedUnit.status, 'Quarantined')
				assert.strictEqual(savedUnit.testing.hcv, 'Reactive')
				assert.strictEqual(savedUnit.clearance.isVerified, false)
			} finally {
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})

		it('should strictly ensure screening recording ALONE NEVER makes a unit Available', async () => {
			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			let savedUnit = null

			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Negative',
				status: 'Quarantined',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: { hiv: 'Pending', hbv: 'Pending', hcv: 'Pending', syphilis: 'Pending', malaria: 'Pending' },
			})

			BloodUnit.findOne = async () => mockUnitDoc
			BloodUnit.prototype.save = async function () {
				savedUnit = this
				return this
			}
			BloodUnitAuditLog.prototype.save = async function () { return this }

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: {
						hiv: 'Non_Reactive',
						hbv: 'Non_Reactive',
						hcv: 'Non_Reactive',
						syphilis: 'Non_Reactive',
						malaria: 'Non_Reactive',
					},
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				// Status is Tested_Passed, NEVER Available
				assert.strictEqual(savedUnit.status, 'Tested_Passed')
				assert.strictEqual(savedUnit.clearance.isVerified, false)
				assert.strictEqual(savedUnit.isIssueEligible(), false)
			} finally {
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})
	})

	// -------------------------------------------------------------
	// 3. Timestamp & Batch Metadata Validation
	// -------------------------------------------------------------
	describe('3. Timestamp & Batch Metadata Validation', () => {
		it('should reject testedAt timestamp that is in the future', async () => {
			const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()

			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: mockUnitId },
				body: {
					hiv: 'Non_Reactive',
					testedAt: futureDate,
				},
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Test timestamp cannot be in the future/i)
		})

		it('should reject testedAt timestamp that precedes unit collection date', async () => {
			const originalFindOne = BloodUnit.findOne

			// Unit collected today at 12:00
			const collectionDate = new Date('2026-10-19T12:00:00Z')
			// Test attempted yesterday
			const beforeCollection = new Date('2026-10-18T10:00:00Z').toISOString()

			BloodUnit.findOne = async () => new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'A_Positive',
				status: 'Quarantined',
				collectionDate,
				expiryDate: new Date('2026-11-23T12:00:00Z'),
				testing: { hiv: 'Pending' },
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: {
						hiv: 'Non_Reactive',
						testedAt: beforeCollection,
					},
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Test timestamp cannot precede unit collection date/i)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject invalid testedAt date string format', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: mockUnitId },
				body: {
					hiv: 'Non_Reactive',
					testedAt: 'not-a-valid-date',
				},
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Invalid testedAt timestamp format/i)
		})

		it('should reject empty or whitespace-only testBatchId', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: mockUnitId },
				body: {
					hiv: 'Non_Reactive',
					testBatchId: '   ',
				},
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /testBatchId must be a non-empty string/i)
		})

		it('should reject testBatchId exceeding 100 characters', async () => {
			const longBatch = 'B'.repeat(101)

			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: mockUnitId },
				body: {
					hiv: 'Non_Reactive',
					testBatchId: longBatch,
				},
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /exceeds maximum permitted length/i)
		})
	})

	// -------------------------------------------------------------
	// 4. Authorization & Ownership (BOLA) Guards
	// -------------------------------------------------------------
	describe('4. Authorization & Ownership (BOLA) Enforcement', () => {
		it('should forbid blood bank B from recording screening results on blood bank A\'s unit (returns 404)', async () => {
			const originalFindOne = BloodUnit.findOne

			BloodUnit.findOne = async (query) => {
				assert.strictEqual(query.bloodbankId, otherBloodbankId)
				return null
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: otherBloodbankUser,
					params: { id: mockUnitId },
					body: { hiv: 'Non_Reactive' },
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 404)
				assert.match(res.responseData.message, /not found or not owned/i)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should reject requests with missing unit identifier', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: '' },
				body: { hiv: 'Non_Reactive' },
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /identifier .* is required/i)
		})
	})

	// -------------------------------------------------------------
	// 5. Input Validation & Schema Enforcement
	// -------------------------------------------------------------
	describe('5. Input Validation & Schema Enforcement', () => {
		it('should reject invalid test result values (e.g. Positive instead of Reactive)', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: mockUnitId },
				body: { hiv: 'Positive' },
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Invalid test result for 'hiv'/i)
			assert.match(res.responseData.message, /Non_Reactive, Reactive/i)
		})

		it('should reject requests with no valid test fields provided', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: mockUnitId },
				body: { notes: 'Only a note without any test result' },
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /At least one valid TTI test result must be provided/i)
		})

		it('should reject unrecognized or illegal top-level fields (injection prevention)', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: mockUnitId },
				body: { hiv: 'Non_Reactive', status: 'Available' },
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unrecognized or forbidden field: 'status'/i)
		})

		it('should reject illegal fields nested inside the tests object', async () => {
			const { req, res, next } = createMockReqRes({
				user: bloodbankUser,
				params: { id: mockUnitId },
				body: {
					tests: {
						hiv: 'Non_Reactive',
						clearance: true, // Attempted clearance injection
					},
				},
			})

			await bloodUnitController.recordScreeningResults(req, res, next)

			assert.strictEqual(res.statusCode, 400)
			assert.match(res.responseData.message, /Unrecognized test name in 'tests': 'clearance'/i)
		})
	})

	// -------------------------------------------------------------
	// 6. Invalid Lifecycle State Guards
	// -------------------------------------------------------------
	describe('6. Invalid Lifecycle State Guards', () => {
		it('should forbid recording screening results on an already Available unit', async () => {
			const originalFindOne = BloodUnit.findOne

			BloodUnit.findOne = async () => ({
				_id: mockUnitId,
				status: 'Available',
				bloodbankId: mockBloodbankId,
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: { hiv: 'Non_Reactive' },
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /Unit is already verified and Available/)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should forbid recording screening results on an Issued unit', async () => {
			const originalFindOne = BloodUnit.findOne

			BloodUnit.findOne = async () => ({
				_id: mockUnitId,
				status: 'Issued',
				bloodbankId: mockBloodbankId,
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: { hiv: 'Non_Reactive' },
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /already issued/)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should forbid recording screening results on a Discarded unit', async () => {
			const originalFindOne = BloodUnit.findOne

			BloodUnit.findOne = async () => ({
				_id: mockUnitId,
				status: 'Discarded',
				bloodbankId: mockBloodbankId,
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: { hiv: 'Non_Reactive' },
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /discarded unit/)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})

		it('should forbid recording screening results on an Expired unit', async () => {
			const originalFindOne = BloodUnit.findOne

			BloodUnit.findOne = async () => ({
				_id: mockUnitId,
				status: 'Expired',
				bloodbankId: mockBloodbankId,
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: { hiv: 'Non_Reactive' },
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 400)
				assert.match(res.responseData.message, /expired blood unit/)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})
	})

	// -------------------------------------------------------------
	// 7. Transaction Rollback & Audit Failure Handling
	// -------------------------------------------------------------
	describe('7. Transaction Rollback & Failure Recovery', () => {
		it('should abort transaction and not commit screening changes when audit log fails', async () => {
			const mockSession = createMockSession()
			const originalStartSession = mongoose.startSession
			mongoose.startSession = async () => mockSession
			mongoose.startSession._isMock = true

			const originalFindOne = BloodUnit.findOne
			const originalUnitSave = BloodUnit.prototype.save
			const originalAuditSave = BloodUnitAuditLog.prototype.save

			const mockUnitDoc = new BloodUnit({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodbankId: mockBloodbankId,
				bloodGroup: 'O_Positive',
				status: 'Quarantined',
				expiryDate: new Date(Date.now() + 35 * 24 * 60 * 60 * 1000),
				testing: { hiv: 'Pending', hbv: 'Pending', hcv: 'Pending', syphilis: 'Pending', malaria: 'Pending' },
			})

			BloodUnit.findOne = async () => mockUnitDoc
			BloodUnit.prototype.save = async function () { return this }

			// Audit save fails
			BloodUnitAuditLog.prototype.save = async function () {
				throw new Error('Audit ledger persistence failure')
			}

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
					body: { hiv: 'Non_Reactive' },
				})

				await bloodUnitController.recordScreeningResults(req, res, next)

				assert.strictEqual(res.statusCode, 500)
				assert.strictEqual(mockSession.isAborted, true)
				assert.strictEqual(mockSession.isCommitted, false)
				assert.strictEqual(mockSession.isEnded, true)
			} finally {
				mongoose.startSession = originalStartSession
				BloodUnit.findOne = originalFindOne
				BloodUnit.prototype.save = originalUnitSave
				BloodUnitAuditLog.prototype.save = originalAuditSave
			}
		})
	})

	// -------------------------------------------------------------
	// 8. Privacy & Unit Inspection Endpoint
	// -------------------------------------------------------------
	describe('8. Privacy & Unit Inspection', () => {
		it('should return unit testing details without exposing donor PII on GET /api/bloodunit/:id', async () => {
			const originalFindOne = BloodUnit.findOne

			BloodUnit.findOne = async () => ({
				_id: mockUnitId,
				unitNumber: mockDIN,
				bloodGroup: 'A_Positive',
				componentType: 'Whole_Blood',
				volumeMl: 450,
				collectionDate: new Date('2026-10-19'),
				expiryDate: new Date('2026-11-23'),
				status: 'Tested_Passed',
				testing: {
					hiv: 'Non_Reactive',
					hbv: 'Non_Reactive',
					hcv: 'Non_Reactive',
					syphilis: 'Non_Reactive',
					malaria: 'Non_Reactive',
					testBatchId: 'BATCH-01',
					testedAt: new Date('2026-10-19T10:00:00Z'),
				},
				clearance: { isVerified: false },
				isLegacyMigrated: false,
			})

			try {
				const { req, res, next } = createMockReqRes({
					user: bloodbankUser,
					params: { id: mockUnitId },
				})

				await bloodUnitController.getBloodUnitById(req, res, next)

				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.responseData.unitNumber, mockDIN)
				assert.strictEqual(res.responseData.status, 'Tested_Passed')
				// Verify donor personal details are NOT returned
				assert.strictEqual(res.responseData.donorUserId, undefined)
				assert.strictEqual(res.responseData.firstName, undefined)
				assert.strictEqual(res.responseData.phoneNo1, undefined)
			} finally {
				BloodUnit.findOne = originalFindOne
			}
		})
	})
})
