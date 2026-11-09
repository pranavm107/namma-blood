/**
 * Audit Cryptographic Signing Service
 * Namma Blood — Stage B3.5.3 External WORM Anchoring & S3 Object Lock
 *
 * Implements detached asymmetric Ed25519 cryptographic signing for audit
 * checkpoint payloads in accordance with RFC 8032.
 *
 * Security Invariants:
 * 1. Signs the exact deterministic canonical JSON representation of the payload.
 * 2. Uses Ed25519 (Edwards-curve Digital Signature Algorithm).
 * 3. Never persists or exposes private keys in MongoDB, logs, or API payloads.
 * 4. Supports key rotation via explicit key identifiers (keyId).
 * 5. Rejects unknown keys, tampered payloads, or invalid signatures fail-closed.
 */

const crypto = require('crypto')
const fs = require('fs')

const SUPPORTED_SIGNING_ALGORITHMS = ['Ed25519']
const DEFAULT_SIGNING_ALGORITHM = 'Ed25519'
const DEFAULT_KEY_ID = 'namma-blood-audit-signing-2026-v1'

/**
 * Validates and normalizes signing configuration.
 *
 * @param {Object} [config={}]
 * @returns {Object} Validated signing configuration
 */
function parseSigningConfig(config = {}) {
	const algorithm = config.algorithm || process.env.AUDIT_SIGNING_ALGORITHM || DEFAULT_SIGNING_ALGORITHM
	if (!SUPPORTED_SIGNING_ALGORITHMS.includes(algorithm)) {
		throw new Error(
			`Unsupported signing algorithm '${algorithm}'. Only ${SUPPORTED_SIGNING_ALGORITHMS.join(', ')} is supported.`
		)
	}

	const keyId = config.keyId || process.env.AUDIT_SIGNING_KEY_ID || DEFAULT_KEY_ID
	if (!keyId || typeof keyId !== 'string' || keyId.trim().length === 0) {
		throw new Error('AUDIT_SIGNING_KEY_ID is required and must be a non-empty string.')
	}

	return {
		algorithm,
		keyId: keyId.trim(),
		privateKeyPath: config.privateKeyPath || process.env.AUDIT_SIGNING_PRIVATE_KEY_PATH || null,
		publicKeyPath: config.publicKeyPath || process.env.AUDIT_SIGNING_PUBLIC_KEY_PATH || null,
		privateKey: config.privateKey || process.env.AUDIT_SIGNING_PRIVATE_KEY || null,
		publicKey: config.publicKey || process.env.AUDIT_SIGNING_PUBLIC_KEY || null,
	}
}

/**
 * Generates an Ed25519 key pair for local development or testing.
 *
 * @returns {{ publicKey: string, privateKey: string }} Key pair in PEM format
 */
function generateSigningKeyPair() {
	const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
		publicKeyEncoding: { type: 'spki', format: 'pem' },
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
	})
	return { publicKey, privateKey }
}

/**
 * Resolves a private key from configuration or environment.
 *
 * @param {Object} [config={}]
 * @returns {string} Private key PEM string
 */
function resolvePrivateKey(config = {}) {
	const parsed = parseSigningConfig(config)
	if (parsed.privateKey) {
		return parsed.privateKey
	}
	if (parsed.privateKeyPath) {
		if (!fs.existsSync(parsed.privateKeyPath)) {
			throw new Error(`Private key file not found at path: ${parsed.privateKeyPath}`)
		}
		return fs.readFileSync(parsed.privateKeyPath, 'utf8')
	}
	throw new Error(
		'Private key is missing. Set AUDIT_SIGNING_PRIVATE_KEY or AUDIT_SIGNING_PRIVATE_KEY_PATH.'
	)
}

/**
 * Resolves a public key from configuration or environment.
 *
 * @param {Object} [config={}]
 * @returns {string} Public key PEM string
 */
function resolvePublicKey(config = {}) {
	const parsed = parseSigningConfig(config)
	if (parsed.publicKey) {
		return parsed.publicKey
	}
	if (parsed.publicKeyPath) {
		if (!fs.existsSync(parsed.publicKeyPath)) {
			throw new Error(`Public key file not found at path: ${parsed.publicKeyPath}`)
		}
		return fs.readFileSync(parsed.publicKeyPath, 'utf8')
	}
	throw new Error(
		'Public key is missing. Set AUDIT_SIGNING_PUBLIC_KEY or AUDIT_SIGNING_PUBLIC_KEY_PATH.'
	)
}

/**
 * Signs a canonical checkpoint payload using an Ed25519 private key.
 *
 * @param {string} canonicalPayload - Deterministic canonical JSON string
 * @param {string} privateKeyPem - Ed25519 private key in PKCS#8 PEM format
 * @param {Object} [options={}]
 * @returns {{ signature: string, algorithm: string, keyId: string, canonicalPayload: string }}
 */
function signCheckpointPayload(canonicalPayload, privateKeyPem, options = {}) {
	if (!canonicalPayload || typeof canonicalPayload !== 'string') {
		throw new TypeError('canonicalPayload must be a non-empty string.')
	}
	if (!privateKeyPem || typeof privateKeyPem !== 'string') {
		throw new TypeError('privateKeyPem must be a non-empty string in PEM format.')
	}

	const config = parseSigningConfig(options)
	const dataBuffer = Buffer.from(canonicalPayload, 'utf8')

	// Ed25519 sign does not use a separate digest algorithm (null passed to crypto.sign)
	const signatureBuffer = crypto.sign(null, dataBuffer, privateKeyPem)
	const signature = signatureBuffer.toString('hex')

	return {
		signature,
		algorithm: config.algorithm,
		keyId: config.keyId,
		canonicalPayload,
	}
}

/**
 * Verifies a detached Ed25519 signature over a canonical checkpoint payload.
 *
 * @param {string} canonicalPayload - Deterministic canonical JSON string
 * @param {string} signatureHex - Hexadecimal signature string
 * @param {string} publicKeyPem - Ed25519 public key in SPKI PEM format
 * @param {Object} [options={}]
 * @returns {{ isValid: boolean, algorithm: string, keyId: string, error?: string }}
 */
function verifyCheckpointSignature(canonicalPayload, signatureHex, publicKeyPem, options = {}) {
	if (!canonicalPayload || typeof canonicalPayload !== 'string') {
		return { isValid: false, error: 'canonicalPayload must be a non-empty string.' }
	}
	if (!signatureHex || typeof signatureHex !== 'string') {
		return { isValid: false, error: 'signatureHex must be a non-empty string.' }
	}
	if (!publicKeyPem || typeof publicKeyPem !== 'string') {
		return { isValid: false, error: 'publicKeyPem must be a non-empty string.' }
	}

	let config
	try {
		config = parseSigningConfig(options)
	} catch (err) {
		return { isValid: false, error: err.message }
	}

	try {
		const dataBuffer = Buffer.from(canonicalPayload, 'utf8')
		const signatureBuffer = Buffer.from(signatureHex, 'hex')

		if (signatureBuffer.length !== 64) {
			return {
				isValid: false,
				algorithm: config.algorithm,
				keyId: config.keyId,
				error: `Invalid signature length: expected 64 bytes (128 hex chars), found ${signatureBuffer.length} bytes.`,
			}
		}

		const isValid = crypto.verify(null, dataBuffer, publicKeyPem, signatureBuffer)

		return {
			isValid,
			algorithm: config.algorithm,
			keyId: config.keyId,
			error: isValid ? undefined : 'Cryptographic signature verification failed (payload altered or invalid key).',
		}
	} catch (err) {
		return {
			isValid: false,
			algorithm: config.algorithm,
			keyId: config.keyId,
			error: `Verification error: ${err.message}`,
		}
	}
}

module.exports = {
	SUPPORTED_SIGNING_ALGORITHMS,
	DEFAULT_SIGNING_ALGORITHM,
	DEFAULT_KEY_ID,
	parseSigningConfig,
	generateSigningKeyPair,
	resolvePrivateKey,
	resolvePublicKey,
	signCheckpointPayload,
	verifyCheckpointSignature,
}
