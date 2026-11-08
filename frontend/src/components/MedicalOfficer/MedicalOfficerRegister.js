import React, { useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { Link, useNavigate } from 'react-router-dom'
import {
	Container,
	Paper,
	Box,
	Typography,
	TextField,
	Button,
	Grid,
	Alert,
	AlertTitle,
	CircularProgress,
	Divider,
	Chip,
} from '@mui/material'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser'
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline'
import { registerMedicalOfficerAsync, resetRegistrationState } from '../../store/medicalOfficerSlice'

const MedicalOfficerRegister = () => {
	const dispatch = useDispatch()
	const navigate = useNavigate()
	const { isLoading, success, error, registeredOfficer } = useSelector(
		(state) => state.medicalOfficer.registration
	)

	const [formData, setFormData] = useState({
		firstName: '',
		lastName: '',
		email: '',
		phoneNo1: '',
		password: '',
		confirmPassword: '',
		medicalRegistrationNumber: '',
		medicalCouncil: '',
		registrationState: '',
		qualification: '',
		specialization: '',
		supportingEvidence: '',
	})

	const [clientErrors, setClientErrors] = useState({})

	const handleChange = (e) => {
		const { name, value } = e.target
		setFormData((prev) => ({ ...prev, [name]: value }))
		if (clientErrors[name]) {
			setClientErrors((prev) => ({ ...prev, [name]: '' }))
		}
	}

	const validate = () => {
		const errors = {}
		if (!formData.firstName.trim()) errors.firstName = 'First name is required.'
		if (!formData.lastName.trim()) errors.lastName = 'Last name is required.'

		const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
		if (!formData.email.trim()) {
			errors.email = 'Email address is required.'
		} else if (!emailRegex.test(formData.email.trim())) {
			errors.email = 'Please enter a valid email address.'
		}

		const cleanPhone = String(formData.phoneNo1).replace(/\D/g, '')
		if (!cleanPhone) {
			errors.phoneNo1 = 'Contact phone number is required.'
		} else if (cleanPhone.length !== 10) {
			errors.phoneNo1 = 'Contact phone number must be exactly 10 digits.'
		}

		if (!formData.password) {
			errors.password = 'Password is required.'
		} else if (formData.password.length < 8 || formData.password.length > 20) {
			errors.password = 'Password must be between 8 and 20 characters.'
		}

		if (formData.password !== formData.confirmPassword) {
			errors.confirmPassword = 'Passwords do not match.'
		}

		if (!formData.medicalRegistrationNumber.trim()) {
			errors.medicalRegistrationNumber = 'Medical Registration Number is required.'
		}

		if (!formData.medicalCouncil.trim()) {
			errors.medicalCouncil = 'Medical Council / Registration Authority is required.'
		}

		setClientErrors(errors)
		return Object.keys(errors).length === 0
	}

	const handleSubmit = (e) => {
		e.preventDefault()
		if (!validate()) return

		const payload = {
			firstName: formData.firstName.trim(),
			lastName: formData.lastName.trim(),
			email: formData.email.trim().toLowerCase(),
			phoneNo1: parseInt(String(formData.phoneNo1).replace(/\D/g, ''), 10),
			password: formData.password,
			medicalRegistrationNumber: formData.medicalRegistrationNumber.trim(),
			medicalCouncil: formData.medicalCouncil.trim(),
			registrationState: formData.registrationState.trim(),
			qualification: formData.qualification.trim(),
			specialization: formData.specialization.trim(),
			supportingEvidence: formData.supportingEvidence.trim(),
		}

		dispatch(registerMedicalOfficerAsync(payload))
	}

	const handleProceedToLogin = () => {
		dispatch(resetRegistrationState())
		navigate('/login/medical-officer')
	}

	if (success && registeredOfficer) {
		return (
			<Container maxWidth="md" sx={{ py: 6 }}>
				<Paper elevation={3} sx={{ p: 4, borderRadius: 2, textAlign: 'center' }}>
					<Box sx={{ display: 'flex', justifyContent: 'center', mb: 2 }}>
						<CheckCircleOutlineIcon sx={{ fontSize: 64, color: '#059669' }} />
					</Box>
					<Typography variant="h5" sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
						Registration Successful
					</Typography>
					<Typography variant="body1" sx={{ color: '#64748b', mb: 3 }}>
						Welcome, Dr. {registeredOfficer.firstName} {registeredOfficer.lastName}! Your Medical Officer account has been created.
					</Typography>

					<Alert severity="info" sx={{ textAlign: 'left', mb: 3 }}>
						<AlertTitle sx={{ fontWeight: 700 }}>Next Steps: Clinical Verification & Hospital Affiliation</AlertTitle>
						Your account is active for authentication, but clinical operations are gated:
						<Box component="ul" sx={{ pl: 2, mt: 1, mb: 0 }}>
							<li><strong>Account Lifecycle:</strong> {registeredOfficer.accountStatus}</li>
							<li><strong>Professional Credentials:</strong> {registeredOfficer.credentialStatus} (Administrative verification required)</li>
							<li><strong>Hospital Affiliations:</strong> None assigned (Hospital nomination or Admin assignment required)</li>
						</Box>
					</Alert>

					<Box sx={{ mt: 3, display: 'flex', justifyContent: 'center', gap: 2 }}>
						<Button
							variant="contained"
							onClick={handleProceedToLogin}
							sx={{
								backgroundColor: '#059669',
								'&:hover': { backgroundColor: '#047857' },
								px: 4,
								py: 1.2,
								fontWeight: 600,
							}}
						>
							Proceed to Medical Officer Login
						</Button>
					</Box>
				</Paper>
			</Container>
		)
	}

	return (
		<Container maxWidth="md" sx={{ py: 5 }}>
			<Paper elevation={2} sx={{ p: { xs: 3, sm: 5 }, borderRadius: 2 }}>
				<Box sx={{ display: 'flex', alignItems: 'center', mb: 1, gap: 1.5 }}>
					<LocalHospitalIcon sx={{ fontSize: 32, color: '#059669' }} />
					<Typography variant="h5" sx={{ fontWeight: 700, color: '#1e293b' }}>
						Medical Officer Self-Registration
					</Typography>
				</Box>
				<Typography variant="body2" sx={{ color: '#64748b', mb: 3 }}>
					Register independently as a qualified medical practitioner. Clinical verification access requires subsequent credential review and verified hospital facility affiliation.
				</Typography>

				<Alert severity="warning" sx={{ mb: 4 }}>
					<AlertTitle sx={{ fontWeight: 700 }}>Clinical Governance & Three-Gate Security Notice</AlertTitle>
					Independent registration does not automatically grant clinical verification authority. Emergency blood request approvals are strictly protected by three authorization gates: (1) Active account status, (2) Verified professional medical credentials, and (3) Active hospital affiliation.
				</Alert>

				{error && (
					<Alert severity="error" sx={{ mb: 3 }}>
						{typeof error === 'string' ? error : error?.message || 'Registration failed. Please check your entries.'}
					</Alert>
				)}

				<Box component="form" onSubmit={handleSubmit} noValidate>
					{/* Section 1: Personal Information */}
					<Typography variant="subtitle1" sx={{ fontWeight: 700, color: '#334155', mb: 1.5 }}>
						1. Personal Information
					</Typography>
					<Grid container spacing={2} sx={{ mb: 3 }}>
						<Grid item xs={12} sm={6}>
							<TextField
								required
								fullWidth
								label="First Name"
								name="firstName"
								value={formData.firstName}
								onChange={handleChange}
								error={Boolean(clientErrors.firstName)}
								helperText={clientErrors.firstName}
								placeholder="e.g. Ramesh"
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								required
								fullWidth
								label="Last Name"
								name="lastName"
								value={formData.lastName}
								onChange={handleChange}
								error={Boolean(clientErrors.lastName)}
								helperText={clientErrors.lastName}
								placeholder="e.g. Cardiologist"
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								required
								fullWidth
								type="email"
								label="Email Address"
								name="email"
								value={formData.email}
								onChange={handleChange}
								error={Boolean(clientErrors.email)}
								helperText={clientErrors.email || 'Will be normalized to lower-case'}
								placeholder="doctor@hospital.org"
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								required
								fullWidth
								label="Primary Contact Number"
								name="phoneNo1"
								value={formData.phoneNo1}
								onChange={handleChange}
								error={Boolean(clientErrors.phoneNo1)}
								helperText={clientErrors.phoneNo1 || '10-digit mobile number'}
								placeholder="9876543210"
							/>
						</Grid>
					</Grid>

					<Divider sx={{ my: 3 }} />

					{/* Section 2: Professional Medical Registration */}
					<Typography variant="subtitle1" sx={{ fontWeight: 700, color: '#334155', mb: 1.5 }}>
						2. Professional Registration Details
					</Typography>
					<Grid container spacing={2} sx={{ mb: 3 }}>
						<Grid item xs={12} sm={6}>
							<TextField
								required
								fullWidth
								label="Medical Registration Number"
								name="medicalRegistrationNumber"
								value={formData.medicalRegistrationNumber}
								onChange={handleChange}
								error={Boolean(clientErrors.medicalRegistrationNumber)}
								helperText={clientErrors.medicalRegistrationNumber || 'MCI / NMC / State Medical Council Number'}
								placeholder="e.g. KMC-12345-2020"
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								required
								fullWidth
								label="Medical Council / Authority"
								name="medicalCouncil"
								value={formData.medicalCouncil}
								onChange={handleChange}
								error={Boolean(clientErrors.medicalCouncil)}
								helperText={clientErrors.medicalCouncil}
								placeholder="e.g. Karnataka Medical Council"
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								fullWidth
								label="Registration State / Region"
								name="registrationState"
								value={formData.registrationState}
								onChange={handleChange}
								placeholder="e.g. Karnataka"
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								fullWidth
								label="Primary Qualification"
								name="qualification"
								value={formData.qualification}
								onChange={handleChange}
								placeholder="e.g. MBBS, MD (Transfusion Medicine)"
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								fullWidth
								label="Clinical Specialization"
								name="specialization"
								value={formData.specialization}
								onChange={handleChange}
								placeholder="e.g. Hematology, General Medicine"
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								fullWidth
								label="Supporting Evidence / Registry URL"
								name="supportingEvidence"
								value={formData.supportingEvidence}
								onChange={handleChange}
								placeholder="Link to council registry entry"
							/>
						</Grid>
					</Grid>

					<Divider sx={{ my: 3 }} />

					{/* Section 3: Account Credentials */}
					<Typography variant="subtitle1" sx={{ fontWeight: 700, color: '#334155', mb: 1.5 }}>
						3. Account Security
					</Typography>
					<Grid container spacing={2} sx={{ mb: 4 }}>
						<Grid item xs={12} sm={6}>
							<TextField
								required
								fullWidth
								type="password"
								label="Password"
								name="password"
								value={formData.password}
								onChange={handleChange}
								error={Boolean(clientErrors.password)}
								helperText={clientErrors.password || 'Must be 8 to 20 characters'}
							/>
						</Grid>
						<Grid item xs={12} sm={6}>
							<TextField
								required
								fullWidth
								type="password"
								label="Confirm Password"
								name="confirmPassword"
								value={formData.confirmPassword}
								onChange={handleChange}
								error={Boolean(clientErrors.confirmPassword)}
								helperText={clientErrors.confirmPassword}
							/>
						</Grid>
					</Grid>

					<Box sx={{ display: 'flex', flexDirection: { xs: 'column', sm: 'row' }, gap: 2, alignItems: 'center', justifyContent: 'space-between' }}>
						<Typography variant="body2" sx={{ color: '#64748b' }}>
							Already have an account?{' '}
							<Link to="/login/medical-officer" style={{ color: '#059669', fontWeight: 700, textDecoration: 'none' }}>
								Sign in here &rarr;
							</Link>
						</Typography>

						<Button
							type="submit"
							variant="contained"
							disabled={isLoading}
							sx={{
								backgroundColor: '#059669',
								'&:hover': { backgroundColor: '#047857' },
								px: 4,
								py: 1.2,
								fontWeight: 700,
								minWidth: 200,
							}}
						>
							{isLoading ? <CircularProgress size={24} sx={{ color: '#ffffff' }} /> : 'Register Account'}
						</Button>
					</Box>
				</Box>
			</Paper>
		</Container>
	)
}

export default MedicalOfficerRegister

