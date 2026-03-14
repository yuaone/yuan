## Identity
- domain: r
- type: language
- confidence: 0.88

# R — Error Pattern Reference

Read the exact error message and the call stack from `traceback()`. R errors are often generic ("object not found", "subscript out of bounds") but the call stack reveals which user function triggered the problem.

## Error Code Quick Reference
- **"object 'x' not found"** — Variable not in scope or wrong environment.
- **"Error in ... : subscript out of bounds"** — Vector/list index out of range.
- **"Error in ... : incorrect number of dimensions"** — Subsetting a vector like a matrix.
- **"NAs introduced by coercion"** — `as.numeric()` or `as.integer()` on non-numeric strings.
- **"Error in ... : replacement has length zero"** — Empty vector assigned to subset.
- **"Warning: longer object length is not a multiple of shorter object length"** — Vector recycling mismatch.
- **"Error: could not find function '...'"** — Package not loaded; function name misspelled.
- **"there is no package called '...'"** — Package not installed.

## Known Error Patterns

### Object Not Found — Environment Scope
- **Symptom**: `Error in my_function() : object 'df' not found`; a variable that exists in the global environment is not accessible inside a function.
- **Cause**: R uses lexical scoping — functions look up variables in the environment where they were defined, not where they are called. A variable in the global environment is not automatically available inside a function that was defined in a different environment. Packages with `NSE` (non-standard evaluation) like `dplyr` use column names as symbols — passing a variable name as a string fails.
- **Strategy**: 1. Pass variables as function arguments rather than relying on global scope: `my_function(df = my_df)`. 2. For dplyr NSE, use `.data[[var_name]]` to reference columns programmatically: `df %>% mutate(new = .data[[col_name]])`. 3. Use `exists("varname")` to check before accessing. 4. Run `ls()` and `ls(envir = parent.env(environment()))` to inspect available names in current and parent environments. 5. Avoid `attach()` — it causes scope pollution and hard-to-track object-not-found errors.
- **Tool sequence**: file_read (function definition and call site) → file_edit (add explicit argument passing or .data[[]] notation)
- **Pitfall**: Do NOT use `<<-` (superassignment) to fix scope issues — it modifies the parent environment and causes state mutation bugs that are very hard to debug.

### Vector Recycling Surprise — Length Mismatch
- **Symptom**: `Warning: longer object length is not a multiple of shorter object length`; result vector has unexpected values; computation silently proceeds with wrong data.
- **Cause**: R recycles shorter vectors to match the length of longer ones in element-wise operations. `c(1,2,3,4) + c(10,20)` produces `c(11,22,13,24)` — the shorter vector is recycled. If lengths are not multiples, R issues a warning but still completes the operation.
- **Strategy**: 1. Treat the recycling warning as an error in data analysis code — check `length(x) == length(y)` before element-wise operations. 2. Use `stopifnot(length(x) == length(y))` as an assertion. 3. For intentional broadcasting of a scalar, document the intent explicitly. 4. In data frame operations, join data frames properly (merge/dplyr join) instead of relying on recycling. 5. Enable warnings as errors during development: `options(warn = 2)`.
- **Tool sequence**: file_read (arithmetic operations) → file_edit (add length checks or stopifnot assertions)
- **Pitfall**: Do NOT suppress the recycling warning with `suppressWarnings()` — the result is silently wrong. Fix the length mismatch.

### Factor vs Character Confusion — Unexpected Levels
- **Symptom**: String operations fail on what appears to be a character column; new values added to a factor become `NA`; `paste()` or `gsub()` produces unexpected output; `nlevels()` returns more levels than values present.
- **Cause**: Factors store categorical data as integers with level labels. When reading CSV files, `read.csv()` in older R versions (pre-4.0) converts string columns to factors by default. Treating a factor as a character vector causes type errors and unexpected behavior.
- **Strategy**: 1. Check column types: `str(df)` — factors show as `Factor w/ N levels`. 2. Convert when needed: `as.character(df$column)`. 3. In modern R (>=4.0), `read.csv` uses `stringsAsFactors = FALSE` by default. For older code, add this parameter explicitly. 4. Use `droplevels(df)` to remove unused factor levels after subsetting. 5. When comparing factor values, always compare to the level string: `df$col == "value"`, not `df$col == 1`.
- **Tool sequence**: shell_exec (`R -e "str(read.csv('file.csv'))"`) → file_read (data loading code) → file_edit (add stringsAsFactors=FALSE or explicit as.character())
- **Pitfall**: Do NOT convert factors to numeric with `as.numeric(factor_col)` — it gives the integer codes (1, 2, 3...), not the original values. Use `as.numeric(as.character(factor_col))`.

### NA Propagation — Silent Calculation Corruption
- **Symptom**: `mean(x)` returns `NA`; `sum(x) == NA`; a single missing value silently poisons an entire calculation.
- **Cause**: `NA` in R propagates through most arithmetic and logical operations — any operation involving `NA` returns `NA`. `mean(c(1, 2, NA, 4))` returns `NA` unless `na.rm = TRUE`.
- **Strategy**: 1. Always include `na.rm = TRUE` in aggregate functions when NA is acceptable: `mean(x, na.rm = TRUE)`, `sum(x, na.rm = TRUE)`. 2. Check for NAs explicitly: `any(is.na(x))` or `sum(is.na(x))`. 3. Decide on NA handling strategy upfront: drop rows (`na.omit(df)`), impute, or flag. 4. Use `complete.cases(df)` to subset to rows with no NAs. 5. For logical operations, `NA | TRUE == TRUE` but `NA & FALSE == FALSE` — be aware of three-valued logic.
- **Tool sequence**: grep (`mean(`, `sum(`, `max(`, `min(`) → file_read → file_edit (add na.rm = TRUE or explicit NA checks)
- **Pitfall**: Do NOT use `na.omit()` blindly on a data frame — it removes entire rows if any column has NA, which may discard more data than intended.

### Package Namespace Conflict — :: Required
- **Symptom**: `Warning: package 'dplyr' masks 'base' function 'filter'`; calling `filter()` calls the wrong function; behavior changes depending on load order of packages.
- **Cause**: Multiple packages export functions with the same name (e.g., `dplyr::filter` and `stats::filter`, `dplyr::lag` and `stats::lag`). The last loaded package wins the unqualified name. Load order affects which function is called.
- **Strategy**: 1. Use the `::` operator to explicitly namespace all function calls in production code: `dplyr::filter()`, `stats::filter()`. 2. Check for conflicts after loading packages: `conflicts()` lists all masked names. 3. Use the `conflicted` package which turns masking warnings into errors: `library(conflicted); conflict_prefer("filter", "dplyr")`. 4. At the top of scripts, document which packages are loaded and in what order.
- **Tool sequence**: shell_exec (`R -e "library(pkg); conflicts()"`) → file_read → file_edit (add :: namespace qualifiers to ambiguous calls)
- **Pitfall**: Do NOT rely on `library()` load order to resolve namespace conflicts — load order changes between environments and makes code non-reproducible.

### Memory Error — Copying Large Data Frames
- **Symptom**: `Error: cannot allocate vector of size N Gb`; R crashes or becomes very slow when processing large data frames; `gc()` doesn't help.
- **Cause**: R uses copy-on-modify semantics — modifying a column in a data frame creates a copy of the entire data frame. Repeated column additions in a loop (`df$new_col <- ...`) can trigger many copies. R also loads entire datasets into RAM.
- **Strategy**: 1. Use `data.table` for large datasets — it modifies by reference with `:=` operator, avoiding copies. 2. For loops that build data frames, use `lapply` + `do.call(rbind, list)` or `dplyr::bind_rows` instead of growing a data frame in a loop. 3. Use `fread()` from `data.table` for faster CSV loading with lower memory usage. 4. Process data in chunks for very large files. 5. Call `gc()` to force garbage collection after removing large objects with `rm(large_object)`.
- **Tool sequence**: file_read (data processing loops) → file_edit (replace loop with lapply/bind_rows or convert to data.table)
- **Pitfall**: Do NOT preallocate a data frame with empty rows and fill by index — it is slower than building a list and converting once at the end.

## Verification
Run: `Rscript --vanilla your_script.R`
- No errors or warnings in output.
- Use `lintr::lint("script.R")` for style and potential bug checks.
- Run `testthat` tests: `devtools::test()` — all tests pass.

## Validation Checklist
- [ ] All functions receive data as arguments, not from global environment
- [ ] `na.rm = TRUE` specified in all aggregate functions where NA is possible
- [ ] No `stringsAsFactors = TRUE` in data loading (or explicit factor handling)
- [ ] Vector length equality checked before element-wise operations
- [ ] Recycling warnings treated as errors during development (`options(warn=2)`)
- [ ] All ambiguous function calls use `::` namespace qualifier
- [ ] `conflicted` package used or load order documented
- [ ] Large data frame operations use `data.table` or `dplyr` instead of loops
- [ ] `lintr` passes with no errors
- [ ] No use of `<<-` superassignment in package code
