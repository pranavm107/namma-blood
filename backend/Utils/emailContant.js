const sendEmail = require('./emailSend')

const registerUserEmail = async (firstName, lastName, email) => {
	const message = `Dear ${firstName} ${lastName},

Welcome to Namma Blood — Blood Donation Platform :)
Every Drop Matters. Every Life Counts.

Thank you for registering into our community-driven platform.
Safe blood is essential for helping people of all ages who suffer
from medical emergencies, trauma, and chronic illnesses. Your donation
saves lives and strengthens our community.

You can now log in to your account here:
http://localhost:3000/login/user

Warm regards,
Namma Blood Community Team`

	await sendEmail({
		email: email,
		subject: 'Welcome to Namma Blood — Blood Donation Platform',
		message,
	})
}

const registerBloodbankEmail = async (bloodbankName, email) => {
	const message = `Dear ${bloodbankName} Team,

Welcome to Namma Blood — Blood Donation Platform.
Your accredited blood bank has been successfully onboarded to our network by the platform administrator.

Your login identifier:
Email: ${email}

Access your Blood Bank Portal here:
http://localhost:3000/login/bloodbank

For security, your account was configured during administrator registration. You can sign in using your established credentials, or use the Forgot Password link to configure a new password:
http://localhost:3000/login/bloodbank

Warm regards,
Namma Blood Administration`

	await sendEmail({
		email: email,
		subject: 'Your Namma Blood Partner Blood Bank Account is Ready',
		message,
	})
}

const forgotPasswordEmail = async (resetToken, email) => {
	const resetURL = `http://localhost:3000/resetpassword/${resetToken}/user`

	await sendEmail({
		email: email,
		subject: 'Namma Blood — Password Reset Token (valid for 10 minutes)',
		message: `Hello,

We received a request to reset your Namma Blood password.
Click the link below to set a new password (valid for 10 minutes):

${resetURL}

If you did not request this, please ignore this email.

Warm regards,
Namma Blood Support Team`,
	})
}

module.exports = {
	registerUserEmail,
	registerBloodbankEmail,
	forgotPasswordEmail,
}
