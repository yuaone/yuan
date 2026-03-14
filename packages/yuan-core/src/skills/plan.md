## Identity
- domain: general
- type: plan
- confidence: 0.8

# Plan — Decompose, Sequence, Risk

Break the goal into tasks that can be executed independently. The plan is wrong if any task requires knowing the output of a parallel task.

## Workflow
1. **Understand** — Read relevant files. Do not plan from assumptions.
2. **Decompose** — Break goal into tasks. Each task = one logical change.
3. **Sequence** — Order by dependencies. What must be done before what?
4. **Assign** — Which files does each task touch? (No two tasks touch the same file.)
5. **Risk** — What can go wrong? What is the rollback?

## Task Format
Each task must specify:
- Goal (one sentence)
- Files to create/modify
- Dependencies (which tasks must complete first)
- Verification (how to confirm it worked)

## Known Error Patterns

### Over-decomposed Tasks
- **Symptom**: 20+ tasks for what should be a 3-task change
- **Cause**: Planning at line-level instead of logical-change level
- **Strategy**: Merge tasks that always change together into one task
- **Pitfall**: Do NOT create a task for each file if they are all part of one logical change.

### Under-specified Verification
- **Symptom**: Task says "done" but it is unclear what "done" means
- **Cause**: No concrete verification step defined
- **Strategy**: Every task needs: run X command, see Y output
- **Pitfall**: Do NOT write "test it works" — write the exact command and expected output.

### Missing Rollback
- **Symptom**: Mid-way through plan, something breaks and there is no way back
- **Cause**: No checkpoint or rollback strategy
- **Strategy**: For any plan with 4+ tasks, define a rollback point (git stash, feature flag, etc.)
- **Pitfall**: Do NOT start a multi-file refactor without a rollback strategy.

## Validation Checklist
- [ ] Each task has a single clear goal
- [ ] No two parallel tasks modify the same file
- [ ] Dependencies between tasks are explicit
- [ ] Each task has a concrete verification step
- [ ] Rollback strategy defined for 4+ task plans
