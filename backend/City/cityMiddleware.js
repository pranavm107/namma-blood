const AppError = require('../Utils/appError')

const cityMiddleware = (req, res, next) => {
	const missingValue = []

	if (
		!req.body.stateName ||
		typeof req.body.stateName !== 'string' ||
		!req.body.stateName.trim()
	) {
		missingValue.push('State Name')
	}

	if (
		!req.body.cityName ||
		typeof req.body.cityName !== 'string' ||
		!req.body.cityName.trim()
	) {
		missingValue.push('City Name')
	}

	if (missingValue.length > 0) {
		return next(
			new AppError(
				`Required missing values : ${missingValue.join(', ')}`,
				400
			)
		)
	}

	next()
}

module.exports = {
	cityMiddleware,
}
