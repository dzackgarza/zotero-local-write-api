# Reinvention Slop Report

### Regex Against Code Artifacts
**Pattern**: Regex against semantic formats

**Concrete Evidence**:
- `build.py:44-55` Using `re.compile` to parse JavaScript variable declarations (`(?:var|const|let) PLUGIN_VERSION = .*?;`).
- `build.py:73-82` `update_bootstrap_metadata()` uses string substitution to patch JavaScript code.

**The "Incredibly Stupid" Test**:
"This is incredibly stupid. Why would we ever do regex string substitution on generated JS when we could just use `bun build --define` to inject these constants at compile time?"

**Narrative Reconstruction**:
The agent needed to inject configuration values into the built JS. Instead of reading the documentation for `bun` (the tool it is already calling) and using its native define/injection capabilities, it treated the JS artifact as a plain text string and reached for Python's regex to monkey-patch it after the fact.

**Existential Justification**:
This code exists to pass environment configuration to the client build. It can be completely eliminated by passing the config variables to the `bun build` command via `--define` flags, allowing the compiler to handle the substitution semantically.

**Owned Surface Reduction**:
Estimated 35 lines of code to be deleted.

**Failure Mode**: Dependency aversion, Regex-as-reflex

### Hand-Rolled Schema Validation
**Pattern**: Bespoke Reinvention of Standard Patterns

**Concrete Evidence**:
- `src/bootstrap.ts:74-130` Hand-rolled runtime type checkers (`requireString`, `requireNonEmptyString`, `optionalNonEmptyString`, `requireObject`, `normalizeStringList`) that perform manual type coercion and validation.

**The "Incredibly Stupid" Test**:
"This is incredibly stupid. Why would we ever do hand-rolled type assertions with custom error strings when we could just use a schema validation library like `zod` or `yup` to define and enforce exact data shapes at the boundary?"

**Narrative Reconstruction**:
The agent needed to validate incoming JSON API requests. Instead of importing an industry-standard validation dependency to declaratively define and parse the data shape, it iteratively added bespoke imperative functions for each new type or structural constraint it encountered.

**Existential Justification**:
This code exists to enforce data shapes at the API boundary. It can be entirely replaced by an external schema validation dependency that guarantees shape and eliminates the need for manual type guards throughout the codebase.

**Owned Surface Reduction**:
Estimated 56 lines of code to be deleted.

**Failure Mode**: Dependency aversion, Ground-up bias

### Graceful Degradation on Missing Files
**Pattern**: Enterprise Patterns in Bespoke Code

**Concrete Evidence**:
- `src/bootstrap.ts:241-248` `handleFulltextAttach` intercepts a missing file error from `importStoredAttachment` and silently falls back to materializing the file from base64 bytes instead.

**The "Incredibly Stupid" Test**:
"This is incredibly stupid. Why would we ever try to silently recover from a missing file path by reading a secondary data field, when we could just fail loudly and let the user know their file path is broken?"

**Narrative Reconstruction**:
The agent was asked to handle both file paths and base64 bytes. Instead of enforcing mutual exclusivity at the boundary or failing when a provided path doesn't exist, it reflexively implemented "graceful degradation." It caught the error and used the alternative data source to prevent a crash, hiding broken caller state from the user.

**Existential Justification**:
This code exists to prevent the request from failing if a provided file path is wrong but base64 data happens to be present. It should be eliminated because in bespoke software, we want to fail loudly on wrong inputs rather than laundering a broken request into a successful operation.

**Owned Surface Reduction**:
Estimated 10 lines of code to be deleted.

**Failure Mode**: Enterprise thinking, Fallback laundering

### Bespoke Regex for Academic Identifiers
**Pattern**: Regex against semantic formats

**Concrete Evidence**:
- `src/bootstrap.ts:616-621` Custom regex logic to detect arXiv (`raw.match(/(?:arxiv:)?.../i)`) and PMID (`/^\d{1,10}$/.test(...)`) identifiers instead of utilizing built-in capabilities.

**The "Incredibly Stupid" Test**:
"This is incredibly stupid. Why would we ever do bespoke regex parsing for academic identifiers when we could just use `Zotero.Utilities` or `Zotero.Search` which already provide battle-tested identification tools?"

**Narrative Reconstruction**:
The agent needed to detect arXiv and PMID identifiers. Instead of investigating Zotero's built-in translation and identification utilities for academic formats, it reflexively wrote bespoke regex primitives. It likely saw `cleanDOI` and `cleanISBN`, couldn't immediately find the others, and fell back to raw language primitives to satisfy the requirement.

**Existential Justification**:
This code exists to detect and route identifier types before looking them up. It can be eliminated by delegating the identifier detection entirely to Zotero's built-in translation APIs, which natively understand the formats.

**Owned Surface Reduction**:
Estimated 6 lines of code to be deleted.

**Failure Mode**: Ground-up bias, Regex-as-reflex

### Switch-Statement Router Accretion
**Pattern**: Complexity as a Dependency-Detection Signal

**Concrete Evidence**:
- `src/bootstrap.ts:634-694` A massive 50+ line `switch` statement in `runWrite` manually dispatching `operation` string values to specific handler functions.

**The "Incredibly Stupid" Test**:
"This is incredibly stupid. Why would we ever manually accrete 28 cases onto a switch statement when we could just use a dictionary dispatch / lookup table of operations mapped to their handler functions?"

**Narrative Reconstruction**:
The agent needed to route incoming request strings to corresponding execution functions. Instead of using a data-aware dispatch map, it mindlessly accreted branches onto a primitive switch statement for each new API operation over multiple iterations.

**Existential Justification**:
This code exists to route API requests. It can be reduced to a 1-line dictionary lookup, removing the structural complexity, repetitive boilerplate, and potential for missing cases.

**Owned Surface Reduction**:
Estimated 50 lines of code to be deleted.

**Failure Mode**: Pattern Replication Without Abstraction, Ground-up bias

### Manual Array Normalization Loop
**Pattern**: Manual Iteration → Library Calls

**Concrete Evidence**:
- `src/bootstrap.ts:114-129` `normalizeStringList` uses an imperative `for` loop, a `Set` accumulator, and deep `if` branches to trim and deduplicate an array of strings.

**The "Incredibly Stupid" Test**:
"This is incredibly stupid. Why would we ever write a 15-line manual accumulator loop with deep branching when we could just use `[...new Set(value.map(v => v.trim()).filter(Boolean))]` or a library validation pipeline?"

**Narrative Reconstruction**:
The agent needed to normalize a list of strings and deduplicate them. Instead of using idiomatic JavaScript functional pipelines, it fell back to an imperative C-style `for` loop with an accumulator, writing verbose language primitives to solve a trivial data transformation.

**Existential Justification**:
This code exists to sanitize array inputs. It can be collapsed into a single line of idiomatic JS or eliminated entirely by moving the array normalization into a schema validation library at the data boundary.

**Owned Surface Reduction**:
Estimated 15 lines of code to be deleted.

**Failure Mode**: Ground-up bias

### Manual Byte Initialization Loop
**Pattern**: Manual Iteration → Library Calls

**Concrete Evidence**:
- `src/bootstrap.ts:182-184` A manual `for` loop inside `materializeUploadBytes` to convert a binary string into a `Uint8Array`.

**The "Incredibly Stupid" Test**:
"This is incredibly stupid. Why would we ever use a manual `for` loop to populate a byte array from a base64 string when we could just use `Uint8Array.from(atob(fileBytesBase64), c => c.charCodeAt(0))` or a dedicated base64 decoding library?"

**Narrative Reconstruction**:
The agent needed to convert a base64 string to a binary blob. Because it did not know the idiomatic JavaScript pipeline for this transformation, it wrote an imperative `for` loop, manipulating individual byte indices directly.

**Existential Justification**:
This code exists to decode base64 file payloads into memory. It can be replaced by a single idiomatic pipeline call, eliminating the imperative array initialization entirely.

**Owned Surface Reduction**:
Estimated 3 lines of code to be deleted.

**Failure Mode**: Ground-up bias