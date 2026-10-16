const AppError = require('../Utils/appError')

const stateMiddleware = (req, res, next) => {
	const missingValue = []

	if (
		!req.body.stateName ||
		typeof req.body.stateName !== 'string' ||
		!req.body.stateName.trim()
	) {
		missingValue.push('State Name')
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
	stateMiddleware,
}
