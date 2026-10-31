import { useState, useCallback } from 'react'
import { getCurrentPosition, getCityStateFallback } from '../utils/geoUtils'

/**
 * Custom React hook for managing client geolocation state and manual City/State fallback.
 *
 * @param {Object} defaultFallback - Initial { city, state } values if available
 * @returns {Object} { coordinates, latitude, longitude, accuracy, isLoading, error, fallbackRequired, requestLocation, setManualFallback }
 */
export function useGeolocation(defaultFallback = { city: '', state: '' }) {
	const [coordinates, setCoordinates] = useState(null)
	const [latitude, setLatitude] = useState(null)
	const [longitude, setLongitude] = useState(null)
	const [accuracy, setAccuracy] = useState(null)
	const [isLoading, setIsLoading] = useState(false)
	const [error, setError] = useState(null)
	const [fallback, setFallback] = useState(() =>
		getCityStateFallback(defaultFallback.city, defaultFallback.state)
	)

	const requestLocation = useCallback(async (options = {}) => {
		setIsLoading(true)
		setError(null)

		const result = await getCurrentPosition(options)

		setIsLoading(false)

		if (result.success) {
			setCoordinates(result.coordinates)
			setLatitude(result.latitude)
			setLongitude(result.longitude)
			setAccuracy(result.accuracy)
			setError(null)
		} else {
			setCoordinates(null)
			setLatitude(null)
			setLongitude(null)
			setAccuracy(null)
			setError(result.error)
		}

		return result
	}, [])

	const setManualFallback = useCallback((city, state) => {
		const newFallback = getCityStateFallback(city, state)
		setFallback(newFallback)
		return newFallback
	}, [])

	return {
		coordinates,
		latitude,
		longitude,
		accuracy,
		isLoading,
		error,
		fallbackRequired: Boolean(!coordinates || error),
		fallback,
		requestLocation,
		setManualFallback,
	}
}

export default useGeolocation
