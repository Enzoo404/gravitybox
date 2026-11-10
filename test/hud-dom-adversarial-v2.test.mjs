import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeUpwardPopoverPosition, applyPopoverGeometry } from '../runtime/hud-popover.js';
import { HUD_STYLES_CSS } from '../runtime/hud-styles.js';

function setupMockBrowser(vw = 1000, vh = 800) {
  globalThis.window = {
    innerWidth: vw,
    innerHeight: vh,
    location: { pathname: '/c/conv-default' }
  };
}

describe('DOM & 布局对抗性复验 (直接验证 runtime/hud-popover.js 与 runtime/hud-styles.js 生产模块)', () => {

  describe('复验重点 1: Popover 极窄视口防裁切 (Case C 实测)', () => {
    it('Case C1 (视口 290px, 卡片 280px): effectivePopoverWidth 应自适应缩容并杜绝溢出', () => {
      setupMockBrowser(290, 800);
      const fakeCapsule = {
        getBoundingClientRect: () => ({ left: 20, width: 60, top: 700, right: 80, bottom: 722 })
      };

      const pos = computeUpwardPopoverPosition(fakeCapsule, 280, 190, 12, 8, 12);
      assert.equal(pos.width, 266, '卡片有效宽度应动态收缩至 266px');
      assert.equal(pos.left, 12, '左侧应安全夹紧在 safeMargin 12px');
      const rightEdge = pos.left + pos.width;
      assert.equal(rightEdge, 278, '右边缘位置应为 278px');
      assert.ok(rightEdge <= 290 - 12, `右边缘必须严格保留 12px 留白: ${rightEdge} <= ${290 - 12}`);
      assert.equal(pos.alignment, 'clamped-left');
    });

    it('Case C2 (极窄视口 260px, 卡片 280px): 必须保持右侧留白并杜绝溢出', () => {
      setupMockBrowser(260, 800);
      const fakeCapsule = {
        getBoundingClientRect: () => ({ left: 10, width: 60, top: 700, right: 70, bottom: 722 })
      };

      const pos = computeUpwardPopoverPosition(fakeCapsule, 280, 190, 12, 8, 12);
      assert.equal(pos.width, 236, '卡片有效宽度应收缩至 236px');
      assert.equal(pos.left, 12, '左侧夹紧在 12px');
      assert.equal(pos.left + pos.width, 248);
    });

    it('Case C3 (二阶段 applyPopoverGeometry 祖先包含块偏移补偿验证)', () => {
      setupMockBrowser(1000, 800);
      const fakeCapsule = {
        getBoundingClientRect: () => ({ left: 450, width: 100, top: 700, right: 550, bottom: 722 })
      };
      const pos = computeUpwardPopoverPosition(fakeCapsule, 280, 190, 12, 8, 12);
      assert.equal(pos.left, 360);

      // 模拟宿主祖先存在 transform 偏移 (+50px, -20px)
      const styleObj = {};
      const arrowStyleObj = {};
      const fakePopover = {
        style: styleObj,
        getBoundingClientRect: () => {
          const l = parseFloat(styleObj.left || '0') + 50;
          const b = parseFloat(styleObj.bottom || '0') + 20;
          return {
            width: 280,
            height: 180,
            left: l,
            right: l + 280,
            top: 800 - b - 180,
            bottom: 800 - b
          };
        }
      };
      const fakeArrow = { style: arrowStyleObj };

      applyPopoverGeometry(fakePopover, fakeArrow, pos);
      // 经过二阶段补偿，style.left 应减去祖先偏移 +50px => 310px
      assert.equal(styleObj.left, '310px');
      assert.equal(arrowStyleObj.left, '140px');
    });

    it('Case C4 (5000 次蒙特卡洛随机对抗压力测试): 视口 150~2560px 100% 杜绝裁切', () => {
      for (let i = 0; i < 5000; i++) {
        const vw = Math.floor(150 + Math.random() * 2000);
        const vh = Math.floor(400 + Math.random() * 800);
        setupMockBrowser(vw, vh);

        const pw = [296, 296, 312][i % 3];
        const safeMargin = 12;
        const capsuleW = 40 + Math.random() * 100;
        const capsuleLeft = Math.random() * (vw + 100) - 50;

        const fakeCapsule = {
          getBoundingClientRect: () => ({ left: capsuleLeft, width: capsuleW, top: 500, right: capsuleLeft + capsuleW, bottom: 522 })
        };

        const pos = computeUpwardPopoverPosition(fakeCapsule, pw, 190, safeMargin, 8, 12);
        assert.ok(pos.left >= safeMargin);
        if (vw >= 120 + 2 * safeMargin) {
          assert.ok(pos.left + pos.width <= vw);
        }
      }
    });
  });

  describe('复验重点 2: 小三角相切夹紧公式与外层 overflow: visible 防裁切校验', () => {
    it('加宽详情保留长数值和中英文模型名，窄屏允许换行而不省略', () => {
      const rule = (selector) => HUD_STYLES_CSS.slice(HUD_STYLES_CSS.indexOf(`${selector} {`)).split('}')[0];
      assert.match(rule('.hud-popover-header'), /flex-wrap:\s*wrap/);
      assert.match(rule('.hud-popover-row'), /justify-content:\s*space-between/);
      for (const selector of ['.hud-popover-val', '.hud-popover-label', '.hud-popover-title',
        '.hud-popover-badge', '.hud-popover-badge-muted']) {
        assert.match(rule(selector), /white-space:\s*normal/);
        assert.match(rule(selector), /overflow-wrap:\s*anywhere/);
        assert.doesNotMatch(rule(selector), /text-overflow:\s*ellipsis|max-width:\s*175px/);
      }
    });

    it('小三角底边两翼必须 100% 严格落在卡片平直底边内 [19, W_eff - 19]', () => {
      setupMockBrowser(1000, 800);
      const fakeLeftCapsule = {
        getBoundingClientRect: () => ({ left: 0, width: 10, top: 700, right: 10, bottom: 722 })
      };
      const posLeft = computeUpwardPopoverPosition(fakeLeftCapsule, 280, 190, 12, 8, 12);
      assert.equal(posLeft.arrowPixelOffset, 19);
      assert.equal(posLeft.arrowPixelOffset - 7, 12);

      const fakeRightCapsule = {
        getBoundingClientRect: () => ({ left: 990, width: 10, top: 700, right: 1000, bottom: 722 })
      };
      const posRight = computeUpwardPopoverPosition(fakeRightCapsule, 280, 190, 12, 8, 12);
      assert.equal(posRight.arrowPixelOffset, 261);
      assert.equal(posRight.arrowPixelOffset + 7, 268);
    });

    it('HUD_STYLES_CSS 中 .hud-popover 必须为 overflow: visible 且由 .hud-popover-inner 承担滚动，防止 bottom: -6px 小三角被裁切', () => {
      assert.match(HUD_STYLES_CSS, /\.hud-popover\s*\{[^}]*overflow:\s*visible/s);
      assert.match(HUD_STYLES_CSS, /\.hud-popover-inner\s*\{[^}]*overflow-y:\s*auto/s);
      assert.match(HUD_STYLES_CSS, /@container\s+hud\s*\(max-width:\s*360px\)/);
      assert.match(HUD_STYLES_CSS, /@container\s+hud\s*\(max-width:\s*440px\)/);
    });
  });
});
