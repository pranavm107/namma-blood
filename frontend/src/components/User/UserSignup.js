import React from 'react'
import { Link, useNavigate } from 'react-router-dom'
import StateDropdown from '../UI/StateDropdownFormik'
import CityDropdown from '../UI/CityDropdownFromik'
import { useDispatch } from 'react-redux'
import { registerUser } from '../../store/userSlice'
import { useFormik } from 'formik'
import * as Yup from 'yup'
import Avatar from '@mui/material/Avatar'
import Button from '@mui/material/Button'
import CssBaseline from '@mui/material/CssBaseline'
import TextField from '@mui/material/TextField'
import Grid from '@mui/material/Grid'
import Box from '@mui/material/Box'
import LockOutlinedIcon from '@mui/icons-material/LockOutlined'
import Typography from '@mui/material/Typography'
import Container from '@mui/material/Container'
import Paper from '@mui/material/Paper'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import { FormControlLabel, FormLabel, Radio, RadioGroup } from '@mui/material'
import { toast } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

const theme = createTheme()

const date = new Date().toJSON()
const day = date.slice(8, 10)
const month = date.slice(5, 7)
const year = Number(date.slice(0, 4)) - 18
const newDate = new Date(`${year}-${month}-${day}`).toJSON()

const validationSchema = Yup.object({
	firstName: Yup.string().required('*First name is required.'),
	lastName: Yup.string().required('*Last name is required.'),
	gender: Yup.string().required('*Gender is required.'),
	dob: Yup.date()
		.required('*Date Of Birth is required.')
		.max(newDate, 'You are not eligible to register.'),
	age: Yup.number()
		.required('*Age is required.')
		.positive(`Age can't start with a minus`)
		.integer(`Age can't include a decimal point`)
		.min(18, 'Age must be greater than 18')
		.max(65, 'Age must be less than 65'),
	phoneNo1: Yup.number()
		.required('*A phone number is required.')
		.positive(`A phone number can't start with a minus.`)
		.integer(`A phone number can't include a decimal point.`)
		.min(10, 'Phone number must be exactly 10 digits'),
	phoneNo2: Yup.number()
		.required('*A phone number is required.')
		.positive(`A phone number can't start with a minus.`)
		.integer(`A phone number can't include a decimal point.`)
		.min(10, 'Phone number must be exactly 10 digits'),
	email: Yup.string().email().required('*Email is required.'),
	state: Yup.string().required('*State name is required.'),
	city: Yup.string().required('*City name is required.'),
	address: Yup.string().required('*Address is required.'),
	pinCode: Yup.number()
		.required('*Pin code is required.')
		.positive(`Pin code can't start with a minus.`)
		.integer(`Pin code can't include a decimal point.`)
		.min(6, 'Pin code must be exactly 6 digits'),
	password: Yup.string()
		.required('*Password is required.')
		.min(
			8,
			'Must Contain 8 Characters, One Uppercase, One Lowercase, One Number.'
		),
	passwordConfirm: Yup.string()
		.required('*Password Confirm is required.')
		.min(
			8,
			'Must Contain 8 Characters, One Uppercase, One Lowercase, One Number.'
		)
		.oneOf(
			[Yup.ref('password'), null],
			'Password and passwordConfirm not match.'
		),
})

const Signup = () => {
	const dispatch = useDispatch()
	const navigate = useNavigate()

	const { handleSubmit, handleChange, values, errors, touched } = useFormik({
		initialValues: {
			firstName: '',
			lastName: '',
			gender: '',
			dob: new Date().toJSON().slice(0, 10),
			age: '',
			phoneNo1: '',
			phoneNo2: '',
			email: '',
			state: '',
			city: '',
			address: '',
			pinCode: '',
			password: '',
			passwordConfirm: '',
		},
		validationSchema,
		onSubmit: (values) => {
			addUser(values)
		},
	})

	const addUser = async (body) => {
		const response = await dispatch(registerUser(body))
		if (response?.meta?.requestStatus === 'fulfilled') {
			toast.success(response?.payload?.message)
			navigate('/login/user')
		} else if (response?.meta?.requestStatus === 'rejected') {
			toast.error(response?.payload?.message)
		} else {
			toast.error('Something went wrong. try again later.')
		}
	}

	return (
		<ThemeProvider theme={theme}>
			<Container component='main' maxWidth='xs' sx={{ my: 4 }}>
				<CssBaseline />
				<Paper
					elevation={0}
					sx={{
						p: { xs: 2.5, sm: 4 },
						borderRadius: 3,
						border: '1px solid #e2e8f0',
						backgroundColor: '#ffffff',
						boxShadow: '0 8px 30px rgba(0, 0, 0, 0.04)',
						width: '100%',
					}}
				>
					<Box
						sx={{
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'center',
							mb: 2,
						}}
					>
						<Avatar
							sx={{
								m: 1,
								bgcolor: '#ffebee',
								color: '#c62828',
								width: 52,
								height: 52,
							}}
						>
							<LockOutlinedIcon />
						</Avatar>
						<Typography
							component='h1'
							variant='h5'
							sx={{ fontWeight: 800, color: '#1e293b' }}
						>
							Join Namma Blood
						</Typography>
						<Typography
							variant='caption'
							sx={{ color: '#64748b', textAlign: 'center', mt: 0.5 }}
						>
							Every Drop Matters. Every Life Counts. Register to donate or request blood.
						</Typography>
					</Box>
					<Box
						component='form'
						noValidate
						onSubmit={handleSubmit}
						sx={{ mt: 2 }}
					>
						<Grid container spacing={1}>
							<Grid item xs={12} sm={6}>
								<TextField
									autoFocus
									required
									fullWidth
									id='firstName'
									name='firstName'
									label='First Name'
									onChange={handleChange}
									value={values?.firstName}
								/>
								{touched?.firstName && errors?.firstName && (
									<div className='error-text-display'>
										{errors?.firstName}
									</div>
								)}
							</Grid>

							<Grid item xs={12} sm={6}>
								<TextField
									required
									fullWidth
									id='lastName'
									name='lastName'
									label='Last Name'
									onChange={handleChange}
									value={values?.lastName}
								/>
								{touched?.lastName && errors?.lastName && (
									<div className='error-text-display'>
										{errors?.lastName}
									</div>
								)}
							</Grid>

							<Grid item xs={12}>
								<FormLabel id='demo-controlled-radio-buttons-group'>
									Gender
								</FormLabel>
								<RadioGroup
									row
									aria-labelledby='demo-row-radio-buttons-group-label'
									id='gender'
									name='gender'
									onChange={handleChange}
									value={values?.gender}
								>
									<FormControlLabel
										value='Male'
										control={<Radio />}
										label='Male'
									/>
									<FormControlLabel
										value='Female'
										control={<Radio />}
										label='Female'
									/>
								</RadioGroup>
								{touched?.gender && errors?.gender && (
									<div className='error-text-display'>
										{errors?.gender}
									</div>
								)}
							</Grid>

							<Grid item xs={12} sm={6}>
								<TextField
									required
									fullWidth
									id='dob'
									name='dob'
									label='Date of Birth'
									type='date'
									focused={false}
									inputProps={{
										min: newDate,
									}}
									onChange={handleChange}
									value={values?.dob}
								/>
								{touched?.dob && errors?.dob && (
									<div className='error-text-display'>
										{errors?.dob}
									</div>
								)}
							</Grid>

							<Grid item xs={12} sm={6}>
								<TextField
									required
									fullWidth
									id='age'
									label='Age'
									name='age'
									type='number'
									onChange={handleChange}
									value={values?.age}
								/>
								{touched?.age && errors?.age && (
									<div className='error-text-display'>
										{errors?.age}
									</div>
								)}
							</Grid>

							<Grid item xs={12} sm={6}>
								<TextField
									required
									fullWidth
									id='phoneNo1'
									name='phoneNo1'
									label='Phone number 1'
									type='number'
									onChange={handleChange}
									value={values?.phoneNo1}
								/>
								{touched?.phoneNo1 && errors?.phoneNo1 && (
									<div className='error-text-display'>
										{errors?.phoneNo1}
									</div>
								)}
							</Grid>

							<Grid item xs={12} sm={6}>
								<TextField
									required
									fullWidth
									id='phoneNo2'
									name='phoneNo2'
									label='Phone number 2'
									type='number'
									onChange={handleChange}
									value={values?.phoneNo2}
								/>
								{touched?.phoneNo2 && errors?.phoneNo2 && (
									<div className='error-text-display'>
										{errors?.phoneNo2}
									</div>
								)}
							</Grid>

							<Grid item xs={12}>
								<TextField
									required
									fullWidth
									id='email'
									name='email'
									label='Email Address'
									onChange={handleChange}
									value={values?.email}
								/>
								{touched?.email && errors?.email && (
									<div className='error-text-display'>
										{errors?.email}
									</div>
								)}
							</Grid>

							<Grid item xs={12} sm={6}>
								<StateDropdown
									title='State'
									touched={touched}
									errors={errors}
									values={values}
									handleChange={handleChange}
									
								/>
							</Grid>

							<Grid item xs={12} sm={6}>
								<CityDropdown
									title='City'
									stateName={values?.state}
									canCallApi={values?.state ? true : false}
									touched={touched}
									errors={errors}
									values={values}
									handleChange={handleChange}
								/>
							</Grid>

							<Grid item xs={12}>
								<TextField
									required
									fullWidth
									id='address'
									name='address'
									label='Address'
									onChange={handleChange}
									value={values?.address}
								/>
								{touched?.address && errors?.address && (
									<div className='error-text-display'>
										{errors?.address}
									</div>
								)}
							</Grid>

							<Grid item xs={12}>
								<TextField
									required
									fullWidth
									id='pinCode'
									name='pinCode'
									label='Pin Code'
									type='number'
									onChange={handleChange}
									value={values?.pinCode}
								/>
								{touched?.pinCode && errors?.pinCode && (
									<div className='error-text-display'>
										{errors?.pinCode}
									</div>
								)}
							</Grid>

							<Grid item xs={12}>
								<TextField
									required
									fullWidth
									id='password'
									name='password'
									label='Password'
									type='password'
									onChange={handleChange}
									value={values?.password}
								/>
								{touched?.password && errors?.password && (
									<div className='error-text-display'>
										{errors?.password}
									</div>
								)}
							</Grid>

							<Grid item xs={12}>
								<TextField
									required
									fullWidth
									id='passwordConfirm'
									name='passwordConfirm'
									label='Password Confirm'
									type='password'
									onChange={handleChange}
									value={values?.passwordConfirm}
								/>
								{touched?.passwordConfirm &&
									errors?.passwordConfirm && (
										<div className='error-text-display'>
											{errors?.passwordConfirm}
										</div>
									)}
							</Grid>
						</Grid>
						<Button
							type='submit'
							fullWidth
							variant='contained'
							sx={{
								mt: 3,
								mb: 2,
								py: 1.2,
								backgroundColor: '#c62828',
								fontWeight: 700,
								textTransform: 'none',
								borderRadius: 2,
								boxShadow: '0 4px 12px rgba(198, 40, 40, 0.3)',
								'&:hover': {
									backgroundColor: '#b71c1c',
								},
							}}
						>
							Register as Donor / Recipient
						</Button>
						<Grid container justifyContent='flex-end'>
							<Grid item>
								<Link
									to='/login/user'
									style={{
										fontSize: '0.875rem',
										color: '#c62828',
										fontWeight: 600,
										textDecoration: 'none',
									}}
								>
									Already registered? Sign in here
								</Link>
							</Grid>
						</Grid>
					</Box>
				</Paper>
			</Container>
		</ThemeProvider>
	)
}

export default Signup
