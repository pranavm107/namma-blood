import {
	validateCoordinates,
	formatDistance,
	calculateHaversineDistanceKm,
	getCityStateFallback,
	getCurrentPosition,
	GEO_ERROR_CODES,
} from '../geoUtils'

describe('Frontend Geolocation Utility (geoUtils)', () => {
	describe('validateCoordinates', () => {
		test('should return true for valid [longitude, latitude] coordinates', () => {
			expect(validateCoordinates([77.5946, 12.9716])).toBe(true) // Bangalore
			expect(validateCoordinates([0, 0])).toBe(true)
			expect(validateCoordinates([-180, -90])).toBe(true)
			expect(validateCoordinates([180, 90])).toBe(true)
		})

		test('should return false for out-of-bounds latitude or longitude', () => {
			expect(validateCoordinates([180.1, 12.0])).toBe(false)
			expect(validateCoordinates([-180.5, 12.0])).toBe(false)
			expect(validateCoordinates([77.0, 90.5])).toBe(false)
			expect(validateCoordinates([77.0, -90.5])).toBe(false)
		})

		test('should return false for invalid data types, NaN, or improper array length', () => {
			expect(validateCoordinates(null)).toBe(false)
			expect(validateCoordinates(undefined)).toBe(false)
			expect(validateCoordinates([77.0])).toBe(false)
			expect(validateCoordinates([77.0, 12.0, 10.0])).toBe(false)
			expect(validateCoordinates(['77.0', '12.0'])).toBe(false)
			expect(validateCoordinates([NaN, 12.0])).toBe(false)
			expect(validateCoordinates([77.0, NaN])).toBe(false)
		})
	})

	describe('formatDistance', () => {
		test('should format distances under 1 kilometer in meters', () => {
			expect(formatDistance(0.45)).toBe('450 m')
			expect(formatDistance(0.852)).toBe('852 m')
			expect(formatDistance(0.05)).toBe('50 m')
		})

		test('should format distances 1 kilometer or greater in km with 1 decimal place', () => {
			expect(formatDistance(1.23)).toBe('1.2 km')
			expect(formatDistance(15.789)).toBe('15.8 km')
			expect(formatDistance(50.0)).toBe('50.0 km')
		})

		test('should gracefully handle invalid or negative values', () => {
			expect(formatDistance(-5)).toBe('Distance unknown')
			expect(formatDistance(null)).toBe('Distance unknown')
			expect(formatDistance(NaN)).toBe('Distance unknown')
		})
	})

	describe('calculateHaversineDistanceKm', () => {
		test('should accurately calculate distance between Bangalore and Mysore (~128 km)', () => {
			const bangalore = [77.5946, 12.9716]
			const mysore = [76.6394, 12.2958]
			const distance = calculateHaversineDistanceKm(bangalore, mysore)

			expect(distance).toBeGreaterThan(120)
			expect(distance).toBeLessThan(140)
		})

		test('should return 0 for identical points', () => {
			const pt = [77.5946, 12.9716]
			expect(calculateHaversineDistanceKm(pt, pt)).toBe(0)
		})

		test('should return 0 when either point is invalid', () => {
			expect(calculateHaversineDistanceKm([999, 999], [77, 12])).toBe(0)
		})
	})

	describe('getCityStateFallback', () => {
		test('should structure city and state fallback when provided', () => {
			const fallback = getCityStateFallback('Bangalore', 'Karnataka')
			expect(fallback).toEqual({
				isGeospatial: false,
				city: 'Bangalore',
				state: 'Karnataka',
				canFallback: true,
			})
		})

		test('should mark canFallback as false when either city or state is empty', () => {
			expect(getCityStateFallback('', 'Karnataka').canFallback).toBe(false)
			expect(getCityStateFallback('Bangalore', '').canFallback).toBe(false)
		})
	})

	describe('getCurrentPosition with mocked navigator.geolocation', () => {
		const originalGeolocation = navigator.geolocation

		afterEach(() => {
			Object.defineProperty(navigator, 'geolocation', {
				value: originalGeolocation,
				writable: true,
				configurable: true,
			})
		})

		test('should return success and [lng, lat] when browser returns position', async () => {
			const mockGeolocation = {
				getCurrentPosition: jest.fn().mockImplementation((success) => {
					success({
						coords: {
							latitude: 12.9716,
							longitude: 77.5946,
							accuracy: 15,
						},
					})
				}),
			}

			Object.defineProperty(navigator, 'geolocation', {
				value: mockGeolocation,
				writable: true,
				configurable: true,
			})

			const result = await getCurrentPosition()

			expect(result.success).toBe(true)
			expect(result.coordinates).toEqual([77.5946, 12.9716])
			expect(result.latitude).toBe(12.9716)
			expect(result.longitude).toBe(77.5946)
			expect(result.fallbackRequired).toBe(false)
			expect(result.error).toBeNull()
		})

		test('should handle PERMISSION_DENIED error and indicate fallbackRequired', async () => {
			const mockGeolocation = {
				getCurrentPosition: jest.fn().mockImplementation((_, error) => {
					error({ code: 1, message: 'User denied Geolocation' })
				}),
			}

			Object.defineProperty(navigator, 'geolocation', {
				value: mockGeolocation,
				writable: true,
				configurable: true,
			})

			const result = await getCurrentPosition()

			expect(result.success).toBe(false)
			expect(result.coordinates).toBeNull()
			expect(result.fallbackRequired).toBe(true)
			expect(result.error.code).toBe(GEO_ERROR_CODES.PERMISSION_DENIED)
		})

		test('should handle POSITION_UNAVAILABLE error and indicate fallbackRequired', async () => {
			const mockGeolocation = {
				getCurrentPosition: jest.fn().mockImplementation((_, error) => {
					error({ code: 2, message: 'Position unavailable' })
				}),
			}

			Object.defineProperty(navigator, 'geolocation', {
				value: mockGeolocation,
				writable: true,
				configurable: true,
			})

			const result = await getCurrentPosition()

			expect(result.success).toBe(false)
			expect(result.fallbackRequired).toBe(true)
			expect(result.error.code).toBe(GEO_ERROR_CODES.POSITION_UNAVAILABLE)
		})

		test('should handle TIMEOUT error and indicate fallbackRequired', async () => {
			const mockGeolocation = {
				getCurrentPosition: jest.fn().mockImplementation((_, error) => {
					error({ code: 3, message: 'Timeout expired' })
				}),
			}

			Object.defineProperty(navigator, 'geolocation', {
				value: mockGeolocation,
				writable: true,
				configurable: true,
			})

			const result = await getCurrentPosition()

			expect(result.success).toBe(false)
			expect(result.fallbackRequired).toBe(true)
			expect(result.error.code).toBe(GEO_ERROR_CODES.TIMEOUT)
		})
	})
})
