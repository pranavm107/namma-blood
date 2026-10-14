import React, { useState } from 'react'
import { useDispatch } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import {
	Box,
	Button,
	Card,
	CardContent,
	Chip,
	Container,
	Grid,
	Paper,
	TextField,
	Typography,
} from '@mui/material'
import EmailIcon from '@mui/icons-material/Email'
import PhoneIcon from '@mui/icons-material/Phone'
import LocationOnIcon from '@mui/icons-material/LocationOn'
import SendIcon from '@mui/icons-material/Send'
import { toast } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'
import { addContactus } from '../../store/contactUsSlice'

const ContactUs = () => {
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const [email, setEmail] = useState('')
	const [phone, setPhone] = useState('')
	const [message, setMessage] = useState('')
	const [isSubmitting, setIsSubmitting] = useState(false)

	const validateInputs = () => {
		if (email.trim().length === 0) {
			toast.error('Please enter your email address')
			return false
		}
		if (!/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,3}$/.test(email)) {
			toast.error('Please enter a valid email address')
			return false
		}
		if (phone.trim().length === 0) {
			toast.error('Please enter your phone number')
			return false
		}
		if (phone.trim().length !== 10) {
			toast.error('Phone number must be exactly 10 digits')
			return false
		}
		if (message.trim().length === 0) {
			toast.error('Please enter your message or query')
			return false
		}
		return true
	}

	const handleSubmit = async (event) => {
		event.preventDefault()
		if (!validateInputs()) return

		setIsSubmitting(true)
		try {
			const response = await dispatch(addContactus({ email, phone, message }))
			if (response?.meta?.requestStatus === 'fulfilled') {
				toast.success(response?.payload?.message || 'Message sent successfully to Namma Blood team.')
				navigate('/')
			} else if (response?.meta?.requestStatus === 'rejected') {
				toast.error(response?.payload?.message || 'Failed to submit message.')
			} else {
				toast.error('Something went wrong. Please try again later.')
			}
		} catch (err) {
			toast.error('Network error. Please try again later.')
		} finally {
			setIsSubmitting(false)
		}
	}

	return (
		<Container maxWidth='lg' sx={{ pb: 8 }}>
			<Paper
				elevation={0}
				sx={{
					p: { xs: 3, md: 4 },
					mb: 4,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #fff8f8 100%)',
					border: '1px solid #ffebee',
				}}
			>
				<Chip
					label='GET IN TOUCH'
					sx={{
						backgroundColor: '#ffebee',
						color: '#c62828',
						fontWeight: 700,
						fontSize: '0.75rem',
						letterSpacing: '0.08em',
						mb: 2,
					}}
				/>
				<Typography variant='h4' component='h1' sx={{ fontWeight: 800, color: '#1e293b', mb: 1 }}>
					Contact Namma Blood
				</Typography>
				<Typography variant='body1' sx={{ color: '#64748b' }}>
					Have questions about donation camps, partner onboarding, or need assistance? Reach out to us.
				</Typography>
			</Paper>

			<Grid container spacing={4}>
				<Grid item xs={12} md={5}>
					<StackSection />
				</Grid>

				<Grid item xs={12} md={7}>
					<Paper
						elevation={0}
						sx={{
							p: { xs: 3, md: 4 },
							borderRadius: 3,
							border: '1px solid #e2e8f0',
							backgroundColor: '#ffffff',
						}}
					>
						<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 2 }}>
							Send Us a Message
						</Typography>

						<Box component='form' onSubmit={handleSubmit} noValidate>
							<TextField
								required
								fullWidth
								margin='normal'
								id='email'
								name='email'
								label='Email Address'
								value={email}
								onChange={(e) => setEmail(e.target.value)}
							/>
							<TextField
								required
								fullWidth
								margin='normal'
								id='phone'
								name='phone'
								label='10-digit Phone Number'
								type='tel'
								value={phone}
								onChange={(e) => setPhone(e.target.value)}
							/>
							<TextField
								required
								fullWidth
								multiline
								rows={4}
								margin='normal'
								id='message'
								name='message'
								label='How can we help you?'
								value={message}
								onChange={(e) => setMessage(e.target.value)}
							/>
							<Button
								type='submit'
								fullWidth
								variant='contained'
								disabled={isSubmitting}
								startIcon={<SendIcon />}
								sx={{
									mt: 3,
									py: 1.3,
									backgroundColor: '#c62828',
									fontWeight: 700,
									textTransform: 'none',
									borderRadius: 2,
									'&:hover': {
										backgroundColor: '#b71c1c',
									},
								}}
							>
								{isSubmitting ? 'Sending...' : 'Send Message'}
							</Button>
						</Box>
					</Paper>
				</Grid>
			</Grid>
		</Container>
	)
}

const StackSection = () => (
	<Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
		<Card elevation={0} sx={{ p: 2, borderRadius: 3, border: '1px solid #e2e8f0' }}>
			<CardContent sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', p: 1 }}>
				<PhoneIcon sx={{ color: '#c62828', mt: 0.5 }} />
				<Box>
					<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
						Helpline & Emergencies
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Available 24x7 for urgent blood requests
					</Typography>
					<Typography variant='body2' sx={{ fontWeight: 600, color: '#c62828', mt: 0.5 }}>
						1800-BLOOD-HELP (Toll Free)
					</Typography>
				</Box>
			</CardContent>
		</Card>

		<Card elevation={0} sx={{ p: 2, borderRadius: 3, border: '1px solid #e2e8f0' }}>
			<CardContent sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', p: 1 }}>
				<EmailIcon sx={{ color: '#0284c7', mt: 0.5 }} />
				<Box>
					<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
						Email Support
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						For donor queries and hospital affiliations
					</Typography>
					<Typography variant='body2' sx={{ fontWeight: 600, color: '#1e293b', mt: 0.5 }}>
						support@nammablood.org
					</Typography>
				</Box>
			</CardContent>
		</Card>

		<Card elevation={0} sx={{ p: 2, borderRadius: 3, border: '1px solid #e2e8f0' }}>
			<CardContent sx={{ display: 'flex', gap: 2, alignItems: 'flex-start', p: 1 }}>
				<LocationOnIcon sx={{ color: '#16a34a', mt: 0.5 }} />
				<Box>
					<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b' }}>
						Community Network
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Connecting certified blood banks and voluntary donors across India.
					</Typography>
				</Box>
			</CardContent>
		</Card>
	</Box>
)

export default ContactUs
