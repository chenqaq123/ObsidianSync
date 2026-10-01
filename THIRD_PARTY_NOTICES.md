# Third-party notices

The Feishu document and image interoperability implementation references
Lark CLI (https://github.com/larksuite/cli), especially its `shortcuts/doc`
implementation and document format references. The TypeScript implementation
in this repository adapts those request formats and image placeholder/binding
steps; it does not bundle or execute the CLI. Its upstream license is retained
below. Plugin-specific conversion rules and sync behavior differ from the CLI.

Source: https://github.com/larksuite/cli/blob/main/LICENSE

MIT License

Copyright (c) 2026 Lark Technologies Pte. Ltd.

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

Obsidian and Electron are supplied by the host application. Build tools and
type declarations are development dependencies, recorded in package-lock.json;
they are not distributed in the plugin bundle.
