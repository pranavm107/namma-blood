/**
 * Namma Blood — Seed Tamil Nadu and Associated Cities
 *
 * Usage:
 *   node scripts/seedTamilNadu.js
 *   or: npm run seed:tn
 *
 * Ensures Tamil Nadu and its key cities are present in MongoDB
 * before administrators run bulk imports for Tamil Nadu blood banks.
 * Idempotent: safe to run multiple times without duplicates.
 */

const path = require('path')
const mongoose = require('mongoose')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const State = require('../State/stateModel')
const City = require('../City/cityModel')

function escapeRegex(text) {
	return String(text).replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')
}

const TAMIL_NADU_CITIES = [
	'Chennai',
	'Coimbatore',
	'Madurai',
	'Tiruchirappalli',
	'Salem',
	'Tirunelveli',
	'Erode',
	'Vellore',
	'Thanjavur',
	'Tiruppur',
	'Thoothukudi',
	'Nagercoil',
	'Hosur',
	'Pollachi',
]

async function seed() {
	const dbUrl = process.env.database_url
	if (!dbUrl) {
		console.error('Error: database_url is not set in environment or backend/.env')
		process.exit(1)
	}

	try {
		await mongoose.connect(dbUrl)
		console.log('Connected to database.')

		// 1. Ensure State: Tamil Nadu
		let state = await State.findOne({
			stateName: { $regex: new RegExp(`^${escapeRegex('Tamil Nadu')}$`, 'i') },
		})

		if (!state) {
			state = await State.create({ stateName: 'Tamil Nadu' })
			console.log(`[CREATED] State: ${state.stateName}`)
		} else {
			console.log(`[EXISTS] State: ${state.stateName}`)
		}

		// 2. Ensure Cities
		let createdCount = 0
		let existingCount = 0

		for (const cityName of TAMIL_NADU_CITIES) {
			const existingCity = await City.findOne({
				cityName: { $regex: new RegExp(`^${escapeRegex(cityName)}$`, 'i') },
			})

			if (!existingCity) {
				await City.create({
					stateName: state.stateName,
					cityName,
				})
				console.log(`  + [CREATED] City: ${cityName} (State: ${state.stateName})`)
				createdCount++
			} else {
				console.log(`  = [EXISTS] City: ${existingCity.cityName} (State: ${existingCity.stateName})`)
				existingCount++
			}
		}

		console.log(`\nSeeding completed: ${createdCount} cities created, ${existingCount} already existed.`)
	} catch (err) {
		console.error('Seeding failed:', err.message)
		process.exit(1)
	} finally {
		await mongoose.disconnect()
		console.log('Database connection closed.')
	}
}

seed()
