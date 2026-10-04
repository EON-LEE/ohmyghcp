# Third-party notices

oh-my-ghcp does not include third-party source code in this repository. The installers (`scripts/install.ps1`,
`scripts/install.sh`) download the software below onto your machine at install time.

## oh-my-claudecode

- Project: https://github.com/Yeachan-Heo/oh-my-claudecode
- Version: v5.6.1, commit `13543f9d6fc1a13a15b68fe5c97baeb3268569e2` (pinned in [`upstream.json`](upstream.json))
- Installed to: `<COPILOT_HOME>/oh-my-ghcp/omc` (unmodified checkout). The generated plugin in
  `<COPILOT_HOME>/oh-my-ghcp/plugin` contains copies of its files, some with Copilot tool and model names substituted,
  and a copy of its `LICENSE`.
- Its npm runtime dependencies are installed by `npm ci --omit=dev` and carry their own licenses (see
  `<COPILOT_HOME>/oh-my-ghcp/omc/node_modules/*/LICENSE*`).

```text
MIT License

Copyright (c) 2025 Yeachan Heo

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
