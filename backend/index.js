const mongoose = require('mongoose')
require("dotenv").config();
const app = require('./app')
const AppError = require('./Utils/appError')


const connection = async () => {
    try {
        await mongoose.connect(process.env.database_url);
        console.log("Successfully connected your application with database!!");
    } catch (err) {
        console.error("Database connection failed:", err.message);
    }
};
connection();


const PORT = process.env.PORT || 5050
const HOST = process.env.HOST || '0.0.0.0'
app.listen(PORT, HOST, () => {
	console.log(`Server is running on http://${HOST}:${PORT}`)
})


