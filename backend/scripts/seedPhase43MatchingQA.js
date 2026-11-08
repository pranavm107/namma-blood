/**
 * Namma Blood — Phase 4.3 Emergency Matching Synthetic QA Data Seeder (Final Safety Revision)
 *
 * PURPOSE:
 * Generates isolated, strictly owned synthetic QA records to support manual
 * and automated testing of the Phase 4.3 Emergency Request Matching API.
 *
 * STRICT SAFETY INVARIANTS:
 * 1. Database Safety:
 *    - Strictly enforces database name === 'namma_blood_dev'.
 *    - Strictly enforces connection host === '127.0.0.1' or 'localhost'. Empty or unknown hosts rejected.
 *    - Rejects execution if NODE_ENV === 'production'.
 *    - Connection strings, credentials, and passwords are NEVER logged or printed.
 *
 * 2. Password Safety:
 *    - No hard-coded passwords in source code.
 *    - Reads password from dedicated environment variable: QA_USER_PASSWORD.
 *    - Validates against User schema constraints (8-20 chars, alphanumeric/._-, no spaces).
 *    - User.create() natively triggers the Mongoose pre-save bcrypt hook (cost 12).
 *
 * 3. Isolated Synthetic Accounts:
 *    - Pre-existing accounts (e.g. priya.rajan@example.com) are NEVER reused as requesters.
 *    - Dedicated synthetic requester: qa.requester.m43@nammablood.test.
 *    - Dedicated synthetic donor: qa.donor.m43@nammablood.test.
 *    - Uses non-routable .test domain and 'Synthetic-QA' markers to prevent confusion with real users.
 *
 * 4. Strict Ownership & Collision Prevention:
 *    - Before reusing any existing record, checks the exact QA ownership marker: '[QA-PHASE43-M4334-SYNTHETIC]'.
 *    - If an identifier exists without the ownership marker, execution aborts immediately.
 *    - Never overwrites existing account details.
 *
 * 5. Blood Bank Independence:
 *    - matchedBloodbankIds is strictly empty ([]).
 *    - Existing blood banks, staff, and inventory records are completely untouched.
 *    - Tests focus on Admin-authorized matching and synthetic donor candidate discovery.
 *
 * 6. Two-Phase Verified Cleanup:
 *    - Stage A: Upfront discovery and complete relationship ownership validation across all collections.
 *      Validates that donor profiles belong to the dedicated QA donor user, and emergency requests
 *      belong to the dedicated QA requester user. Aborts on any ambiguity BEFORE any deletion.
 *    - Stage B: Deletion executed strictly by exact ObjectIds validated in Stage A.
 *    - Pre-existing accounts and inventory are strictly protected. Idempotent.
 *
 * 7. Fixture Integrity Validation:
 *    - Validates all clinical safety invariants and shortfall integrity before reporting success.
 *    - Correctly accepts both null and undefined for unreviewed donor fields (reviewedByStaffId, reviewedAt),
 *      while strictly failing on any populated clinical clearance data.
 *    - Request verificationStatus is 'Verified' solely as a synthetic dev fixture for matching exercise.
 *    - Donor clinicalEligibilityStatus is preserved as 'Pending_Clinical_Evaluation' (no fake medical approvals).
 *
 * Usage:
 *   Seed mode:    export QA_USER_PASSWORD="YourSecurePassword_123" && node scripts/seedPhase43MatchingQA.js
 *   Cleanup mode: node scripts/seedPhase43MatchingQA.js --cleanup
 */

const path = require('path')
const mongoose = require('mongoose')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

// Models
const { EmergencyBloodRequest } = require('../Emergency/emergencyBloodRequestModel')
const { EmergencyDonorProfile } = require('../Emergency/emergencyDonorProfileModel')
const User = require('../User/userModel')

// Safety Configurations
const REQUIRED_DATABASE_NAME = 'namma_blood_dev'
const ALLOWED_EXPLICIT_HOSTS = ['127.0.0.1', 'localhost']
const QA_OWNERSHIP_MARKER = '[QA-PHASE43-M4334-SYNTHETIC]'

// Deterministic Synthetic QA Identifiers (Non-routable .test domain)
const QA_REQUEST_NUMBER = 'EMG-20261106-QA4301'
const QA_REQUESTER_EMAIL = 'qa.requester.m43@nammablood.test'
const QA_REQUESTER_PHONE = 9876500091
const QA_DONOR_EMAIL = 'qa.donor.m43@nammablood.test'
const QA_DONOR_PHONE = 9876500092

// Protected Accounts Exclusion List (NEVER deleted or modified by this script)
const PROTECTED_ACCOUNT_EMAILS = [
	'priya.rajan@example.com',
	'adyar.lifeline@example.com',
	'vellore.cmcbc@example.com',
	'apollo.central@nammablood.test',
	'mo.adyar@nammablood.internal',
	'lab.adyar@nammablood.internal',
	'admin@nammablood.org',
	'pranavagneeshm@gmail.com',
]

/**
 * Validates and extracts the QA password from environment.
 * Fails closed if missing, malformed, or violating User model constraints.
 */
function getAndValidateQAPassword() {
	const rawPassword = process.env.QA_USER_PASSWORD

	if (!rawPassword || typeof rawPassword !== 'string') {
		console.error('\n🚨 [QA-SAFETY-CRITICAL] Missing required environment variable: QA_USER_PASSWORD')
		console.error('Please export QA_USER_PASSWORD before executing this script.')
		console.error('Example: export QA_USER_PASSWORD="YourSecurePassword_123"\n')
		process.exit(1)
	}

	const password = rawPassword.trim()

	if (password.length < 8 || password.length > 20) {
		console.error('\n🚨 [QA-SAFETY-CRITICAL] QA_USER_PASSWORD validation failed:')
		console.error('Password length must be between 8 and 20 characters (User model schema constraint).\n')
		process.exit(1)
	}

	if (!/^[a-zA-Z0-9._-]+$/.test(password)) {
		console.error('\n🚨 [QA-SAFETY-CRITICAL] QA_USER_PASSWORD validation failed:')
		console.error('Password contains invalid characters. Allowed characters are alphanumeric, ., _, and -.\n')
		process.exit(1)
	}

	if (/\s/.test(rawPassword)) {
		console.error('\n🚨 [QA-SAFETY-CRITICAL] QA_USER_PASSWORD validation failed: password must not contain whitespace.\n')
		process.exit(1)
	}

	return password
}

/**
 * Validates strict database connection safety invariants.
 */
function assertDatabaseSafety() {
	// 1. Production Environment Guard
	const env = (process.env.NODE_ENV || '').toLowerCase().trim()
	if (env === 'production') {
		console.error('\n🚨 [QA-SAFETY-CRITICAL] Execution aborted: NODE_ENV is "production"!')
		console.error('QA seed scripts are strictly prohibited in production environments.\n')
		process.exit(1)
	}

	// 2. Database Name Guard
	const activeDbName = mongoose.connection.db
		? mongoose.connection.db.databaseName
		: mongoose.connection.name
	if (!activeDbName || activeDbName !== REQUIRED_DATABASE_NAME) {
		console.error(`\n🚨 [QA-SAFETY-CRITICAL] Execution aborted: Database is "${activeDbName || 'UNKNOWN'}"!`)
		console.error(`This script strictly requires the isolated development database "${REQUIRED_DATABASE_NAME}".\n`)
		process.exit(1)
	}

	// 3. Connection Host Guard (Rejects empty, remote, or unknown hosts)
	const host = String(mongoose.connection.host || '').toLowerCase().trim()
	if (!host || !ALLOWED_EXPLICIT_HOSTS.includes(host)) {
		console.error(`\n🚨 [QA-SAFETY-CRITICAL] Execution aborted: Connection host is "${host || 'EMPTY'}"!`)
		console.error('This script strictly requires an explicit localhost connection (127.0.0.1 or localhost).\n')
		process.exit(1)
	}

	console.log(`[Safety Guard] Passed. Connected to host "${host}", database "${activeDbName}".`)
}

/**
 * Validates fixture data integrity invariants prior to reporting success.
 * Accepts both null and undefined for unreviewed clinical fields while strictly
 * rejecting any populated clinical review evidence.
 */
function assertFixtureIntegrity(requestDoc, profileDoc, requesterDoc, donorDoc) {
	if (!requestDoc || !profileDoc || !requesterDoc || !donorDoc) {
		throw new Error('Integrity validation failed: one or more required fixture documents are missing.')
	}

	// Request Invariants
	if (requestDoc.verificationStatus !== 'Verified') {
		throw new Error(`Integrity violation: request.verificationStatus is "${requestDoc.verificationStatus}", expected "Verified".`)
	}
	if (requestDoc.status !== 'Active') {
		throw new Error(`Integrity violation: request.status is "${requestDoc.status}", expected "Active".`)
	}
	if (new Date(requestDoc.expiresAt).getTime() <= Date.now()) {
		throw new Error('Integrity violation: request.expiresAt is not in the future.')
	}
	if (requestDoc.unitsReserved !== requestDoc.reservedUnitIds.length) {
		throw new Error('Integrity violation: request.unitsReserved does not equal reservedUnitIds.length.')
	}
	if (requestDoc.unitsReserved + requestDoc.unitsFulfilled > requestDoc.unitsRequested) {
		throw new Error('Integrity violation: sum of reserved and fulfilled units exceeds unitsRequested.')
	}
	if (requestDoc.matchedBloodbankIds.length !== 0) {
		throw new Error('Integrity violation: matchedBloodbankIds must be strictly empty ([]) for this isolated fixture.')
	}
	if (requestDoc.requesterUserId.toString() !== requesterDoc._id.toString()) {
		throw new Error('Integrity violation: request.requesterUserId does not match synthetic requester ID.')
	}

	// Donor Profile Invariants
	if (profileDoc.userId.toString() !== donorDoc._id.toString()) {
		throw new Error('Integrity violation: profile.userId does not match synthetic donor ID.')
	}
	if (profileDoc.clinicalEligibilityStatus !== 'Pending_Clinical_Evaluation') {
		throw new Error(`Integrity violation: profile.clinicalEligibilityStatus is "${profileDoc.clinicalEligibilityStatus}", expected "Pending_Clinical_Evaluation".`)
	}

	// Safe Clinical Review Inspection: Accepts null and undefined, rejects populated values
	const hasStaffReview = profileDoc.reviewedByStaffId !== null && profileDoc.reviewedByStaffId !== undefined
	const hasReviewTimestamp = profileDoc.reviewedAt !== null && profileDoc.reviewedAt !== undefined
	if (hasStaffReview || hasReviewTimestamp) {
		throw new Error('Integrity violation: donor profile contains unauthorized clinical clearance fields.')
	}

	console.log('[Integrity Audit] All clinical safety and shortfall data integrity invariants confirmed.')
}

/**
 * Two-phase verified cleanup: Discovers, verifies ownership relationships, and deletes strictly QA records by ObjectId.
 */
async function performCleanup() {
	console.log('\n--- Namma Blood: Phase 4.3 QA Data Cleanup (Two-Phase Verified) ---')
	assertDatabaseSafety()

	// =========================================================================
	// STAGE A: DISCOVERY & COMPLETE RELATIONSHIP OWNERSHIP VALIDATION
	// All ownership and relationship checks must pass BEFORE any deletion occurs.
	// =========================================================================

	// 1. Discover Candidate QA Users
	const candidateUsers = await User.find({
		email: { $in: [QA_REQUESTER_EMAIL, QA_DONOR_EMAIL] },
	}).lean()

	const safeUserIdsToDelete = []
	let validatedRequesterUser = null
	let validatedDonorUser = null

	for (const u of candidateUsers) {
		// Protected account check
		if (PROTECTED_ACCOUNT_EMAILS.includes(u.email)) {
			console.error(`🚨 [SAFETY VIOLATION] Candidate user "${u.email}" is on the protected accounts list! Aborting cleanup.`)
			process.exit(1)
		}
		// Non-routable .test domain check
		if (!u.email.endsWith('@nammablood.test')) {
			console.error(`🚨 [SAFETY VIOLATION] Candidate user "${u.email}" does not have the @nammablood.test domain! Aborting cleanup.`)
			process.exit(1)
		}
		// Ownership marker check
		if (!u.address || !u.address.includes(QA_OWNERSHIP_MARKER) || u.lastName !== 'Synthetic-QA') {
			console.error(`🚨 [OWNERSHIP AMBIGUITY] User "${u.email}" lacks ownership marker "${QA_OWNERSHIP_MARKER}". Aborting cleanup.`)
			process.exit(1)
		}

		safeUserIdsToDelete.push(u._id)
		if (u.email === QA_REQUESTER_EMAIL) validatedRequesterUser = u
		if (u.email === QA_DONOR_EMAIL) validatedDonorUser = u
	}

	// 2. Discover Candidate Emergency Blood Requests
	const candidateRequests = await EmergencyBloodRequest.find({
		requestNumber: QA_REQUEST_NUMBER,
	}).lean()

	const reqIdsToDelete = []
	for (const req of candidateRequests) {
		// Ownership marker check
		if (!req.clinicalJustification || !req.clinicalJustification.includes(QA_OWNERSHIP_MARKER)) {
			console.error(`🚨 [OWNERSHIP AMBIGUITY] Request "${req.requestNumber}" lacks ownership marker "${QA_OWNERSHIP_MARKER}". Aborting cleanup to prevent data loss.`)
			process.exit(1)
		}

		// Relationship check: Must belong to the validated synthetic requester user
		if (!validatedRequesterUser) {
			console.error(`🚨 [OWNERSHIP AMBIGUITY] Request "${req.requestNumber}" exists, but the related synthetic requester user "${QA_REQUESTER_EMAIL}" is missing. Aborting cleanup.`)
			process.exit(1)
		}
		if (req.requesterUserId.toString() !== validatedRequesterUser._id.toString()) {
			console.error(`🚨 [OWNERSHIP AMBIGUITY] Request "${req.requestNumber}" requesterUserId (${req.requesterUserId}) does not match validated synthetic requester ID (${validatedRequesterUser._id}). Aborting cleanup.`)
			process.exit(1)
		}

		reqIdsToDelete.push(req._id)
	}

	// 3. Discover Candidate Emergency Donor Profiles
	const candidateProfiles = await EmergencyDonorProfile.find({
		clinicalReviewNotes: { $regex: /\[QA-PHASE43-M4334-SYNTHETIC\]/ },
	}).lean()

	const profileIdsToDelete = []
	for (const prof of candidateProfiles) {
		// Relationship check: Must belong to the validated synthetic donor user
		if (!validatedDonorUser) {
			console.error(`🚨 [OWNERSHIP AMBIGUITY] Donor profile "${prof._id}" exists, but the related synthetic donor user "${QA_DONOR_EMAIL}" is missing. Aborting cleanup.`)
			process.exit(1)
		}
		if (prof.userId.toString() !== validatedDonorUser._id.toString()) {
			console.error(`🚨 [OWNERSHIP AMBIGUITY] Donor profile "${prof._id}" userId (${prof.userId}) does not match validated synthetic donor ID (${validatedDonorUser._id}). Aborting cleanup.`)
			process.exit(1)
		}

		profileIdsToDelete.push(prof._id)
	}

	// =========================================================================
	// STAGE B: TARGETED DELETIONS BY EXACT OBJECTID
	// Only executed after all Stage A ownership and relationship checks have passed.
	// =========================================================================
	let deletedReqCount = 0
	let deletedProfCount = 0
	let deletedUserCount = 0

	if (reqIdsToDelete.length > 0) {
		const res = await EmergencyBloodRequest.deleteMany({ _id: { $in: reqIdsToDelete } })
		deletedReqCount = res.deletedCount || 0
	}

	if (profileIdsToDelete.length > 0) {
		const res = await EmergencyDonorProfile.deleteMany({ _id: { $in: profileIdsToDelete } })
		deletedProfCount = res.deletedCount || 0
	}

	if (safeUserIdsToDelete.length > 0) {
		const res = await User.deleteMany({ _id: { $in: safeUserIdsToDelete } })
		deletedUserCount = res.deletedCount || 0
	}

	console.log(`[Cleaned] Verified Emergency Requests removed : ${deletedReqCount}`)
	console.log(`[Cleaned] Verified Donor Profiles removed   : ${deletedProfCount}`)
	console.log(`[Cleaned] Verified Synthetic Users removed   : ${deletedUserCount}`)
	console.log('[Success] Cleanup completed idempotently. All pre-existing accounts and inventory preserved.\n')
}

/**
 * Seeding procedure: Creates isolated synthetic QA records idempotently with strict ownership checks.
 */
async function performSeed() {
	console.log('\n--- Namma Blood: Phase 4.3 Emergency Matching QA Data Seeder ---')
	assertDatabaseSafety()

	// Extract and validate password from environment (never logged)
	const validatedPassword = getAndValidateQAPassword()

	// 1. Ensure Dedicated Synthetic QA Requester User
	let requester = await User.findOne({ email: QA_REQUESTER_EMAIL })
	if (requester) {
		// Strict Ownership Guard: Verify existing record ownership before reuse
		if (!requester.address || !requester.address.includes(QA_OWNERSHIP_MARKER) || requester.lastName !== 'Synthetic-QA') {
			console.error(`\n🚨 [OWNERSHIP COLLISION] User with email "${QA_REQUESTER_EMAIL}" exists but lacks the QA ownership marker.`)
			console.error('Aborting execution to prevent overwriting or modifying an unmanaged user account.\n')
			process.exit(1)
		}
		console.log(`[Exists]  Verified QA Requester User   : ${requester.email} (ID: ${requester._id})`)
	} else {
		// User.create() invokes the Mongoose pre('save') bcrypt hashing middleware (cost 12)
		requester = await User.create({
			email: QA_REQUESTER_EMAIL,
			phoneNo1: QA_REQUESTER_PHONE,
			firstName: 'QA-Requester',
			lastName: 'Synthetic-QA',
			gender: 'Female',
			dob: new Date('1990-01-01'),
			age: 36,
			password: validatedPassword,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: `${QA_OWNERSHIP_MARKER} Synthetic Requester Testing Facility, 21 Victoria Road`,
			pinCode: 600006,
			status: true,
		})
		console.log(`[Created] Dedicated Synthetic Requester : ${requester.email} (ID: ${requester._id})`)
	}

	// 2. Ensure Dedicated Synthetic QA Donor User
	let donorUser = await User.findOne({ email: QA_DONOR_EMAIL })
	if (donorUser) {
		// Strict Ownership Guard: Verify existing record ownership before reuse
		if (!donorUser.address || !donorUser.address.includes(QA_OWNERSHIP_MARKER) || donorUser.lastName !== 'Synthetic-QA') {
			console.error(`\n🚨 [OWNERSHIP COLLISION] User with email "${QA_DONOR_EMAIL}" exists but lacks the QA ownership marker.`)
			console.error('Aborting execution to prevent overwriting or modifying an unmanaged user account.\n')
			process.exit(1)
		}
		console.log(`[Exists]  Verified QA Donor User       : ${donorUser.email} (ID: ${donorUser._id})`)
	} else {
		donorUser = await User.create({
			email: QA_DONOR_EMAIL,
			phoneNo1: QA_DONOR_PHONE,
			firstName: 'QA-Donor',
			lastName: 'Synthetic-QA',
			gender: 'Male',
			dob: new Date('1995-05-15'),
			age: 31,
			password: validatedPassword,
			state: 'Tamil Nadu',
			city: 'Chennai',
			address: `${QA_OWNERSHIP_MARKER} Synthetic Donor Testing Residence, 12 Besant Nagar`,
			pinCode: 600090,
			status: true,
		})
		console.log(`[Created] Dedicated Synthetic Donor User: ${donorUser.email} (ID: ${donorUser._id})`)
	}

	// 3. Ensure Synthetic Emergency Donor Profile
	let donorProfile = await EmergencyDonorProfile.findOne({ userId: donorUser._id })
	if (donorProfile) {
		// Strict Ownership Guard: Verify existing record ownership before reuse
		if (!donorProfile.clinicalReviewNotes || !donorProfile.clinicalReviewNotes.includes(QA_OWNERSHIP_MARKER)) {
			console.error(`\n🚨 [OWNERSHIP COLLISION] Donor profile exists for user "${donorUser._id}" but lacks the QA ownership marker.`)
			console.error('Aborting execution to prevent overwriting or modifying an unmanaged donor profile.\n')
			process.exit(1)
		}
		console.log(`[Exists]  Verified QA Donor Profile    : B_Positive (Profile ID: ${donorProfile._id})`)
	} else {
		donorProfile = await EmergencyDonorProfile.create({
			userId: donorUser._id,
			bloodGroup: 'B_Positive',
			isEmergencyDonor: true,
			availabilityStatus: 'Ready',
			clinicalEligibilityStatus: 'Pending_Clinical_Evaluation', // Strictly unapproved; self-reported intent only
			lastDonationDate: new Date(Date.now() - 120 * 24 * 60 * 60 * 1000), // 120 days ago
			lastDonationComponent: 'Whole_Blood',
			eligibleToDonateAfter: null,
			clinicalReviewNotes:
				`${QA_OWNERSHIP_MARKER} Self-reported voluntary emergency donor awaiting clinical evaluation. No medical clearance or TTI screening results established.`,
			location: {
				type: 'Point',
				coordinates: [80.2500, 13.0600], // ~0.4 km from hospital coordinates
			},
			state: 'Tamil Nadu',
			city: 'Chennai',
			pinCode: 600006,
			maxTravelDistanceKm: 15,
			notificationPreferences: {
				email: true,
				webPush: false,
				inApp: true,
			},
		})
		console.log(`[Created] Synthetic Donor Profile      : B_Positive (Profile ID: ${donorProfile._id})`)
	}

	// 4. Ensure Verified, Active Emergency Blood Request (Strictly matchedBloodbankIds: [])
	let emergencyRequest = await EmergencyBloodRequest.findOne({ requestNumber: QA_REQUEST_NUMBER })
	if (emergencyRequest) {
		// Strict Ownership Guard: Verify existing record ownership before reuse
		if (
			!emergencyRequest.clinicalJustification ||
			!emergencyRequest.clinicalJustification.includes(QA_OWNERSHIP_MARKER) ||
			emergencyRequest.requesterUserId.toString() !== requester._id.toString()
		) {
			console.error(`\n🚨 [OWNERSHIP COLLISION] Emergency request "${QA_REQUEST_NUMBER}" exists but lacks the QA ownership marker.`)
			console.error('Aborting execution to prevent overwriting or modifying an unmanaged emergency request.\n')
			process.exit(1)
		}
		console.log(`[Exists]  Verified QA Emergency Request: ${emergencyRequest.requestNumber} (ID: ${emergencyRequest._id})`)
	} else {
		emergencyRequest = await EmergencyBloodRequest.create({
			requestNumber: QA_REQUEST_NUMBER,
			requesterUserId: requester._id,
			patientName: 'QA-Synthetic Patient (Non-Clinical)',
			patientAge: 35,
			patientGender: 'Female',
			requiredBloodGroup: 'B_Positive',
			requiredComponent: 'Packed_Red_Blood_Cells',
			unitsRequested: 2,
			unitsReserved: 0,
			unitsFulfilled: 0,
			reservedUnitIds: [],
			urgencyLevel: 'Critical',
			requiredWithinHours: 4,
			expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours future validity
			hospitalName: 'Apollo Hospitals Chennai (QA Reference Facility)',
			hospitalAddress: '21 Greams Road, Thousand Lights',
			hospitalCity: 'Chennai',
			hospitalState: 'Tamil Nadu',
			hospitalPinCode: 600006,
			location: {
				type: 'Point',
				coordinates: [80.2524, 13.0604],
			},
			attendingDoctor: {
				doctorName: 'QA Test Coordinator (Non-Medical)',
				doctorPhone: '9876543210',
				registrationNumber: 'QA-TMC-NONE',
			},
			matchedBloodbankIds: [], // Strictly unassigned for initial isolated matching QA
			verificationStatus: 'Verified', // Synthetic dev fixture exclusively for matching engine exercise
			status: 'Active',
			clinicalJustification:
				`${QA_OWNERSHIP_MARKER} Synthetic test emergency ticket created solely for Phase 4.3 candidate matching engine testing. Not real clinical or emergency data.`,
		})
		console.log(`[Created] Emergency Blood Request       : ${emergencyRequest.requestNumber} (ID: ${emergencyRequest._id})`)
	}

	// 5. Audit Fixture Integrity Invariants
	assertFixtureIntegrity(emergencyRequest, donorProfile, requester, donorUser)

	// 6. Summary Output for Postman Environment Configuration
	console.log('\n======================================================')
	console.log('🎉 QA DATA PREPARATION COMPLETE')
	console.log('======================================================')
	console.log(`Target Environment Variable   : requestId`)
	console.log(`Generated MongoDB ObjectId    : ${emergencyRequest._id}`)
	console.log(`Human-Readable Request Number : ${emergencyRequest.requestNumber}`)
	console.log(`Verification Status           : ${emergencyRequest.verificationStatus} (Synthetic Dev Test Fixture)`)
	console.log(`Lifecycle Status              : ${emergencyRequest.status}`)
	console.log(`Expiry Window                 : ${emergencyRequest.expiresAt.toISOString()} (Valid for 24h)`)
	console.log(`Dedicated Requester Account   : ${requester.email}`)
	console.log(`Dedicated Donor Account       : ${donorUser.email}`)
	console.log(`Donor Clinical Status         : ${donorProfile.clinicalEligibilityStatus} (Self-Reported Only)`)
	console.log(`Matched Blood Banks           : [] (Strictly unassigned)`)
	console.log(`Shortfall Invariants Verified : unitsRequested=${emergencyRequest.unitsRequested}, unitsReserved=${emergencyRequest.unitsReserved}`)
	console.log('Authorized Login Accounts for Testing /matches:')
	console.log(`  1. Platform Administrator   : admin@nammablood.org (Platform Oversight)`)
	console.log(`  2. Request Owner User       : ${requester.email} (Requester IDOR Ownership)`)
	console.log('======================================================\n')
}

/**
 * Main Controller
 */
async function main() {
	const dbUrl = process.env.database_url
	if (!dbUrl) {
		console.error('Error: database_url is not defined in backend/.env')
		process.exit(1)
	}

	try {
		await mongoose.connect(dbUrl)
		const isCleanup = process.argv.includes('--cleanup')

		if (isCleanup) {
			await performCleanup()
		} else {
			await performSeed()
		}
	} catch (err) {
		console.error('\n[Execution Error]', err.message)
		process.exit(1)
	} finally {
		await mongoose.disconnect()
	}
}

main()
