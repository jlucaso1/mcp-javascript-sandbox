# MCP QuickJS Runner

A server implementing the Model Context Protocol (MCP) that provides a tool to securely execute arbitrary JavaScript code within a QuickJS engine compiled to WebAssembly (WASM) and run using Node.js's built-in WASI implementation.

## Description

This server acts as an MCP tool provider. It exposes a single tool, `run_javascript_code`, which takes a string of JavaScript code as input. The code is then executed inside a sandboxed QuickJS WASM environment. The server captures the standard output (`stdout`) and standard error (`stderr`) streams from the execution and returns them, along with any execution errors, back to the MCP client.

This allows language models or other MCP clients to safely execute potentially untrusted JavaScript code snippets without compromising the host system.

## Features

*   **Secure Execution:** Runs JavaScript in a WASM sandbox using QuickJS and Node.js WASI.
*   **Standard I/O Capture:** Captures `stdout` and `stderr` from the executed JavaScript code.
*   **Error Reporting:** Reports runtime errors from QuickJS and non-zero exit codes.
*   **MCP Integration:** Exposes functionality as a standard MCP tool over `stdio`.
*   **Built with TypeScript:** Provides type safety during development.

## How it Works

1.  **WASM Module:** Uses a pre-compiled QuickJS engine (`qjs-wasi.wasm`) targeting the WebAssembly System Interface (WASI).
2.  **Node.js WASI:** Leverages the `node:wasi` module in Node.js to instantiate and run the WASM module.
3.  **Stdio Redirection (Temporary Files):** To capture `stdout` and `stderr` from the WASM environment, the server currently relies on the standard approach compatible with `node:wasi`:
    *   A temporary directory is created on the host filesystem using `node:fs/promises` and `node:os`.
    *   Temporary files for `stdout` and `stderr` are opened within this directory.
    *   The **real OS file descriptors** for these files are passed to the `WASI` instance during initialization (`stdout: fd`, `stderr: fd`).
    *   The QuickJS WASM module writes its output to these descriptors, which gets routed by WASI to the temporary files.
    *   After execution finishes, the server closes the file handles and reads the content of the temporary files.
    *   The temporary directory and files are cleaned up.
    *   *(Note: Attempts to use in-memory pipes or virtual filesystems like `memfs` were unsuccessful because `node:wasi` currently requires real OS file descriptors for stdio.)*
4.  **MCP Communication:** The server uses `@modelcontextprotocol/sdk` to listen for MCP requests via `stdio` and respond with the execution results formatted according to the protocol.

## Prerequisites

*   [Node.js](https://nodejs.org/) (v23.x or later recommended, check `node:wasi` compatibility for your specific version)
*   [npm](https://www.npmjs.com/) or [yarn](https://yarnpkg.com/)
*   The QuickJS WASM file (`qjs-wasi.wasm`) must be present in the same directory as the compiled server script (e.g., `./dist/qjs-wasi.wasm` relative to `./dist/server.js`). You may need to obtain or compile this separately.

## Installation

1.  Clone the repository (if applicable).
2.  Install dependencies:
    ```bash
    npm install
    ```
## Usage

```bash
node server.ts
