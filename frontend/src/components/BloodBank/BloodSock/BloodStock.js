import React, { useEffect, useState } from 'react'
import styled from '@emotion/styled'
import {
	Box,
	Button,
	Dialog,
	DialogActions,
	DialogContent,
	DialogContentText,
	DialogTitle,
	Grid,
	TextField,
	Alert,
	Chip,
} from '@mui/material'
import Paper from '@mui/material/Paper'
import { useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import BloodTypeDropdown from '../../UI/BloodTypeDropdown'
import { getBloodStock, updateStock } from '../../../store/stockSlice'
import BloodStockLoader from '../../UI/BloodStockLoader'
import { toast } from 'react-toastify'
import 'react-toastify/dist/ReactToastify.css'

const Item = styled(Paper)(({ theme }) => ({
	...theme.typography.body2,
	padding: theme.spacing(1),
	textAlign: 'center',
	backgroundColor: '#ed907e',
	fontSize: 20,
	fontWeight: 'bold',
	color: theme.palette.text.secondary,
}))

const BloodStock = () => {
	const dispatch = useDispatch()
	const navigate = useNavigate()
	const { stock, isLoading } = useSelector((state) => state?.stock)
	const [open, setOpen] = useState(false)
	const [bloodType, setBloodType] = useState('')
	const [unit, setUnit] = useState(0)
	const [temp, setTemp] = useState(false)
	const [error, setError] = useState('')

	useEffect(() => {
		dispatch(getBloodStock())
	}, [dispatch, temp])

	const handleClose = () => {
		setUnit(0)
		setBloodType('')
		setOpen(false)
	}

	const setBloodtypeDataHandler = (bloodType) => {
		setBloodType(bloodType)
		setError('')
	}

	const getDisplayStock = (bg) => {
		if (stock?.legacyUnverifiedStock && typeof stock.legacyUnverifiedStock[bg] === 'number') {
			return stock.legacyUnverifiedStock[bg]
		}
		return stock?.[bg] ?? 0
	}

	const onStockChangeHandler = (e) => {
		if (bloodType !== '') {
			const currentCount = getDisplayStock(bloodType)
			if (currentCount + Number(e.target.value) >= 0) {
				setError('')
				setUnit(e.target.value)
			} else {
				setError('You can not decrease stock more than you have.')
			}
		} else {
			setError('Please select Blood type')
		}
	}

	const addStockHandler = async () => {
		if (bloodType?.length === 0) {
			toast.error('Select blood type')
			return
		}
		if (unit === 0) {
			toast.error('Enter how many unit you can increase or decrease')
			return
		}
		const response = await dispatch(updateStock({ [bloodType]: unit }))
		if (response?.meta?.requestStatus === 'fulfilled') {
			toast.success(response?.payload?.message)
			setOpen(false)
			setUnit(0)
			setTemp(!temp)
			dispatch(getBloodStock())
		} else if (response?.meta?.requestStatus === 'rejected') {
			toast.error(response?.payload?.message)
		} else {
			toast.error('Something went wrong. try again later.')
		}
	}

	return (
		<>
			{/* Unverified Aggregate Stock Demarcation Banner */}
			<Alert
				severity='warning'
				sx={{ mb: 3 }}
				action={
					<Box sx={{ display: 'flex', gap: 1 }}>
						<Button
							color='inherit'
							size='small'
							variant='outlined'
							onClick={() => navigate('/bloodbank/inventory')}
						>
							Traceable Units
						</Button>
						<Button
							color='inherit'
							size='small'
							variant='outlined'
							onClick={() => navigate('/bloodbank/reconciliation')}
						>
							Reconciliation
						</Button>
					</Box>
				}
			>
				<strong>UNVERIFIED LEGACY AGGREGATE STOCK:</strong> The counts below reflect legacy whole-blood aggregate estimates. They lack individual DIN barcodes, mandatory 5-panel TTI screening, and Medical Officer clearance. <strong>Never issue unverified stock to patients.</strong> Use the <strong>Reconciliation Console</strong> to audit and migrate aggregate stock into traceable units.
			</Alert>

			{stock?.inventoryClassification === 'HYBRID_TRANSITIONAL' && (
				<Alert severity='info' sx={{ mb: 2 }}>
					<strong>Transitional Inventory Notice:</strong> Displaying raw unverified legacy aggregate numbers below. Verified traceable units ({stock?.traceableVerifiedStock?.A_Positive ?? 0} A+, {stock?.traceableVerifiedStock?.O_Positive ?? 0} O+) are tracked separately in the <strong>Traceable Units</strong> console.
				</Alert>
			)}

			<Grid container spacing={2} columns={12} alignItems='center' sx={{ mb: 2 }}>
				<Grid item xs={10}>
					<Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
						<h1 style={{ color: '#b45309', margin: 0 }}>Legacy Blood Stock</h1>
						<Chip label='Unverified Aggregate' color='warning' size='small' variant='outlined' />
					</Box>
				</Grid>
				<Grid item xs={2}>
					<Button
						variant='contained'
						color='primary'
						onClick={() => setOpen(true)}
					>
						Update Stock
					</Button>
				</Grid>
			</Grid>

			{isLoading ? (
				<BloodStockLoader />
			) : (
				<Box sx={{ width: '100%', border: '1px solid grey', p: 2 }}>
					<Grid
						sx={{ m: 2 }}
						container
						rowSpacing={1}
						columnSpacing={{ xs: 1, sm: 2, md: 3 }}
					>
						<Grid item xs={3}>
							<Item>A+ : {getDisplayStock('A_Positive')}</Item>
						</Grid>
						<Grid item xs={3}>
							<Item>A- : {getDisplayStock('A_Negative')}</Item>
						</Grid>
						<Grid item xs={3}>
							<Item>B+ : {getDisplayStock('B_Positive')}</Item>
						</Grid>
						<Grid item xs={3}>
							<Item>B- : {getDisplayStock('B_Negative')}</Item>
						</Grid>
						<Grid item xs={3}>
							<Item>AB+ : {getDisplayStock('AB_Positive')}</Item>
						</Grid>
						<Grid item xs={3}>
							<Item>AB- : {getDisplayStock('AB_Negative')}</Item>
						</Grid>
						<Grid item xs={3}>
							<Item>O+ : {getDisplayStock('O_Positive')}</Item>
						</Grid>
						<Grid item xs={3}>
							<Item>O- : {getDisplayStock('O_Negative')}</Item>
						</Grid>
					</Grid>
				</Box>
			)}

			<Dialog open={open} onClose={handleClose}>
				<DialogTitle>Update Stock</DialogTitle>
				<DialogContent>
					<DialogContentText sx={{ mb: 2 }}>
						Choose Blood Type and enter amount you want to update
						(if you give positive number it will increase stock else
						decrease stock)
					</DialogContentText>
					<BloodTypeDropdown
						title='Blood Type'
						bloodtypeData={setBloodtypeDataHandler}
					/>

					<TextField
						sx={{ mb: 3, mt: 2 }}
						autoFocus
						required
						fullWidth
						id='unit'
						name='unit'
						label='Unit'
						type='number'
						onChange={onStockChangeHandler}
						value={unit}
					/>
					<div style={{ color: 'red' }}>{error !== '' && error}</div>
				</DialogContent>
				<DialogActions>
					<Button onClick={handleClose}>Cancel</Button>
					<Button onClick={addStockHandler}>Update Stock</Button>
				</DialogActions>
			</Dialog>
		</>
	)
}

export default BloodStock
