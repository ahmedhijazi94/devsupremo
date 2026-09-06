// Independently generated using Python's zipfile, both standard ZIP methods.
const stored = 'UEsDBBQAAAAAAAubJl2yb1MAOQEAADkBAAAPAAAAYWNjZXB0YW5jZS5qc29ueyJ2ZXJzaW9uIjoxLCJwcm9qZWN0SWQiOiIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJzaGEiOiJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiYmJiIiwiZW52aXJvbm1lbnQiOiJkZXZlbG9wbWVudCIsInJ1bklkIjoxMCwicnVuQXR0ZW1wdCI6MSwiY29tcGxldGVkQXQiOiIyMDI2LTA5LTA2VDAxOjA1OjAwLjAwMFoiLCJjaGVja3MiOlt7Im5hbWUiOiJ0aWNrZXQgb3duZXJzaGlwIiwidHlwZSI6InJscyIsInN0YXR1cyI6InBhc3NlZCJ9XSwiY3JpdGVyaW9uSWRzIjpbIm93bmVyLWlzb2xhdGlvbiJdfVBLAQIUAxQAAAAAAAubJl2yb1MAOQEAADkBAAAPAAAAAAAAAAAAAACAAQAAAABhY2NlcHRhbmNlLmpzb25QSwUGAAAAAAEAAQA9AAAAZgEAAAAA'
const deflated = 'UEsDBBQAAAAIAAubJl2yb1MAwQAAADkBAAAPAAAAYWNjZXB0YW5jZS5qc29ujZAxDwIhDIX/iul8Z3pGjbI5ujtpHBCaHHoHBOoZY/zvFqK7b2hoeN+D9gUTpeyCB9U1EFO4kuG9BQXdV20ty1I2v/YnaCD3WsyXPyUA+cml4EfyLKCliYYQa9dAuvvydof1uGOmMXL9mQljHIjJ7gq1wMW6xW2L6wN2ClcKcY6IR4kwPZlbBnV6gdcjiZmduRHPwsPLpL2LYuJnLDdpyGUC1nwXAqLOmSy8z5KSHFOStextyYIKty6HQXNZ1vn9AVBLAQIUAxQAAAAIAAubJl2yb1MAwQAAADkBAAAPAAAAAAAAAAAAAACAAQAAAABhY2NlcHRhbmNlLmpzb25QSwUGAAAAAAEAAQA9AAAA7gAAAAAA'
export const acceptanceArchive = (compressed = true): Buffer => Buffer.from(compressed ? deflated : stored, 'base64')
export const acceptanceFixture = {
  version: 1 as const, projectId: '11111111-1111-4111-8111-111111111111', sha: 'b'.repeat(40), environment: 'development' as const,
  runId: 10, runAttempt: 1, completedAt: '2026-09-06T01:05:00.000Z',
  checks: [{ name: 'ticket ownership', type: 'rls' as const, status: 'passed' as const }], criterionIds: ['owner-isolation'],
}
