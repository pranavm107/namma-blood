const mockAxios = {
	get: jest.fn(() => Promise.resolve({ data: {} })),
	post: jest.fn(() => Promise.resolve({ data: {} })),
	put: jest.fn(() => Promise.resolve({ data: {} })),
	patch: jest.fn(() => Promise.resolve({ data: {} })),
	delete: jest.fn(() => Promise.resolve({ data: {} })),
	create: jest.fn(function () {
		return mockAxios
	}),
	interceptors: {
		request: { use: jest.fn(), eject: jest.fn() },
		response: { use: jest.fn(), eject: jest.fn() },
	},
}

export default mockAxios
