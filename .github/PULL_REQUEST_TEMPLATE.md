## 变更概述 (Summary)

<!-- 简要说明本次 Pull Request 解决的问题或引入的功能。如果关联已有 Issue，请注明如 Closes #123 -->

## 变更类型 (Type of Change)

- [ ] 🐛 Bug 修复 (`fix`)
- [ ] ✨ 新特性 (`feat`)
- [ ] 🌐 词典补充与汉化修正 (`dict/` / `ui-strings/`)
- [ ] 🎨 原生界面与交互优化 (`style` / `native/`)
- [ ] ♻️ 代码重构 (`refactor`)
- [ ] 🧪 测试用例补充或修复 (`test`)
- [ ] 📝 文档与工程配置更新 (`docs` / `chore`)

## 开发者自检清单 (Checklist)

提交 PR 前请确认已完成以下检查：

- [ ] 本地运行 `npm run build` 与 `npm test` 全部通过
- [ ] 如涉及界面汉化或 DOM 注入，已运行 `npm run test:browser` 并通过无头浏览器回归测试
- [ ] 如涉及词典或发布门禁，已运行 `node tools/verify.mjs --no-vendor` 通过门禁校验
- [ ] 严守隐私与版权底线：未提交任何官方 `vendor/` 二进制包、未包含真实邮箱/Token/本机物理路径等敏感信息
- [ ] 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范

## 测试与验证说明 (How Has This Been Tested?)

<!-- 简要描述你在本地如何验证此次改动（例如测试输出摘要、涉及的 Antigravity 版本或界面截图） -->
