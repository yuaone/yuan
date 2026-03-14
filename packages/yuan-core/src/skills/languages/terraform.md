## Identity
- domain: terraform
- type: language
- confidence: 0.90

# Terraform — Error Pattern Reference

Read the full error message including the resource address and provider error detail. Terraform errors are often split across a plan error and an apply error — both matter.

## Error Code Quick Reference
- **"Error: Error acquiring the state lock"** — Another operation holds the state lock.
- **"Error: Reference to undeclared resource"** — Resource name typo or not yet defined.
- **"Error: Provider configuration not present"** — Provider block missing or alias mismatch.
- **"Error: Unsupported argument"** — Attribute not valid for the resource type/version.
- **"Error: Cycle"** — Circular dependency between resources.
- **"Error: Invalid value for variable"** — Variable validation constraint failed.
- **"Warning: Deprecated attribute"** — Attribute removed in newer provider version.
- **"Error: Backend configuration changed"** — Backend config changed without `terraform init -reconfigure`.

## Known Error Patterns

### State Lock Timeout — Backend Locking
- **Symptom**: `Error: Error acquiring the state lock` with a lock ID and holder info; plan/apply hangs indefinitely.
- **Cause**: A previous `terraform apply` or `plan` was interrupted (Ctrl-C, CI timeout, crash) without releasing the state lock. The backend (S3+DynamoDB, GCS, Terraform Cloud) still holds the lock from the dead operation.
- **Strategy**: 1. Read the error output fully — it includes the lock ID and the operation that holds it. 2. Verify that no legitimate Terraform operation is running (check CI jobs, team members). 3. If confirmed stale, force-unlock: `terraform force-unlock <LOCK_ID>`. 4. For DynamoDB-backed state, you can also delete the lock item directly via AWS Console as a last resort. 5. Prevent future stale locks: use CI jobs with proper timeout handling and signal trapping.
- **Tool sequence**: shell_exec (`terraform force-unlock <ID>`) → shell_exec (`terraform plan` to verify state is clean)
- **Pitfall**: Do NOT force-unlock while another legitimate apply is running — you will corrupt the state. Confirm no other operations are active first.

### Plan/Apply Diff Surprise — lifecycle ignore_changes
- **Symptom**: `terraform plan` shows unexpected changes to a resource that was not modified in code; resource would be destroyed and recreated on every apply.
- **Cause**: External systems (autoscalers, deployment tools, human edits) modified attributes that Terraform tracks. Without `lifecycle { ignore_changes = [...] }`, Terraform wants to revert these changes. Alternatively, a `for_each` or `count` index change can cause full resource replacement.
- **Strategy**: 1. Run `terraform plan -out=tfplan` and read the diff carefully — identify which attribute is changing. 2. If the attribute is legitimately managed externally (e.g., `desired_count` on an ECS service managed by an autoscaler), add `lifecycle { ignore_changes = [desired_count] }`. 3. If it is a `for_each` index issue, check that the map keys are stable identifiers, not positional indices. 4. Never use `ignore_changes = all` — it makes Terraform blind to all drift.
- **Tool sequence**: shell_exec (`terraform plan`) → file_read (resource definition) → file_edit (add lifecycle ignore_changes for specific attributes)
- **Pitfall**: Do NOT add `ignore_changes` reflexively to stop a noisy plan — understand WHY the attribute is drifting and fix the root cause if it is your code making the unintended change.

### Provider Version Constraint Missing — Breaking Changes
- **Symptom**: `terraform init` installs a newer provider version that removes or renames attributes; existing configurations break after `terraform init -upgrade`.
- **Cause**: `required_providers` block either has no version constraint or uses `~>` incorrectly, allowing major version upgrades that introduce breaking changes.
- **Strategy**: 1. Read the `required_providers` block in `versions.tf` or the root module. 2. Pin to a compatible version range: `version = "~> 5.0"` (allows 5.x but not 6.0). 3. Review provider changelogs when intentionally upgrading. 4. Commit the `.terraform.lock.hcl` file to version control — it pins exact provider versions for reproducible builds. 5. Use `terraform providers lock` to regenerate the lock file after intentional upgrades.
- **Tool sequence**: file_read (versions.tf) → file_edit (add or tighten version constraints) → shell_exec (`terraform init`) → shell_exec (git add .terraform.lock.hcl)
- **Pitfall**: Do NOT delete `.terraform.lock.hcl` to "fix" provider issues — it is a security and reproducibility artifact. Regenerate it properly with `terraform providers lock`.

### Sensitive Value in Output — Secret Exposure
- **Symptom**: `terraform output` prints database passwords, API keys, or private keys in plaintext; CI logs expose secrets; state file contains secrets in plaintext.
- **Cause**: An `output` block exposes a sensitive resource attribute (e.g., `aws_db_instance.password`, `tls_private_key.private_key_pem`) without `sensitive = true`. Even with `sensitive = true`, the value is still stored in plaintext in the Terraform state file.
- **Strategy**: 1. Grep all `output` blocks for sensitive attributes. 2. Add `sensitive = true` to outputs that expose secrets — this prevents them from printing in logs. 3. Audit the state backend: ensure state storage (S3 bucket, GCS bucket) has encryption at rest and access logging enabled. 4. For truly sensitive values, use a secrets manager (AWS Secrets Manager, HashiCorp Vault) instead of outputting them via Terraform. 5. Never commit state files to version control.
- **Tool sequence**: grep (`output "`) → file_read → file_edit (add sensitive = true) → shell_exec (verify state backend encryption config)
- **Pitfall**: Do NOT think `sensitive = true` removes the secret from state — it only hides it in plan/apply output. The state file still contains it in plaintext.

### Circular Dependency Between Resources
- **Symptom**: `Error: Cycle: <resource_a> → <resource_b> → <resource_a>`; Terraform cannot determine apply order.
- **Cause**: Resource A references an attribute of Resource B (creating A→B dependency), and Resource B references an attribute of Resource A (creating B→A dependency). This can happen through `depends_on`, data source references, or implicit attribute references.
- **Strategy**: 1. Read the error — Terraform prints the full cycle chain. 2. Map out WHY each reference exists. 3. Break the cycle by: (a) extracting a shared resource that both depend on, (b) using a `null_resource` or `terraform_data` with `triggers` to decouple, (c) restructuring so one resource passes a value that does not itself depend on the other. 4. Avoid using `depends_on` on entire modules — use it only on specific resources.
- **Tool sequence**: file_read (both resource definitions) → grep (cross-references between them) → file_edit (extract shared resource or remove circular reference)
- **Pitfall**: Do NOT use `depends_on = []` to remove declared dependencies without understanding what ordering those dependencies enforced — you may create race conditions in provisioning.

### Resource Replaced on Rename — State Orphan
- **Symptom**: `terraform plan` shows a resource being destroyed and a new one created when you only renamed it in code; infrastructure is unnecessarily replaced.
- **Cause**: Terraform tracks resources by their address (type + name). Renaming `aws_s3_bucket.old_name` to `aws_s3_bucket.new_name` looks like a deletion + creation.
- **Strategy**: 1. Use `terraform state mv <old_address> <new_address>` to rename the resource in state without destroying it. 2. Then update the `.tf` file with the new name. 3. Run `terraform plan` — it should show no changes. 4. For module renames, use `terraform state mv module.old module.new`.
- **Tool sequence**: shell_exec (`terraform state list`) → shell_exec (`terraform state mv <old> <new>`) → file_edit (rename in .tf) → shell_exec (`terraform plan`)
- **Pitfall**: Do NOT apply before running `terraform state mv` — the apply will destroy existing infrastructure to "create" the renamed resource.

## Verification
Run: `terraform validate` then `terraform plan`
- `terraform validate` must exit 0 with "Success! The configuration is valid."
- `terraform plan` should show only the expected changes — read every `+`, `-`, and `~` carefully.
- Run `tflint` for additional style and provider-specific checks.

## Validation Checklist
- [ ] `required_providers` has version constraints for all providers
- [ ] `.terraform.lock.hcl` is committed to version control
- [ ] All sensitive outputs have `sensitive = true`
- [ ] No secrets stored in `.tfvars` files committed to version control
- [ ] State backend uses encrypted storage with access logging
- [ ] `terraform validate` exits 0
- [ ] No `depends_on = [<entire_module>]` without justification
- [ ] All `lifecycle` blocks are justified with a comment explaining why
- [ ] Resource names use stable identifiers (not positional indices) in `for_each`
- [ ] `tflint` passes with no errors
