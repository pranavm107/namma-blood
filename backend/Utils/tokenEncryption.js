/**
 * Invitation Token Authenticated Encryption Utility
 * Namma Blood — Hospital-Based Medical Officer Onboarding & Multi-Doctor Association (Stage B3.1)
 *
 * Secures bearer invitation tokens before persistence in asynchronous notification outbox records.
 *
 * Security Requirements:
 * - Uses authenticated encryption (AES-256-GCM) with unique 96-bit initialization vectors (IV).
 * - Enforces dedicated, cryptographically strong encryption key (INVITATION_TOKEN_ENCRYPTION_KEY).
 * - Fails closed immediately if encryption key is absent, empty, or has an invalid length.
 * - Zero fallback to predictable keys or plaintext storage.
 * - Authenticates ciphertext integrity with GCM authentication tags.
 */

const crypto = require('crypto')

const ALGORITHM = 'aes-256-gcm'
const IV_BYTE_LENGTH = 12 // 96 bits recommended for AES-GCM

/**
 * Validates and retrieves the configured 256-bit encryption key.
 * Fails closed if the key is missing or not 32 bytes.
 *
 * @returns {Buffer} 32-byte key buffer
 */
function getEncryptionKey() {
	const keyConfig = process.env.INVITATION_TOKEN_ENCRYPTION_KEY

	if (!keyConfig || typeof keyConfig !== 'string' || keyConfig.trim() === '') {
		const err = new Error(
			'Server configuration error: INVITATION_TOKEN_ENCRYPTION_KEY is not configured. Delivery token encryption cannot proceed.'
		)
		err.statusCode = 500
		throw err
	}

	const trimmed = keyConfig.trim()

	// 64-char hex string (32 bytes)
	if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
		return Buffer.from(trimmed, 'hex')
	}

	// Raw 32-character utf8 buffer
	const rawBuffer = Buffer.from(trimmed, 'utf8')
	if (rawBuffer.length === 32) {
		return rawBuffer
	}

	const err = new Error(
		'Server configuration error: INVITATION_TOKEN_ENCRYPTION_KEY must be a valid 32-byte key (64 hex characters or 32 raw bytes).'
	)
	err.statusCode = 500
	throw err
}

/**
 * Encrypts a raw token string using AES-256-GCM.
 *
 * @param {string} rawToken - Bearer invitation token in plaintext
 * @returns {{ algorithm: string, iv: string, tag: string, encryptedData: string }}
 */
function encryptInvitationToken(rawToken) {
	if (!rawToken || typeof rawToken !== 'string') {
		const err = new Error('Cannot encrypt invalid or empty invitation token.')
		err.statusCode = 400
		throw err
	}

	const key = getEncryptionKey()
	const iv = crypto.randomBytes(IV_BYTE_LENGTH)
	const cipher = crypto.createCipheriv(ALGORITHM, key, iv)

	let encrypted = cipher.update(rawToken, 'utf8', 'hex')
	encrypted += cipher.final('hex')
	const tag = cipher.getAuthTag()

	return {
		algorithm: ALGORITHM,
		iv: iv.toString('hex'),
		tag: tag.toString('hex'),
		encryptedData: encrypted,
	}
}

/**
 * Decrypts and authenticates an encrypted token payload.
 *
 * @param {{ algorithm?: string, iv: string, tag: string, encryptedData: string }} payload
 * @returns {string} Decrypted raw token
 */
function decryptInvitationToken(payload) {
	if (
		!payload ||
		typeof payload !== 'object' ||
		!payload.iv ||
		!payload.tag ||
		!payload.encryptedData
	) {
		const err = new Error('Malformed encryption payload: missing required iv, tag, or encryptedData fields.')
		err.statusCode = 400
		throw err
	}

	const key = getEncryptionKey()
	const iv = Buffer.from(payload.iv, 'hex')
	const tag = Buffer.from(payload.tag, 'hex')
	const decipher = crypto.createDecipheriv(ALGORITHM, key, iv)
	decipher.setAuthTag(tag)

	let decrypted = decipher.update(payload.encryptedData, 'hex', 'utf8')
	decrypted += decipher.final('utf8')

	return decrypted
}

module.exports = {
	getEncryptionKey,
	encryptInvitationToken,
	decryptInvitationToken,
}

