# Acknowledgments

This project stands on other people's work. Only things this repository actually uses, runs against or documents are listed. Licenses are the projects' own; check them before you redistribute anything.

## Used by the code or the build

- **Capacitor** (Ionic, MIT): the Android shell around the static app. `@capacitor/core`, `@capacitor/android`, `@capacitor/cli`.
- **Ajv** (MIT): JSON Schema validation for the `effort-export/1` format (dev dependency).
- **fake-indexeddb** (Apache-2.0): lets the browser storage tests run in Node (dev dependency).
- **Node.js** (OpenJSF): the built-in test runner, `node:sqlite` and the CLI runtime.
- **Web Speech API** (W3C draft, implemented by your browser): optional voice capture. The browser vendor's speech service does the recognition, which is why the app tells you before it listens.

## Optional local helpers you run yourself

- **llama.cpp** (ggml-org, MIT) and **Ollama** (MIT): the app can talk to a model you host yourself. Nothing ships with a model or a hosted endpoint. Model licenses belong to each model's authors.

## Pointers, not dependencies

- **988 Suicide & Crisis Lifeline** (US): the safety note points to it. This project has no affiliation with it, and the keyword check is not a clinical tool.

## How it was made

Steven Ammer sets the requirements and makes the product decisions. Implementation is AI-assisted: Anthropic's Claude and OpenAI's Codex wrote and reviewed code under his direction, and he gates what ships. The core logic was extracted from his private E.F.F.O.R.T. Android app; see [SOURCE.md](SOURCE.md).

If you find something missing or wrong here, open an issue and I'll fix it.
