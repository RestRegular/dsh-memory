import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scanSecrets, redactSecrets } from '../src/secrets.ts'

test('scanSecrets detects common credential shapes', () => {
  const text = [
    '数据库密码 password: hunter2secret',
    '我的 key 是 sk-abcdefghijklmnop123456',
    'github token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890',
    'AKIAIOSFODNN7EXAMPLE',
    'xoxb-123456789-abcdefghij',
    'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
  ].join('\n')
  const kinds = new Set(scanSecrets(text).map((f) => f.kind))
  assert.ok(kinds.has('key-assignment'), 'key=value rule fires')
  assert.ok(kinds.has('api-key-sk'))
  assert.ok(kinds.has('github-token'))
  assert.ok(kinds.has('aws-access-key'))
  assert.ok(kinds.has('slack-token'))
  assert.ok(kinds.has('bearer-token'))
})

test('scanSecrets detects private key blocks', () => {
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----'
  const found = scanSecrets(`记住这个 ${pem}`)
  assert.ok(found.some((f) => f.kind === 'private-key'))
})

test('clean text has no findings', () => {
  assert.equal(scanSecrets('部署数据库迁移必须先做备份，用 PostgreSQL 16').length, 0)
  assert.equal(scanSecrets('').length, 0)
})

test('redactSecrets masks spans with kind labels', () => {
  const redacted = redactSecrets('key 是 sk-abcdefghijklmnop123456 请保存')
  assert.ok(!redacted.includes('sk-abcdefghijklmnop123456'))
  assert.ok(redacted.includes('[REDACTED:api-key-sk]'))
  // redaction is idempotent on already-redacted text
  assert.equal(redactSecrets(redacted), redacted)
})

test('every scan finding is also caught after redaction', () => {
  const dirty = 'token: supersecretvalue123 和 sk-abcdefghijklmnop123456'
  const clean = redactSecrets(dirty)
  assert.equal(scanSecrets(clean).length, 0, 'redacted output is clean')
})
