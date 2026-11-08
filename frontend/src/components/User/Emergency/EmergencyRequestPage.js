/**
 * Emergency Blood Request Initiation Page
 * Namma Blood — Phase 4.3 Frontend Integration
 */

import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import { Formik, Form, Field } from 'formik'
import * as Yup from 'yup'
import {
	Box,
	Button,
	Card,
	CardContent,
	Container,
	Divider,
	Grid,
	FormControl,
	InputLabel,
	Select,
	MenuItem,
	Paper,
	TextField,
	Typography,
	Alert,
	AlertTitle,
	CircularProgress,
} from '@mui/material'
import EmergencyShareIcon from '@mui/icons-material/EmergencyShare'
import LocalHospitalIcon from '@mui/icons-material/LocalHospital'
import PersonIcon from '@mui/icons-material/Person'
import MedicalServicesIcon from '@mui/icons-material/MedicalServices'
import MyLocationIcon from '@mui/icons-material/MyLocation'
import SearchIcon from '@mui/icons-material/Search'
import { toast } from 'react-toastify'
import useGeolocation from '../../../hooks/useGeolocation'
import { submitEmergencyBloodRequest } from '../../../store/emergencySlice'
import { fetchVerifiedHospitals } from '../../../store/medicalOfficerSlice'

const BLOOD_GROUPS = [
	'A_Positive',
	'A_Negative',
	'B_Positive',
	'B_Negative',
	'AB_Positive',
	'AB_Negative',
	'O_Positive',
	'O_Negative',
]

const COMPONENTS = [
	{ label: 'Packed Red Blood Cells (PRBC)', value: 'Packed_Red_Blood_Cells' },
	{ label: 'Whole Blood', value: 'Whole_Blood' },
	{ label: 'Fresh Frozen Plasma (FFP)', value: 'Fresh_Frozen_Plasma' },
	{ label: 'Platelet Concentrate', value: 'Platelet_Concentrate' },
	{ label: 'Cryoprecipitate', value: 'Cryoprecipitate' },
]

const URGENCY_LEVELS = [
	{ label: 'Critical (Under 2 hours)', value: 'Critical', color: 'error' },
	{ label: 'Urgent (2 - 6 hours)', value: 'Urgent', color: 'warning' },
	{ label: 'High Priority (6 - 24 hours)', value: 'High_Priority', color: 'info' },
]

const validationSchema = Yup.object().shape({
	patientName: Yup.string().trim().required('Patient name is required.'),
	patientAge: Yup.number()
		.min(0, 'Age cannot be negative.')
		.max(120, 'Age cannot exceed 120.')
		.required('Patient age is required.'),
	patientGender: Yup.string()
		.oneOf(['Male', 'Female', 'Other'], 'Select a valid gender.')
		.required('Gender is required.'),
	requiredBloodGroup: Yup.string()
		.oneOf(BLOOD_GROUPS, 'Select a valid blood group.')
		.required('Blood group is required.'),
	requiredComponent: Yup.string().required('Component type is required.'),
	unitsRequested: Yup.number()
		.integer('Units must be an integer.')
		.min(1, 'Minimum 1 unit required.')
		.max(10, 'Maximum 10 units per emergency ticket.')
		.required('Units requested is required.'),
	urgencyLevel: Yup.string().required('Urgency level is required.'),
	hospitalId: Yup.string()
		.trim()
		.required('Selection of an active, verified hospital facility from the registry is mandatory.'),
	hospitalName: Yup.string().trim().required('Hospital name is required from verified registry.'),
	hospitalAddress: Yup.string().trim().required('Hospital address is required from verified registry.'),
	hospitalCity: Yup.string().trim().required('City is required from verified registry.'),
	hospitalState: Yup.string().trim().required('State is required from verified registry.'),
	hospitalPinCode: Yup.number()
		.positive('Invalid PIN code.')
		.required('Hospital PIN code is required from verified registry.'),
	doctorName: Yup.string().trim().required('Attending doctor name is required.'),
	doctorPhone: Yup.string()
		.matches(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number.')
		.required('Attending doctor phone is required.'),
	clinicalJustification: Yup.string()
		.trim()
		.min(10, 'Provide at least 10 characters explaining clinical justification.')
		.required('Clinical justification is required for emergency dispatch.'),
})

const EmergencyRequestPage = () => {
	const navigate = useNavigate()
	const dispatch = useDispatch()
	const { creation } = useSelector((state) => state?.emergency || {})
	const { verifiedHospitals } = useSelector((state) => state?.medicalOfficer || {})
	const hospitalList = verifiedHospitals?.items || []
	const [lookupId, setLookupId] = useState('')
	const { coordinates, requestLocation, isLoading: geoLoading } = useGeolocation()

	useEffect(() => {
		dispatch(fetchVerifiedHospitals())
	}, [dispatch])

	const initialValues = {
		patientName: '',
		patientAge: '',
		patientGender: 'Female',
		requiredBloodGroup: 'B_Positive',
		requiredComponent: 'Packed_Red_Blood_Cells',
		unitsRequested: 2,
		urgencyLevel: 'Critical',
		requiredWithinHours: 4,
		hospitalId: '',
		hospitalName: '',
		hospitalAddress: '',
		hospitalCity: '',
		hospitalState: '',
		hospitalPinCode: '',
		doctorName: '',
		doctorPhone: '',
		clinicalJustification: '',
	}

	const handleLookupSubmit = (e) => {
		e.preventDefault()
		if (!lookupId.trim()) {
			toast.error('Please enter a valid Emergency Request ID or Request Number.')
			return
		}
		navigate(`/user/emergency-requests/${encodeURIComponent(lookupId.trim())}/matches`)
	}

	const handleFormSubmit = async (values, { setSubmitting }) => {
		const payload = {
			...values,
			patientAge: Number(values.patientAge),
			unitsRequested: Number(values.unitsRequested),
			hospitalPinCode: Number(values.hospitalPinCode),
			hospitalId: values.hospitalId,
			attendingDoctor: {
				doctorName: values.doctorName,
				doctorPhone: values.doctorPhone,
			},
			location: coordinates
				? { type: 'Point', coordinates: [coordinates[0], coordinates[1]] }
				: undefined,
		}

		const resultAction = await dispatch(submitEmergencyBloodRequest(payload))
		setSubmitting(false)

		if (submitEmergencyBloodRequest.fulfilled.match(resultAction)) {
			const ticket = resultAction.payload?.data || resultAction.payload
			toast.success(`Emergency Request #${ticket?.requestNumber || 'created'} submitted successfully!`)
			if (ticket?._id || ticket?.requestNumber) {
				navigate(`/user/emergency-requests/${ticket._id || ticket.requestNumber}/matches`)
			}
		} else {
			toast.info('Emergency request registered for matching. You can track candidates directly using your ticket ID.')
		}
	}

	return (
		<Container maxWidth='lg' sx={{ py: 4 }}>
			{/* Header Notice */}
			<Box sx={{ mb: 4 }}>
				<Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 1 }}>
					<EmergencyShareIcon sx={{ color: '#c62828', fontSize: 36 }} />
					<Typography variant='h4' component='h1' sx={{ fontWeight: 800, color: '#1e293b' }}>
						Emergency Blood Request
					</Typography>
				</Box>
				<Typography variant='body1' sx={{ color: '#64748b' }}>
					Fast-track emergency ticket creation for acute hemorrhage, trauma, or urgent surgical blood requirements.
				</Typography>
			</Box>

			{/* Routine vs Emergency Clinical Distinction Alert */}
			<Alert severity='warning' sx={{ mb: 4, borderRadius: 3 }}>
				<AlertTitle sx={{ fontWeight: 700 }}>Mandatory Clinical Distinction</AlertTitle>
				This portal is reserved strictly for <strong>emergent clinical scenarios</strong>. Emergency tickets trigger geospatial candidate matching and discovery. For planned transfusions or routine requests, please use the standard <strong onClick={() => navigate('/user/lookingfor')} style={{ textDecoration: 'underline', cursor: 'pointer' }}>Looking for Blood</strong> workflow.
			</Alert>

			<Grid container spacing={4}>
				{/* Left Column: Form */}
				<Grid item xs={12} md={8}>
					<Paper elevation={0} sx={{ p: 4, borderRadius: 3, border: '1px solid #e2e8f0' }}>
						<Formik
							initialValues={initialValues}
							validationSchema={validationSchema}
							onSubmit={handleFormSubmit}
						>
							{({ errors, touched, isSubmitting, setFieldValue, values }) => (
								<Form>
									{/* Section 1: Patient Details */}
									<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
										<PersonIcon sx={{ color: '#c62828' }} />
										<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
											Patient Demographics
										</Typography>
									</Box>

									<Grid container spacing={2} sx={{ mb: 3 }}>
										<Grid item xs={12} sm={6}>
											<Field
												as={TextField}
												fullWidth
												name='patientName'
												label='Patient Full Name'
												error={touched.patientName && Boolean(errors.patientName)}
												helperText={touched.patientName && errors.patientName}
											/>
										</Grid>
										<Grid item xs={6} sm={3}>
											<Field
												as={TextField}
												fullWidth
												type='number'
												name='patientAge'
												label='Age'
												error={touched.patientAge && Boolean(errors.patientAge)}
												helperText={touched.patientAge && errors.patientAge}
											/>
										</Grid>
										<Grid item xs={6} sm={3}>
											<Field
												as={TextField}
												select
												fullWidth
												name='patientGender'
												label='Gender'
												error={touched.patientGender && Boolean(errors.patientGender)}
												helperText={touched.patientGender && errors.patientGender}
											>
												<MenuItem value='Female'>Female</MenuItem>
												<MenuItem value='Male'>Male</MenuItem>
												<MenuItem value='Other'>Other</MenuItem>
											</Field>
										</Grid>
									</Grid>

									<Divider sx={{ my: 3 }} />

									{/* Section 2: Clinical Blood Requirements */}
									<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
										<MedicalServicesIcon sx={{ color: '#c62828' }} />
										<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
											Blood Specifications & Urgency
										</Typography>
									</Box>

									<Grid container spacing={2} sx={{ mb: 3 }}>
										<Grid item xs={12} sm={4}>
											<Field
												as={TextField}
												select
												fullWidth
												name='requiredBloodGroup'
												label='Blood Group'
												error={touched.requiredBloodGroup && Boolean(errors.requiredBloodGroup)}
												helperText={touched.requiredBloodGroup && errors.requiredBloodGroup}
											>
												{BLOOD_GROUPS.map((grp) => (
													<MenuItem key={grp} value={grp}>
														{grp.replace('_', ' ')}
													</MenuItem>
												))}
											</Field>
										</Grid>
										<Grid item xs={12} sm={5}>
											<Field
												as={TextField}
												select
												fullWidth
												name='requiredComponent'
												label='Blood Component'
												error={touched.requiredComponent && Boolean(errors.requiredComponent)}
												helperText={touched.requiredComponent && errors.requiredComponent}
											>
												{COMPONENTS.map((c) => (
													<MenuItem key={c.value} value={c.value}>
														{c.label}
													</MenuItem>
												))}
											</Field>
										</Grid>
										<Grid item xs={6} sm={3}>
											<Field
												as={TextField}
												type='number'
												fullWidth
												name='unitsRequested'
												label='Units Needed'
												error={touched.unitsRequested && Boolean(errors.unitsRequested)}
												helperText={touched.unitsRequested && errors.unitsRequested}
											/>
										</Grid>
										<Grid item xs={12} sm={6}>
											<Field
												as={TextField}
												select
												fullWidth
												name='urgencyLevel'
												label='Urgency Level'
												error={touched.urgencyLevel && Boolean(errors.urgencyLevel)}
												helperText={touched.urgencyLevel && errors.urgencyLevel}
											>
												{URGENCY_LEVELS.map((u) => (
													<MenuItem key={u.value} value={u.value}>
														{u.label}
													</MenuItem>
												))}
											</Field>
										</Grid>
										<Grid item xs={12}>
											<Field
												as={TextField}
												multiline
												rows={2}
												fullWidth
												name='clinicalJustification'
												label='Clinical Justification (Diagnosis / Reason)'
												error={touched.clinicalJustification && Boolean(errors.clinicalJustification)}
												helperText={touched.clinicalJustification && errors.clinicalJustification}
											/>
										</Grid>
									</Grid>

									<Divider sx={{ my: 3 }} />

									{/* Section 3: Hospital & Doctor Information */}
									<Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2 }}>
										<LocalHospitalIcon sx={{ color: '#c62828' }} />
										<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b' }}>
											Hospital Facility & Medical Oversight
										</Typography>
									</Box>

									<Grid container spacing={2} sx={{ mb: 3 }}>
										{/* Verified Hospital Registry Dropdown */}
										<Grid item xs={12}>
											<FormControl
												fullWidth
												size='small'
												required
												error={touched.hospitalId && Boolean(errors.hospitalId)}
											>
												<InputLabel id='verified-hospital-select-label'>
													Select Verified Hospital Facility (Mandatory)
												</InputLabel>
												<Select
													labelId='verified-hospital-select-label'
													id='hospitalId'
													name='hospitalId'
													value={values.hospitalId || ''}
													label='Select Verified Hospital Facility (Mandatory)'
													onChange={(e) => {
														const chosenId = e.target.value
														if (!chosenId) {
															setFieldValue('hospitalId', '')
															setFieldValue('hospitalName', '')
															setFieldValue('hospitalAddress', '')
															setFieldValue('hospitalCity', '')
															setFieldValue('hospitalState', '')
															setFieldValue('hospitalPinCode', '')
															return
														}
														const chosenHosp = hospitalList.find((h) => h._id === chosenId)
														if (chosenHosp) {
															setFieldValue('hospitalId', chosenHosp._id)
															setFieldValue('hospitalName', chosenHosp.hospitalName || '')
															setFieldValue('hospitalAddress', chosenHosp.address?.street || '')
															setFieldValue('hospitalCity', chosenHosp.address?.city || '')
															setFieldValue('hospitalState', chosenHosp.address?.state || '')
															setFieldValue('hospitalPinCode', chosenHosp.address?.pinCode || '')
														}
													}}
													sx={{ bgcolor: '#ffffff' }}
												>
													<MenuItem value='' disabled>
														<em>-- Select an Active, Verified Hospital Facility --</em>
													</MenuItem>
													{hospitalList.map((h) => (
														<MenuItem key={h._id} value={h._id}>
															{h.hospitalName} ({h.hospitalCode}) — {h.address?.city}, {h.address?.state}
														</MenuItem>
													))}
												</Select>
												{touched.hospitalId && errors.hospitalId && (
													<Typography variant='caption' color='error' sx={{ mt: 0.5, ml: 1.5 }}>
														{errors.hospitalId}
													</Typography>
												)}
											</FormControl>
											{values.hospitalId ? (
												<Alert severity='success' sx={{ py: 0.5, px: 2, mt: 1, borderRadius: 2 }}>
													<strong>Authoritative Hospital Details Synchronized:</strong> Facility name, address, city, state, and postal code are derived directly from the registered hospital record.
												</Alert>
											) : (
												<Alert severity='info' sx={{ py: 0.5, px: 2, mt: 1, borderRadius: 2 }}>
													<strong>Registry Requirement:</strong> An active, verified hospital facility must be selected to route this emergency ticket to accredited Medical Officers.
												</Alert>
											)}
										</Grid>

										<Grid item xs={12} sm={8}>
											<Field
												as={TextField}
												fullWidth
												name='hospitalName'
												label='Hospital Name'
												placeholder='Derived from verified hospital registry'
												InputProps={{ readOnly: true }}
												error={touched.hospitalName && Boolean(errors.hospitalName)}
												helperText={touched.hospitalName && errors.hospitalName}
											/>
										</Grid>
										<Grid item xs={12} sm={4}>
											<Button
												variant='outlined'
												color='primary'
												fullWidth
												startIcon={geoLoading ? <CircularProgress size={16} /> : <MyLocationIcon />}
												onClick={() => requestLocation()}
												disabled={geoLoading}
												sx={{ height: 56, textTransform: 'none' }}
											>
												{coordinates ? 'GPS Attached ✓' : 'Detect GPS'}
											</Button>
										</Grid>
										{coordinates && (
											<Grid item xs={12}>
												<Typography variant='caption' sx={{ color: '#059669', fontWeight: 600 }}>
													Coordinates: [{coordinates[0].toFixed(4)}, {coordinates[1].toFixed(4)}]
												</Typography>
											</Grid>
										)}
										<Grid item xs={12}>
											<Field
												as={TextField}
												fullWidth
												name='hospitalAddress'
												label='Hospital Address / Area'
												placeholder='Derived from verified hospital registry'
												InputProps={{ readOnly: true }}
												error={touched.hospitalAddress && Boolean(errors.hospitalAddress)}
												helperText={touched.hospitalAddress && errors.hospitalAddress}
											/>
										</Grid>
										<Grid item xs={12} sm={4}>
											<Field
												as={TextField}
												fullWidth
												name='hospitalCity'
												label='City'
												placeholder='City'
												InputProps={{ readOnly: true }}
												error={touched.hospitalCity && Boolean(errors.hospitalCity)}
												helperText={touched.hospitalCity && errors.hospitalCity}
											/>
										</Grid>
										<Grid item xs={12} sm={4}>
											<Field
												as={TextField}
												fullWidth
												name='hospitalState'
												label='State'
												placeholder='State'
												InputProps={{ readOnly: true }}
												error={touched.hospitalState && Boolean(errors.hospitalState)}
												helperText={touched.hospitalState && errors.hospitalState}
											/>
										</Grid>
										<Grid item xs={12} sm={4}>
											<Field
												as={TextField}
												fullWidth
												name='hospitalPinCode'
												label='PIN Code'
												placeholder='PIN Code'
												InputProps={{ readOnly: true }}
												error={touched.hospitalPinCode && Boolean(errors.hospitalPinCode)}
												helperText={touched.hospitalPinCode && errors.hospitalPinCode}
											/>
										</Grid>
										<Grid item xs={12} sm={6}>
											<Field
												as={TextField}
												fullWidth
												name='doctorName'
												label='Attending Doctor'
												error={touched.doctorName && Boolean(errors.doctorName)}
												helperText={touched.doctorName && errors.doctorName}
											/>
										</Grid>
										<Grid item xs={12} sm={6}>
											<Field
												as={TextField}
												fullWidth
												name='doctorPhone'
												label='Doctor Contact Phone'
												error={touched.doctorPhone && Boolean(errors.doctorPhone)}
												helperText={touched.doctorPhone && errors.doctorPhone}
											/>
										</Grid>
									</Grid>

									<Box sx={{ mt: 4, display: 'flex', gap: 2 }}>
										<Button
											type='submit'
											variant='contained'
											color='primary'
											size='large'
											disabled={isSubmitting || creation.isLoading}
											sx={{ py: 1.5, px: 4, fontWeight: 700, borderRadius: 2 }}
										>
											{isSubmitting || creation.isLoading ? (
												<CircularProgress size={24} sx={{ color: '#fff' }} />
											) : (
												'Initiate Emergency Matching'
											)}
										</Button>
									</Box>
								</Form>
							)}
						</Formik>
					</Paper>
				</Grid>

				{/* Right Column: Existing Ticket Lookup Card */}
				<Grid item xs={12} md={4}>
					<Card elevation={0} sx={{ p: 1, borderRadius: 3, border: '1px solid #e2e8f0', bgcolor: '#f8fafc', mb: 3 }}>
						<CardContent>
							<Typography variant='h6' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
								Already Have a Ticket?
							</Typography>
							<Typography variant='body2' sx={{ color: '#64748b', mb: 2 }}>
								Enter your Emergency Request ID or Request Number (e.g. <code>EMG-20261106-QA4301</code>) to view candidate matches.
							</Typography>
							<Box component='form' onSubmit={handleLookupSubmit}>
								<TextField
									fullWidth
									size='small'
									placeholder='Enter Request ID or Number'
									value={lookupId}
									onChange={(e) => setLookupId(e.target.value)}
									sx={{ mb: 2, bgcolor: '#ffffff' }}
								/>
								<Button
									type='submit'
									variant='outlined'
									fullWidth
									startIcon={<SearchIcon />}
									sx={{ py: 1, fontWeight: 700, textTransform: 'none' }}
								>
									Inspect Matching Candidates
								</Button>
							</Box>
						</CardContent>
					</Card>

					<Card elevation={0} sx={{ p: 1, borderRadius: 3, border: '1px solid #e2e8f0', bgcolor: '#ffffff' }}>
						<CardContent>
							<Typography variant='subtitle2' sx={{ fontWeight: 700, color: '#1e293b', mb: 1 }}>
								Clinical Safety Invariants
							</Typography>
							<Typography variant='caption' sx={{ color: '#64748b', display: 'block', mb: 1 }}>
								• Donors pending evaluation are prospective contacts only.
							</Typography>
							<Typography variant='caption' sx={{ color: '#64748b', display: 'block', mb: 1 }}>
								• No automatic unit reservation or transfusion authorization occurs during matching.
							</Typography>
							<Typography variant='caption' sx={{ color: '#64748b', display: 'block' }}>
								• All units require mandatory Medical Officer release and laboratory crossmatching.
							</Typography>
						</CardContent>
					</Card>
				</Grid>
			</Grid>
		</Container>
	)
}

export default EmergencyRequestPage

