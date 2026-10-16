module.exports = (fun) => {
	return (req, res, next) => {
		return fun(req, res, next).catch(next)
	}
}
