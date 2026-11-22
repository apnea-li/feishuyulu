// ==UserScript==
// @name         语录 - 自动点击“我已阅读并理解题目要求”
// @namespace    https://bytedance.feishu.link/
// @version      1.0.0
// @description  当网页出现蓝色的“我已阅读并理解题目要求”按钮时，延迟 0.3 秒（300ms）后自动点击
// @author       Xiang Li
// @match        https://bytedance.feishu.link/app/app_4jy9qcj3uzy9w/*
// @match        https://*.feishu.link/app/*
// @match        https://*.feishu.cn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const TARGET_TEXT = '我已阅读并理解题目要求';
    const CLICK_DELAY_MS = 300; // 0.3秒

    // 使用 WeakSet 记录已安排或已触发点击的按钮节点，避免在 0.3 秒延迟期间或动画期间重复触发
    const processedButtons = new WeakSet();

    /**
     * 判断按钮是否可见且可点击
     * @param {HTMLButtonElement} btn
     * @returns {boolean}
     */
    function isButtonClickable(btn) {
        if (!btn || !btn.isConnected) return false;
        if (btn.disabled || btn.getAttribute('aria-busy') === 'true') return false;

        // 精确匹配按钮文本
        const text = (btn.textContent || '').trim();
        if (text !== TARGET_TEXT) return false;

        // 校验主按钮特征（对应 HTML 中的 data-slot="button" data-variant="default" 蓝色主按钮）
        const variant = btn.getAttribute('data-variant');
        if (variant && variant !== 'default') return false;

        // 校验元素在页面上真实可见
        const style = window.getComputedStyle(btn);
        if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
            return false;
        }
        const rect = btn.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    /**
     * 扫描并安排点击目标按钮
     */
    function checkAndScheduleClick() {
        const buttons = document.querySelectorAll('button[data-slot="button"], button');

        for (const btn of buttons) {
            if (processedButtons.has(btn)) continue;

            if (isButtonClickable(btn)) {
                processedButtons.add(btn);

                setTimeout(() => {
                    // 0.3 秒后再次校验按钮是否仍在 DOM 中且未被禁用
                    if (isButtonClickable(btn)) {
                        btn.click();
                        console.log('[语录自动点击] 已在出现 0.3 秒后自动点击“我已阅读并理解题目要求”按钮');
                    } else {
                        // 若当时不可点，移除标记以便后续状态恢复时重试
                        processedButtons.delete(btn);
                    }
                }, CLICK_DELAY_MS);
            }
        }
    }

    // 1. 初始页面加载完成后立即检查一次
    checkAndScheduleClick();

    // 2. 监听 DOM 动态变化（应对切换下一题、上一题或异步渲染出按钮的情况）
    const observer = new MutationObserver(() => {
        checkAndScheduleClick();
    });

    if (document.body) {
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['disabled', 'aria-busy', 'class', 'style']
        });
    }
})();