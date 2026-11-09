#!/usr/bin/env node
/**
 * Namma Blood — Independent Offline Audit Compliance Verification CLI
 * Stage B3.5.4 Remediation
 *
 * Verifies exported audit checkpoint evidence envelopes, Ed25519 signatures,
 * canonical payload SHA-256 hashes, sequence continuity, and AWS S3 Object Lock
 * COMPLIANCE mode retention evidence completely offline without network calls.
 *
 * Usage:
 *   node backend/scripts/verifyAuditCompliance.js --input <file_or_dir> [options]
 *
 * Options:
 *   --input <path>                   Path to checkpoint JSON file or directory of checkpoints (Required)
 *   --mode <mode>                    Verification mode: offline-crypto | offline-bundle | live-aws (Default: offline-bundle)
 *   --public-key <path>              Path to Ed25519 SPKI PEM public key file (Optional if in env)
 *   --output <path>                  Path to output structured JSON verification report (Optional)
 *   --ledger-id <id>                 Expected ledger ID (Default: GLOBAL_ADMIN_AUDIT_HEAD)
 *   --required-retention-days <days> Minimum acceptable retention days (Explicit configuration; no 7-year assumption)
 *   --json                           Output JSON only to stdout
 *   --help, -h                       Display this help message
 *
 * Exit Codes:
 *   0 = Verification PASSED (Status: VALID)
 *   1 = Verification FAILED (Status: INVALID, INCOMPLETE, or PENDING)
 *   2 = CLI invocation error, path traversal violation, or missing input file
 */

const fs = require('fs')
const path = require('path')
const {
	VERIFICATION_STATUS,
	VERIFICATION_MODE,
	RETENTION_VERIFICATION_SOURCE,
	resolveRequiredRetentionDays,
	validateRequiredRetentionDays,
	verifyExportedEvidenceBundle,
} = require('../Hospital/auditCheckpointComplianceVerifier')
const { GLOBAL_HEAD_ID } = require('../Hospital/auditChainHeadModel')

/**
 * Validates a user-supplied file or directory path against path traversal attacks.
 * Rejects null bytes, relative traversal sequences ('..'), and malformed inputs.
 *
 * @param {string} targetPath - Path supplied by user
 * @param {string} paramName - Parameter name for error reporting
 * @returns {string} Fully resolved absolute path
 */
function assertSafePath(targetPath, paramName = 'path') {
	if (!targetPath || typeof targetPath !== 'string') {
		throw new Error(`Invalid ${paramName}: argument must be a non-empty string.`)
	}

	// Reject null byte injection
	if (targetPath.includes('\0')) {
		throw new Error(`Security Violation: Null byte detected in ${paramName}.`)
	}

	// Strictly reject directory traversal sequences
	const normalized = path.normalize(targetPath)
	if (
		targetPath.includes('..') ||
		normalized.split(path.sep).includes('..') ||
		(targetPath.startsWith('..') || normalized.startsWith('..'))
	) {
		throw new Error(
			`Security Violation: Path traversal sequence ('..') detected in ${paramName}: '${targetPath}'.`
		)
	}

	return path.resolve(targetPath)
}

/**
 * Parses command-line arguments into a structured options object.
 *
 * @param {string[]} argv
 * @returns {object}
 */
function parseArgs(argv) {
	const options = {
		input: null,
		mode: VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE,
		publicKey: null,
		output: null,
		ledgerId: GLOBAL_HEAD_ID,
		requiredRetentionDays: resolveRequiredRetentionDays(),
		jsonOnly: false,
		help: false,
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]

		if (arg === '--help' || arg === '-h') {
			options.help = true
		} else if (arg === '--json') {
			options.jsonOnly = true
		} else if (arg === '--input' && i + 1 < argv.length) {
			options.input = argv[++i]
		} else if (arg === '--mode' && i + 1 < argv.length) {
			const m = argv[++i].toLowerCase()
			if (m === 'offline-crypto' || m === 'crypto') {
				options.mode = VERIFICATION_MODE.OFFLINE_CRYPTOGRAPHIC
			} else if (m === 'offline-bundle' || m === 'bundle') {
				options.mode = VERIFICATION_MODE.OFFLINE_EXPORTED_EVIDENCE
			} else if (m === 'live-aws' || m === 'live') {
				options.mode = VERIFICATION_MODE.LIVE_AWS_VERIFICATION
			} else {
				throw new Error(
					`Invalid --mode: '${m}'. Permitted modes: offline-crypto, offline-bundle, live-aws.`
				)
			}
		} else if (arg === '--public-key' && i + 1 < argv.length) {
			options.publicKey = argv[++i]
		} else if (arg === '--output' && i + 1 < argv.length) {
			options.output = argv[++i]
		} else if (arg === '--ledger-id' && i + 1 < argv.length) {
			options.ledgerId = argv[++i]
		} else if (arg === '--required-retention-days' && i + 1 < argv.length) {
			options.requiredRetentionDays = validateRequiredRetentionDays(argv[++i])
		} else if (arg.startsWith('--')) {
			throw new Error(`Unknown option: ${arg}`)
		}
	}

	return options
}

/**
 * Prints help instructions to stdout.
 */
function printHelp() {
	console.log(`
Namma Blood — Offline Audit Compliance Verification CLI (Stage B3.5.4)

Usage:
  node backend/scripts/verifyAuditCompliance.js --input <path> [options]

Required:
  --input <path>                   Path to a checkpoint JSON file or directory containing exported checkpoints

Options:
  --mode <mode>                    Verification mode: offline-crypto | offline-bundle | live-aws (default: offline-bundle)
  --public-key <path>              Path to Ed25519 SPKI PEM public key file (or set AUDIT_SIGNING_PUBLIC_KEY)
  --output <path>                  Write structured verification report JSON to destination path
  --ledger-id <id>                 Ledger ID to verify against (default: ${GLOBAL_HEAD_ID})
  --required-retention-days <days> Explicit required retention policy in days (or set AUDIT_WORM_REQUIRED_RETENTION_DAYS)
  --json                           Emit JSON report only to stdout (suppresses human-readable format)
  --help, -h                       Show this help message

Exit Codes:
  0 = VALID: All cryptographic, structural, chain continuity, and WORM checks passed
  1 = INVALID / INCOMPLETE: Verification failed or gaps were detected in evidence
  2 = Execution Error: Invalid arguments, path traversal rejection, or unreadable files
`)
}

/**
 * Formats and prints a terminal summary report.
 *
 * @param {object} report
 * @param {object} options
 */
function printTerminalReport(report, options = {}) {
	const BOLD = '\x1b[1m'
	const RESET = '\x1b[0m'
	const GREEN = '\x1b[32m'
	const RED = '\x1b[31m'
	const YELLOW = '\x1b[33m'
	const CYAN = '\x1b[36m'

	const statusColor =
		report.overallStatus === VERIFICATION_STATUS.VALID
			? GREEN
			: report.overallStatus === VERIFICATION_STATUS.INCOMPLETE
			? YELLOW
			: RED

	console.log('')
	console.log(`${BOLD}========================================================================${RESET}`)
	console.log(`${BOLD}             NAMMA BLOOD AUDIT COMPLIANCE VERIFICATION REPORT            ${RESET}`)
	console.log(`${BOLD}========================================================================${RESET}`)
	console.log(`  Report ID:           ${report.verificationId || report.reportId}`)
	console.log(`  Verifier Version:    ${report.verifierVersion}`)
	console.log(`  Verification Mode:   ${CYAN}${report.verificationMode}${RESET}`)
	console.log(`  Live AWS Verified:   ${report.liveAwsVerificationPerformed ? GREEN + 'YES' : YELLOW + 'NO (Offline)'}${RESET}`)
	console.log(`  Retention Source:    ${report.retentionVerificationSource}`)
	console.log(`  Retention Policy:    ${options.requiredRetentionDays ? options.requiredRetentionDays + ' days (Enforced)' : 'None configured (No 7-year assumption)'}`)
	console.log(`  Generated At:        ${report.verificationTimestamp || report.generatedAt}`)
	console.log(`  Target Ledger:       ${CYAN}${report.ledgerId}${RESET}`)
	console.log(`  Overall Status:      ${statusColor}${BOLD}${report.overallStatus}${RESET}`)
	console.log(`  Total Checkpoints:   ${report.verifiedSequenceRange?.totalCheckpoints ?? report.summary?.totalCheckpoints ?? 0}`)
	console.log(`  Sequence Coverage:   ${report.verifiedSequenceRange?.startSequence ?? report.summary?.sequenceRange?.start} -> ${report.verifiedSequenceRange?.endSequence ?? report.summary?.sequenceRange?.end} (${report.verifiedSequenceRange?.totalRecords ?? report.summary?.sequenceRange?.totalSequenceEvents ?? 0} events)`)
	console.log(`  Execution Time:      ${report.metadata?.executionDurationMs ?? 0}ms`)
	console.log(`${BOLD}------------------------------------------------------------------------${RESET}`)

	if (report.warnings && report.warnings.length > 0) {
		console.log(`${BOLD}Notices & Warnings (${report.warnings.length}):${RESET}`)
		for (const w of report.warnings) {
			console.log(`  [${YELLOW}NOTICE${RESET}] ${w}`)
		}
		console.log(`${BOLD}------------------------------------------------------------------------${RESET}`)
	}

	if (report.failedCheckIds && report.failedCheckIds.length > 0) {
		console.log(`${BOLD}Failed Checks (${report.failedCheckIds.length}):${RESET}`)
		for (const chkId of report.failedCheckIds) {
			const detail = report.individualChecks?.find((c) => c.checkId === chkId)
			console.log(`  [${RED}FAIL${RESET}] ${chkId}: ${detail?.details || 'Check failed'}`)
		}
		console.log(`${BOLD}------------------------------------------------------------------------${RESET}`)
	} else if (report.missingEvidenceIds && report.missingEvidenceIds.length > 0) {
		console.log(`${BOLD}Missing Evidence (${report.missingEvidenceIds.length}):${RESET}`)
		for (const chkId of report.missingEvidenceIds) {
			const detail = report.individualChecks?.find((c) => c.checkId === chkId)
			console.log(`  [${YELLOW}MISSING${RESET}] ${chkId}: ${detail?.details || 'Evidence missing'}`)
		}
		console.log(`${BOLD}------------------------------------------------------------------------${RESET}`)
	} else {
		console.log(`  ${GREEN}✓ All cryptographic, structural, and continuity invariants verified.${RESET}`)
		console.log(`${BOLD}------------------------------------------------------------------------${RESET}`)
	}
	console.log('')
}

/**
 * Main CLI execution entry point.
 *
 * @param {string[]} argv
 * @returns {Promise<number>} Exit code
 */
async function main(argv = process.argv.slice(2)) {
	const startTime = Date.now()

	let options
	try {
		options = parseArgs(argv)
	} catch (err) {
		console.error(`CLI Argument Error: ${err.message}`)
		return 2
	}

	if (options.help) {
		printHelp()
		return 0
	}

	if (!options.input) {
		console.error('Error: Missing required argument --input <path>. Use --help for usage.')
		return 2
	}

	// Validate paths against path traversal
	let safeInputPath
	let safeOutputPath = null
	let safePublicKeyPath = null

	try {
		safeInputPath = assertSafePath(options.input, '--input')
		if (options.output) {
			safeOutputPath = assertSafePath(options.output, '--output')
		}
		if (options.publicKey) {
			safePublicKeyPath = assertSafePath(options.publicKey, '--public-key')
		}
	} catch (err) {
		console.error(`Path Security Error: ${err.message}`)
		return 2
	}

	// Verify input exists
	if (!fs.existsSync(safeInputPath)) {
		console.error(`Input Error: Specified input path does not exist: '${safeInputPath}'`)
		return 2
	}

	// Read public key if provided
	let publicKeyPem = null
	if (safePublicKeyPath) {
		try {
			if (!fs.existsSync(safePublicKeyPath)) {
				console.error(`Public Key Error: Specified public key file does not exist: '${safePublicKeyPath}'`)
				return 2
			}
			publicKeyPem = fs.readFileSync(safePublicKeyPath, 'utf8')
		} catch (err) {
			console.error(`Public Key Read Error: ${err.message}`)
			return 2
		}
	} else if (process.env.AUDIT_SIGNING_PUBLIC_KEY_PATH) {
		try {
			const envKeyPath = assertSafePath(
				process.env.AUDIT_SIGNING_PUBLIC_KEY_PATH,
				'AUDIT_SIGNING_PUBLIC_KEY_PATH'
			)
			if (fs.existsSync(envKeyPath)) {
				publicKeyPem = fs.readFileSync(envKeyPath, 'utf8')
			}
		} catch (err) {
			console.error(`Env Public Key Read Error: ${err.message}`)
			return 2
		}
	} else if (process.env.AUDIT_SIGNING_PUBLIC_KEY) {
		publicKeyPem = process.env.AUDIT_SIGNING_PUBLIC_KEY
	} else if (process.env.AUDIT_CHECKPOINT_PUBLIC_KEY) {
		publicKeyPem = process.env.AUDIT_CHECKPOINT_PUBLIC_KEY
	}

	// Ingest evidence bundle (file or directory)
	let rawBundle
	try {
		const stat = fs.statSync(safeInputPath)
		if (stat.isDirectory()) {
			const files = fs.readdirSync(safeInputPath).filter((f) => f.endsWith('.json'))
			if (files.length === 0) {
				console.error(`Input Error: Directory contains no .json checkpoint files: '${safeInputPath}'`)
				return 2
			}
			const checkpoints = []
			for (const file of files) {
				const filePath = path.join(safeInputPath, file)
				const content = fs.readFileSync(filePath, 'utf8')
				const parsed = JSON.parse(content)
				if (Array.isArray(parsed)) {
					checkpoints.push(...parsed)
				} else if (parsed && parsed.checkpoints && Array.isArray(parsed.checkpoints)) {
					checkpoints.push(...parsed.checkpoints)
				} else if (parsed && typeof parsed === 'object') {
					checkpoints.push(parsed)
				}
			}
			rawBundle = {
				bundleVersion: '1.0.0',
				ledgerId: options.ledgerId,
				exportedAt: new Date().toISOString(),
				publicKey: publicKeyPem,
				checkpoints,
			}
		} else {
			const fileContent = fs.readFileSync(safeInputPath, 'utf8')
			rawBundle = JSON.parse(fileContent)
			if (Array.isArray(rawBundle)) {
				rawBundle = {
					bundleVersion: '1.0.0',
					ledgerId: options.ledgerId,
					exportedAt: new Date().toISOString(),
					publicKey: publicKeyPem,
					checkpoints: rawBundle,
				}
			} else if (rawBundle && rawBundle.checkpointId && !rawBundle.checkpoints) {
				rawBundle = {
					bundleVersion: '1.0.0',
					ledgerId: rawBundle.ledgerId || options.ledgerId,
					exportedAt: new Date().toISOString(),
					publicKey: publicKeyPem,
					checkpoints: [rawBundle],
				}
			}
			if (publicKeyPem && !rawBundle.publicKey) {
				rawBundle.publicKey = publicKeyPem
			}
		}
	} catch (err) {
		console.error(`Input Ingestion Error: ${err.message}`)
		return 2
	}

	// Execute independent compliance verification
	let report
	try {
		report = verifyExportedEvidenceBundle(rawBundle, {
			verificationMode: options.mode,
			expectedLedgerId: options.ledgerId,
			requiredRetentionDays: options.requiredRetentionDays,
			publicKey: publicKeyPem,
		})
		if (!report.metadata) {
			report.metadata = {}
		}
		report.metadata.executionDurationMs = Date.now() - startTime
	} catch (err) {
		console.error(`Verification Execution Exception: ${err.message}`)
		return 2
	}

	// Write output report if requested
	if (safeOutputPath) {
		try {
			fs.writeFileSync(safeOutputPath, JSON.stringify(report, null, 2), 'utf8')
		} catch (err) {
			console.error(`Output Write Error: ${err.message}`)
			return 2
		}
	}

	// Output results
	if (options.jsonOnly) {
		console.log(JSON.stringify(report, null, 2))
	} else {
		printTerminalReport(report, options)
	}

	// Determine exit code
	if (report.overallStatus === VERIFICATION_STATUS.VALID) {
		return 0
	} else {
		return 1
	}
}

// Execute if run directly from CLI
if (require.main === module) {
	main(process.argv.slice(2))
		.then((exitCode) => {
			process.exit(exitCode)
		})
		.catch((err) => {
			console.error(`Unhandled Fatal Error: ${err.message}`)
			process.exit(2)
		})
}

module.exports = {
	main,
	assertSafePath,
	parseArgs,
}
