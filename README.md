# byRhinoView

A premium, lightweight, zero-install 3D Rhino & CAD Web Viewer designed for seamless model interaction directly in the web browser. 

웹 브라우저에서 직접 매끄럽고 빠른 3D Rhino 및 CAD 모델 뷰잉과 상호작용을 지원하는 고성능 경량 웹 뷰어 솔루션입니다.

---

## 🌟 Key Features (주요 기능)

* **High-Fidelity CAD Formats:** Support for `.3dm` (Rhino 3D versions 5–8), `.glb`, `.stl`, `.3mf`, and `.stp`/`.step`/`.igs` file drops.
* **Premium Shading Modes:** Interactive shaded, wireframe, technical sketch, rendered, and beautiful **Arctic (Ambient Occlusion style)** modes.
* **Smart Session Management:** Save your entire viewing session—including camera perspectives, custom colors, layer visibilities, measurements, and lights—into a single `.rhv` package.
* **Export Package (HTML):** Export the viewer **and** the current model as one self-contained, offline `.html` file. Double-click to open in any browser—no server, plugin, or internet required. Ideal for sending models to clients for review.
* **View in AR:** Stand the model on a real table or floor through the phone's camera — the native AR view in the Android app (ARCore), or AR Quick Look straight from Safari on iPhone/iPad. The button is hidden where no AR runtime exists (desktop, Android Chrome).
* **Named Views:** Save custom camera viewpoints and animate transitions seamlessly.
* **Analysis Tools:** In-app distance/angle measurement utilities with smart vertex snapping, and real-time interactive clipping plane sections.
* **12-Language Support (i18n):** Automatically adapts to 12 languages matching Rhino 3D (en, ko, fr, de, es, it, ja, zh-CN, zh-TW, pt-BR, cs, pl).

---

## 📂 Repository Structure (저장소 구조)

This repository contains the clean distribution of the **byRhinoView Web Viewer**:

```text
byRhinoView/
├── www/                     # Core Web Viewer Source Files
│   ├── index.html           # Main Application Layout & Structure
│   ├── app.js               # Main Application Bootstrap & Logic
│   ├── style.css            # Custom Styling & Glassmorphic Design
│   ├── loaders.js           # 3D Model Parsers (.3dm, .glb, .stl, .stp, etc.)
│   ├── tools.js             # Distance, Angle, Clipping Plane, & Search Tools
│   ├── selection.js         # Object Selection & Gumball Helpers
│   ├── session.js           # Session/Package Importer & Exporter (.rhv + HTML)
│   ├── ar.js                # View in AR: GLB to the Android app, USDZ to iOS Quick Look
│   ├── i18n.js              # 12-Language Translation Catalog
│   ├── viewer-shell.html    # Prebuilt self-contained offline shell (generated)
│   ├── README.md            # Web Viewer Sub-README
│   ├── features.md          # Full Feature Documentation
│   └── privacy.md           # Bilingual Privacy Policy
├── build/
│   └── build-shell.mjs      # esbuild bundler → www/viewer-shell.html
├── LICENSE                  # MIT License
└── package.json             # NPM Configuration & Scripts
```

> [!IMPORTANT]
> `www/viewer-shell.html` is a **build artifact** consumed at runtime by the
> Export Package feature. Re-run `npm run build:shell` whenever the viewer
> source (`www/*.js`, `style.css`) changes, so exported packages embed the
> latest viewer.

> [!NOTE]
> Local development and build configurations for mobile platforms (Android/iOS) are ignored via `.gitignore` to maintain a lightweight, clean web-viewer-only repository layout for open-source distribution.

---

## 🛠️ Technology Stack (기술 스택)

* **Core Structure:** Pure HTML5 semantic elements
* **Design & Styling:** Vanilla CSS3 (Custom HSL properties, Glassmorphism, animations, Responsive Design)
* **Logic:** Modular Javascript (ES6 modules)
* **3D Engine:** Three.js (WebGL 3D Engine)
* **CAD Parsing:** rhino3dm.js (WebAssembly CAD importer)
* **Raycasting:** three-mesh-bvh (Fast GPU-based spatial index)
* **Color System:** Coloris (Premium Vanilla color picker)

---

## 🚀 Running Locally (로컬 실행 방법)

### 1. Install Dependencies
Ensure you have [Node.js](https://nodejs.org/) installed, then run:
```bash
npm install
```

### 2. Launch Local Dev Server
To start the local development server (served via `http-server` on port 8080):
```bash
npm run dev
```
Open your browser and navigate to `http://localhost:8080` to interact with the viewer.

### 3. (Optional) Build the Offline Export Shell
The **Export Package (HTML)** feature relies on a prebuilt, fully-inlined viewer
shell. Regenerate it after changing any viewer source:
```bash
npm run build:shell   # bundles the viewer → www/viewer-shell.html
```

---

## 📄 Documentation (문서 가이드)

* **Detailed Product Features & Guide:** [www/features.md](file:///www/features.md)
* **Bilingual Privacy Policy (개인정보처리방침):** [www/privacy.md](file:///www/privacy.md) (or open [www/privacy.html](file:///www/privacy.html) directly in a browser).

---

## 🔒 Security & Privacy (보안 및 개인정보 보호)

**byRhinoView** values user privacy and operates completely offline and locally.
All 3D models and session files opened within the app are processed entirely **offline and locally** inside your browser sandbox. Your confidential models are **never uploaded to any server**.

---

## ⚖️ Open Source & Third-Party Licenses

**byRhinoView** is built upon and inspired by the following incredible open-source projects. All libraries are distributed under their respective permissive licenses:

1. **Three.js** (MIT License) - Core WebGL 3D rendering pipeline and scenegraph.
2. **rhino3dm.js** by Robert McNeel & Associates (MIT License) - WebAssembly-based parser for native Rhino `.3dm` files.
3. **three-mesh-bvh** by Garrett Johnson (MIT License) - High-performance BVH spatial index for interactive object picking and measurements.
4. **Coloris** (MIT License) - Vanilla CSS/JS custom color picker.

---

## ⚖️ License

The custom viewer logic, CSS styling, and integration layer of **byRhinoView** are licensed under the **MIT License**.

Copyright © 2026 Plus Plastic. All rights reserved.
