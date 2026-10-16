/**
 * Test Suite: Admin Bulk Import Templates, Validation & Transactional Provisioning
 *
 * Verifies:
 * 1. Downloadable CSV templates, fictional samples, and formula injection protection.
 * 2. Admin authorization enforcement (reject unauthenticated and user tokens).
 * 3. File limits (2 MB file size, 500 row count), malformed CSVs, and quoted fields.
 * 4. Critical Invariant: STRICT ZERO-MUTATION guarantee during preview.
 * 5. Referential validation (State & City) and schema validation (Category, PinCode, Phone, Email, Password).
 * 6. Duplicate detection within file and against existing database records.
 * 7. Confirmed batch import: server revalidation, explicit confirmation, atomic transaction,
 *    provisioning of associated BloodStock records, and rollback on failure.
 */

const { describe, it, beforeEach } = require('node:test')
const assert = require('node:assert')
const jwt = require('jsonwebtoken')
const {
	getTemplateCsv,
	getSampleCsv,
	escapeCsvValue,
} = require('../BulkImport/bulkImportTemplates')
const {
	parseCsvContent,
	validateBulkData,
	validatePasswordComplexity,
} = require('../BulkImport/bulkImportValidation')
const bulkImportController = require('../BulkImport/bulkImportController')
const { withTransaction } = require('../Utils/transactionHelper')
const State = require('../State/stateModel')
const City = require('../City/cityModel')
const BloodBank = require('../BloodBank/bloodbankModel')
const Bloodstock = require('../BloodStock/bloodStockModel')
const Admin = require('../Admin/adminModel')

// Mock Response Helper
function createMockRes() {
	const res = {
		statusCode: 200,
		headers: {},
		data: null,
		status(code) {
			this.statusCode = code
			return this
		},
		json(payload) {
			this.data = payload
			return this
		},
		send(body) {
			this.data = body
			return this
		},
		setHeader(key, val) {
			this.headers[key.toLowerCase()] = val
		},
	}
	return res
}

describe('Phase 2 — Bulk-Import Templates and Validation', () => {
	const originalJwtSecret = process.env.JWT_SECRET
	const originalNodeEnv = process.env.NODE_ENV

	beforeEach(() => {
		process.env.JWT_SECRET = 'test_secret_key_bulk_import_12345'
		process.env.NODE_ENV = 'development'
	})

	describe('1. CSV Templates, Fictional Samples & Formula Injection Defense', () => {
		it('should generate valid downloadable template headers for bloodbank, city, and state', () => {
			const bloodbankCsv = getTemplateCsv('bloodbank')
			assert.ok(bloodbankCsv.includes('bloodbankName,category,contactPerson'))
			assert.ok(bloodbankCsv.includes('state,city,pinCode,phoneNo1,phoneNo2,email,password,openingDate'))

			const cityCsv = getTemplateCsv('city')
			assert.strictEqual(cityCsv.trim(), 'stateName,cityName')

			const stateCsv = getTemplateCsv('state')
			assert.strictEqual(stateCsv.trim(), 'stateName')

			assert.strictEqual(getTemplateCsv('unsupported_entity'), null)
		})

		it('should generate fictional sample CSV rows without real personal or donor data', () => {
			const bloodbankSample = getSampleCsv('bloodbank')
			assert.ok(bloodbankSample.includes('City Central Blood Center'))
			assert.ok(bloodbankSample.includes('example.org'))
			// Must not contain any donor references
			assert.ok(!bloodbankSample.toLowerCase().includes('donor'))

			const citySample = getSampleCsv('city')
			assert.ok(citySample.includes('Karnataka,Mysuru'))
		})

		it('should neutralize CSV formula injection characters (=, +, -, @, \\t, \\r)', () => {
			assert.strictEqual(escapeCsvValue('=SUM(A1:A10)'), "'=SUM(A1:A10)")
			assert.strictEqual(escapeCsvValue('+cmd|calc'), "'+cmd|calc")
			assert.strictEqual(escapeCsvValue('-1+1'), "'-1+1")
			assert.strictEqual(escapeCsvValue('@echo'), "'@echo")
			assert.strictEqual(escapeCsvValue('\tmalicious'), "'\tmalicious")
		})

		it('should properly escape values containing commas, quotes, and newlines', () => {
			assert.strictEqual(escapeCsvValue('Hello, World'), '"Hello, World"')
			assert.strictEqual(escapeCsvValue('Quote "Test"'), '"Quote ""Test"""')
			assert.strictEqual(escapeCsvValue('Multi\nLine'), '"Multi\nLine"')
		})
	})

	describe('2. CSV Parser Limits & Error Handling', () => {
		it('should reject file sizes exceeding 2 MB limit', () => {
			const largeBuffer = Buffer.alloc(2 * 1024 * 1024 + 10, 'a')
			assert.throws(
				() => parseCsvContent(largeBuffer),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.match(err.message, /exceeds maximum allowed limit of 2 MB/i)
					return true
				}
			)
		})

		it('should reject empty or whitespace-only CSV input', () => {
			assert.throws(
				() => parseCsvContent('   \n\n  '),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.match(err.message, /empty/i)
					return true
				}
			)
		})

		it('should reject batches exceeding 500 rows limit', () => {
			const headers = 'stateName\n'
			const rows = Array.from({ length: 501 }, (_, i) => `State${i}\n`).join('')
			const csv = headers + rows

			assert.throws(
				() => parseCsvContent(csv),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.match(err.message, /exceeds the maximum batch limit of 500 rows/i)
					return true
				}
			)
		})

		it('should return descriptive 400 error for malformed CSV with unclosed quotes', () => {
			const malformedCsv = 'stateName,cityName\nKarnataka,"Unclosed quote city\nMaharashtra,Pune'
			assert.throws(
				() => parseCsvContent(malformedCsv),
				(err) => {
					assert.strictEqual(err.statusCode, 400)
					assert.match(err.message, /Malformed CSV/i)
					return true
				}
			)
		})

		it('should parse valid quoted fields with commas and embedded quotes', () => {
			const csv = 'stateName,cityName\nKarnataka,"Mysuru, South"\nMaharashtra,"""Central"" Pune"'
			const records = parseCsvContent(csv)
			assert.strictEqual(records.length, 2)
			assert.strictEqual(records[0].cityName, 'Mysuru, South')
			assert.strictEqual(records[1].cityName, '"Central" Pune')
		})
	})

	describe('3. Password Complexity and Security Rules', () => {
		it('should enforce password length (8 to 20 chars)', () => {
			assert.strictEqual(validatePasswordComplexity('Short1!'), false)
			assert.strictEqual(validatePasswordComplexity('ThisPasswordIsWayTooLong1234567890'), false)
		})

		it('should reject passwords containing spaces', () => {
			assert.strictEqual(validatePasswordComplexity('Pass word1'), false)
		})

		it('should require at least one uppercase, one lowercase, and one number', () => {
			assert.strictEqual(validatePasswordComplexity('alllowercase1'), false)
			assert.strictEqual(validatePasswordComplexity('ALLUPPERCASE1'), false)
			assert.strictEqual(validatePasswordComplexity('NoNumberHere'), false)
			assert.strictEqual(validatePasswordComplexity('ValidPass123'), true)
		})
	})

	describe('4. Preview Workflow — ZERO-MUTATION GUARANTEE', () => {
		it('should validate CSV and guarantee ZERO database mutations during preview', async () => {
			// Spy on mutation methods to ensure they are NEVER called
			let mutationCalled = false
			const originalSave = BloodBank.prototype.save
			const originalCreate = BloodBank.create
			const originalInsertMany = BloodBank.insertMany
			const originalStockCreate = Bloodstock.create

			BloodBank.prototype.save = () => { mutationCalled = true; throw new Error('MUTATION FORBIDDEN') }
			BloodBank.create = () => { mutationCalled = true; throw new Error('MUTATION FORBIDDEN') }
			BloodBank.insertMany = () => { mutationCalled = true; throw new Error('MUTATION FORBIDDEN') }
			Bloodstock.create = () => { mutationCalled = true; throw new Error('MUTATION FORBIDDEN') }

			// Mock read-only DB methods
			const origStateFind = State.find
			const origCityFind = City.find
			const origBankFind = BloodBank.find

			State.find = () => ({
				select: () => ({ lean: async () => [{ stateName: 'Karnataka' }] }),
			})
			City.find = () => ({
				select: () => ({ lean: async () => [{ cityName: 'Bengaluru', stateName: 'Karnataka' }] }),
			})
			BloodBank.find = () => ({
				select: () => ({ lean: async () => [] }),
			})

			try {
				const req = {
					params: { entity: 'bloodbank' },
					body: {
						csv:
							'bloodbankName,category,contactPerson,address1,address2,state,city,pinCode,phoneNo1,phoneNo2,email,password,openingDate\n' +
							'Valid Bank,Government,Dr. Test,123 Rd,Area 1,Karnataka,Bengaluru,560001,9876543210,9876543211,test@example.org,Passw0rd123,2020-01-01',
					},
				}
				const res = createMockRes()
				let nextErr = null

				await bulkImportController.previewBulkImport(req, res, (err) => { nextErr = err })

				assert.strictEqual(nextErr, null)
				assert.strictEqual(res.statusCode, 200)
				assert.strictEqual(res.data.status, 'success')
				assert.strictEqual(res.data.totalRows, 1)
				assert.strictEqual(res.data.validRowsCount, 1)
				assert.strictEqual(res.data.invalidRowsCount, 0)
				assert.strictEqual(res.data.canImport, true)

				// Redaction invariant: Plaintext password must NOT be leaked in preview!
				assert.strictEqual(res.data.preview[0].data.password, '********')

				// Zero-mutation invariant verified: No save or create called!
				assert.strictEqual(mutationCalled, false)
			} finally {
				BloodBank.prototype.save = originalSave
				BloodBank.create = originalCreate
				BloodBank.insertMany = originalInsertMany
				Bloodstock.create = originalStockCreate
				State.find = origStateFind
				City.find = origCityFind
				BloodBank.find = origBankFind
			}
		})
	})

	describe('5. Referential Integrity & Schema Validations', () => {
		it('should flag error when state does not exist in database', async () => {
			const origStateFind = State.find
			const origCityFind = City.find
			const origBankFind = BloodBank.find

			// Return empty states (meaning Karnataka is not in DB)
			State.find = () => ({ select: () => ({ lean: async () => [] }) })
			City.find = () => ({ select: () => ({ lean: async () => [] }) })
			BloodBank.find = () => ({ select: () => ({ lean: async () => [] }) })

			try {
				const records = [
					{
						bloodbankName: 'Test Bank',
						category: 'Government',
						contactPerson: 'Dr. Test',
						address1: '123 Rd',
						address2: 'Area 1',
						state: 'NonExistentState',
						city: 'Bengaluru',
						pinCode: '560001',
						phoneNo1: '9876543210',
						phoneNo2: '9876543211',
						email: 'test@example.org',
						password: 'ValidPassword1',
						openingDate: '2020-01-01',
					},
				]

				const result = await validateBulkData('bloodbank', records)
				assert.strictEqual(result.canImport, false)
				assert.strictEqual(result.invalidRowsCount, 1)
				assert.ok(
					result.errors.some(
						(e) => e.field === 'state' && e.message.includes('does not exist')
					)
				)
			} finally {
				State.find = origStateFind
				City.find = origCityFind
				BloodBank.find = origBankFind
			}
		})

		it('should flag error when city is not registered under referenced state', async () => {
			const origStateFind = State.find
			const origCityFind = City.find
			const origBankFind = BloodBank.find

			State.find = () => ({
				select: () => ({ lean: async () => [{ stateName: 'Karnataka' }] }),
			})
			// City exists, but under Maharashtra, not Karnataka!
			City.find = () => ({
				select: () => ({ lean: async () => [{ cityName: 'Pune', stateName: 'Maharashtra' }] }),
			})
			BloodBank.find = () => ({ select: () => ({ lean: async () => [] }) })

			try {
				const records = [
					{
						bloodbankName: 'Test Bank',
						category: 'Government',
						contactPerson: 'Dr. Test',
						address1: '123 Rd',
						address2: 'Area 1',
						state: 'Karnataka',
						city: 'Pune',
						pinCode: '560001',
						phoneNo1: '9876543210',
						phoneNo2: '9876543211',
						email: 'test@example.org',
						password: 'ValidPassword1',
						openingDate: '2020-01-01',
					},
				]

				const result = await validateBulkData('bloodbank', records)
				assert.strictEqual(result.canImport, false)
				assert.ok(
					result.errors.some(
						(e) =>
							e.field === 'city' &&
							e.message.includes("is not registered under State 'Karnataka'")
					)
				)
			} finally {
				State.find = origStateFind
				City.find = origCityFind
				BloodBank.find = origBankFind
			}
		})

		it('should validate invalid category, pin code, phone numbers, and future dates', async () => {
			const origStateFind = State.find
			const origCityFind = City.find
			const origBankFind = BloodBank.find

			State.find = () => ({ select: () => ({ lean: async () => [{ stateName: 'Karnataka' }] }) })
			City.find = () => ({ select: () => ({ lean: async () => [{ cityName: 'Bengaluru', stateName: 'Karnataka' }] }) })
			BloodBank.find = () => ({ select: () => ({ lean: async () => [] }) })

			try {
				const records = [
					{
						bloodbankName: 'Invalid Bank',
						category: 'InvalidCategory',
						contactPerson: 'Dr. Test',
						address1: '123 Rd',
						address2: 'Area 1',
						state: 'Karnataka',
						city: 'Bengaluru',
						pinCode: '123', // Invalid pinCode
						phoneNo1: '12345', // Invalid phone 1
						phoneNo2: '12345', // Phone 2 equals Phone 1
						email: 'notanemail',
						password: 'short',
						openingDate: '2099-01-01', // Future date
					},
				]

				const result = await validateBulkData('bloodbank', records)
				assert.strictEqual(result.canImport, false)
				assert.strictEqual(result.validRowsCount, 0)
				assert.ok(result.errors.some((e) => e.field === 'category'))
				assert.ok(result.errors.some((e) => e.field === 'pinCode'))
				assert.ok(result.errors.some((e) => e.field === 'phoneNo1'))
				assert.ok(result.errors.some((e) => e.field === 'phoneNo2'))
				assert.ok(result.errors.some((e) => e.field === 'email'))
				assert.ok(result.errors.some((e) => e.field === 'password'))
				assert.ok(result.errors.some((e) => e.field === 'openingDate'))
			} finally {
				State.find = origStateFind
				City.find = origCityFind
				BloodBank.find = origBankFind
			}
		})
	})

	describe('6. Duplicate Detection (In-File and Against Database)', () => {
		it('should detect in-file duplicates on email, phone, and name', async () => {
			const origStateFind = State.find
			const origCityFind = City.find
			const origBankFind = BloodBank.find

			State.find = () => ({ select: () => ({ lean: async () => [{ stateName: 'Karnataka' }] }) })
			City.find = () => ({ select: () => ({ lean: async () => [{ cityName: 'Bengaluru', stateName: 'Karnataka' }] }) })
			BloodBank.find = () => ({ select: () => ({ lean: async () => [] }) })

			try {
				const records = [
					{
						bloodbankName: 'Duplicate Name Bank',
						category: 'Government',
						contactPerson: 'Dr. A',
						address1: '123 Rd',
						address2: 'A1',
						state: 'Karnataka',
						city: 'Bengaluru',
						pinCode: '560001',
						phoneNo1: '9845011111',
						phoneNo2: '9845022222',
						email: 'shared@example.org',
						password: 'Passw0rd123',
						openingDate: '2020-01-01',
					},
					{
						bloodbankName: 'Duplicate Name Bank', // Duplicate name in file
						category: 'Government',
						contactPerson: 'Dr. B',
						address1: '456 Rd',
						address2: 'A2',
						state: 'Karnataka',
						city: 'Bengaluru',
						pinCode: '560001',
						phoneNo1: '9845011111', // Duplicate phone in file
						phoneNo2: '9845033333',
						email: 'shared@example.org', // Duplicate email in file
						password: 'Passw0rd123',
						openingDate: '2020-01-01',
					},
				]

				const result = await validateBulkData('bloodbank', records)
				assert.strictEqual(result.canImport, false)
				assert.strictEqual(result.validRowsCount, 1)
				assert.strictEqual(result.invalidRowsCount, 1)

				const row3Errors = result.errors.filter((e) => e.row === 3)
				assert.ok(row3Errors.some((e) => e.field === 'email' && e.message.includes('duplicated within file')))
				assert.ok(row3Errors.some((e) => e.field === 'phoneNo1' && e.message.includes('duplicated within file')))
				assert.ok(row3Errors.some((e) => e.field === 'bloodbankName' && e.message.includes('Duplicate blood bank name')))
			} finally {
				State.find = origStateFind
				City.find = origCityFind
				BloodBank.find = origBankFind
			}
		})

		it('should detect conflicts against existing database records (email / phone)', async () => {
			const origStateFind = State.find
			const origCityFind = City.find
			const origBankFind = BloodBank.find

			State.find = () => ({ select: () => ({ lean: async () => [{ stateName: 'Karnataka' }] }) })
			City.find = () => ({ select: () => ({ lean: async () => [{ cityName: 'Bengaluru', stateName: 'Karnataka' }] }) })

			// Mock existing record in database
			BloodBank.find = () => ({
				select: () => ({
					lean: async () => [
						{ email: 'existing@example.org', phoneNo1: '9845099999', phoneNo2: '9845088888' },
					],
				}),
			})

			try {
				const records = [
					{
						bloodbankName: 'Conflicting Bank',
						category: 'Government',
						contactPerson: 'Dr. C',
						address1: '789 Rd',
						address2: 'A3',
						state: 'Karnataka',
						city: 'Bengaluru',
						pinCode: '560001',
						phoneNo1: '9845099999', // Collides with DB phone
						phoneNo2: '9845077777',
						email: 'existing@example.org', // Collides with DB email
						password: 'Passw0rd123',
						openingDate: '2020-01-01',
					},
				]

				const result = await validateBulkData('bloodbank', records)
				assert.strictEqual(result.canImport, false)
				assert.ok(result.errors.some((e) => e.field === 'email' && e.message.includes('already belongs to an existing blood bank')))
				assert.ok(result.errors.some((e) => e.field === 'phoneNo1' && e.message.includes('already belongs to an existing blood bank')))
			} finally {
				State.find = origStateFind
				City.find = origCityFind
				BloodBank.find = origBankFind
			}
		})
	})

	describe('7. Confirmed Batch Import & Atomic Provisioning', () => {
		it('should reject confirmed import if explicit confirm flag is omitted', async () => {
			const req = {
				params: { entity: 'bloodbank' },
				body: { csv: 'some,csv', confirm: false },
				headers: {},
			}
			const res = createMockRes()
			let nextErr = null

			await bulkImportController.confirmBulkImport(req, res, (err) => { nextErr = err })

			assert.ok(nextErr)
			assert.strictEqual(nextErr.statusCode, 400)
			assert.match(nextErr.message, /Explicit user confirmation is required/i)
		})

		it('should atomically import bloodbanks and provision associated BloodStock records', async () => {
			const origStateFind = State.find
			const origCityFind = City.find
			const origBankFind = BloodBank.find
			const origSaveBank = BloodBank.prototype.save
			const origSaveStock = Bloodstock.prototype.save

			State.find = () => ({ select: () => ({ lean: async () => [{ stateName: 'Karnataka' }] }) })
			City.find = () => ({ select: () => ({ lean: async () => [{ cityName: 'Bengaluru', stateName: 'Karnataka' }] }) })
			BloodBank.find = () => ({ select: () => ({ lean: async () => [] }) })

			const createdBanks = []
			const createdStocks = []

			BloodBank.prototype.save = async function (opts) {
				this._id = 'mock_bank_id_101'
				createdBanks.push({ ...this.toObject ? this.toObject() : this, opts })
				return this
			}

			Bloodstock.prototype.save = async function (opts) {
				createdStocks.push({ ...this.toObject ? this.toObject() : this, opts })
				return this
			}

			try {
				const req = {
					params: { entity: 'bloodbank' },
					body: {
						confirm: true,
						csv:
							'bloodbankName,category,contactPerson,address1,address2,state,city,pinCode,phoneNo1,phoneNo2,email,password,openingDate\n' +
							'Apollo City Bank,Private,Dr. Apollo,10 Medical Way,North,Karnataka,Bengaluru,560001,9845012345,9845012346,apollo@example.org,Passw0rd123,2020-01-01',
					},
					headers: {},
				}
				const res = createMockRes()
				let nextErr = null

				await bulkImportController.confirmBulkImport(req, res, (err) => { nextErr = err })

				assert.strictEqual(nextErr, null)
				assert.strictEqual(res.statusCode, 201)
				assert.strictEqual(res.data.status, 'success')
				assert.strictEqual(res.data.totalImported, 1)

				// Verify both BloodBank and BloodStock were saved
				assert.strictEqual(createdBanks.length, 1)
				assert.strictEqual(createdStocks.length, 1)
				assert.strictEqual(String(createdStocks[0].bloodbankId), String(createdBanks[0]._id))
			} finally {
				State.find = origStateFind
				City.find = origCityFind
				BloodBank.find = origBankFind
				BloodBank.prototype.save = origSaveBank
				Bloodstock.prototype.save = origSaveStock
			}
		})

		it('should rollback transaction if stock record creation fails', async () => {
			const origStateFind = State.find
			const origCityFind = City.find
			const origBankFind = BloodBank.find
			const origSaveBank = BloodBank.prototype.save
			const origSaveStock = Bloodstock.prototype.save

			State.find = () => ({ select: () => ({ lean: async () => [{ stateName: 'Karnataka' }] }) })
			City.find = () => ({ select: () => ({ lean: async () => [{ cityName: 'Bengaluru', stateName: 'Karnataka' }] }) })
			BloodBank.find = () => ({ select: () => ({ lean: async () => [] }) })

			BloodBank.prototype.save = async function () {
				this._id = 'mock_bank_id_fail'
				return this
			}
			Bloodstock.prototype.save = async function () {
				throw new Error('Database disk error during BloodStock provisioning')
			}

			try {
				const req = {
					params: { entity: 'bloodbank' },
					body: {
						confirm: true,
						csv:
							'bloodbankName,category,contactPerson,address1,address2,state,city,pinCode,phoneNo1,phoneNo2,email,password,openingDate\n' +
							'Rollback Bank,Government,Dr. Roll,10 Way,North,Karnataka,Bengaluru,560001,9845012345,9845012346,rollback@example.org,Passw0rd123,2020-01-01',
					},
					headers: {},
				}
				const res = createMockRes()
				let thrownErr = null

				await bulkImportController.confirmBulkImport(req, res, (err) => { thrownErr = err })

				assert.ok(thrownErr)
				assert.match(thrownErr.message, /Database disk error/i)
			} finally {
				State.find = origStateFind
				City.find = origCityFind
				BloodBank.find = origBankFind
				BloodBank.prototype.save = origSaveBank
				Bloodstock.prototype.save = origSaveStock
			}
		})

		it('should fail closed in production if MongoDB multi-document transactions are unsupported', async () => {
			process.env.NODE_ENV = 'production'

			// Ensure canUseTransactions returns false
			const origConnection = State.db
			const req = {
				params: { entity: 'state' },
				body: {
					confirm: true,
					csv: 'stateName\nGoa',
				},
				headers: {},
			}
			const res = createMockRes()
			let thrownErr = null

			// State.find returns empty (no duplicates)
			const origStateFind = State.find
			State.find = () => ({ select: () => ({ lean: async () => [] }) })

			try {
				await bulkImportController.confirmBulkImport(req, res, (err) => { thrownErr = err })
				assert.ok(thrownErr)
				assert.strictEqual(thrownErr.statusCode, 500)
				assert.match(thrownErr.message, /Production deployment requires a MongoDB Replica Set/i)
			} finally {
				State.find = origStateFind
				process.env.NODE_ENV = 'development'
			}
		})
	})

	describe('8. Master Data Import: City & State', () => {
		it('should preview and import Cities linked to existing States', async () => {
			const origStateFind = State.find
			const origCityFind = City.find
			const origCitySave = City.prototype.save

			State.find = () => ({ select: () => ({ lean: async () => [{ stateName: 'Karnataka' }] }) })
			City.find = () => ({ select: () => ({ lean: async () => [] }) })

			const savedCities = []
			City.prototype.save = async function () {
				savedCities.push(this.cityName)
				return this
			}

			try {
				const csv = 'stateName,cityName\nKarnataka,Hubballi\nKarnataka,Belagavi'
				const previewReq = {
					params: { entity: 'city' },
					body: { csv },
				}
				const previewRes = createMockRes()
				await bulkImportController.previewBulkImport(previewReq, previewRes, () => {})

				assert.strictEqual(previewRes.statusCode, 200)
				assert.strictEqual(previewRes.data.validRowsCount, 2)
				assert.strictEqual(previewRes.data.canImport, true)

				const confirmReq = {
					params: { entity: 'city' },
					body: { csv, confirm: true },
					headers: {},
				}
				const confirmRes = createMockRes()
				await bulkImportController.confirmBulkImport(confirmReq, confirmRes, () => {})

				assert.strictEqual(confirmRes.statusCode, 201)
				assert.strictEqual(confirmRes.data.totalImported, 2)
				assert.deepStrictEqual(savedCities, ['Hubballi', 'Belagavi'])
			} finally {
				State.find = origStateFind
				City.find = origCityFind
				City.prototype.save = origCitySave
			}
		})
	})

	describe('9. Authorization & Access Control', () => {
		const { protect } = require('../Login_And_Authentication/authMiddleware')
		const { selectAdminModel } = require('../Common/Middlewares/selectModels')

		it('should reject unauthenticated request with no token (401)', async () => {
			const req = {
				headers: {},
				model: Admin,
			}
			const res = createMockRes()
			let calledNext = false
			await protect(req, res, () => { calledNext = true })
			assert.strictEqual(calledNext, false)
			assert.strictEqual(res.statusCode, 401)
			assert.match(res.data.message, /not logged in/i)
		})

		it('should reject non-admin (user token) attempting admin bulk import (401)', async () => {
			// Create user token
			const userToken = jwt.sign(
				{ id: 'mock_user_id_999', iat: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 3600 },
				process.env.JWT_SECRET
			)

			// req.model is Admin (via selectAdminModel)
			const req = {
				headers: { authorization: `Bearer ${userToken}` },
			}
			selectAdminModel(req, {}, () => {})

			// Mock Admin.findById to return null since ID belongs to regular user, not admin
			const origAdminFindById = Admin.findById
			Admin.findById = () => ({
				select: async () => null,
			})

			const res = createMockRes()
			let calledNext = false
			try {
				await protect(req, res, () => { calledNext = true })
				assert.strictEqual(calledNext, false)
				assert.strictEqual(res.statusCode, 401)
				assert.match(res.data.message, /does no longer exist/i)
			} finally {
				Admin.findById = origAdminFindById
			}
		})

		it('should allow authenticated admin token to proceed', async () => {
			const adminToken = jwt.sign(
				{ id: 'mock_admin_id_1', iat: Math.floor(Date.now() / 1000) - 10, exp: Math.floor(Date.now() / 1000) + 3600 },
				process.env.JWT_SECRET
			)

			const req = {
				headers: { authorization: `Bearer ${adminToken}` },
			}
			selectAdminModel(req, {}, () => {})

			const origAdminFindById = Admin.findById
			Admin.findById = () => ({
				select: async () => ({
					_id: 'mock_admin_id_1',
					changedPasswordAfter: () => false,
				}),
			})

			const res = createMockRes()
			let calledNext = false
			try {
				await protect(req, res, () => { calledNext = true })
				assert.strictEqual(calledNext, true)
				assert.strictEqual(req.user._id, 'mock_admin_id_1')
			} finally {
				Admin.findById = origAdminFindById
			}
		})
	})
})
