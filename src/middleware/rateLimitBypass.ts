/**
 * Header value that lets test agents skip the rate limiter. Kept out of
 * test-helpers so production code never imports test-only dependencies, and
 * only honoured when NODE_ENV is "test".
 */
export const RATE_LIMIT_BYPASS_TOKEN = 'test-bypass-token-12345'
