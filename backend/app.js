const express = require('express')
const morgan = require('morgan')
const cors = require('cors')

const userRoute = require('./User/userRoute')
const bloodbankRoute = require('./BloodBank/bloodbankRoute')
const bloodbankStaffRoute = require('./BloodBank/bloodbankStaffRoute')
const adminRoute = require('./Admin/adminRoute')
const globleErrorhandler = require('./Utils/errorMiddlewares')
const stateRouter = require('./State/stateRoute')
const cityRouter = require('./City/cityRoute')
const donateRequestsRouter = require('./BloodDonate/bloodDonateRouter')
const receiveRequestsRouter = require('./BloodReceive/bloodReceiveRouter')
const bloodStock = require('./BloodStock/bloodStockRoute')
const bloodUnitRoute = require('./BloodUnit/bloodUnitRoute')
const contactusRoute = require('./ContactUs/contactUsRoute')
const bulkImportRoute = require('./BulkImport/bulkImportRoute')

const mongoose = require('mongoose')

const app = express()

app.use(express.json({ limit: '2mb' }))
app.use(express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }))
app.use(cors())
app.use(morgan('dev'))

// Check DB connection status before handling API requests
app.use((req, res, next) => {
	if (mongoose.connection.readyState !== 1 && req.originalUrl.startsWith('/api')) {
		return res.status(503).json({
			message: 'Database is currently disconnected. Please check MongoDB Atlas network access/IP whitelist.',
		})
	}
	next()
})

app.use('/api/admin/bulk-import', bulkImportRoute)
app.use('/api/admin', adminRoute)
app.use('/api/user', userRoute)
app.use('/api/bloodbank/staff', bloodbankStaffRoute)
app.use('/api/bloodbank', bloodbankRoute)
app.use('/api/state', stateRouter)
app.use('/api/city', cityRouter)
app.use('/api/donaterequests', donateRequestsRouter)
app.use('/api/receiverequests', receiveRequestsRouter)
app.use('/api/bloodstock', bloodStock)
app.use('/api/bloodunit', bloodUnitRoute)
app.use('/api/contactus', contactusRoute)

app.use(globleErrorhandler)

module.exports = app
