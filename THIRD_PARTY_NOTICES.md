# 第三方材料与开源声明 (Third-Party Notices)

GravityBox 的应用逻辑、原生 macOS AppKit 界面与扩展引擎均为本项目的独立实现。为了确保开源合规与清晰的版权隔离，特对项目中涉及的第三方材料、致谢与商标作如下声明：

## 1. 词典架构与独立实现 (Dictionary Architecture)

GravityBox 的基础词典与版本分层词典结构（`dict/`，按功能与版本分层）、文案提取与动态插值模板引擎，以及基于官方发布包 SHA256 指纹的覆盖率校验均为 GravityBox 项目独立设计与维护实现。

## 2. 官方界面包与版权隔离 (Vendor Isolation)

- Antigravity 官方应用的界面包（JavaScript bundle / ASAR）版权归原权利人所有。
- **版权隔离措施**：本项目严格遵循版权隔离原则，`vendor/` 目录已被彻底移出 Git 版本控制并加入 `.gitignore`。开源仓库中不包含、亦不分发任何官方二进制与未经授权的代码副本。
- 本项目仅在 `ui-strings/` 目录下分发经公开合法接口提取的文案键值结构与官方指纹元数据，并在 `tools/verify.mjs` 和 `tools/coverage-report.mjs` 中提供免 vendor 校验模式，供开源社区参与词典维护与对账。

## 3. 运行环境许可 (Runtime Environment)

完整安装包内置了构建时复制的 Apple Silicon / Universal Node 22 运行环境，随包分发其官方 LICENSE（包含 Node.js、V8、libuv 等第三方组件许可，位于安装包内 `Contents/Resources/runtime/LICENSE` 与本仓库 `licenses/NODE-LICENSE`）。Node 来源：[Node.js 官方网站](https://nodejs.org/)。

## 4. 商标与品牌免责声明 (Trademark Disclaimer)

- **Google**、**Antigravity**、**Gemini**、**Google Cloud Platform** 均为 Google LLC 的商标或注册商标。
- **Claude** 为 Anthropic PBC 的商标或注册商标。
- **OpenAI**、**ChatGPT** 为 OpenAI Inc. 的商标或注册商标。
- **Apple**、**macOS**、**AppKit**、**SF Symbols** 均为 Apple Inc. 的商标或注册商标。

**免责声明**：GravityBox 是一个独立的第三方开源工具箱，与 Google LLC、Anthropic PBC、OpenAI Inc. 或 Apple Inc. 无任何形式的官方隶属、合作、关联、赞助或背书关系。项目中出现的商标名称、品牌标识与模型识别图标仅用于技术事实性描述、功能兼容指引及模型供应商识别（Nominative Fair Use），其合法权利归各自权利人所有。
