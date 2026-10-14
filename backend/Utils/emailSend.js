const nodemailer = require('nodemailer')

const sendEmail = async (options) => {
	// 1) validation of who is sending and authorization to send email
	const transporter = nodemailer.createTransport({
		service: 'gmail',
		host: process.env.EMAIL_HOST,
		port: process.env.EMAIL_PORT,
		auth: {
			user: process.env.EMAIL_USERNAME,
			pass: process.env.EMAIL_PASSWORD,
		},
	})

	// 2) defining whom to send and all other options (header, message, etc.)
	const mailOptions = {
		from: process.env.EMAIL_USERNAME,
		to: options.email,
		subject: options.subject,
		text: options.message,
	}

	// 3) now actually send the email using async/await
	try {
		const info = await transporter.sendMail(mailOptions)
		return info
	} catch (error) {
		console.error('Email sending failed (check EMAIL_USERNAME and EMAIL_PASSWORD in .env):', error.message)
	}
}

module.exports = sendEmail
