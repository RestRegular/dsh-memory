/**
 * Secret denylist for memory content (design §11): refuse or redact anything
 * that looks like a credential before it reaches the store or the embedder.
 * Patterns are deliberately conservative — better a false refusal on an
 * obvious token shape than a silent key leak into a plaintext JSONL file.
 */

                                
              
               
                
 

                    
              
            
 

const RULES             = [
  { kind: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { kind: 'api-key-sk', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g },
  {
    kind: 'key-assignment',
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*['"]?[^\s'"]{8,}/gi,
  },
]

/** Find credential-shaped spans in free text. */
export function scanSecrets(text        )                  {
  const found                  = []
  for (const { kind, re } of RULES) {
    re.lastIndex = 0
    let m                        
    while ((m = re.exec(text)) !== null) {
      found.push({ kind, index: m.index, length: m[0].length })
      if (m.index === re.lastIndex) re.lastIndex++ // guard zero-length loops
    }
  }
  return found
}

/** Mask every matched span as [REDACTED:<kind>]; length changes are expected. */
export function redactSecrets(text        )         {
  let out = text
  for (const { kind, re } of RULES) {
    re.lastIndex = 0
    out = out.replace(re, `[REDACTED:${kind}]`)
  }
  return out
}


//# sourceURL=source/memory-local/src/secrets.ts