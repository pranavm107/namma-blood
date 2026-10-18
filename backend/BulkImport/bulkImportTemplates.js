/**
 * Bulk Import CSV Templates and Fictional Samples for Namma Blood
 * Supported entities: BloodBank, City, State
 *
 * CRITICAL INVARIANTS:
 * - Only approved administrative entities are supported.
 * - Samples contain strictly fictional data (no real personal, donor, or patient data).
 * - Values starting with formula characters (=, +, -, @, \t, \r) are sanitized to prevent CSV injection.
 */

// Escape cell values to prevent CSV formula injection in spreadsheet applications
function escapeCsvValue(val) {
	if (val === null || val === undefined) return ''
	let str = String(val)
	// Neutralize formula injection
	if (/^[=+\-@\t\r]/.test(str)) {
		str = `'${str}`
	} else {
		str = str.trim()
	}
	// If string contains comma, quote, or newline, enclose in quotes and escape internal quotes
	if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
		return `"${str.replace(/"/g, '""')}"`
	}
	return str
}

function buildCsv(headers, rows) {
	const headerLine = headers.map(escapeCsvValue).join(',')
	const dataLines = rows.map((row) => headers.map((h) => escapeCsvValue(row[h] || '')).join(','))
	return [headerLine, ...dataLines].join('\r\n') + '\r\n'
}

const TEMPLATES = {
	bloodbank: {
		headers: [
			'bloodbankName',
			'category',
			'contactPerson',
			'address1',
			'address2',
			'state',
			'city',
			'pinCode',
			'phoneNo1',
			'phoneNo2',
			'email',
			'password',
			'openingDate',
		],
		fieldDocumentation: {
			bloodbankName: 'Name of the accredited blood bank (e.g. City Central Blood Center)',
			category: 'Allowed values: Government, RedCross, Private, Charitable',
			contactPerson: 'Full name of the designated coordinator / medical officer',
			address1: 'Street address line 1 (e.g. 104 Medical College Road)',
			address2: 'Street address line 2 / Area (e.g. Sector 5)',
			state: 'State name (must match an existing state in the system, e.g. Karnataka)',
			city: 'City name (must match an existing city under the specified state, e.g. Bengaluru)',
			pinCode: 'Postal code: exactly 6 positive digits (e.g. 560001)',
			phoneNo1: 'Primary phone number: exactly 10 digits, must be unique across all banks',
			phoneNo2: 'Alternate phone number: exactly 10 digits, must be unique across all banks',
			email: 'Official email address, must be unique across all banks',
			password: 'Initial setup password: 8 to 20 characters, min 1 uppercase, 1 lowercase, 1 number, no spaces',
			openingDate: 'Establishment / accreditation date in YYYY-MM-DD format (must be in the past; defaults to today if omitted)',
		},
		samples: [
			{
				bloodbankName: 'City Central Blood Center',
				category: 'Government',
				contactPerson: 'Dr. Ramesh Kumar',
				address1: '124 Hospital Campus Road',
				address2: 'Ward 12',
				state: 'Karnataka',
				city: 'Bengaluru',
				pinCode: '560001',
				phoneNo1: '9845012345',
				phoneNo2: '9845012346',
				email: 'citycentral.blr@example.org',
				password: 'BloodBank@2026',
				openingDate: '2020-01-15',
			},
			{
				bloodbankName: 'Red Cross Regional Blood Bank',
				category: 'RedCross',
				contactPerson: 'Priya Sharma',
				address1: '58 Red Cross Bhavan',
				address2: 'Shivaji Nagar',
				state: 'Karnataka',
				city: 'Bengaluru',
				pinCode: '560051',
				phoneNo1: '9845023456',
				phoneNo2: '9845023457',
				email: 'redcross.blr@example.org',
				password: 'BloodBank@2026',
				openingDate: '2018-06-20',
			},
			{
				bloodbankName: 'Rotary Voluntary Blood Bank',
				category: 'Charitable',
				contactPerson: 'Suresh Menon',
				address1: '15 Community Health Center Road',
				address2: 'Gandhi Nagar',
				state: 'Karnataka',
				city: 'Bengaluru',
				pinCode: '560009',
				phoneNo1: '9845045678',
				phoneNo2: '9845045679',
				email: 'rotaryblood.blr@example.org',
				password: 'BloodBank@2026',
				openingDate: '2019-04-12',
			},
			{
				bloodbankName: 'Apex Health Blood Centre',
				category: 'Private',
				contactPerson: 'Dr. Anand Verma',
				address1: '402 Metro Healthcare Avenue',
				address2: 'Indiranagar',
				state: 'Karnataka',
				city: 'Bengaluru',
				pinCode: '560038',
				phoneNo1: '9845034567',
				phoneNo2: '9845034568',
				email: 'apexhealth.blr@example.org',
				password: 'BloodBank@2026',
				openingDate: '2021-11-10',
			},
		],
	},

	city: {
		headers: ['stateName', 'cityName'],
		fieldDocumentation: {
			stateName: 'State name (must match an existing State record, e.g. Karnataka)',
			cityName: 'City name (must be unique across all cities, e.g. Mysuru)',
		},
		samples: [
			{ stateName: 'Karnataka', cityName: 'Mysuru' },
			{ stateName: 'Karnataka', cityName: 'Mangaluru' },
			{ stateName: 'Karnataka', cityName: 'Hubballi' },
			{ stateName: 'Maharashtra', cityName: 'Pune' },
			{ stateName: 'Maharashtra', cityName: 'Nagpur' },
		],
	},

	state: {
		headers: ['stateName'],
		fieldDocumentation: {
			stateName: 'State name (must be unique across all states, e.g. Karnataka)',
		},
		samples: [
			{ stateName: 'Karnataka' },
			{ stateName: 'Maharashtra' },
			{ stateName: 'Tamil Nadu' },
			{ stateName: 'Telangana' },
			{ stateName: 'Kerala' },
		],
	},
}

function getTemplateCsv(entity) {
	const spec = TEMPLATES[entity]
	if (!spec) return null
	return buildCsv(spec.headers, [])
}

function getSampleCsv(entity) {
	const spec = TEMPLATES[entity]
	if (!spec) return null
	return buildCsv(spec.headers, spec.samples)
}

function getDocumentation(entity) {
	const spec = TEMPLATES[entity]
	if (!spec) return null
	return {
		entity,
		headers: spec.headers,
		fields: spec.fieldDocumentation,
	}
}

module.exports = {
	TEMPLATES,
	getTemplateCsv,
	getSampleCsv,
	getDocumentation,
	escapeCsvValue,
}
