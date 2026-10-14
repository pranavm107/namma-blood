import React, { useEffect, useState } from 'react'
import CityDropdown from '../../UI/CityDropdown'
import StateDropdown from '../../UI/StateDropdown'
import { Box, Paper, Typography } from '@mui/material'
import BloodbankList from './BloodbankList'
import { useDispatch } from 'react-redux'
import {
	clearBloodbankData,
	getBloodbanks,
} from '../../../store/bloodbankSlice'

const LookingForBlood = () => {
	const dispatch = useDispatch()
	const [stateName, setStateName] = useState('')

	useEffect(() => {
		dispatch(clearBloodbankData())
	}, [dispatch])

	const stateChangeHandler = (stateName) => {
		setStateName(stateName)
		dispatch(getBloodbanks(`state=${stateName}`))
	}

	const cityChangeHandler = (cityName) => {
		dispatch(getBloodbanks(`state=${stateName}&city=${cityName}`))
	}

	return (
		<>
			<Box sx={{ mb: 3 }}>
				<Typography variant='h5' component='h1' sx={{ fontWeight: 800, color: '#1e293b' }}>
					Search Blood Stock & Request Units
				</Typography>
				<Typography variant='body2' sx={{ color: '#64748b' }}>
					Locate verified blood banks in your area and request blood components for emergency medical care
				</Typography>
			</Box>

			<Paper
				elevation={0}
				sx={{
					p: 3,
					mb: 3,
					borderRadius: 3,
					border: '1px solid #e2e8f0',
					backgroundColor: '#ffffff',
					boxShadow: '0 4px 16px rgba(0,0,0,0.02)',
				}}
			>
				<Typography variant='subtitle1' sx={{ fontWeight: 700, color: '#1e293b', mb: 2 }}>
					Filter by Location
				</Typography>
				<Box
					sx={{
						display: 'flex',
						flexWrap: 'wrap',
						gap: 3,
						alignItems: 'center',
					}}
				>
					<StateDropdown
						title='State'
						stateChangeHandler={stateChangeHandler}
					/>

					<CityDropdown
						title='City'
						stateName={stateName}
						canCallApi={stateName ? true : false}
						cityChangeHandler={cityChangeHandler}
					/>
				</Box>
			</Paper>

			<BloodbankList />
		</>
	)
}

export default LookingForBlood
