/**
 * Hospital Registration Form — Admin Hospital Registry Management
 * Namma Blood — Phase 4.3.5 Hospital-Based Medical Officer Verification System
 */

import React, { useState } from 'react'
import { useDispatch, useSelector } from 'react-redux'
import { useNavigate } from 'react-router-dom'
import { Formik, Form, Field } from 'formik'
import * as Yup from 'yup'
import {
	Box,
	Button,
	Card,
	Container,
	Divider,
	Grid,
	MenuItem,
	Paper,
	TextField,
	Typography,
	Alert,
	AlertTitle,
	CircularProgress,
} from '@mui/material'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import MyLocationIcon from '@mui/icons-material/MyLocation'
import ShieldIcon from '@mui/icons-material/Shield'
import { toast } from 'react-toastify'
import useGeolocation from '../../hooks/useGeolocation'
import { registerHospital, resetRegistrationState } from '../../store/adminHospitalSlice'

const VALID_HOSPITAL_TYPES = [
	{ label: 'Private Healthcare Facility', value: 'Private' },
	{ label: 'Government / District Hospital', value: 'Government' },
	{ label: 'Trust / Non-Profit Hospital', value: 'Trust' },
	{ label: 'Autonomous Medical Institute', value: 'Autonomous' },
]

const validationSchema = Yup.object().shape({
	hospitalName: Yup.string().trim().min(3, 'At least 3 characters').required('Hospital name is required.'),
	hospitalType: Yup.string()
		.oneOf(['Government', 'Private', 'Trust', 'Autonomous'], 'Select a valid hospital type.')
		.required('Hospital type is required.'),
	street: Yup.string().trim().required('Street address is required.'),
	city: Yup.string().trim().required('City is required.'),
	state: Yup.string().trim().required('State is required.'),
	pinCode: Yup.string()
		.trim()
		.matches(/^\d{5,8}$/, 'PIN code must be 5 to 8 digits.')
		.required('Postal PIN code is required.'),
	contactPhone: Yup.string()
		.trim()
		.matches(/^[0-9+\-\s]{7,15}$/, 'Enter a valid telephone or mobile contact number.')
		.required('Contact phone number is required.'),
	contactEmail: Yup.string()
		.trim()
		.email('Enter a valid email address.')
		.required('Official contact email is required.'),
})

const RegisterHospital = () => {
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const { isLoading, error } = useSelector((state) => state.adminHospital?.registration || {})
	const { coordinates, requestLocation, isLoading: geoLoading } = useGeolocation()
	const [customLng, setCustomLng] = useState('')
	const [customLat, setCustomLat] = useState('')

	const initialValues = {
		hospitalName: '',
		hospitalType: 'Private',
		street: '',
		city: '',
		state: '',
		pinCode: '',
		contactPhone: '',
		contactEmail: '',
	}

	const handleSubmit = async (values, { setSubmitting, setFieldError }) => {
		let location = undefined
		if (coordinates) {
			location = {
				type: 'Point',
				coordinates: [coordinates[0], coordinates[1]],
			}
		} else if (customLng && customLat) {
			const lng = parseFloat(customLng)
			const lat = parseFloat(customLat)
			if (!isNaN(lng) && !isNaN(lat) && lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
				location = {
					type: 'Point',
					coordinates: [lng, lat],
				}
			}
		}

		const payload = {
			hospitalName: values.hospitalName.trim(),
			hospitalType: values.hospitalType,
			address: {
				street: values.street.trim(),
				city: values.city.trim(),
				state: values.state.trim(),
				pinCode: String(values.pinCode).trim(),
			},
			contactPhone: values.contactPhone.trim(),
			contactEmail: values.contactEmail.trim().toLowerCase(),
			location,
		}

		const resultAction = await dispatch(registerHospital(payload))
		setSubmitting(false)

		if (registerHospital.fulfilled.match(resultAction)) {
			const createdHospital = resultAction.payload
			const generatedCode = createdHospital?.hospitalCode || ''
			toast.success(
				`Hospital '${createdHospital?.hospitalName || payload.hospitalName}' registered successfully with Code: ${generatedCode}`,
				{ toastId: 'hosp-reg-success' }
			)
			dispatch(resetRegistrationState())
			navigate('/admin/hospitals')
		} else {
			const errorPayload = resultAction.payload
			const errMsg = errorPayload?.message || errorPayload || 'Failed to register hospital.'
			toast.error(errMsg, { toastId: 'hospital-reg-error' })

			// Highlight specific field if returned by backend
			if (errorPayload?.field) {
				const f = errorPayload.field.replace('address.', '')
				setFieldError(f, errMsg)
			} else if (Array.isArray(errorPayload?.fields)) {
				errorPayload.fields.forEach((f) => {
					const cleanF = f.replace('address.', '')
					setFieldError(cleanF, `Required field: ${cleanF}`)
				})
			}
		}
	}

	return (
		<Container maxWidth='md' sx={{ pb: 8, pt: 2 }}>
			{/* Breadcrumb / Back button */}
			<Button
				startIcon={<ArrowBackIcon />}
				onClick={() => navigate('/admin/hospitals')}
				sx={{ mb: 2, textTransform: 'none', color: '#64748b', fontWeight: 600 }}
			>
				Back to Hospital Directory
			</Button>

			<Paper
				elevation={0}
				sx={{
					p: 3,
					mb: 3,
					borderRadius: 3,
					background: 'linear-gradient(135deg, #ffffff 0%, #f0fdf4 100%)',
					border: '1px solid #bbf7d0',
					display: 'flex',
					alignItems: 'center',
					gap: 2,
				}}
			>
				<LocalHospitalIcon sx={{ color: '#16a34a', fontSize: 36 }} />
				<Box>
					<Typography variant='h5' sx={{ fontWeight: 800, color: '#1e293b' }}>
						Register Hospital Facility
					</Typography>
					<Typography variant='body2' sx={{ color: '#64748b' }}>
						Onboard an accredited hospital into the central emergency verification network.
					</Typography>
				</Box>
			</Paper>

			<Card
				elevation={0}
				sx={{
					p: { xs: 2.5, md: 4 },
					borderRadius: 3,
					border: '1px solid #e2e8f0',
					backgroundColor: '#ffffff',
				}}
			>
				<Alert severity='info' sx={{ mb: 3, borderRadius: 2 }}>
					<AlertTitle sx={{ fontWeight: 700 }}>Registry Verification Governance</AlertTitle>
					New hospital facilities are registered in <strong>Pending</strong> status and are inactive by default.
					An authorized platform administrator must review institutional credentials before the hospital is activated for Medical Officer oversight.
				</Alert>

				{error && (
					<Alert severity='error' sx={{ mb: 3, borderRadius: 2 }}>
						{error}
					</Alert>
				)}

				<Formik initialValues={initialValues} validationSchema={validationSchema} onSubmit={handleSubmit}>
					{({ errors, touched, isSubmitting }) => (
						<Form>
							<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 2 }}>
								1. Institutional Identity
							</Typography>
							<Grid container spacing={2} sx={{ mb: 3 }}>
								<Grid item xs={12} sm={6}>
									<TextField
										fullWidth
										disabled
										label='Hospital Code (Institutional Identifier)'
										value='[Auto-Generated by System Upon Registration]'
										InputProps={{
											readOnly: true,
										}}
										helperText='Assigned by backend server (Format: HOSP-<CITY>-0001).'
										sx={{
											backgroundColor: '#f8fafc',
											borderRadius: 1,
											'& .MuiInputBase-input.Mui-disabled': {
												WebkitTextFillColor: '#047857',
												fontWeight: 700,
												fontFamily: 'monospace',
												fontSize: '0.875rem',
											},
										}}
									/>
								</Grid>
								<Grid item xs={12} sm={6}>
									<Field
										as={TextField}
										fullWidth
										select
										name='hospitalType'
										label='Facility Classification'
										error={touched.hospitalType && Boolean(errors.hospitalType)}
										helperText={touched.hospitalType && errors.hospitalType}
									>
										{VALID_HOSPITAL_TYPES.map((t) => (
											<MenuItem key={t.value} value={t.value}>
												{t.label}
											</MenuItem>
										))}
									</Field>
								</Grid>
								<Grid item xs={12}>
									<Field
										as={TextField}
										fullWidth
										name='hospitalName'
										label='Full Hospital Name'
										placeholder='e.g. Apollo Main Hospital'
										error={touched.hospitalName && Boolean(errors.hospitalName)}
										helperText={touched.hospitalName && errors.hospitalName}
									/>
								</Grid>
							</Grid>

							<Divider sx={{ my: 3 }} />

							<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 2 }}>
								2. Physical Location & Postal Details
							</Typography>
							<Grid container spacing={2} sx={{ mb: 3 }}>
								<Grid item xs={12}>
									<Field
										as={TextField}
										fullWidth
										name='street'
										label='Street Address / Area'
										placeholder='e.g. 21 Greams Lane, Thousand Lights'
										error={touched.street && Boolean(errors.street)}
										helperText={touched.street && errors.street}
									/>
								</Grid>
								<Grid item xs={12} sm={4}>
									<Field
										as={TextField}
										fullWidth
										name='city'
										label='City'
										error={touched.city && Boolean(errors.city)}
										helperText={touched.city && errors.city}
									/>
								</Grid>
								<Grid item xs={12} sm={4}>
									<Field
										as={TextField}
										fullWidth
										name='state'
										label='State'
										error={touched.state && Boolean(errors.state)}
										helperText={touched.state && errors.state}
									/>
								</Grid>
								<Grid item xs={12} sm={4}>
									<Field
										as={TextField}
										fullWidth
										name='pinCode'
										label='Postal PIN Code'
										placeholder='600006'
										error={touched.pinCode && Boolean(errors.pinCode)}
										helperText={touched.pinCode && errors.pinCode}
									/>
								</Grid>
							</Grid>

							<Divider sx={{ my: 3 }} />

							<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 2 }}>
								3. Contact & Communication
							</Typography>
							<Grid container spacing={2} sx={{ mb: 3 }}>
								<Grid item xs={12} sm={6}>
									<Field
										as={TextField}
										fullWidth
										name='contactPhone'
										label='Primary Contact Phone'
										placeholder='e.g. 04428290200 or 9840123456'
										error={touched.contactPhone && Boolean(errors.contactPhone)}
										helperText={touched.contactPhone && errors.contactPhone}
									/>
								</Grid>
								<Grid item xs={12} sm={6}>
									<Field
										as={TextField}
										fullWidth
										name='contactEmail'
										label='Official Contact Email'
										placeholder='bloodbank@apollo.org'
										error={touched.contactEmail && Boolean(errors.contactEmail)}
										helperText={touched.contactEmail && errors.contactEmail}
									/>
								</Grid>
							</Grid>

							<Divider sx={{ my: 3 }} />

							<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 2 }}>
								4. Geolocation (Optional)
							</Typography>
							<Grid container spacing={2} alignItems='center' sx={{ mb: 4 }}>
								<Grid item xs={12} sm={6}>
									<Button
										variant='outlined'
										color='primary'
										fullWidth
										startIcon={geoLoading ? <CircularProgress size={16} /> : <MyLocationIcon />}
										onClick={() => requestLocation()}
										disabled={geoLoading}
										sx={{ height: 50, textTransform: 'none' }}
									>
										{coordinates ? 'GPS Attached ✓' : 'Detect Current GPS'}
									</Button>
								</Grid>
								<Grid item xs={12} sm={6}>
									{coordinates ? (
										<Typography variant='body2' sx={{ color: '#059669', fontWeight: 600 }}>
											GPS Attached: [{coordinates[0].toFixed(5)}, {coordinates[1].toFixed(5)}]
										</Typography>
									) : (
										<Box sx={{ display: 'flex', gap: 1 }}>
											<TextField
												size='small'
												placeholder='Lng'
												value={customLng}
												onChange={(e) => setCustomLng(e.target.value)}
												sx={{ flex: 1 }}
											/>
											<TextField
												size='small'
												placeholder='Lat'
												value={customLat}
												onChange={(e) => setCustomLat(e.target.value)}
												sx={{ flex: 1 }}
											/>
										</Box>
									)}
								</Grid>
							</Grid>

							<Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 2 }}>
								<Button
									variant='outlined'
									onClick={() => navigate('/admin/hospitals')}
									sx={{ textTransform: 'none', fontWeight: 600 }}
								>
									Cancel
								</Button>
								<Button
									type='submit'
									variant='contained'
									disabled={isSubmitting || isLoading}
									startIcon={isLoading ? <CircularProgress size={18} /> : <ShieldIcon />}
									sx={{
										backgroundColor: '#16a34a',
										fontWeight: 700,
										textTransform: 'none',
										px: 4,
										py: 1.2,
										borderRadius: 2,
										'&:hover': { backgroundColor: '#15803d' },
									}}
								>
									{isLoading ? 'Registering...' : 'Register Hospital'}
								</Button>
							</Box>
						</Form>
					)}
				</Formik>
			</Card>
		</Container>
	)
}

export default RegisterHospital
