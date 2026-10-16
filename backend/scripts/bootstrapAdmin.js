/**
 * Namma Blood — Secure Admin Bootstrapping CLI Script
 *
 * Usage:
 *   Interactive prompt mode:
 *     npm run seed:admin
 *
 *   Environment variable / CI mode:
 *     ADMIN_EMAIL="admin@nammablood.org" ADMIN_PHONE="9876543210" ADMIN_PASSWORD="SecurePassword123" npm run seed:admin
 *
 * Security:
 *   - Passwords are never echoed or printed to stdout/stderr.
 *   - Passwords are hashed using the existing bcryptjs schema pre-save hook.
 *   - Duplicate admin accounts (email or phone) are strictly prevented.
 */

const path = require('path')
const readline = require('readline')
const mongoose = require('mongoose')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const Admin = require('../Admin/adminModel')
const {
	emailValidate,
	passwordLengthValidate,
	passwordValidate,
	passwordSpaceValidate,
	phoneNumberValidate,
} = require('../Common/Functions/validateInputs')

const askQuestion = (query) => {
	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	})
	return new Promise((resolve) => {
		rl.question(query, (answer) => {
			rl.close()
			resolve((answer || '').trim())
		})
	})
}

const askPassword = (promptText) => {
	return new Promise((resolve) => {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		})

		let password = ''
		process.stdout.write(promptText)

		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true)
			process.stdin.resume()
			process.stdin.setEncoding('utf8')

			const onData = (char) => {
				if (char === '\n' || char === '\r' || char === '\u0004') {
					process.stdin.setRawMode(false)
					process.stdin.pause()
					process.stdin.removeListener('data', onData)
					process.stdout.write('\n')
					rl.close()
					resolve(password)
				} else if (char === '\u0003') {
					// Ctrl+C
					process.stdin.setRawMode(false)
					process.stdout.write('\n[Aborted by user]\n')
					process.exit(1)
				} else if (char === '\b' || char === '\x7f') {
					// Backspace
					if (password.length > 0) {
						password = password.slice(0, -1)
						process.stdout.write('\b \b')
					}
				} else {
					password += char
					process.stdout.write('*')
				}
			}

			process.stdin.on('data', onData)
		} else {
			// Non-interactive fallback
			rl.question('', (ans) => {
				rl.close()
				resolve(ans.trim())
			})
		}
	})
}

const validateAdminInputs = (email, phoneNo, password, confirmPassword) => {
	if (!email || !phoneNo || !password) {
		return 'Email, phone number, and password are required.'
	}

	if (!emailValidate(email)) {
		return 'Invalid email address format.'
	}

	if (!phoneNumberValidate(phoneNo)) {
		return 'Invalid phone number. Must be exactly 10 digits.'
	}

	if (!passwordSpaceValidate(password)) {
		return 'Password cannot contain spaces.'
	}

	if (!passwordLengthValidate(password)) {
		return 'Password must be between 8 and 20 characters.'
	}

	if (!passwordValidate(password)) {
		return 'Password contains invalid characters. Use alphanumeric and . _ - characters.'
	}

	if (confirmPassword !== undefined && password !== confirmPassword) {
		return 'Password and confirmation password do not match.'
	}

	return null
}

const bootstrapAdmin = async () => {
	const dbUrl = process.env.database_url
	if (!dbUrl) {
		console.error('[Error] database_url is not defined in backend/.env.')
		process.exit(1)
	}

	console.log('--- Namma Blood: Secure Admin Account Bootstrapper ---')

	try {
		await mongoose.connect(dbUrl, { serverSelectionTimeoutMS: 8000 })
	} catch (connErr) {
		console.error('[Error] Failed to connect to MongoDB database:')
		console.error(connErr.message)
		console.error('Please verify your database_url and MongoDB Atlas network access/IP whitelist.')
		process.exit(1)
	}

	try {
		const existingAdminCount = await Admin.countDocuments()
		const isInteractive = !process.env.ADMIN_EMAIL && !process.env.ADMIN_PHONE && !process.env.ADMIN_PASSWORD
		const forceFlag = process.argv.includes('--force')

		if (existingAdminCount > 0) {
			console.log(`[Notice] Found ${existingAdminCount} existing administrator account(s) in database.`)
			if (!forceFlag) {
				if (isInteractive) {
					const confirm = await askQuestion('An administrator account already exists. Create another? (y/N): ')
					if (confirm.toLowerCase() !== 'y' && confirm.toLowerCase() !== 'yes') {
						console.log('[Info] Operation cancelled by user. No accounts were created.')
						await mongoose.disconnect()
						process.exit(0)
					}
				} else {
					console.error('[Aborted] An admin already exists. Pass --force to create additional accounts in non-interactive mode.')
					await mongoose.disconnect()
					process.exit(1)
				}
			}
		}

		let email = process.env.ADMIN_EMAIL
		let phoneNo = process.env.ADMIN_PHONE
		let password = process.env.ADMIN_PASSWORD
		let confirmPassword

		if (isInteractive) {
			email = await askQuestion('Enter Admin Email: ')
			phoneNo = await askQuestion('Enter Admin 10-digit Phone Number: ')
			password = await askPassword('Enter Admin Password (8-20 characters): ')
			confirmPassword = await askPassword('Confirm Admin Password: ')
		}

		const validationError = validateAdminInputs(email, phoneNo, password, confirmPassword)
		if (validationError) {
			console.error(`[Validation Error] ${validationError}`)
			await mongoose.disconnect()
			process.exit(1)
		}

		// Prevent duplicate email or phone number
		const duplicate = await Admin.findOne({
			$or: [{ email: email.toLowerCase() }, { phoneNo }],
		})

		if (duplicate) {
			if (duplicate.email.toLowerCase() === email.toLowerCase()) {
				console.error(`[Duplicate Error] An admin account with email "${email}" already exists.`)
			} else {
				console.error(`[Duplicate Error] An admin account with phone number "${phoneNo}" already exists.`)
			}
			await mongoose.disconnect()
			process.exit(1)
		}

		// Create admin — schema pre('save') hook handles password hashing with bcryptjs
		await Admin.create({
			email: email.toLowerCase(),
			phoneNo,
			password,
		})

		console.log('\n[Success] Administrator account created successfully.')
		console.log(`  Email: ${email.toLowerCase()}`)
		console.log(`  Phone: ${phoneNo}`)
		console.log('  Password: [PROTECTED — STORED AS BCRYPT HASH]')
	} catch (err) {
		console.error('[Error] Failed to create admin account:', err.message)
		process.exitCode = 1
	} finally {
		await mongoose.disconnect()
	}
}

if (require.main === module) {
	bootstrapAdmin()
}

module.exports = {
	validateAdminInputs,
	bootstrapAdmin,
}
