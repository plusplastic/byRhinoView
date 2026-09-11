# byRhinoView - Product Features & Guide / 제품 기능 소개 및 가이드

Welcome to the **byRhinoView** features and capabilities guide. byRhinoView is a premium, lightweight, zero-install 3D CAD viewer running 100% locally in your web browser or as a standalone PWA on Android & iOS.

**byRhinoView** 제품 기능 소개 및 전체 기능 가이드입니다. byRhinoView는 웹 브라우저에서 100% 오프라인 로컬로 작동하며 설치가 필요 없는 경량의 프리미엄 3D Rhino & CAD 뷰어 솔루션으로, 모바일(Android/iOS) 독립 실행형 PWA로도 완벽하게 지원됩니다.

---

## 🌟 Key Highlights / 핵심 특장점

### 1. Zero-Install & Local Sandbox (무설치 & 로컬 샌드박스)
* **EN:** Opens instantly in any modern web browser without installing any plugins, apps, or registering an account. All 3D geometry is processed 100% locally within your device's browser sandbox—your confidential models are **never uploaded to any server**.
* **KR:** 플러그인이나 앱 설치, 회원 가입 없이 웹 브라우저에서 즉시 실행됩니다. 모든 3D 데이터는 사용자의 모바일/PC 기기 내부(로컬 샌드박스)에서만 100% 처리되므로, 소중한 디자인 모델이 **외부 서버로 절대 업로드되지 않아 안전합니다.**

### 2. Native CAD Engine (고성능 기본 CAD 엔진)
* **EN:** Powered by WebAssembly (rhino3dm.js) and optimized WebGL rendering pipelines, delivering fast rendering speeds and accurate display of complex curves and nurbs geometries.
* **KR:** WebAssembly(rhino3dm.js) 및 최적화된 WebGL 렌더링 파이프라인을 탑재하여 모바일 기기에서도 부드러운 회전과 정밀한 라이노 특유의 넙스(NURBS) 경계 및 곡선 표현을 지원합니다.

### 3. Native OS Integration & PWA (모바일 앱 연동 및 PWA)
* **EN:** Installs as a standalone App via Progressive Web App (PWA) with bespoke splash screens and status bar translucent configurations on iOS and Android. Supports **direct file opening associations**—easily double-click `.3dm`, `.stp`, `.igs` files in your File Manager or KakaoTalk to instantly launch and view in byRhinoView.
* **KR:** 프로그레시브 웹 앱(PWA) 기술을 지원하여 모바일 기기 홈 화면에 설치해 독립 앱처럼 실행할 수 있으며, iOS 전용 스플래시 화면 및 반투명 상태바 스타일링이 적용되어 있습니다. 안드로이드 **파일 공유(앱 연결) 연동**을 완벽하게 지원하여, 내파일(파일 앱)이나 카카오톡 다운로드 폴더에서 `.3dm`, `.stp`, `.igs` 파일을 터치하면 바로 byRhinoView로 연결해 열어볼 수 있습니다.

---

## 📋 Comprehensive Feature Checklist / 기능 상세 정리

### 1. 📂 Supported CAD Formats / 지원 파일 포맷
* **`.3dm` (Rhino 3D):** Support for Rhino version 5, 6, 7, and 8 files with high fidelity curves, rendering materials, layers, and object colors.
* **`.glb` / `.gltf`:** Rapid loading of GL Transmission Format models with custom environment mapping.
* **`.stl`:** 3D printing stereolithography mesh models.
* **`.3mf`:** High-efficiency 3D manufacturing format files.
* **`.stp` / `.step` / `.igs` / `.iges`:** Supports sessions and imports via standard file drops and native OS file associations.
* **`.rhv`:** The custom package file format for byRhinoView that saves your entire viewing state.

---

### 2. 🎨 Advanced Shading & View Modes / 프리미엄 쉐이딩 및 뷰 모드
Customize how your models are displayed using professional viewport modes:
* **Shaded (음영):** Classic solid rendering with visible boundary wireframes.
* **Wireframe (와이어프레임):** Displays only structural curve outlines and mesh edges, ideal for verifying internal geometries.
* **Arctic (아키텍처/앰비언트 오클루전):** Premium architectural mode rendering with smooth, soft ambient occlusion shadows, highlighting depth and form beautifully without textures.
* **Rendered (렌더링):** Full material support, realistic shadows, and environmental reflections.
* **Technical Sketch (기술적 스케치):** Artistic technical draft styling with outlines and hidden line silhouettes.

---

### 3. 📐 Professional Analysis Tools / 정밀 분석 및 검증 도구
* **Distance Measurement (거리 측정):** Interactive distance tool with high-accuracy **vertex snapping (Snap to Vertex)** on loaded meshes.
* **Angle Measurement (각도 측정):** Measures precise angles between three custom points with dynamic vertex snapping.
* **Stylus-Only Measuring (펜 전용 측정):** While a measurement tool is active, a single finger or a resting palm is ignored, so an Apple Pencil or other stylus can snap to a vertex without the hand orbiting the view. Two-finger zoom and pan still work, except while the stylus is actually in use. Arms itself the first time a stylus is used; toggle it off in the Measurements panel to measure by touch.
* **Measurement History List (측정 기록 내역):** Tracks and displays all measurements in a beautiful overlay table with custom units and dynamic deletion/clear-all options.
* **Clipping Plane (클리핑 단면):** 3-Axis (X, Y, Z) sectioning tools. Slide the section plane in real time, **Flip** the clipping direction, and reset instantly to examine internal components.
* **Section Cap Fill (단면 채움):** Fills the cut cross-section of closed solids at the clipping plane with a solid color, so sectioned models read as filled surfaces rather than hollow shells.
* **3D Notes (3D 노트):** Pin color-coded notes to specific points on the model to capture review comments, then edit, delete, and manage them from the notes list.
* **Object Properties (개체 속성):** Inspect a selected object's name, layer, color, and material, and review Rhino's **Attribute User Text** in a dedicated tab.
* **Find Object (개체 검색):** Real-time search of objects or mesh parts by name. Double-click to highlight, zoom-fit, or isolate selected elements.

---

### 4. ⚙️ Environmental Lighting & Rendering Settings / 정밀 조명 및 렌더링 설정
* **Interactive Backgrounds (인터랙티브 배경):** Choose between **Solid color**, **2-Color gradient**, **Radial gradient (with custom spread)**, **4-Color gradient**, or **HDR environment background**. Includes seamless Coloris color picker integration.
* **Environment presets (조명 프리셋):** Switch environment atmospheres between Studio, Neutral, Sky, Sunset, and Night.
* **Custom HDR Backgrounds (커스텀 HDR 지원):** Open and load any external `.hdr` or `.exr` file to calculate high-fidelity light environments and reflections.
* **Lighting Sliders (상세 조명 조절):**
  * **Ambient Light:** Control overall brightness of shadowed surfaces.
  * **Sun Light:** Toggle solar directional light, adjust intensity, azimuth (sun rotation), and elevation (sun height).
* **Color Grading & Adjustments (컬러 그레이딩):** Professional color-correction tools including **Exposure, Contrast, Saturation, and Temperature** sliders to adjust visual tones dynamically.
* **Visibility Toggles (요소 가시성 제어):** Instantly show or hide **Edges/Outlines**, **Annotations**, **Ground grids/planes**, and **Shadows**.

---

### 5. 🎥 Camera & Viewport Navigation / 카메라 및 뷰포트 제어
* **Projection Modes (투영 모드):** Choose between **Perspective** (natural real-world depth) and **Parallel/Orthographic** (accurate technical representation).
* **Perspective FOV:** Dynamic Field of View slider to control camera lens perspective (10° - 100°).
* **Damping & Friction (마찰력 조절):** Toggle and fine-tune smooth camera rotation momentum and inertia.
* **Viewport Presets (뷰 방향 설정):** Standard camera orientations: **Perspective**, **Top**, **Front**, **Right**.
* **Named Views (뷰 저장 및 전환):** Import NamedViews embedded inside Rhino `.3dm` files, save new custom views dynamically, and animate transitions smoothly.

---

### 6. 📁 Layer & Hierarchy Management / 레이어 및 계층 구조 관리
* **Rhino Layers Support (라이노 레이어 지원):** Automatically imports the original hierarchical layer structure from `.3dm` files.
* **Visibility Toggle (레이어 가시성):** Toggle individual or group visibility.
* **Layer Colors (레이어 색상 매칭):** Visual circle indicators display and match the native layer colors defined in your Rhino model, providing immediate context.
* **Global Control (일괄 제어):** One-click button to toggle all layers on or off.

---

### 7. 💾 Smart Session Management / 스마트 세션 및 내보내기
* **`.rhv` Session Packages:** Instead of raw files, save your entire design session into a single `.rhv` package. This bundle captures:
  1. The 3D model geometry.
  2. Active camera angle and projection.
  3. Custom background gradient colors or active HDR.
  4. Layer visibility toggles.
  5. Placed measurement annotations and markers.
  6. Lighting intensities and color grading options.
* **Save & Save As (데스크톱 저장):** On desktop Chromium, **Save** overwrites the opened `.rhv` in place—or opens a native save dialog in the source file's folder when another format was loaded. **Save As** always opens the native dialog so you choose folder + name in one step. (Other browsers and mobile fall back to a download.)
* **Export Package (HTML) (HTML 패키지 내보내기):** Export the viewer **together with** the loaded model as a single self-contained, offline `.html` file—open it with a double-click in any browser, with no server, plugin, or internet required. Perfect for sending models to clients for review.
* **Capture Screenshot (고해상도 캡처):** Capture high-resolution image snapshots directly from the 3D viewport canvas.
* **GLB Export:** Export the parsed mesh structure directly to standard `.glb` format for alternate VR/AR pipelines.
* **Bilingual UI (12 Languages):** Adaptation for English, Korean, French, German, Spanish, Italian, Japanese, Simplified Chinese, Traditional Chinese, Portuguese, Czech, and Polish matching Rhino 3D's standard UI languages.

---

### 8. 📱 iOS / Android PWA & Web Support / iOS / Android PWA 및 웹 지원
* **EN:** Fully compatible with Progressive Web App (PWA) specifications, allowing installation as a standalone app on iOS/Android home screens. Integrates native splash screens and translucent status bar designs on iOS, and executes completely without plugins on all modern web browsers.
* **KR:** 프로그레시브 웹 앱(PWA) 규격을 충족하여 모바일 홈 화면에 독립 앱처럼 추가해 원클릭으로 기동할 수 있습니다. iOS를 겨냥한 전용 스플래시 애니메이션 및 반투명 상태 표시줄(Status Bar) 스타일링을 내장하고 있으며, 모든 브라우저에서 설치 없이 100% 무설치로 바로 구동됩니다.

---

## ⚖️ Open Source & License / 오픈소스 및 라이선스

### MIT License / MIT 라이선스 적용
* **EN:** byRhinoView is distributed as free, open-source software under the permissive **MIT License**. Anyone (including individuals, education, research, and commercial corporate entities) can freely use, modify, merge, publish, distribute, sublicense, and sell copies without restriction.
* **KR:** byRhinoView는 허용도가 높은 **MIT 라이선스**를 기반으로 배포되는 자유 오픈소스 소프트웨어입니다. 개인, 교육, 연구 목적은 물론 **상업적 목적으로도 기업 사용자 누구나** 비용 결제나 가입 절차 없이 전면 무료로 자유롭게 활용, 수정, 병합, 배포, 서브라이선스 부여 및 사본 판매를 할 수 있습니다.

### Copyright & Liability Disclaimer / 저작권 및 면책 고지
* **EN:** Substantial portions or copies of the software must include the original copyright notice. The software is provided "as is" without warranty of any kind, and the authors/copyright holders are not liable for any claims or damages.
* **KR:** 소프트웨어 복제본이나 실질적 일부를 재배포할 시에는 원래의 저작권 고지를 포함해야 합니다. 본 소프트웨어는 명시적/묵시적 보증 없이 "있는 그대로" 제공되며, 사용 시 발생하는 어떠한 손해나 청구에 대해서도 개발사 및 저작권자는 면책됩니다.

---

## 🚀 Get Started / 시작하기

1. **Open App:** Launch byRhinoView on your web browser or launch the installed PWA.
2. **Load Model:** Drag & drop any `.3dm`, `.glb`, `.stl`, `.3mf`, `.stp` file into the canvas, or click **File > Open**.
3. **Navigate:** Left-drag to Rotate, Right-drag to Pan, Scroll to Zoom.
4. **Use Tools:** Measure sizes, slice clipping sections, change themes, or modify sun positions dynamically in the sidebars.

---
*Copyright © 2026 Plus Plastic. All rights reserved. Distributed under the MIT License.*
