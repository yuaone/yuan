## Identity
- domain: sql
- type: language
- confidence: 0.91

# SQL — Error Pattern Reference

Read the query plan (`EXPLAIN ANALYZE`) before optimizing. Most SQL performance bugs are visible in the plan. Always check the execution count and actual rows vs. estimated rows.

## Quick Reference
- **Seq Scan** — Full table scan; usually means missing or unused index.
- **Nested Loop** — Can be N+1 if the inner query is driven by outer rows without batching.
- **Hash Join / Merge Join** — Efficient for large set joins.
- **Filter** — Rows filtered AFTER scan; ideally filters happen at index scan level.
- **NULL** — Not equal to anything, including itself. Use `IS NULL` / `IS NOT NULL`.

## Known Error Patterns

### N+1 Query — Missing JOIN
- **Symptom**: Application issues one query to fetch N parent rows, then N separate queries to fetch child data. Slow page loads proportional to result set size.
- **Cause**: ORM lazy loading or application-level loop issuing per-row queries. The database work is done outside SQL.
- **Strategy**: 1. Log all queries during a request (ORM query log or `pg_stat_statements`). 2. Identify repeated queries differing only by an ID parameter. 3. Rewrite as a single query using JOIN or a subquery: `SELECT p.*, c.* FROM parents p JOIN children c ON c.parent_id = p.id WHERE p.id IN (...)`. 4. In ORMs, use eager loading: `.includes()`, `.eager_load()`, `JOIN FETCH`, etc.
- **Tool sequence**: shell_exec (query log or EXPLAIN) → file_read (ORM query code) → file_edit (add JOIN or eager load)
- **Pitfall**: Do NOT add `LIMIT 1` to inner queries as a workaround — batch the entire fetch in one query.

### Index Not Used — Function on Indexed Column
- **Symptom**: `EXPLAIN ANALYZE` shows Seq Scan on a large table even though an index exists on the column in the WHERE clause.
- **Cause**: Wrapping an indexed column in a function (`WHERE LOWER(email) = ...`, `WHERE DATE(created_at) = ...`) prevents the index from being used because the index stores the raw value, not the function result.
- **Strategy**: 1. Run `EXPLAIN ANALYZE` on the slow query. 2. Identify the Seq Scan and the WHERE predicate. 3. Options: a) Create a functional index: `CREATE INDEX ON users (LOWER(email));`. b) Rewrite the query to avoid the function on the column side: `WHERE created_at >= '2024-01-01' AND created_at < '2024-01-02'` instead of `WHERE DATE(created_at) = '2024-01-01'`. c) Store the normalized value in a separate indexed column.
- **Tool sequence**: shell_exec (`EXPLAIN ANALYZE <query>`) → file_read (query definition) → file_edit (rewrite predicate or add functional index)
- **Pitfall**: Do NOT add an index to the column if the query wraps it in a function. The new index will also be unused.

### NULL Comparison — IS NULL vs = NULL
- **Symptom**: `WHERE column = NULL` returns zero rows even when null values exist. `WHERE column != NULL` also returns zero rows.
- **Cause**: In SQL, NULL represents an unknown value. Any comparison with `=`, `!=`, `<`, `>` against NULL evaluates to NULL (unknown), not TRUE or FALSE. Rows are only returned where the predicate is TRUE.
- **Strategy**: 1. Replace `= NULL` with `IS NULL`. 2. Replace `!= NULL` or `<> NULL` with `IS NOT NULL`. 3. For COALESCE or conditional logic: `COALESCE(column, default_value)`.
- **Tool sequence**: grep (`= NULL\|!= NULL\|<> NULL`) → file_read → file_edit (replace with IS NULL / IS NOT NULL)
- **Pitfall**: `NOT IN (subquery)` silently returns zero rows if the subquery contains any NULL values. Use `NOT EXISTS` instead for nullable subqueries.

### Implicit Type Conversion in WHERE
- **Symptom**: Query returns wrong results or runs slowly because an index is not used. No error is raised.
- **Cause**: Comparing a column to a literal of a different type forces an implicit cast. E.g., comparing an integer column to a string literal `WHERE id = '123'`, or a varchar column to a number. Some databases cast the column (index unusable); others cast the literal (usually OK).
- **Strategy**: 1. Identify the column type from the schema. 2. Ensure the literal or bound parameter matches the column type exactly. 3. In application code, use parameterized queries with the correct type binding. 4. Run `EXPLAIN ANALYZE` to confirm the plan does not include a cast on the column side.
- **Tool sequence**: shell_exec (`\d table_name` or schema query) → file_read (query) → file_edit (cast literal or fix parameter type)
- **Pitfall**: Do NOT cast the column in the WHERE clause to match the literal: `WHERE CAST(id AS VARCHAR) = '123'` — this prevents index use. Cast the literal instead: `WHERE id = 123`.

### Missing Transaction Rollback on Error
- **Symptom**: Partial data written to the database when an error occurs mid-operation. Data is in an inconsistent state.
- **Cause**: Multiple related DML statements (INSERT, UPDATE, DELETE) are not wrapped in a transaction, or the error handling path does not issue a ROLLBACK.
- **Strategy**: 1. Wrap all related DML in `BEGIN; ... COMMIT;`. 2. In application code, use try/catch with ROLLBACK in the catch block. 3. Use database-level constraints (FK, UNIQUE, CHECK) as the last line of defense. 4. Test the error path explicitly.
- **Tool sequence**: grep (`INSERT\|UPDATE\|DELETE`) → file_read (transaction boundary) → file_edit (add BEGIN/COMMIT/ROLLBACK)
- **Pitfall**: Do NOT issue COMMIT before verifying all statements succeeded. Commit only at the outermost transaction boundary.

### Missing Index on Foreign Key
- **Symptom**: Deletes or updates on parent table are slow; parent-side queries perform Seq Scans on child table.
- **Cause**: Foreign key columns on the child table are not indexed. The database must scan the entire child table to enforce FK constraints on parent modification.
- **Strategy**: 1. Identify all FK columns in the schema. 2. For each FK column, check if an index exists: `\d child_table`. 3. Add index: `CREATE INDEX ON child_table (parent_id);`.
- **Tool sequence**: shell_exec (schema inspection) → file_edit (migration to add index)
- **Pitfall**: Do NOT add the index to the parent's primary key column — add it to the FK column on the child table.

## Verification
Run: `EXPLAIN ANALYZE <query>` for any query touching tables with >10k rows.
- Target: no Seq Scan on large tables (unless the query reads most of the table).
- Target: actual rows ≈ estimated rows (large divergence indicates stale statistics — run `ANALYZE table_name`).

## Validation Checklist
- [ ] `EXPLAIN ANALYZE` reviewed for all slow queries (>100ms)
- [ ] No `= NULL` or `!= NULL` comparisons in WHERE clauses
- [ ] All function-wrapped column predicates reviewed for index usage
- [ ] All multi-statement DML wrapped in explicit transactions
- [ ] FK columns on child tables have indexes
- [ ] `NOT IN (subquery)` replaced with `NOT EXISTS` where subquery may return NULLs
- [ ] Parameterized queries used — no string-concatenated SQL
- [ ] `ANALYZE` run after bulk data changes to refresh statistics
