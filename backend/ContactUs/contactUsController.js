const Contactus = require('./contactUsModel')
const catchAsync = require('../Utils/catchAsync')

const addContactUs = catchAsync(async (req, res) => {
	const email = (req.body.email || '').trim().toLowerCase()
	const phone = (req.body.phone || '').trim()
	const message = (req.body.message || '').trim()

	if (!email || !phone || !message) {
		return res.status(400).json({
			message: 'Email, phone, and message are required.',
		})
	}

	await Contactus.create({ email, phone, message })

	return res.status(201).json({
		message: 'Thank you for contactus. We will response you soon.',
	})
})

module.exports = {
	addContactUs,
}
