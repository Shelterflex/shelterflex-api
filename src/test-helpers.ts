import supertest from 'supertest'
import { createApp } from './app.js'
import { expect } from 'vitest'

export const RATE_LIMIT_BYPASS_TOKEN = 'test-bypass-token-12345'

/**
 * Creates a supertest agent for testing the Express app.
 * Automatically sets the rate-limit bypass header so route-level tests are
 * never throttled by the comprehensive or advanced rate limiters.
 * Tests do not require external network access.
 */
export function createTestAgent() {
  const app = createApp()
  return supertest(app).set('x-ratelimit-bypass', RATE_LIMIT_BYPASS_TOKEN)
}

/**
 * Validates that a response has the x-request-id header.
 */
export function expectRequestId(response: supertest.Response): void {
  expect(response.headers['x-request-id']).toBeDefined()
  expect(typeof response.headers['x-request-id']).toBe('string')
  expect(response.headers['x-request-id'].length).toBeGreaterThan(0)
}

/**
 * Standard error response shape validator.
 */
export function expectErrorShape(
  response: supertest.Response,
  expectedCode: string,
  expectedStatus: number
): void {
  expect(response.status).toBe(expectedStatus)
  expect(response.body).toHaveProperty('error')
  expect(response.body.error).toHaveProperty('code', expectedCode)
  expect(response.body.error).toHaveProperty('message')
  expect(typeof response.body.error.message).toBe('string')
}

