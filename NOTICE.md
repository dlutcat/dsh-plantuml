# Third-party software

## PlantUML browser engine

`vendor/plantuml.js` and `vendor/stdlib/*` are the client-side PlantUML engine
and its standard library, taken unmodified from the official
[plantuml/plantuml-for-github](https://github.com/plantuml/plantuml-for-github)
repository (`Chrome/vendor/plantuml.js` and the sibling standard-library
files).

- Upstream copyright: PlantUML (Arnaud Roques)
- License: MIT
- Build: TeaVM compilation of the PlantUML Java sources, including the Smetana
  layout engine (a port of the Graphviz algorithms) — no WebAssembly module and
  no JVM are involved at runtime.

MIT License

Copyright (c) 2026 PlantUML

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

### On the license of generated diagrams

Images produced by *executing* PlantUML belong to the author of the diagram
source, not to the PlantUML project, and carry no license obligation. See the
[PlantUML FAQ](https://plantuml.com/en/faq).
