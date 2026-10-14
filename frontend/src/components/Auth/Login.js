import React, { useState } from 'react'
import { useDispatch } from 'react-redux'
import { Link, useNavigate, useParams } from 'react-router-dom'
import Avatar from '@mui/material/Avatar'
import Button from '@mui/material/Button'
import CssBaseline from '@mui/material/CssBaseline'
import TextField from '@mui/material/TextField'
import Grid from '@mui/material/Grid'
import Box from '@mui/material/Box'
import Paper from '@mui/material/Paper'
import Chip from '@mui/material/Chip'
import Typography from '@mui/material/Typography'
import Container from '@mui/material/Container'
import BloodtypeIcon from '@mui/icons-material/Bloodtype'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import AdminPanelSettingsIcon from '@mui/icons-material/AdminPanelSettings'
import { toast } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'
import { createTheme, ThemeProvider } from '@mui/material/styles'
import { loginAdmin, loginBloodbank, loginUser } from '../../store/loginslice'

const theme = createTheme({
	palette: {
		primary: {
			main: '#c62828',
		},
	},
})

const Login = () => {
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const { role } = useParams()
	const [errors, setErrors] = useState({
		emailError: '',
		passwordError: '',
	})

	const [user, setUser] = useState({
		email: '',
		password: '',
	})

	const roleConfig = {
		admin: {
			title: 'Admin Portal',
			subtitle: 'Administrative access for Namma Blood system management',
			icon: <AdminPanelSettingsIcon />,
			badgeColor: '#1e293b',
		},
		bloodbank: {
			title: 'Blood Bank Partner Login',
			subtitle: 'Manage blood stock, incoming requests, and donor appointments',
			icon: <LocalHospitalIcon />,
			badgeColor: '#0284c7',
		},
		user: {
			title: 'Donor & Recipient Login',
			subtitle: 'Sign in to schedule donations or request life-saving blood units',
			icon: <BloodtypeIcon />,
			badgeColor: '#c62828',
		},
	}

	const currentRole = roleConfig[role] || roleConfig.user

	const inputChangeHandler = (event) => {
		const { name, value } = event?.target

		if (name === 'email') {
			setErrors((prev) => ({ ...prev, emailError: '' }))
		}
		if (name === 'password') {
			setErrors((prev) => ({ ...prev, passwordError: '' }))
		}

		setUser((prev) => ({ ...prev, [name]: value }))
	}

	const validateInputs = () => {
		let err = 0
		const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,3}$/
		if (!emailRegex.test(user?.email)) {
			setErrors((prev) => ({ ...prev, emailError: 'Please enter a valid email address.' }))
			err++
		}
		if (user?.password?.length < 8 || user?.password?.length > 20) {
			setErrors((prev) => ({
				...prev,
				passwordError: 'Password must be between 8 and 20 characters.',
			}))
			err++
		}
		return err === 0
	}

	const handleSubmit = async (event) => {
		event.preventDefault()
		const isValid = validateInputs()

		if (isValid) {
			if (role === 'user') {
				const response = await dispatch(loginUser(user))
				if (response?.meta?.requestStatus === 'fulfilled') {
					toast.success('Logged in successfully.')
					navigate('/user')
				} else if (response?.meta?.requestStatus === 'rejected') {
					toast.error(response?.payload?.message || 'Login failed.')
				} else {
					toast.error('Something went wrong. Please try again later.')
				}
			} else if (role === 'bloodbank') {
				const response = await dispatch(loginBloodbank(user))
				if (response?.meta?.requestStatus === 'fulfilled') {
					toast.success('Logged in successfully.')
					navigate('/bloodbank')
				} else if (response?.meta?.requestStatus === 'rejected') {
					toast.error(response?.payload?.message || 'Login failed.')
				} else {
					toast.error('Something went wrong. Please try again later.')
				}
			} else if (role === 'admin') {
				const response = await dispatch(loginAdmin(user))
				if (response?.meta?.requestStatus === 'fulfilled') {
					toast.success('Logged in successfully.')
					navigate('/admin/bloodbanks')
				} else if (response?.meta?.requestStatus === 'rejected') {
					toast.error(response?.payload?.message || 'Login failed.')
				} else {
					toast.error('Something went wrong. Please try again later.')
				}
			}
		}
	}

	return (
		<ThemeProvider theme={theme}>
			<Container component='main' maxWidth='xs' sx={{ my: 4 }}>
				<CssBaseline />
				<Paper
					elevation={0}
					sx={{
						p: 4,
						borderRadius: 3,
						border: '1px solid #e2e8f0',
						backgroundColor: '#ffffff',
						boxShadow: '0 8px 30px rgba(0, 0, 0, 0.04)',
						display: 'flex',
						flexDirection: 'column',
						alignItems: 'center',
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
						{currentRole.icon}
					</Avatar>

					<Chip
						label='NAMMA BLOOD'
						size='small'
						sx={{
							backgroundColor: '#ffebee',
							color: '#c62828',
							fontWeight: 700,
							letterSpacing: '0.08em',
							fontSize: '0.7rem',
							mt: 0.5,
							mb: 1,
						}}
					/>

					<Typography component='h1' variant='h5' sx={{ fontWeight: 800, color: '#1e293b', textAlign: 'center' }}>
						{currentRole.title}
					</Typography>
					<Typography variant='caption' sx={{ color: '#64748b', textAlign: 'center', mt: 0.5, mb: 2 }}>
						{currentRole.subtitle}
					</Typography>

					<Box component='form' onSubmit={handleSubmit} noValidate sx={{ width: '100%' }}>
						<TextField
							autoFocus
							required
							fullWidth
							margin='normal'
							id='email'
							name='email'
							label='Email Address'
							value={user.email}
							onChange={inputChangeHandler}
							error={Boolean(errors?.emailError)}
							helperText={errors?.emailError}
						/>

						<TextField
							required
							fullWidth
							margin='normal'
							id='password'
							name='password'
							label='Password'
							type='password'
							value={user.password}
							onChange={inputChangeHandler}
							error={Boolean(errors?.passwordError)}
							helperText={errors?.passwordError}
						/>

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
							Sign In
						</Button>

						<Grid container spacing={1} sx={{ mt: 1 }}>
							<Grid item xs={12} sm={6}>
								<Link
									to='/forgotpassword/user'
									style={{
										fontSize: '0.85rem',
										color: '#64748b',
										textDecoration: 'none',
									}}
								>
									Forgot password?
								</Link>
							</Grid>
							<Grid item xs={12} sm={6} sx={{ textAlign: { sm: 'right' } }}>
								{role === 'user' && (
									<Link
										to='/user/signup'
										style={{
											fontSize: '0.85rem',
											color: '#c62828',
											fontWeight: 600,
											textDecoration: 'none',
										}}
									>
										Create account
									</Link>
								)}
							</Grid>
						</Grid>
					</Box>
				</Paper>
			</Container>
		</ThemeProvider>
	)
}

export default Login
