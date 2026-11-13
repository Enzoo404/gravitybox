import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeUpwardPopoverPosition, applyPopoverGeometry } from '../runtime/hud-popover.js';

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

    it('Popover geometry remains within deterministic viewport and anchor boundaries', () => {
      for (const vw of [150, 260, 290, 320, 440, 1000, 2560]) {
        for (const pw of [280, 296, 312]) {
          for (const left of [-50, 0, vw / 2, vw - 20, vw + 50]) {
            for (const width of [40, 140]) {
              setupMockBrowser(vw, 800);
              const capsule = { getBoundingClientRect: () => ({ left, width, right: left + width, top: 700, bottom: 722 }) };
              const pos = computeUpwardPopoverPosition(capsule, pw, 190, 12, 8, 12);
              assert.ok(pos.left >= 12, JSON.stringify({ vw, pw, left, width, pos }));
              assert.ok(pos.left + pos.width <= vw - 12, JSON.stringify({ vw, pw, left, width, pos }));
            }
          }
        }
      }
    });
  });

  describe('复验重点 2: 小三角相切夹紧公式与外层 overflow: visible 防裁切校验', () => {

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
  });
});
