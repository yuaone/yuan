## Identity
- domain: security
- type: scan
- confidence: 0.9

# Security Scan — OWASP Top 10 Patterns

Scan for vulnerabilities before they reach production. Each pattern below is a real-world attack vector.

## Scan Order
1. Injection (SQL, shell, LDAP, XML)
2. Secrets and credentials in code
3. Authentication and authorization gaps
4. Insecure deserialization
5. Sensitive data exposure

## Known Error Patterns

### SQL Injection
- **Symptom**: User input concatenated directly into SQL string
- **Cause**: String interpolation used instead of parameterized queries
- **Strategy**: 1. Grep for string concatenation with SQL keywords 2. Replace with parameterized queries or ORM methods
- **Tool sequence**: grep (SELECT.*+) → file_read → file_edit
- **Pitfall**: Do NOT use string replacement as a sanitization method. Use parameterized queries only.

### Shell Injection
- **Symptom**: User input passed to shell command execution
- **Cause**: exec(userInput), shell=True with dynamic input, template string in subprocess
- **Strategy**: 1. Grep for shell=True, exec(, subprocess with dynamic args 2. Replace with argument arrays, never shell strings
- **Tool sequence**: grep (shell=True) → file_read → file_edit
- **Pitfall**: Do NOT use shell=True with any user-controlled input, ever.

### Hardcoded Secrets
- **Symptom**: API keys, passwords, tokens in source code
- **Cause**: Developer committed credentials directly
- **Strategy**: 1. Grep for common secret patterns 2. Move to environment variables 3. Add to .gitignore
- **Tool sequence**: grep (password=, api_key=, secret=, sk-, Bearer) → file_read → file_edit
- **Pitfall**: Do NOT just delete the secret — rotate it first, then remove from code.

### Path Traversal
- **Symptom**: User-supplied file path used without validation
- **Cause**: open(userPath), readFile(req.params.filename) without sanitization
- **Strategy**: 1. Validate path is within allowed directory 2. Use path.resolve() and check it starts with allowed base
- **Tool sequence**: grep (readFile, open(, fs.) → file_read → file_edit
- **Pitfall**: Do NOT use path.basename() alone — it does not prevent traversal through symlinks.

### Insecure Direct Object Reference
- **Symptom**: Resource ID from request used directly without ownership check
- **Cause**: db.find({ id: req.params.id }) without checking userId matches session
- **Strategy**: Always check that the authenticated user owns the requested resource
- **Tool sequence**: grep (req.params, req.query) → file_read → file_edit
- **Pitfall**: Do NOT assume frontend-only authorization is sufficient.

## Validation Checklist
- [ ] No user input in SQL/shell/LDAP strings
- [ ] No secrets in source code
- [ ] All file paths validated against base directory
- [ ] All resource access checks ownership
- [ ] Dependencies scanned for known vulnerabilities
