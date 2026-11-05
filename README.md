# GravityBox

<p align="center">
  <img src="https://raw.githubusercontent.com/Enzoo404/gravitybox/main/assets/master-1024.png" width="128" height="128" alt="GravityBox Logo" style="border-radius: 24px;" />
</p>

<p align="center">
  <strong>专为 Google Antigravity 开发者打造的 macOS 菜单栏助手</strong>
  <br>
  <span>界面汉化 · 额度监控与重置倒计时 · 多账号一键切换 · Token 消耗记账</span>
</p>

<p align="center">
  <a href="https://github.com/Enzoo404/gravitybox/releases/latest"><img src="https://img.shields.io/github/v/release/Enzoo404/gravitybox?color=blue&style=flat-square" alt="Latest Release"></a>
  <a href="https://github.com/Enzoo404/gravitybox/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Enzoo404/gravitybox/ci.yml?branch=main&style=flat-square&logo=github" alt="CI Status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/platform-macOS%2014%2B-lightgrey.svg?style=flat-square&logo=apple" alt="Platform">
  <img src="https://img.shields.io/badge/arch-Apple%20Silicon-orange.svg?style=flat-square" alt="Arch">
</p>

---

## 🙋‍♂️ 为什么做这个项目？

作为一个每天重度使用 **Google Antigravity** 写代码的开发者，官方客户端用起来确实爽，但有几个地方实在太憋屈了：

1. **界面全是英文**：各种复杂的模型设置和调试面板看着费劲。市面上的汉化脚本动不动就去改客户端安装包文件，不仅容易破坏签名导致应用打不开，官方一更新还直接报废。
2. **额度像个玄学**：写着写着突然就限额了！官方界面把 5 小时短期限额和每周总限额混在一块，完全不知道还要等几个小时几分钟才能恢复。
3. **换个账号太折腾**：准备了备用 Google 账号，但每次主号没额度了都要在客户端里退登、重新走网页 OAuth 验证，非常打断写代码的思路。
4. **不知道自己用了多少钱**：跑了这么多会话和 Agent，到底消耗了多少 Token？按官方 API 定价折合多少美元？心里完全没本账。

为了让自己写代码更顺心，我写了 **GravityBox** —— 一个常驻在 Mac 屏幕右上角菜单栏的原生小工具，把这些痛点一次性全搞定。

---

## ✨ 它能帮你做什么？

### 🇨🇳 1. 干净、不伤原版的界面汉化
- **不改客户端安装包**：通过本地调试通道在前端运行时翻译，不解包、不改签名、官方客户端哪怕天天自动更新也不影响使用。
- **绝不乱翻代码**：只翻译菜单、按钮和设置说明；**绝不碰**你的代码块、终端输出、聊天正文和专有名词，不用担心代码被误翻搞坏。
- **随时切回英文**：菜单栏点一下就能随时在中文和官方原版英文之间无缝切换。

### ⏱️ 2. 算清剩余额度，精准重置倒计时
- **把限额拆开算**：分别清楚展示 Gemini 的 5 小时限额和每周限额，不再是一头雾水。
- **分秒级倒计时**：清晰显示「还有 2 小时 15 分钟后重置」，到点准时恢复，不用盲目等待。
- **全模型支持**：额外支持 Gemini 4 Argon、Claude / GPT 限额独立查看，额度快见底时提前提醒。

### 🔄 3. 多个 Google 账号，一键免密切换
- **无感秒切**：提前存好你的 Google 账号，主号额度见底了，在菜单栏点一下小号直接切过去，不需要每次都重新登入登出。
- **系统钥匙串加密**：所有登录凭证均保存在 macOS 自带的 Keychain（系统钥匙串）中，安全靠谱。
- **智能推荐**：哪个号额度最多，一目了然告诉你切换到哪个最划算。

### 💰 4. Token 消耗统计与 API 费用记账
- **本地直接读取**：自动统计你在各个项目、各个会话里消耗的 Input / Output Token，清清楚楚。
- **自动折算美元**：按官方 2026 最新定价，帮你算清折合美元花费，历史消耗永久对账。

### ⚡️ 5. 原生极轻，常驻菜单栏
- 用 Swift / AppKit 开发的原生 macOS 菜单栏小工具，常驻后台内存占用极低，CPU 几乎不费电。
- **100% 离线隐私**：所有数据都在你的 Mac 本地，**没有数据上报、没有后台埋点、不连任何第三方服务器**，代码全开源，完全放心用。

---

## 🚀 下载与安装

### 推荐：直接下载安装包 (DMG)

1. 前往 👉 [Releases 页面](https://github.com/Enzoo404/gravitybox/releases) 下载最新的 `GravityBox-1.0.0-arm64.dmg`。
2. 双击打开，把 `GravityBox.app` 拖进「应用程序 (Applications)」文件夹即可。
3. **首次打开遇到苹果拦截怎么办？**
   因为这是个人开源项目，没有花 99 美元/年买 Apple 商业企业证书做公证，macOS Gatekeeper（系统安全门禁）初次打开时可能会提示“无法打开”或“已被损坏”。
   只需打开终端执行这一行命令，回车即可解除隔离正常打开：
   ```bash
   sudo xattr -rd com.apple.quarantine /Applications/GravityBox.app
   ```

### 极客方式：从源码自己编译跑

如果你想自己编译或者修改代码，要求环境：
- macOS 14+ (Apple Silicon 芯片)
- Node.js `>=22.15.0 <23`
- Xcode 命令行工具 (`xcode-select --install`)

```bash
# 1. 克隆项目
git clone https://github.com/Enzoo404/gravitybox.git
cd gravitybox

# 2. 安装依赖并编译
npm ci
npm run build

# 3. 运行全部测试
npm test

# 4. 自己打包 DMG 安装包
npm run package:mac
```

---

## ❓ 常见问题 (FAQ)

**Q：用这个工具会导致我的 Google 账号被封吗？**  
A：不会。工具只是帮助你在本地做账号快速切换，调用的全都是你电脑本机的官方登录通道，没有任何爬虫、刷量或外挂作弊逻辑。

**Q：汉化会弄坏 Antigravity 的代码补全或聊天吗？**  
A：绝对不会。界面的汉化逻辑做了严格的节点隔离，代码编辑器、终端窗口、提示词输入框和聊天内容全都在白名单保护区内，绝不会被篡改。

**Q：我的账号密码会被上传吗？**  
A：完全不会。所有 OAuth Token 全程存储在你电脑系统自带的 macOS Keychain（钥匙串）中，GravityBox 没有任何服务器，代码 100% 开源，你随时可以检查源码。

---

## 📄 开源许可

本项目基于 [MIT License](./LICENSE) 开源。

如果你觉得好用，欢迎点个 ⭐️ **Star** 支持一下！
