# Code Tool Demo

This demo shows when to use `pi-code-tool`, how helper functions like `ls` are scoped, and why code-mode is useful for multi-step workflows.

## Setup

From this repository:

```bash
npm install
npm run build
pi -e dist/pi/extension.js
```

Or, while developing from source:

```bash
pi -e src/pi/extension.ts
```

## Key idea

`ls`, `grep`, `find`, `read`, `bash`, `edit`, and `write` are **not standalone pi tools** provided by this package.

They are Python helper functions that exist **only inside the `code` tool**.

Correct:

```text
Use the code tool to run: print(ls("."))
```

Incorrect:

```text
Call ls on the current directory.
```

## Demo 1: Loop/filter/aggregate without filling context

Prompt:

```text
Use the code tool to list the top-level repository files, count how many TypeScript files are under src and test, and print only a compact summary.
```

Expected model behavior: one `code` tool call similar to:

```python
src_files = find("**/*.ts", "src")
test_files = find("**/*.ts", "test")
print(f"src TypeScript files: {len(src_files.splitlines())}")
print(f"test TypeScript files: {len(test_files.splitlines())}")
```

Why this is better than direct tool calls: the file lists can be filtered and counted inside the sandbox, and only the summary reaches model context.

## Demo 2: Read files through the workspace mount

Prompt:

```text
Use the code tool to read package.json from /workspace, parse it as JSON, and print the package name, version, and test command.
```

Expected model behavior:

```python
import json
pkg = json.loads(open("/workspace/package.json").read())
print(f"{pkg['name']} {pkg['version']}")
print(f"test: {pkg['scripts']['test']}")
```

## Demo 3: Approval-gated mutation

Prompt:

```text
Use the code tool to compute the sum of 1..100, then write it to demo/total.txt.
```

Expected model behavior:

```python
total = sum(range(1, 101))
print(f"computed total: {total}")
write("demo/total.txt", str(total) + "\n")
```

What should happen:

1. The script prints the computed total.
2. The `write(...)` call pauses for approval.
3. If approved, the file is written.
4. If denied, Python receives `PermissionError`.
5. If suspended, the run can later resume with `{"resume": true}` and already-completed work will not repeat, or discard the pending gate with `{"abandon": true}`.

## Demo 4: Save a reusable helper

Prompt:

```text
Use the code tool to define and save a reusable Python function named repo_package_summary(path="package.json") that returns the package name and version from a package.json file. Then use it immediately.
```

Expected model behavior:

```python
code = '''
def repo_package_summary(path="package.json"):
    import json
    data = json.loads(open(f"/workspace/{path}").read())
    return {"name": data["name"], "version": data["version"]}
'''

save_tool(
    "repo_package_summary",
    code,
    "Return name and version from a package.json file. Args: path str. Returns: dict.",
)

# Define it in this session too, because save_tool loads it automatically only in future sessions/reset.
def repo_package_summary(path="package.json"):
    import json
    data = json.loads(open(f"/workspace/{path}").read())
    return {"name": data["name"], "version": data["version"]}

print(repo_package_summary())
```

Later, in a fresh session or after `reset=true`, the saved helper can be called directly from inside `code`:

```python
print(repo_package_summary())
```
